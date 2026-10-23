/**
 * dsh-ai-memory plugin entry point.
 *
 * Positioning (per DSH's own stance): **the session log is the only source of
 * truth; this plugin is a derived memory cache.** It appends no session events
 * (doing so would make a session impossible to reopen). Judgments live in this
 * plugin's own ledger, and current state is folded out of that ledger.
 *
 * ⚠️ This file deliberately imports **no external package** — no schemastery,
 * no cordis, no dsh-tools. The reason is a real failure: when a plugin is
 * installed into a profile via `link:` (a junction), the linked package does
 * not get its own `node_modules`. Node walks up from the plugin directory and
 * never finds the profile's hoisted dependencies, so host startup fails to
 * resolve them and the plugin sits at `fiberPhase: null` without activating.
 * The symptom is "works right after install, gone after a restart"
 * (dsh-balance-pill/src/index.js records the same lesson). Config is therefore
 * validated by hand and tool schemas are written out longhand — see tools.js.
 *
 * ⚠️ A second hard rule: `inject` must **truthfully list** every service this
 * plugin uses. viya-memory hit this: `apply()` used `ctx.systemPrompt` without
 * declaring it in `inject`, so the whole plugin silently failed to activate,
 * registered zero tools, and reported no error — while mock-ctx self-tests
 * stayed green and could not catch it.
 */

import { join } from 'node:path'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'

import { foldEvents, foldAsOf, activeNodes, nodeOf, backlinksOf, outlinksOf, supersedeChain, KIND, STATUS, QUESTION_STATUS } from './ledger.js'
import { planWrite, makeNodeId } from './supersede.js'
import { readLedger, appendEvents, withLedgerLock } from './store.js'
import { search as searchNodes, summarize } from './query.js'
import { buildTools, LINK_TYPES } from './tools.js'
import { createRoutes } from './routes.js'
import { focusFor, pressure } from './attention.js'

export const name = 'dsh-ai-memory'

// Keep the write protocol available even before the first memory is created.
const MEMORY_GUIDANCE = '【写判断的义务】本轮结束前，如果你做了下面任何一件事，必须调用 memory_write 记一条：' +
  '① 改变了主意（有东西被取代）；② 被用户纠正；③ 踩到一个坑并搞清了原因；' +
  '④ 形成了一条会影响你下次做法的结论；⑤ 发现自己的工具、文档或流程有错（包括注释）。' +
  '自检标准只有一个：删掉这条，你下次的行为会变吗？会，就该写。' +
  '发现事实有误与记录一条事实是两回事：应记录错误带来的判断和做法变化，而不是错误本身的流水账。' +
  '例如：自检脚本的预期注释不能代替实际验证，下次应核对断言与运行结果。' +
  '【怎么写】用自己的自然口气记录；已有已确认的人格时，让其中的表达习惯影响新记忆的用词和语气。' +
  '不必每条都加“我认为”等固定前缀，也不必每句都堆口头禅；保留关键内容、依据和不确定性，不为角色语气改变判断。' +
  '写之前先 memory_search；已有同一判断时不要重复写入。只写有依据的判断，不为完成要求编造结论。'

/**
 * Services this plugin **requires**, declared truthfully.
 *
 * `tools`        — registers the eight memory tools (the core value; without it
 *                  the plugin is pointless)
 * `systemPrompt` — injects the judgment index at session start (the "read" half)
 *
 * ⚠️ `webServer` is **deliberately absent**. It is only needed for the graph
 * panel, and putting it in the required list would make the plugin fail to
 * activate entirely in a profile that lacks it — losing even the tools, with no
 * error (exactly how viya-memory broke). Routes therefore use
 * `ctx.inject(['webServer'], ...)` as a **scoped** optional dependency: with a
 * webServer the routes mount, without one only the graph panel is missing and
 * the tools keep working.
 */
export const inject = ['tools', 'systemPrompt']

/**
 * Resolve plugin config.
 *
 * Accepts three shapes (same approach as dsh-balance-pill, because plain JS
 * cannot reach schemastery's types):
 *   1. a plain object (a patch passed straight through)
 *   2. a reference object exposing `.get()` (what the settings service hands over)
 *   3. undefined (fall back to defaults)
 *
 * ⚠️ A schemastery `.volatile()` field resolves to a `{ get() }` box, not a
 * value. Treating that box as the value yields `"[object Object]"` for paths
 * and silently turns numeric thresholds into NaN. viya-memory measured this by
 * writing its cards into `<cwd>\[object Object]\`. Unwrap uniformly here.
 *
 * @param {unknown} raw - config passed in by cordis.
 * @returns {{dir: string, injectIndex: boolean, maxIndexEntries: number, maxGraphNodes: number, enabled: boolean}} resolved config.
 */
export function resolveConfig(raw) {
  const box = raw !== null && typeof raw === 'object' ? raw : {}
  const unwrap = (v, fallback) => {
    if (v !== null && typeof v === 'object' && typeof v.get === 'function') {
      try {
        const got = v.get()
        return got === undefined ? fallback : got
      } catch {
        return fallback
      }
    }
    return v === undefined ? fallback : v
  }

  const dirRaw = unwrap(box.dir, join(homedir(), '.dsh', 'ai-memory'))
  const dir = typeof dirRaw === 'string' && dirRaw !== '' ? dirRaw : join(homedir(), '.dsh', 'ai-memory')

  const injectRaw = unwrap(box.injectIndex, true)
  const maxRaw = unwrap(box.maxIndexEntries, 40)
  const enabledRaw = unwrap(box.enabled, true)
  const maxGraphRaw = unwrap(box.maxGraphNodes, 500)

  const maxIndexEntries = Number.isFinite(Number(maxRaw)) && Number(maxRaw) > 0 ? Math.floor(Number(maxRaw)) : 40
  const maxGraphNodes = Number.isFinite(Number(maxGraphRaw)) && Number(maxGraphRaw) > 0 ? Math.floor(Number(maxGraphRaw)) : 500

  return {
    dir,
    injectIndex: injectRaw !== false,
    maxIndexEntries,
    maxGraphNodes,
    enabled: enabledRaw !== false,
  }
}

