/**
 * Append-only ledger: the single source of truth for memory.
 *
 * Why a ledger rather than a set of mutable card files:
 * - Judgments get superseded, and the supersession process is itself
 *   information. A mutable file shows only the result; the ledger shows
 *   "held this in March → overturned by that evidence in June → changed back
 *   in September".
 * - The ledger is plain-text JSONL: human-readable, git-diffable, deletable,
 *   hand-editable.
 * - The graph, backlinks and active set are all derived by folding. They can be
 *   rebuilt at any time and lose nothing when deleted, matching DSH's official
 *   position that the session log is the only source of truth and plugin memory
 *   is a derived cache.
 *
 * Pure functions only (no filesystem), so tests can feed event arrays directly.
 *
 * Event types (all append-only; historical lines are never modified):
 *   node.created      a judgment or rule is recorded
 *   node.revised      text changed (history kept, not a supersession)
 *   node.superseded   replaced by a newer judgment (bi-temporal: the old
 *                     valid_to is closed, never deleted)
 *   node.withdrawn    withdrawn after a self-detected error, with no successor
 *   edge.linked       bidirectional link created
 *   edge.unlinked     bidirectional link removed
 *   rule.amended      rule change (governed: carries a reason, rollback-able)
 *   persona.proposed  a candidate personality trait is observed
 *   persona.accepted  a candidate is confirmed as part of the personality
 *   persona.rejected  a candidate is explicitly declined
 *   persona.revised   a confirmed trait is refined with a reason
 */

/** Event types the ledger recognizes. Unknown types are recorded as a problem, never silently swallowed. */
export const EVENT_TYPES = Object.freeze([
  'node.created',
  'node.revised',
  'node.superseded',
  'node.withdrawn',
  'edge.linked',
  'edge.unlinked',
  'rule.amended',
  'persona.proposed',
  'persona.accepted',
  'persona.rejected',
  'persona.revised',
])

/** Node status. Only active nodes take part in search and injection. */
export const STATUS = Object.freeze({
  ACTIVE: 'active',
  SUPERSEDED: 'superseded',
  WITHDRAWN: 'withdrawn',
})

/**
 * Node kinds.
 *
 * - `judgment`  superseded when evidence overturns it (it evolves)
 * - `rule`      a constraint on itself; changes go through governance
 *               (auditable, rollback-able)
 * - `insight`   an idea or observation with no subject/relation/object triple.
 *               Its value is being remembered, not being held to account, so it
 *               takes no part in supersession. Without a key it cannot be
 *               stored as a judgment, and forcing a triple would make the
 *               model fabricate structure.
 *
 * Older ledgers contain only the first two kinds. New kinds are additive;
 * existing data still reads.
 */
export const KIND = Object.freeze({
  JUDGMENT: 'judgment',
  RULE: 'rule',
  INSIGHT: 'insight',
  PERSONA: 'persona',
})

/**
 * Create an empty state.
 * @returns {object} State object that applyEvent updates in place.
 */
export function createState() {
  return {
    seq: 0,
    nodes: new Map(),
    edges: [],
    persona: new Map(),
    problems: [],
  }
}

/**
 * Apply one event to the state in place.
 *
 * Deliberately pure, synchronous, IO-free and exception-free: a bad event is
 * recorded in problems rather than thrown, because one bad line must not make
 * the whole memory store unreadable — that would mean losing all memory.
 *
 * @param {object} state - Product of createState().
 * @param {object} ev - Ledger event `{ seq, at, type, data }`.
 * @returns {object} The same state (convenient for reduce).
 */
