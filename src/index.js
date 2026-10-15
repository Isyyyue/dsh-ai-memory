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
    if (text === '') return { action: 'rejected', note: 'A judgment cannot be empty.' }
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
      if (!res.ok) return { action: 'failed', note: `write to disk failed: ${res.reason}` }
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
    if (from === '' || to === '') return { ok: false, note: 'Both `from` and `to` are required.' }
    if (from === to) return { ok: false, note: 'A judgment cannot be linked to itself.' }
    const { state } = lib.load()
    if (!state.nodes.has(from)) return { ok: false, note: `No judgment ${from}. Use memory_search to confirm the id.` }
    if (!state.nodes.has(to)) return { ok: false, note: `No judgment ${to}. Use memory_search to confirm the id.` }
    const at = now()
    const res = lib.commit([{ seq: state.seq + 1, at, type: 'edge.linked', data: { from, to, type, note: String(args?.note ?? '') } }])
    if (!res.ok) return { ok: false, note: `write to disk failed: ${res.reason}` }
    return { ok: true, note: `Linked ${from} and ${to} as ${type} (both sides see it; no one-way edges).` }
  }

  const history = (args) => {
    const id = String(args?.id ?? '')
    const { events, state } = lib.load()
    const n = nodeOf(state, id)
    if (n === undefined) return { found: false, note: `No judgment ${id}.` }

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
        return { found: false, note: `At ${when} this judgment did not exist yet (it was created ${new Date(n.createdAt).toISOString()}).` }
      }
      return {
        found: true,
        revisions: before.history.map((h) => ({ at: h.at, text: summarize(h.text, 200), reason: h.reason })),
        chain: supersedeChain(then, id).chain.map((c) => ({ id: c.id, text: summarize(c.text, 160), status: c.status })),
        note: `At ${when}: status ${before.status}, revision ${before.revision}.`,
      }
    }

    const { chain } = supersedeChain(state, id)
    return {
      found: true,
      revisions: n.history.map((h) => ({ at: h.at, text: summarize(h.text, 200), reason: h.reason })),
      chain: chain.map((c) => ({ id: c.id, text: summarize(c.text, 160), status: c.status })),
      note: `${n.history.length} change(s); supersession chain length ${chain.length}.`,
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
        note: rules.length === 0 ? 'No rules yet.' : `${rules.length} rule(s).`,
      }
    }

    if (action === 'amend') {
      const id = String(args?.id ?? '')
      const text = String(args?.text ?? '').trim()
      const reason = String(args?.reason ?? '').trim()
      // Governance: changing a rule requires a reason. A change without one is
      // refused — that is the precondition for "auditable".
      if (reason === '') return { ok: false, note: 'Amending a rule requires a reason (deliberate: a change with no stated reason cannot be audited).' }
      if (text === '') return { ok: false, note: 'The new rule cannot be empty.' }

      if (!state.nodes.has(id)) {
        // A missing rule is created, and the reason is recorded as its rationale.
        const at = now()
        const newId = makeNodeId(at, state.seq + 1)
        const res = lib.commit([
          { seq: state.seq + 1, at, type: 'node.created', data: { id: newId, kind: KIND.RULE, text } },
        ])
        if (!res.ok) return { ok: false, note: `write to disk failed: ${res.reason}` }
        return { ok: true, rules: [{ id: newId, text, revision: 1, history: [] }], note: `Rule created (${newId}). Reason: ${reason}` }
      }

      const at = now()
      const res = lib.commit([{ seq: state.seq + 1, at, type: 'rule.amended', data: { id, after: text, reason } }])
      if (!res.ok) return { ok: false, note: `write to disk failed: ${res.reason}` }
      const after = lib.load()
      const n = nodeOf(after.state, id)
      return {
        ok: true,
        rules: [{ id, text: n.text, revision: n.revision, history: n.history.map((h) => `${new Date(h.at).toISOString()} · ${h.reason}`) }],
        note: `Rule amended (revision ${n.revision}). The reason is on record.`,
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
      if (reason === '') return { ok: false, note: 'A rollback also requires a reason (it is a change too, and must be auditable).' }
      if (!Number.isInteger(toRevision) || toRevision < 1) {
        return { ok: false, note: 'rollback requires to_revision (a positive integer, 1-based, indexing the history from memory_rule read).' }
      }
      const target = nodeOf(state, id)
      if (target === undefined) return { ok: false, note: `No rule ${id}.` }
      if (target.kind !== KIND.RULE) return { ok: false, note: `${id} is not a rule (kind=${target.kind}); rule governance only covers kind=rule nodes.` }
      const entry = target.history[toRevision - 1]
      if (entry === undefined) {
        return {
          ok: false,
          note: `Rule ${id} has only ${target.history.length} revision(s); there is no revision ${toRevision}. Use action=read to see the history.`,
        }
      }
      if (toRevision === target.revision) {
        return { ok: false, note: `Rule ${id} is already at revision ${toRevision}; nothing to roll back.` }
      }

      const at = now()
      const res = lib.commit([
        {
          seq: state.seq + 1,
          at,
          type: 'rule.amended',
          data: { id, after: entry.text, reason: `rollback to revision ${toRevision}: ${reason}` },
        },
      ])
      if (!res.ok) return { ok: false, note: `write to disk failed: ${res.reason}` }
      const after = lib.load()
      const n = nodeOf(after.state, id)
      return {
        ok: true,
        rules: [{ id, text: n.text, revision: n.revision, history: n.history.map((h) => `${new Date(h.at).toISOString()} · ${h.reason}`) }],
        note: `Rolled back to revision ${toRevision} (now revision ${n.revision}). The rollback is on record too — history was not erased.`,
      }
    }

    return { ok: false, note: `Unknown action: ${action} (supported: read / amend / rollback).` }
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
          ? 'The memory store is empty. That is honest in itself — when no real judgment can be written, empty is correct.'
          : `${active.length} active; ${orphans} still unconnected.`,
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
  lines.push('## Your own memory')
  lines.push('')
  lines.push('These are judgments you formed earlier, plus the rules you set for yourself.')
  lines.push('They are **your own positions**, not statements the user made.')

  if (rules.length > 0) {
    lines.push('')
    lines.push('### Rules you set for yourself (changing one requires a reason)')
    for (const r of rules) lines.push(`- [${r.id}] ${summarize(r.text, 300)}`)
  }

  if (judgments.length > 0) {
    lines.push('')
    lines.push(`### Active judgments (${judgments.length} total${judgments.length > maxEntries ? `, first ${maxEntries} listed` : ''})`)
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
    lines.push(`### Ideas not yet settled into judgments (${insights.length} total${insights.length > budget ? `, newest ${budget} listed` : ''})`)
    for (const it of shown) lines.push(`- [${it.id}] ${summarize(it.text, 200)}`)
  }

  lines.push('')
  lines.push(
    'When you form a new judgment, notice two older judgments conflicting, get corrected, or change your mind: ' +
      'call memory_search first, then memory_write. ' +
      'Write judgments, not facts — facts can be looked up, only judgments are yours. ' +
      'If you cannot write a real judgment, do not write one.',
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