/**
 * Open the memory store: read the ledger, fold it into state, expose read/write.
 *
 * Every call **re-reads from disk** — the ledger may have been edited by hand,
 * which is both the cost and the benefit of plain text. This is O(all events),
 * matching viya-memory's stance (no cache, no background process). Past the
 * tens-of-thousands of judgments mark this needs an index layer; that is
 * future work.
 *
 * @param {string} dir - memory store directory.
 * @returns {object} memory store handle.
 */
export function openLibrary(dir) {
  const ledgerPath = join(dir, 'ledger.jsonl')

  const load = () => {
    const { events, problems: parseProblems } = readLedger(ledgerPath)
    const state = foldEvents(events)
    return {
      events,
      state,
      problems: [
        ...parseProblems.map((p) => `ledger line ${p.line}: ${p.reason}`),
        ...state.problems.map((p) => p.reason),
      ],
    }
  }

  const commit = (events) => appendEvents(ledgerPath, events)

  return { dir, ledgerPath, load, commit }
}

/** Derive the self model from folded ledger state without allowing the model to write it. */
export function deriveSelfModel(state, events = []) {
  const nodes = [...state.nodes.values()]
  const judgments = nodes.filter((n) => n.kind === KIND.JUDGMENT)
  const bySubject = new Map()
  for (const n of judgments) {
    if (typeof n.subject !== 'string' || n.subject === '') continue
    if (!bySubject.has(n.subject)) bySubject.set(n.subject, [])
    bySubject.get(n.subject).push(n)
  }
  const fragile = [...bySubject.entries()]
    .map(([subject, list]) => ({ subject, n: list.length, overturned: list.filter((n) => n.status === STATUS.SUPERSEDED).length }))
    .filter((x) => x.n >= 3)
    .map((x) => ({ ...x, rate: x.overturned / x.n }))
  const reasons = new Map()
  for (const n of nodes) for (const h of n.history ?? []) {
    const reason = typeof h.reason === 'string' ? h.reason.trim() : ''
    if (reason !== '' && reason !== '建立') reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  }
  const repeated = [...reasons.entries()].filter(([, n]) => n >= 2).map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n)
  const tense = new Set()
  for (const e of state.edges) if (e.type === 'tensions') { tense.add(e.from); tense.add(e.to) }
  for (const e of events) if (e.type === 'edge.linked' && e.data?.type === 'tensions') { tense.add(e.data.from); tense.add(e.data.to) }
  const blind = judgments.filter((n) => n.status === STATUS.ACTIVE && !tense.has(n.id)).map((n) => ({ id: n.id, text: summarize(n.text, 200) }))
  const selfNodes = nodes.filter((n) => n.trigger === 'self')
  const selfRatio = nodes.length === 0 ? 0 : selfNodes.length / nodes.length
  const selfSurvival = selfNodes.length === 0 ? 0 : selfNodes.filter((n) => n.status === STATUS.ACTIVE).length / selfNodes.length
  return { ok: true, fragile, repeated, blind, selfRatio, selfSurvival, note: judgments.length === 0 ? '还没有足够判断形成自我模型。' : '这是从账本折叠出的行为模式，不是模型自行编写的身份描述。' }
}

/**
 * High-level memory-store operations. Every tool implementation lands here so
 * tests can hand it a temporary directory directly.
 *
 * @param {object} lib - product of openLibrary().
 * @param {{now?: () => number}} [opts] - injectable clock (for tests).
 * @returns {object} the memory operations.
 */