export function applyEvent(state, ev) {
  if (ev === null || typeof ev !== 'object') {
    state.problems.push({ at: 'fold', reason: '事件不是对象', raw: ev })
    return state
  }
  if (!EVENT_TYPES.includes(ev.type)) {
    state.problems.push({ at: 'fold', reason: `未知事件类型 ${String(ev.type)}`, seq: ev.seq })
    return state
  }
  const d = ev.data ?? {}
  const at = typeof ev.at === 'number' ? ev.at : 0

  switch (ev.type) {
    case 'node.created': {
      const id = typeof d.id === 'string' && d.id !== '' ? d.id : `n_${String(ev.seq ?? 0).padStart(4, '0')}`
      if (state.nodes.has(id)) {
        state.problems.push({ at: 'fold', reason: `节点 id 重复：${id}`, seq: ev.seq })
        break
      }
      state.nodes.set(id, {
        id,
        kind: d.kind === KIND.RULE || d.kind === KIND.INSIGHT ? d.kind : KIND.JUDGMENT,
        text: typeof d.text === 'string' ? d.text : '',
        // Triple used for deterministic supersession. If any component is missing, the node takes part in search only, never in supersession.
        subject: typeof d.subject === 'string' && d.subject !== '' ? d.subject : null,
        relation: typeof d.relation === 'string' && d.relation !== '' ? d.relation : null,
        object: typeof d.object === 'string' && d.object !== '' ? d.object : null,
        tags: Array.isArray(d.tags) ? d.tags.filter((t) => typeof t === 'string') : [],
        citations: Array.isArray(d.citations) ? d.citations.filter((c) => typeof c === 'string') : [],
        createdAt: at,
        // Bi-temporal ledger: validFrom/validTo say when the fact was true, createdAt says when the system learned it.
        validFrom: at,
        validTo: null,
        supersededBy: null,
        status: STATUS.ACTIVE,
        revision: 1,
        history: [{ at, text: typeof d.text === 'string' ? d.text : '', reason: '建立' }],
      })
      break
    }

    case 'node.revised': {
      const n = state.nodes.get(d.id)
      if (n === undefined) {
        state.problems.push({ at: 'fold', reason: `改文字指向不存在的节点：${String(d.id)}`, seq: ev.seq })
        break
      }
      const before = n.text
      n.text = typeof d.text === 'string' ? d.text : n.text
      if (typeof d.subject === 'string' && d.subject !== '') n.subject = d.subject
      if (typeof d.relation === 'string' && d.relation !== '') n.relation = d.relation
      if (typeof d.object === 'string' && d.object !== '') n.object = d.object
      n.revision += 1
      n.history.push({ at, text: n.text, before, reason: typeof d.reason === 'string' ? d.reason : '修订' })
      break
    }

    case 'node.superseded': {
      const old = state.nodes.get(d.id)
      const by = state.nodes.get(d.byId)
      if (old === undefined || by === undefined) {
        state.problems.push({
          at: 'fold',
          reason: `取代指向不存在的节点：${String(d.id)} → ${String(d.byId)}`,
          seq: ev.seq,
        })
        break
      }
      // Key: retired, never deleted. The old node stays in the ledger for as-of-time queries and provenance.
      old.status = STATUS.SUPERSEDED
      old.validTo = at
      old.supersededBy = by.id
      old.history.push({ at, text: old.text, reason: `被 ${by.id} 取代：${String(d.reason ?? '')}` })
      break
    }

    case 'node.withdrawn': {
      const n = state.nodes.get(d.id)
      if (n === undefined) {
        state.problems.push({ at: 'fold', reason: `撤回指向不存在的节点：${String(d.id)}`, seq: ev.seq })
        break
      }
      n.status = STATUS.WITHDRAWN
      n.validTo = at
      n.history.push({ at, text: n.text, reason: `撤回：${String(d.reason ?? '')}` })
      break
    }

    case 'edge.linked': {
      const from = state.nodes.get(d.from)
      const to = state.nodes.get(d.to)
      if (from === undefined || to === undefined) {
        state.problems.push({
          at: 'fold',
          reason: `双链指向不存在的节点：${String(d.from)} → ${String(d.to)}`,
          seq: ev.seq,
        })
        break
      }
      if (from.id === to.id) {
        state.problems.push({ at: 'fold', reason: '不允许自连', seq: ev.seq })
        break
      }
      // Dedup key = from + to + type, so one node pair can carry several relations (a complement and a tension can coexist).
      const key = `${from.id}\u0000${to.id}\u0000${String(d.type ?? 'related')}`
      if (state.edges.some((e) => `${e.from}\u0000${e.to}\u0000${e.type}` === key)) break
      state.edges.push({
        from: from.id,
        to: to.id,
        type: typeof d.type === 'string' && d.type !== '' ? d.type : 'related',
        note: typeof d.note === 'string' ? d.note : '',
        at,
      })
      break
    }

    case 'edge.unlinked': {
      const type = typeof d.type === 'string' && d.type !== '' ? d.type : null
      state.edges = state.edges.filter((e) => {
        if (e.from !== d.from || e.to !== d.to) return true
        if (type !== null && e.type !== type) return true
        return false
      })
      break
    }

    case 'rule.amended': {
      // Rules are carried by nodes (kind: 'rule'); the reason and the before/after text stay in the event, so changes are auditable and rollback-able.
      const n = state.nodes.get(d.id)
      if (n === undefined) {
        state.problems.push({ at: 'fold', reason: `规则变更指向不存在的节点：${String(d.id)}`, seq: ev.seq })
        break
      }
      const before = n.text
      n.text = typeof d.after === 'string' ? d.after : n.text
      n.revision += 1
      n.history.push({
        at,
        text: n.text,
        before,
        reason: typeof d.reason === 'string' ? d.reason : '规则变更',
        amendment: true,
      })
      break
    }

    case 'persona.proposed': {
      const id = typeof d.id === 'string' && d.id !== '' ? d.id : `p_${String(ev.seq ?? 0).padStart(4, '0')}`
      if (state.persona.has(id)) {
        state.problems.push({ at: 'fold', reason: `人格候选 id 重复：${id}`, seq: ev.seq })
        break
      }
      const confidence = Number(d.confidence)
      state.persona.set(id, {
        id,
        text: typeof d.text === 'string' ? d.text : '',
        status: 'candidate',
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
        evidence: Array.isArray(d.evidence) ? d.evidence.filter((x) => typeof x === 'string') : [],
        sourceIds: Array.isArray(d.sourceIds) ? d.sourceIds.filter((x) => typeof x === 'string') : [],
        createdAt: at,
        updatedAt: at,
        history: [{ at, action: 'proposed', text: typeof d.text === 'string' ? d.text : '', reason: typeof d.reason === 'string' ? d.reason : '' }],
      })
      break
    }

    case 'persona.accepted':
    case 'persona.rejected': {
      const p = state.persona.get(d.id)
      if (p === undefined) {
        state.problems.push({ at: 'fold', reason: `人格操作指向不存在的候选：${String(d.id)}`, seq: ev.seq })
        break
      }
      p.status = ev.type === 'persona.accepted' ? 'active' : 'rejected'
      p.updatedAt = at
      p.history.push({ at, action: ev.type === 'persona.accepted' ? 'accepted' : 'rejected', text: p.text, reason: typeof d.reason === 'string' ? d.reason : '' })
      break
    }

    case 'persona.revised': {
      const p = state.persona.get(d.id)
      if (p === undefined) {
        state.problems.push({ at: 'fold', reason: `人格修订指向不存在的特征：${String(d.id)}`, seq: ev.seq })
        break
      }
      const before = p.text
      p.text = typeof d.after === 'string' ? d.after : p.text
      if (Number.isFinite(Number(d.confidence))) p.confidence = Math.max(0, Math.min(1, Number(d.confidence)))
      p.updatedAt = at
      p.history.push({ at, action: 'revised', text: p.text, before, reason: typeof d.reason === 'string' ? d.reason : '' })
      break
    }

    default:
      break
  }

  if (typeof ev.seq === 'number' && ev.seq > state.seq) state.seq = ev.seq
  return state
}

