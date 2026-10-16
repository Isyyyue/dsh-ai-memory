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
import { homedir } from 'node:os'

import { foldEvents, foldAsOf, activeNodes, nodeOf, backlinksOf, outlinksOf, supersedeChain, KIND, STATUS } from './ledger.js'
import { planWrite, makeNodeId } from './supersede.js'
import { readLedger, appendEvents } from './store.js'
import { search as searchNodes, summarize } from './query.js'
import { buildTools } from './tools.js'
import { createRoutes } from './routes.js'

export const name = 'dsh-ai-memory'

// Keep the write protocol available even before the first memory is created.
const MEMORY_GUIDANCE = '【写判断的义务】本轮结束前，如果你做了下面任何一件事，必须调用 memory_write 记一条：' +
  '① 改变了主意（有东西被取代）；② 被用户纠正；③ 踩到一个坑并搞清了原因；' +
  '④ 形成了一条会影响你下次做法的结论；⑤ 发现自己的工具、文档或流程有错（包括注释）。' +
  '自检标准只有一个：删掉这条，你下次的行为会变吗？会，就该写。' +
  '发现事实有误与记录一条事实是两回事：应记录错误带来的判断和做法变化，而不是错误本身的流水账。' +
  '例如：自检脚本的预期注释不能代替实际验证，下次应核对断言与运行结果。' +
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
    const { state } = lib.load()
    const at = now()
    const newId = makeNodeId(at, state.seq + 1)
    const { events, outcome } = planWrite(
      state,
      {
        text,
        subject: args?.subject,
        relation: args?.relation,
        object: args?.object,
        // Three node kinds: judgment (default) / rule (governed) / insight (not superseded).
        kind: args?.kind === KIND.RULE ? KIND.RULE
          : args?.kind === KIND.INSIGHT ? KIND.INSIGHT
            : KIND.JUDGMENT,
        tags: Array.isArray(args?.tags) ? args.tags : [],
        citations: Array.isArray(args?.citations) ? args.citations : [],
        reason: args?.reason,
      },
      { at, nextSeq: state.seq, newId },
    )
    if (events.length > 0) {
      const res = lib.commit(events)
      if (!res.ok) return { action: 'failed', note: `写盘失败：${res.reason}` }
    }

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
    const type = String(args?.type ?? 'complements')
    if (from === '' || to === '') return { ok: false, note: 'from 与 to 都必填。' }
    if (from === to) return { ok: false, note: '不能自连。' }
    const { state } = lib.load()
    if (!state.nodes.has(from)) return { ok: false, note: `找不到判断 ${from}。先 memory_search 确认 id。` }
    if (!state.nodes.has(to)) return { ok: false, note: `找不到判断 ${to}。先 memory_search 确认 id。` }
    const at = now()
    const res = lib.commit([{ seq: state.seq + 1, at, type: 'edge.linked', data: { from, to, type, note: String(args?.note ?? '') } }])
    if (!res.ok) return { ok: false, note: `写盘失败：${res.reason}` }
    return { ok: true, note: `已在 ${from} 与 ${to} 之间建立 ${type} 关系（两边都会看到，不留单向边）。` }
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
      // Governance: changing a rule requires a reason. A change without one is
      // refused — that is the precondition for "auditable".
      if (reason === '') return { ok: false, note: '改规矩必须给 reason（这条纪律是刻意的：没有理由的变更无法审计）。' }
      if (text === '') return { ok: false, note: '新规矩不能为空。' }

      if (!state.nodes.has(id)) {
        // A missing rule is created, and the reason is recorded as its rationale.
        const at = now()
        const newId = makeNodeId(at, state.seq + 1)
        const res = lib.commit([
          { seq: state.seq + 1, at, type: 'node.created', data: { id: newId, kind: KIND.RULE, text } },
        ])
        if (!res.ok) return { ok: false, note: `写盘失败：${res.reason}` }
        return { ok: true, rules: [{ id: newId, text, revision: 1, history: [] }], note: `新规矩已建立（${newId}）。理由：${reason}` }
      }

      if (state.nodes.get(id).kind !== KIND.RULE) return { ok: false, note: `${id} 不是规矩，不能通过 memory_rule 修改。` }
      const at = now()
      const res = lib.commit([{ seq: state.seq + 1, at, type: 'rule.amended', data: { id, after: text, reason } }])
      if (!res.ok) return { ok: false, note: `写盘失败：${res.reason}` }
      const after = lib.load()
      const n = nodeOf(after.state, id)
      return {
        ok: true,
        rules: [{ id, text: n.text, revision: n.revision, history: n.history.map((h) => `${new Date(h.at).toISOString()} · ${h.reason}`) }],
        note: `规矩已改（第 ${n.revision} 版）。理由已留痕。`,
      }
    }

    if (action === 'rollback') {
      // Rollback restores a rule to its **Nth revision** (N is 1-based and maps
      // to history[N-1]). It restores rather than deleting events: the ledger is
      // append-only and history is never erased. A rollback is itself a new
      // change, so it also needs a reason and also enters history — which keeps
      // the act of rolling back auditable instead of wiping the past.
      const id = String(args?.id ?? '')
      const toRevision = Number(args?.to_revision)
      const reason = String(args?.reason ?? '').trim()
      if (reason === '') return { ok: false, note: '回滚也要给 reason（回滚同样是一次变更，同样要能审计）。' }
      if (!Number.isInteger(toRevision) || toRevision < 1) {
        return { ok: false, note: 'rollback 需要 to_revision（正整数，从 1 开始，对应 memory_rule read 里 history 的序号）。' }
      }
      const target = nodeOf(state, id)
      if (target === undefined) return { ok: false, note: `找不到规矩 ${id}。` }
      if (target.kind !== KIND.RULE) return { ok: false, note: `${id} 不是规矩（kind=${target.kind}），规矩治理只管 kind=rule 的节点。` }
      const entry = target.history[toRevision - 1]
      if (entry === undefined) {
        return {
          ok: false,
          note: `规矩 ${id} 只有 ${target.history.length} 版，没有第 ${toRevision} 版。先用 action=read 看 history。`,
        }
      }
      if (toRevision === target.revision) {
        return { ok: false, note: `规矩 ${id} 现在就是第 ${toRevision} 版，无需回滚。` }
      }

      const at = now()
      const res = lib.commit([
        {
          seq: state.seq + 1,
          at,
          type: 'rule.amended',
          data: { id, after: entry.text, reason: `回滚到第 ${toRevision} 版：${reason}` },
        },
      ])
      if (!res.ok) return { ok: false, note: `写盘失败：${res.reason}` }
      const after = lib.load()
      const n = nodeOf(after.state, id)
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
    if (action === 'propose') {
      const text = String(args?.text ?? '').trim()
      if (text === '') return { ok: false, note: '人格候选不能为空。' }
      const id = makeNodeId(now(), state.seq + 1).replace(/^n_/, 'p_')
      const evidence = Array.isArray(args?.evidence) ? args.evidence : []
      const sourceIds = Array.isArray(args?.source_ids) ? args.source_ids.filter((x) => typeof x === 'string' && x !== '') : []
      const missing = sourceIds.filter((sourceId) => !state.nodes.has(sourceId))
      if (missing.length > 0) return { ok: false, note: `人格候选引用了不存在的记忆：${missing.join(', ')}` }
      const confidence = Number.isFinite(Number(args?.confidence)) ? Number(args.confidence) : 0.5
      const res = lib.commit([{ seq: state.seq + 1, at: now(), type: 'persona.proposed', data: { id, text, evidence, sourceIds, confidence, reason } }])
      if (!res.ok) return { ok: false, note: `写盘失败：${res.reason}` }
      return { ok: true, action: 'proposed', id, status: 'candidate', note: '人格候选已记录，等待用户确认；它暂时不会成为稳定人格。' }
    }

    const id = String(args?.id ?? '')
    const current = state.persona.get(id)
    if (current === undefined) return { ok: false, note: `找不到人格特征 ${id}。先用 action=read 查看。` }
    if (reason === '') return { ok: false, note: `${action} 必须给 reason，确保人格变化可审计。` }

    if (action === 'accept' || action === 'reject') {
      if (action === 'accept' && current.status !== 'candidate') return { ok: false, note: `只有 candidate 才能确认，当前状态是 ${current.status}。` }
      if (action === 'reject' && current.status !== 'candidate') return { ok: false, note: `只有 candidate 才能拒绝，当前状态是 ${current.status}。` }
      const res = lib.commit([{ seq: state.seq + 1, at: now(), type: action === 'accept' ? 'persona.accepted' : 'persona.rejected', data: { id, reason } }])
      if (!res.ok) return { ok: false, note: `写盘失败：${res.reason}` }
      return { ok: true, action, id, status: action === 'accept' ? 'active' : 'rejected', note: action === 'accept' ? '人格特征已确认，会进入后续会话注入。' : '人格候选已拒绝，不会进入人格注入。' }
    }

    if (action === 'revise') {
      if (current.status !== 'active') return { ok: false, note: `只有已确认的人格才能修订，当前状态是 ${current.status}。` }
      const text = String(args?.text ?? '').trim()
      if (text === '') return { ok: false, note: '修订后的人格特征不能为空。' }
      const confidence = Number.isFinite(Number(args?.confidence)) ? Number(args.confidence) : current.confidence
      const res = lib.commit([{ seq: state.seq + 1, at: now(), type: 'persona.revised', data: { id, after: text, confidence, reason } }])
      if (!res.ok) return { ok: false, note: `写盘失败：${res.reason}` }
      return { ok: true, action: 'revised', id, status: current.status, note: '人格特征已修订，修订理由已留痕。' }
    }

    return { ok: false, note: `不认识的 action：${action}（支持 read / propose / accept / reject / revise）。` }
  }

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
      instruction: '回顾这些属于你的记忆，寻找稳定但尚未记录的表达倾向；一次反思最多提出一个候选人格，用 memory_persona propose，并填写 source_ids。不要把一次性的用户要求直接当成人格。',
      note: `已准备 ${memories.length} 条近期记忆和 ${traits.length} 条人格特征供自我反思。`,
    }
  }

  const stats = () => {
    const { state, problems } = lib.load()
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

  return { search, write, connect, history, rule, persona, reflect, stats }
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
  const { state } = lib.load()
  const active = activeNodes(state)
  const hasPersona = [...state.persona.values()].some((p) => p.status === 'active')
  if (active.length === 0 && !hasPersona) return MEMORY_GUIDANCE

  const rules = active.filter((n) => n.kind === KIND.RULE)
  const judgments = active.filter((n) => n.kind === KIND.JUDGMENT)
  const insights = active.filter((n) => n.kind === KIND.INSIGHT)
  const persona = [...state.persona.values()]
  const activePersona = persona.filter((p) => p.status === 'active')

  const lines = []
  lines.push('【你自己的记忆】以下是你此前形成的判断与给自己定的规矩。它们**是你自己的观点**，不是用户说的话。')

  if (rules.length > 0) {
    lines.push('')
    lines.push('规矩（你给自己定的，改它要说明理由）：')
    for (const r of rules) lines.push(`- [${r.id}] ${summarize(r.text, 300)}`)
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
    lines.push('已确认的人格（这是你逐渐形成的表达倾向，不是用户临时指令）：')
    for (const p of activePersona.slice(0, Math.max(1, Math.floor(maxEntries / 2)))) lines.push(`- [${p.id}] ${summarize(p.text, 240)}`)
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