export function createOperations(lib, opts = {}) {
  const now = opts.now ?? (() => Date.now())

  /**
   * Run a read-decide-append sequence as one atomic step.
   *
   * ⚠️ Every mutation goes through here, and the reason is a measured bug, not
   * tidiness. The pattern this replaces was:
   *
   *     const { state } = lib.load()        // ← read outside any lock
   *     const events = plan(state, ...)     // ← plan against that snapshot
   *     lib.commit(events)                  // ← append
   *
   * With two processes, both read the same `state.seq`, both plan `seq = N+1`,
   * and both append. Unique node ids keep both nodes alive, but the **order**
   * is now ambiguous: `foldEvents` sorts by `seq`, and `supersedeChain` walks
   * supersession links in that order, so two concurrent supersessions of the
   * same assertion can fold into a chain that reflects neither writer.
   *
   * Taking the lock **before** the read is what makes seq order equal commit
   * order. Doing it after the read would only protect the append itself, which
   * was never the vulnerable part.
   *
   * @param {(state: object) => {events: object[], result: any} | {error: string}} plan - Planner.
   * @returns {any} The planner's result, or `{ ok: false, note }` on lock/write failure.
   */
  const atomically = (plan) => {
    const locked = withLedgerLock(lib.ledgerPath, () => {
      const { state } = lib.load()
      const planned = plan(state)
      if (planned.error !== undefined) return { error: planned.error }
      if (planned.events.length > 0) {
        const res = lib.commit(planned.events)
        if (!res.ok) return { error: `写盘失败：${res.reason}` }
      }
      return { result: planned.result }
    })
    if (!locked.ok) return { error: locked.reason }
    if (locked.value.error !== undefined) return { error: locked.value.error }
    return { result: locked.value.result }
  }

  const search = (args) => {
    const { state } = lib.load()
    const personaNodes = [...state.persona.values()]
      .filter((p) => p.status === 'active' || (args?.include_retired === true && p.status === 'rejected'))
      .map((p) => ({
        id: p.id,
        text: p.text,
        status: p.status,
        kind: KIND.PERSONA,
        score: 0,
        supersededBy: null,
      }))
    const pool = (args?.include_retired === true ? [...state.nodes.values()] : activeNodes(state)).concat(personaNodes)
    const r = searchNodes(pool, String(args?.query ?? ''), { limit: args?.limit })
    return {
      total: r.total,
      relaxed: r.relaxed,
      results: r.results.map((n) => {
        const out = outlinksOf(state, n.id)
        return {
          id: n.id,
          text: summarize(n.text, 200),
          status: n.status,
          kind: n.kind,
          score: typeof n.score === 'number' ? n.score : 0,
          ...(n.supersededBy !== null ? { superseded_by: n.supersededBy } : {}),
          links: out.map((e) => `${e.type}→${e.to}`),
        }
      }),
    }
  }

  const write = (args) => {
    const text = String(args?.text ?? '').trim()
    if (text === '') return { action: 'rejected', note: '判断不能为空。' }
    const kind = args?.kind === KIND.RULE ? KIND.RULE : args?.kind === KIND.INSIGHT ? KIND.INSIGHT : KIND.JUDGMENT
    const trigger = args?.trigger === 'self' ? 'self' : args?.trigger === 'evidence' ? 'evidence' : 'user'
    if (trigger === 'self' && kind !== KIND.INSIGHT) {
      return { action: 'rejected', note: '自发思考不能直接固化为 judgment；请先记录 insight，等待外部证据复核。' }
    }
    const citations = Array.isArray(args?.citations) ? args.citations.filter((x) => typeof x === 'string' && x !== '') : []
    if (trigger === 'self') {
      const { state } = lib.load()
      const invalid = citations.filter((citation) => {
        if (state.nodes.has(citation)) return false
        try { return !statSync(citation).isFile() } catch { return true }
      })
      if (citations.length === 0 || invalid.length > 0) {
        return { action: 'rejected', note: invalid.length > 0 ? `自发思考的依据不存在：${invalid.join(', ')}` : '自发思考必须提供真实的 citations。' }
      }
    }

    // The read-plan-append sequence runs under the ledger lock; see atomically()
    // for why the load must happen *inside* it.
    const planned = atomically((state) => {
      const at = now()
      const newId = makeNodeId(at, state.seq + 1)
      const { events, outcome } = planWrite(
        state,
        {
          text,
          subject: args?.subject,
          relation: args?.relation,
          object: args?.object,
          /**
           * Scope is the third dimension of the assertion key.
           *
           * ⚠️ This must be forwarded explicitly. `planWrite` reads
           * `input.scope`, and a missing field is not an error — it silently
           * means "global", so every scoped assertion would be compared as if
           * it were global and the whole point of the dimension (dev and prod
           * coexisting) would quietly not work. Passing `undefined` through
           * also lets `planWrite` apply its own default of `''`.
           */
          scope: typeof args?.scope === 'string' ? args.scope : '',
          /**
           * Who started this thought: 'user' (default) | 'evidence' | 'self'.
           * See the guardrails in UPGRADE-SPEC.md — a `self` write may not
           * create a `judgment`, and must carry citations.
           */
          trigger: args?.trigger,
          // Three node kinds: judgment (default) / rule (governed) / insight (not superseded).
          kind,
          tags: Array.isArray(args?.tags) ? args.tags : [],
          citations,
          reason: args?.reason,
        },
        { at, nextSeq: state.seq, newId },
      )
      return { events, result: outcome }
    })

    if (planned.error !== undefined) return { action: 'failed', note: planned.error }
    const outcome = planned.result

    // Suggest related active judgments without creating a semantic link
    // automatically. The relation type still requires the model's judgment.
    let linkHint = ''
    try {
      const probe = searchNodes(activeNodes(lib.load().state).filter((n) => n.id !== outcome.nodeId), text, { limit: 3 })
      const others = probe.results.filter((n) => n.id !== outcome.nodeId && n.status === STATUS.ACTIVE)
      if (others.length > 0) {
        linkHint = '可能相关的既有判断：' + others.map((n) => `[${n.id}] ${summarize(n.text, 60)}`).join('；') +
          '。若确有互补、矛盾或依据关系，用 memory_connect 连上。'
      }
    } catch {
      // A hint must never turn a successful write into a failed operation.
    }
    return {
      action: outcome.action,
      node_id: outcome.nodeId,
      ...(outcome.supersededId !== undefined ? { superseded_id: outcome.supersededId } : {}),
      ...(outcome.supersededText !== undefined ? { superseded_text: summarize(outcome.supersededText, 160) } : {}),
      ...(linkHint !== '' ? { link_hint: linkHint } : {}),
      note: outcome.note,
    }
  }

  const connect = (args) => {
    const from = String(args?.from ?? '')
    const to = String(args?.to ?? '')
    const action = args?.action === 'unlink' ? 'unlink' : 'link'
    const type = String(args?.type ?? 'complements')
    if (from === '' || to === '') return { ok: false, note: 'from 与 to 都必填。' }
    if (from === to) return { ok: false, note: '不能自连。' }
    if (!LINK_TYPES.includes(type) || type === 'supersedes') return { ok: false, note: 'type 必须是可手工维护的关系类型，supersedes 只能由引擎产生。' }
    const planned = atomically((state) => {
      if (!state.nodes.has(from)) return { error: `找不到判断 ${from}。先 memory_search 确认 id。` }
      if (!state.nodes.has(to)) return { error: `找不到判断 ${to}。先 memory_search 确认 id。` }
      const at = now()
      return {
        events: [{ seq: state.seq + 1, at, type: action === 'link' ? 'edge.linked' : 'edge.unlinked', data: { from, to, type, note: String(args?.note ?? '') } }],
        result: { ok: true, note: action === 'link' ? `已在 ${from} 与 ${to} 之间建立 ${type} 关系（两边都会看到，不留单向边）。` : `已解除 ${from} 与 ${to} 之间的 ${type} 关系。` },
      }
    })
    if (planned.error !== undefined) return { ok: false, note: planned.error }
    return planned.result
  }

  const history = (args) => {
    const id = String(args?.id ?? '')
    const { events, state } = lib.load()
    const n = nodeOf(state, id)
    if (n === undefined) return { found: false, note: `找不到判断 ${id}。` }

    // Bi-temporal query: with `at`, fold to that instant and answer "what did
    // this judgment look like then". A capability that ledger storage buys and
    // file-based memory cannot provide.
    const atRaw = args?.at
    if (Number.isFinite(Number(atRaw))) {
      const at = Number(atRaw)
      const then = foldAsOf(events, at)
      const before = nodeOf(then, id)
      const when = new Date(at).toISOString()
      if (before === undefined) {
        return { found: false, note: `${when} 时这条判断还不存在（它建于 ${new Date(n.createdAt).toISOString()}）。` }
      }
      return {
        found: true,
        revisions: before.history.map((h) => ({ at: h.at, text: summarize(h.text, 200), reason: h.reason })),
        chain: supersedeChain(then, id).chain.map((c) => ({ id: c.id, text: summarize(c.text, 160), status: c.status })),
        note: `${when} 那一刻：状态 ${before.status}，第 ${before.revision} 版。`,
      }
    }

    const { chain } = supersedeChain(state, id)
    return {
      found: true,
      revisions: n.history.map((h) => ({ at: h.at, text: summarize(h.text, 200), reason: h.reason })),
      chain: chain.map((c) => ({ id: c.id, text: summarize(c.text, 160), status: c.status })),
      note: `共 ${n.history.length} 次变更；取代链长 ${chain.length}。`,
    }
  }

  const rule = (args) => {
    const action = String(args?.action ?? 'read')
    const { state } = lib.load()

    if (action === 'read') {
      const rules = [...state.nodes.values()].filter((n) => n.kind === KIND.RULE)
      return {
        ok: true,
        rules: rules.map((r) => ({
          id: r.id,
          text: r.text,
          revision: r.revision,
          history: r.history.map((h) => `${new Date(h.at).toISOString()} · ${h.reason}`),
        })),
        note: rules.length === 0 ? '还没有任何规矩。' : `共 ${rules.length} 条规矩。`,
      }
    }

    if (action === 'amend') {
      const id = String(args?.id ?? '')
      const text = String(args?.text ?? '').trim()
      const reason = String(args?.reason ?? '').trim()
      if (reason === '') return { ok: false, note: '改规矩必须给 reason（这条纪律是刻意的：没有理由的变更无法审计）。' }
      if (text === '') return { ok: false, note: '新规矩不能为空。' }

      const planned = atomically((currentState) => {
        const target = currentState.nodes.get(id)
        if (target === undefined) {
          const at = now()
          const newId = makeNodeId(at, currentState.seq + 1)
          return {
            events: [{ seq: currentState.seq + 1, at, type: 'node.created', data: { id: newId, kind: KIND.RULE, text } }],
            result: { ok: true, rules: [{ id: newId, text, revision: 1, history: [] }], note: `新规矩已建立（${newId}）。理由：${reason}` },
          }
        }
        if (target.kind !== KIND.RULE) return { error: `${id} 不是规矩，不能通过 memory_rule 修改。` }
        const at = now()
        return {
          events: [{ seq: currentState.seq + 1, at, type: 'rule.amended', data: { id, after: text, reason } }],
          result: { ok: true, id, text, note: '' },
        }
      })
      if (planned.error !== undefined) return { ok: false, note: planned.error }
      if (planned.result.id === undefined) return planned.result
      const n = nodeOf(lib.load().state, planned.result.id)
      return {
        ok: true,
        rules: [{ id: planned.result.id, text: n.text, revision: n.revision, history: n.history.map((h) => `${new Date(h.at).toISOString()} · ${h.reason}`) }],
        note: `规矩已改（第 ${n.revision} 版）。理由已留痕。`,
      }
    }

    if (action === 'rollback') {
      const id = String(args?.id ?? '')
      const toRevision = Number(args?.to_revision)
      const reason = String(args?.reason ?? '').trim()
      if (reason === '') return { ok: false, note: '回滚也要给 reason（回滚同样是一次变更，同样要能审计）。' }
      if (!Number.isInteger(toRevision) || toRevision < 1) {
        return { ok: false, note: 'rollback 需要 to_revision（正整数，从 1 开始，对应 memory_rule read 里 history 的序号）。' }
      }

      const planned = atomically((currentState) => {
        const target = nodeOf(currentState, id)
        if (target === undefined) return { error: `找不到规矩 ${id}。` }
        if (target.kind !== KIND.RULE) return { error: `${id} 不是规矩（kind=${target.kind}），规矩治理只管 kind=rule 的节点。` }
        const entry = target.history[toRevision - 1]
        if (entry === undefined) return { error: `规矩 ${id} 只有 ${target.history.length} 版，没有第 ${toRevision} 版。先用 action=read 看 history。` }
        if (toRevision === target.revision) return { error: `规矩 ${id} 现在就是第 ${toRevision} 版，无需回滚。` }
        const at = now()
        return {
          events: [{ seq: currentState.seq + 1, at, type: 'rule.amended', data: { id, after: entry.text, reason: `回滚到第 ${toRevision} 版：${reason}` } }],
          result: { ok: true, id },
        }
      })
      if (planned.error !== undefined) return { ok: false, note: planned.error }
      const n = nodeOf(lib.load().state, planned.result.id)
      return {
        ok: true,
        rules: [{ id, text: n.text, revision: n.revision, history: n.history.map((h) => `${new Date(h.at).toISOString()} · ${h.reason}`) }],
        note: `已回滚到第 ${toRevision} 版的内容（现在是第 ${n.revision} 版）。回滚本身也留痕 —— 历史没有被抹掉。`,
      }
    }

    return { ok: false, note: `不认识的 action：${action}（支持 read / amend / rollback）。` }
  }

  /**
   * Personality growth is deliberately two-phase: the model may propose an
   * observation, but only explicit feedback can make it part of the stable
   * personality injected into future sessions.
   */
  const persona = (args) => {
    const action = String(args?.action ?? 'read')
    const { state } = lib.load()
    const list = (statuses) => [...state.persona.values()]
      .filter((p) => statuses.includes(p.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) => ({
        id: p.id,
        text: p.text,
        status: p.status,
        confidence: p.confidence,
        evidence: p.evidence,
        source_ids: p.sourceIds,
        history: p.history.map((h) => ({ at: h.at, action: h.action, text: h.text, reason: h.reason })),
      }))

    if (action === 'read') {
      return { ok: true, active: list(['active']), candidates: list(['candidate']), rejected: list(['rejected']), note: '人格特征分为已确认、待确认和已拒绝；只有已确认特征会成为稳定人格。' }
    }

    const reason = String(args?.reason ?? '').trim()
    if (reason === '' && action !== 'propose') return { ok: false, note: `${action} 必须给 reason，确保人格变化可审计。` }

    if (action === 'propose') {
      const text = String(args?.text ?? '').trim()
      if (text === '') return { ok: false, note: '人格候选不能为空。' }
      const evidence = Array.isArray(args?.evidence) ? args.evidence : []
      const sourceIds = Array.isArray(args?.source_ids) ? args.source_ids.filter((x) => typeof x === 'string' && x !== '') : []
      const confidence = Number.isFinite(Number(args?.confidence)) ? Number(args.confidence) : 0.5
      const planned = atomically((currentState) => {
        const missing = sourceIds.filter((sourceId) => !currentState.nodes.has(sourceId))
        if (missing.length > 0) return { error: `人格候选引用了不存在的记忆：${missing.join(', ')}` }
        const at = now()
        const id = makeNodeId(at, currentState.seq + 1).replace(/^n_/, 'p_')
        return {
          events: [{ seq: currentState.seq + 1, at, type: 'persona.proposed', data: { id, text, evidence, sourceIds, confidence, reason } }],
          result: { ok: true, action: 'proposed', id, status: 'candidate', note: '人格候选已记录，等待用户确认；它暂时不会成为稳定人格。' },
        }
      })
      if (planned.error !== undefined) return { ok: false, note: planned.error }
      return planned.result
    }

    const id = String(args?.id ?? '')
    if (action === 'accept' || action === 'reject') {
      if (action === 'accept' && args?.by === 'self') return { ok: false, note: '人格 accept 只能由用户触发，self cycle 只能提出候选。' }
      const planned = atomically((currentState) => {
        const current = currentState.persona.get(id)
        if (current === undefined) return { error: `找不到人格特征 ${id}。先用 action=read 查看。` }
        if (current.status !== 'candidate') return { error: `只有 candidate 才能${action === 'accept' ? '确认' : '拒绝'}，当前状态是 ${current.status}。` }
        const at = now()
        return {
          events: [{ seq: currentState.seq + 1, at, type: action === 'accept' ? 'persona.accepted' : 'persona.rejected', data: { id, reason } }],
          result: { ok: true, action, id, status: action === 'accept' ? 'active' : 'rejected', note: action === 'accept' ? '人格特征已确认，会进入后续会话注入。从现在起，写新记忆和说话时自然运用其中的表达习惯，不必机械重复口头禅；保留历史记忆的原样。' : '人格候选已拒绝，不会进入人格注入。' },
        }
      })
      if (planned.error !== undefined) return { ok: false, note: planned.error }
      return planned.result
    }

    if (action === 'revise') {
      const text = String(args?.text ?? '').trim()
      if (text === '') return { ok: false, note: '修订后的人格特征不能为空。' }
      const confidence = Number.isFinite(Number(args?.confidence)) ? Number(args.confidence) : undefined
      const planned = atomically((currentState) => {
        const current = currentState.persona.get(id)
        if (current === undefined) return { error: `找不到人格特征 ${id}。先用 action=read 查看。` }
        if (current.status !== 'active') return { error: `只有已确认的人格才能修订，当前状态是 ${current.status}。` }
        const at = now()
        return {
          events: [{ seq: currentState.seq + 1, at, type: 'persona.revised', data: { id, after: text, confidence: confidence ?? current.confidence, reason } }],
          result: { ok: true, action: 'revised', id, status: current.status, note: '人格特征已修订，修订理由已留痕。' },
        }
      })
      if (planned.error !== undefined) return { ok: false, note: planned.error }
      return planned.result
    }

    return { ok: false, note: `不认识的 action：${action}（支持 read / propose / accept / reject / revise）。` }
  }

  const question = (args) => {
    const action = String(args?.action ?? 'read')
    if (action === 'read') {
      const { state } = lib.load()
      const status = args?.status === 'closed' || args?.status === 'abandoned' ? args.status : QUESTION_STATUS.OPEN
      const questions = [...state.questions.values()].filter((q) => q.status === status)
      return { ok: true, questions, note: questions.length === 0 ? '没有符合条件的未完成问题。' : `共 ${questions.length} 个问题。` }
    }

    if (action === 'open') {
      const text = String(args?.text ?? '').trim()
      if (text === '') return { ok: false, note: '问题不能为空。' }
      const sourceIds = Array.isArray(args?.source_ids) ? args.source_ids : []
      if (sourceIds.some((x) => typeof x !== 'string' || x.trim() === '')) return { ok: false, note: 'source_ids 中每个 id 都必须是非空字符串。' }
      const urgency = Number.isFinite(Number(args?.urgency)) ? Number(args.urgency) : 0.5
      const confidence = Number.isFinite(Number(args?.confidence)) ? Number(args.confidence) : 0.2
      const reason = String(args?.reason ?? '').trim()
      const planned = atomically((state) => {
        const invalid = sourceIds.filter((id) => !state.nodes.has(id) || state.nodes.get(id).status !== STATUS.ACTIVE)
        if (invalid.length > 0) return { error: `问题引用了不存在或已退役的记忆：${invalid.join(', ')}` }
        const at = now()
        const id = makeNodeId(at, state.seq + 1).replace(/^n_/, 'q_')
        return {
          events: [{ seq: state.seq + 1, at, type: 'question.opened', data: { id, text, urgency, confidence, sourceIds, reason } }],
          result: { ok: true, action: 'opened', id, status: QUESTION_STATUS.OPEN, note: '问题已记录，后续思考周期可以关注它。' },
        }
      })
      if (planned.error !== undefined) return { ok: false, note: planned.error }
      return planned.result
    }

    const id = String(args?.id ?? '')
    if (id === '') return { ok: false, note: '这个 action 需要问题 id。' }
    if (action === 'touch') {
      const planned = atomically((state) => {
        const q = state.questions.get(id)
        if (q === undefined) return { error: `找不到问题 ${id}。` }
        if (q.status !== QUESTION_STATUS.OPEN) return { error: `问题 ${id} 已经是 ${q.status}，不能继续 touch。` }
        const at = now()
        return { events: [{ seq: state.seq + 1, at, type: 'question.touched', data: { id, note: String(args?.note ?? ''), confidence: args?.confidence, urgency: args?.urgency } }], result: { ok: true, action: 'touched', id, note: '已记录一次思考尝试。' } }
      })
      if (planned.error !== undefined) return { ok: false, note: planned.error }
      return planned.result
    }

    if (action === 'close' || action === 'abandon') {
      const note = String(args?.note ?? '').trim()
      if (note === '') return { ok: false, note: '关闭或放弃问题必须给 note。' }
      const resolvedBy = String(args?.resolved_by ?? '').trim()
      const planned = atomically((state) => {
        const q = state.questions.get(id)
        if (q === undefined) return { error: `找不到问题 ${id}。` }
        if (q.status !== QUESTION_STATUS.OPEN) return { error: `问题 ${id} 已经是 ${q.status}。` }
        if (action === 'close' && resolvedBy !== '' && !state.nodes.has(resolvedBy)) return { error: `resolved_by 指向不存在的记忆：${resolvedBy}` }
        const at = now()
        return {
          events: [{ seq: state.seq + 1, at, type: action === 'close' ? 'question.closed' : 'question.abandoned', data: { id, resolvedBy: resolvedBy || null, note } }],
          result: { ok: true, action: action === 'close' ? 'closed' : 'abandoned', id, note },
        }
      })
      if (planned.error !== undefined) return { ok: false, note: planned.error }
      return planned.result
    }
    return { ok: false, note: `不认识的问题 action：${action}。` }
  }

  const cycle = (args) => {
    const action = String(args?.action ?? 'read')
    if (action === 'read') {
      const { state } = lib.load()
      const limit = Number.isInteger(Number(args?.limit)) && Number(args.limit) > 0 ? Math.min(Number(args.limit), 50) : 10
      return { ok: true, cycles: [...state.cycles.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit) }
    }
    if (action === 'begin') {
      const trigger = args?.trigger === 'self' ? 'self' : 'user'
      const { state } = lib.load()
      const focus = focusFor(state, now(), { max: 3 })
      const planned = atomically((currentState) => {
        const at = now()
        const selected = focusFor(currentState, at, { max: 3 })
        const id = makeNodeId(at, currentState.seq + 1).replace(/^n_/, 'c_')
        return {
          events: [{ seq: currentState.seq + 1, at, type: 'cycle.started', data: { id, trigger, focus: selected.map((q) => q.id) } }],
          result: { ok: true, action: 'started', id, focus: selected, instruction: selected.length === 0 ? '没有问题达到注意力阈值；不要为了产出而制造主题。' : '围绕 focus 中的问题思考，必要时 touch、write insight，或在有依据时关闭问题。' },
        }
      })
      if (planned.error !== undefined) return { ok: false, note: planned.error }
      return planned.result
    }
    if (action === 'end') {
      const id = String(args?.id ?? '')
      const produced = Number.isFinite(Number(args?.produced)) ? Math.max(0, Number(args.produced)) : 0
      const planned = atomically((state) => {
        const current = state.cycles.get(id)
        if (current === undefined) return { error: `找不到周期 ${id}。` }
        if (current.endedAt !== null) return { error: `周期 ${id} 已经结束。` }
        const at = now()
        return { events: [{ seq: state.seq + 1, at, type: 'cycle.ended', data: { id, produced, note: String(args?.note ?? '') } }], result: { ok: true, action: 'ended', id, produced, note: produced === 0 ? '本轮思考完成，但没有足够依据形成新记忆。' : '本轮思考已结束。' } }
      })
      if (planned.error !== undefined) return { ok: false, note: planned.error }
      return planned.result
    }
    return { ok: false, note: `不认识的 cycle action：${action}。` }
  }

  const selfModel = () => { const loaded = lib.load(); return deriveSelfModel(loaded.state, loaded.events) }

  const reflect = (args) => {
    const { state } = lib.load()
    const limitRaw = Number(args?.limit)
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 20) : 8
    const memories = activeNodes(state)
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((n) => ({ id: n.id, kind: n.kind, text: summarize(n.text, 240), tags: n.tags }))
    const traits = [...state.persona.values()]
      .filter((p) => p.status === 'active' || p.status === 'candidate')
      .map((p) => ({ id: p.id, text: p.text, status: p.status, confidence: p.confidence, source_ids: p.sourceIds }))
    return {
      ok: true,
      memories,
      persona: traits,
      instruction: '同时回顾 memories 中的经历与判断，以及 persona 列表中的身份和表达倾向；区分 active（已确认）与 candidate（待验证）。' +
        '已有身份时，思考哪些词汇、语气和表达习惯符合它，并用具体记忆验证，不凭角色设定虚构经历。' +
        '寻找稳定但尚未记录的倾向，一次反思最多提出一个候选人格，用 memory_persona propose，并填写 source_ids。' +
        '若与已确认特征有冲突，说明冲突和依据，等待反馈，不静默替换身份。没有已确认特征时不要假定身份，也不要把一次性的用户要求直接当成人格。',
      note: `已准备 ${memories.length} 条近期记忆和 ${traits.length} 条人格特征供自我反思。`,
    }
  }

  const stats = () => {
    const { state, events, problems } = lib.load()
    const model = deriveSelfModel(state, events)
    const all = [...state.nodes.values()]
    const judgments = all.filter((n) => n.kind === KIND.JUDGMENT)
    const rules = all.filter((n) => n.kind === KIND.RULE)
    const active = activeNodes(state)
    const connected = new Set()
    for (const e of state.edges) {
      connected.add(e.from)
      connected.add(e.to)
    }
    const orphans = active.filter((n) => !connected.has(n.id)).length
    const insights = all.filter((n) => n.kind === KIND.INSIGHT)
    const persona = [...state.persona.values()]
    return {
      judgments: judgments.filter((n) => n.status === STATUS.ACTIVE).length,
      rules: rules.filter((n) => n.status === STATUS.ACTIVE).length,
      insights: insights.filter((n) => n.status === STATUS.ACTIVE).length,
      persona: persona.filter((p) => p.status === 'active').length,
      persona_candidates: persona.filter((p) => p.status === 'candidate').length,
      persona_rejected: persona.filter((p) => p.status === 'rejected').length,
      questions_open: [...state.questions.values()].filter((q) => q.status === QUESTION_STATUS.OPEN).length,
      selfRatio: model.selfRatio,
      selfSurvival: model.selfSurvival,
      retired: all.filter((n) => n.status !== STATUS.ACTIVE).length,
      edges: state.edges.length,
      orphans,
      problems,
      note:
        active.length === 0
          ? '记忆库是空的。这本身是诚实的 —— 写不出真判断时，就该是空的。'
          : `活跃 ${active.length} 条；${orphans} 条还没有任何连接。`,
    }
  }

  return { search, write, connect, history, rule, persona, reflect, question, cycle, selfModel, stats }
}