/**
 * Fold the whole event sequence into the current state. This is the only read path.
 * @param {object[]} events - Events in ascending seq order.
 * @returns {object} State (with nodes / edges / seq / problems).
 */
export function foldEvents(events) {
  const state = createState()
  for (const ev of events) applyEvent(state, ev)
  return state
}

/** Currently active nodes. Only these take part in search, injection and supersession. */
export function activeNodes(state) {
  return [...state.nodes.values()].filter((n) => n.status === STATUS.ACTIVE)
}

/** Look up a node by id. */
export function nodeOf(state, id) {
  return state.nodes.get(id) ?? undefined
}

/** Incoming edges of a node (who references it): backlinks. */
export function backlinksOf(state, id) {
  return state.edges.filter((e) => e.to === id)
}

/** Outgoing edges of a node (what it references). */
export function outlinksOf(state, id) {
  return state.edges.filter((e) => e.from === id)
}

/**
 * Walk a supersession chain to its end to see what a judgment eventually became.
 * This is the provenance implementation: backwards reaches the origin, forwards
 * reaches the outcome.
 *
 * @param {object} state - Folded state.
 * @param {string} id - Starting node id.
 * @returns {{chain: object[], terminal: object|undefined}} Supersession chain and its terminal node.
 */
export function supersedeChain(state, id) {
  const chain = []
  const seen = new Set()
  let cur = state.nodes.get(id)
  while (cur !== undefined && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.push(cur)
    if (cur.supersededBy === null) break
    cur = state.nodes.get(cur.supersededBy)
  }
  return { chain, terminal: chain[chain.length - 1] }
}

/**
 * Bi-temporal query: fold the ledger into the state as of time T.
 *
 * This is the core capability ledger storage buys, and file-based memory cannot
 * provide it: validFrom / validTo record valid time (when the fact was true),
 * while createdAt records transaction time (when the system learned it). Taking
 * the event prefix with `at <= T` and folding it yields the exact state at T.
 *
 * Why this is exact rather than approximate: the ledger is append-only, so the
 * state at any moment is a pure function of the event prefix before it. This is
 * DSH's "everything must be reconstructable from committed events" principle
 * applied on the plugin side.
 *
 * @param {object[]} events - All events (ascending seq order; filtered internally).
 * @param {number} at - Unix millisecond timestamp.
 * @returns {object} State at T (same shape as foldEvents).
 */
export function foldAsOf(events, at) {
  const prefix = []
  for (const ev of events) {
    const t = typeof ev?.at === 'number' ? ev.at : 0
    if (t <= at) prefix.push(ev)
  }
  return foldEvents(prefix)
}

/**
 * Which node is active on an assertion key at a given moment.
 *
 * The most common bi-temporal question: "which port was in force in March?"
 *
 * @param {object[]} events - All events.
 * @param {number} at - Query moment.
 * @param {string} key - Key produced by assertionKey().
 * @returns {object|undefined} Node active at that moment; undefined when none.
 */
export function activeAssertionAsOf(events, at, key) {
  const state = foldAsOf(events, at)
  for (const n of state.nodes.values()) {
    if (n.status !== STATUS.ACTIVE) continue
    const s = typeof n.subject === 'string' ? n.subject : ''
    const r = typeof n.relation === 'string' ? n.relation : ''
    if (s === '' || r === '') continue
    if (`${s}\u0000${r}` === key) return n
  }
  return undefined
}
