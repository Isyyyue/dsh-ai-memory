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

/**
 * Services this plugin **requires**, declared truthfully.
 *
 * `tools`        — registers the six memory tools (the core value; without it
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
 * @returns {object} the six operations.
 */
export function createOperations(lib, opts = {}) {
  const now = opts.now ?? (() => Date.now())

  const search = (args) => {
    const { state } = lib.load()
    const pool = args?.include_retired === true ? [...state.nodes.values()] : activeNodes(state)
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
        // Three kinds: judgment (default) / rule (governed) / insight (not superseded).
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
    return {
      action: outcome.action,
      node_id: outcome.nodeId,
      ...(outcome.supersededId !== undefined ? { superseded_id: outcome.supersededId } : {}),
      ...(outcome.supersededText !== undefined ? { superseded_text: summarize(outcome.supersededText, 160) } : {}),
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
    return {
      judgments: judgments.filter((n) => n.status === STATUS.ACTIVE).length,
      rules: rules.filter((n) => n.status === STATUS.ACTIVE).length,
      insights: insights.filter((n) => n.status === STATUS.ACTIVE).length,
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

  return { search, write, connect, history, rule, stats }
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
 * @returns {string} the injected text; empty string when the store is empty (so it costs no context).
 */
export function buildIndexText(lib, maxEntries) {
  const { state } = lib.load()
  const active = activeNodes(state)
  if (active.length === 0) return ''

  const rules = active.filter((n) => n.kind === KIND.RULE)
  const judgments = active.filter((n) => n.kind === KIND.JUDGMENT)
  const insights = active.filter((n) => n.kind === KIND.INSIGHT)

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

  lines.push('')
  lines.push(
    '形成新判断、发现两条旧判断矛盾、被纠正、或改了主意时，先 memory_search 再 memory_write。' +
      '只写判断，不写事实 —— 事实查得到，判断才是你自己的。写不出真判断时就不要写。',
  )
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