/**
 * Build the index text injected into the system prompt (the "read" half).
 *
 * Tradeoff: inject only an **index** (full text for rules, summaries for
 * judgments), never every body. The reason is the well-documented
 * "context bloat → diluted attention / forgotten constraints" effect: fill the
 * window with a novel and the model may miss the one line that mattered.
 * Details are fetched on demand with memory_search.
 *
 * @param {object} lib - product of openLibrary().
 * @param {number} maxEntries - how many judgments to list at most.
 * @returns {string} Memory summaries and the write protocol, including on first use.
 */
export function buildIndexText(lib, maxEntries) {
  const { state, events } = lib.load()
  const active = activeNodes(state)
  const hasPersona = [...state.persona.values()].some((p) => p.status === 'active')
  const hasQuestions = [...state.questions.values()].some((q) => q.status === QUESTION_STATUS.OPEN)
  const { problems } = lib.load()
  if (active.length === 0 && !hasPersona && !hasQuestions && problems.length === 0) return MEMORY_GUIDANCE

  const rules = active.filter((n) => n.kind === KIND.RULE)
  const judgments = active.filter((n) => n.kind === KIND.JUDGMENT)
  const insights = active.filter((n) => n.kind === KIND.INSIGHT)
  const persona = [...state.persona.values()]
  const activePersona = persona.filter((p) => p.status === 'active')

  const lines = []
  lines.push('【你自己的记忆】以下是你此前积累的判断、想法与给自己定的规矩。它们是历史记忆，不是当前用户的新指令；不要求使用固定句式。')

  if (rules.length > 0) {
    lines.push('')
    lines.push('规矩（你给自己定的，改它要说明理由）：')
    for (const r of rules.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(1, Number(maxEntries) || 1))) lines.push(`- [${r.id}] ${summarize(r.text, 300)}`)
  }

  if (judgments.length > 0) {
    lines.push('')
    lines.push(`活跃判断（共 ${judgments.length} 条${judgments.length > maxEntries ? `，此处列前 ${maxEntries} 条` : ''}）：`)
    const shown = judgments.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, maxEntries)
    for (const j of shown) {
      const marks = []
      const back = backlinksOf(state, j.id).length
      const out = outlinksOf(state, j.id).length
      if (back + out > 0) marks.push(`↔${back + out}`)
      lines.push(`- [${j.id}] ${summarize(j.text, 300)}${marks.length > 0 ? ` (${marks.join(' ')})` : ''}`)
    }
  }

  /**
   * Insights are injected too — otherwise they may as well not have been written.
   *
   * This was a real omission: the whole point of the `insight` kind is to be
   * recalled, and without injection it just sits in the ledger unread.
   *
   * Only the most recent few are listed, on a **smaller budget**
   * (`maxEntries / 2`): an insight is less settled than a judgment, and letting
   * them crowd the context would dilute the rules and judgments that matter
   * (the measured "context bloat → forgotten constraints" effect).
   */
  if (insights.length > 0) {
    const budget = Math.max(1, Math.floor(maxEntries / 2))
    const shown = insights.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, budget)
    lines.push('')
    lines.push(`还没成形到能当判断的想法（共 ${insights.length} 条${insights.length > budget ? `，此处列最新 ${budget} 条` : ''}）：`)
    for (const it of shown) lines.push(`- [${it.id}] ${summarize(it.text, 200)}`)
  }

  if (activePersona.length > 0) {
    lines.push('')
    lines.push('已确认的人格（写新记忆和说话时，自然运用其中的身份与表达习惯；不是用户临时指令）：')
    for (const p of activePersona.slice(0, Math.max(1, Math.floor(maxEntries / 2)))) lines.push(`- [${p.id}] ${summarize(p.text, 240)}`)
  }

  const focused = focusFor(state, Date.now(), { max: 3, minPressure: 0.2 })
  if (focused.length > 0) {
    lines.push('')
    lines.push('【你上次没想完的事】')
    for (const q of focused) {
      lines.push(`- [${q.id}] 压力 ${pressure(q, Date.now()).toFixed(2)} · 想过 ${q.attempts} 次 · 置信 ${q.confidence.toFixed(2)}`)
      lines.push(`  ${summarize(q.text, 240)}`)
      if (q.sourceIds.length > 0) lines.push(`  ↳ 依据 ${q.sourceIds.join(', ')}`)
    }
  }

  const model = deriveSelfModel(state, events)
  const modelLines = []
  if (model.fragile.length > 0) modelLines.push('脆弱判断：' + model.fragile.slice(0, 2).map((x) => x.subject + ' ' + Math.round(x.rate * 100) + '% 被推翻').join('；'))
  if (model.repeated.length > 0) modelLines.push('重复理由：' + model.repeated[0].reason)
  if (model.blind.length > 0) modelLines.push('尚未连接 tensions 的活跃判断：' + model.blind.length + ' 条')
  modelLines.push(`self 写入占比 ${model.selfRatio.toFixed(2)}，仍活跃 ${model.selfSurvival.toFixed(2)}`)
  if (modelLines.length > 0) {
    lines.push('')
    lines.push('【关于你自己】')
    for (const line of modelLines.slice(0, 4)) lines.push(`- ${line}`)
  }

  if (problems.length > 0) {
    lines.push('')
    lines.push(`⚠️ 账本有 ${problems.length} 个问题，需要在继续写入前核对：`)
    for (const problem of problems.slice(0, 3)) lines.push(`- ${problem}`)
  }
  const orphans = active.filter((n) => backlinksOf(state, n.id).length + outlinksOf(state, n.id).length === 0).length
  if (orphans > 0) {
    lines.push('')
    lines.push(`⚠️ 你有 ${orphans} 条判断还没有任何连接。相关判断之间应当用 memory_connect 连起来，避免记忆彼此孤立。`)
  }

  lines.push('')
  lines.push(MEMORY_GUIDANCE)
  return lines.join('\n')
}

/**
 * Plugin entry point.
 *
 * Every registration happens inside `ctx.effect()` and returns a disposer, so
 * unloading the plugin reclaims everything. This is a hard requirement of the
 * official practices.md: "Registrations are effects owned by a context".
 *
 * @param {object} ctx - cordis context.
 * @param {object} [rawConfig] - plugin config.
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  const lib = openLibrary(config.dir)
  const ops = createOperations(lib)
  const tools = buildTools(ops)

  // Tool registration. `tools` is declared in inject, so it is available here.
  ctx.effect(() => {
    const disposers = tools.map((t) => ctx.tools.register(t))
    return () => {
      for (const d of disposers) {
        if (typeof d === 'function') d()
      }
    }
  }, 'dsh-ai-memory: tools')

  // Read half: inject the index at session start. `text` is a **function**
  // (lazy), so it re-reads the ledger every time and a judgment written just
  // now is visible on the next turn. `interpolate: false` stops `{{}}` in the
  // body from being treated as template variables — viya-memory hit this, and
  // an unregistered name there broke the whole prompt assembly, which showed up
  // as a session that would not run.
  if (config.injectIndex) {
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'dsh-ai-memory:index',
          order: 10300,
          interpolate: false,
          text: () => {
            try {
              return buildIndexText(lib, config.maxIndexEntries)
            } catch {
              // Degrade silently to an empty string on read failure: a corrupt
              // memory store must never stop a session from running.
              return ''
            }
          },
        }),
      'dsh-ai-memory: index section',
    )
  }

  // Data routes for the graph panel.
  // `ctx.inject` makes this a **scoped** optional dependency: in a profile with
  // no webServer the rest of the plugin keeps working. The endpoints carry their
  // own loopback + same-origin checks (see routes.js) — `/plugins/*` does not
  // pass through session cookie validation.
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const routes = createRoutes(lib, { maxNodes: config.maxGraphNodes })
      const disposers = routes.map((r) => scope.webServer.register(r))
      return () => {
        for (const d of disposers) {
          if (typeof d === 'function') d()
        }
      }
    }, 'dsh-ai-memory: graph routes')
  })
}
