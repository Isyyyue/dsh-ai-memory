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
 *   question.opened   something it has not finished thinking about
 *   question.touched  it thought about that question again
 *   question.closed   resolved (optionally naming the judgment that resolved it)
 *   question.abandoned deliberately dropped, kept for the record
 *   cycle.started     a thinking cycle began; `trigger: 'self'` = no user present
 *   cycle.ended       it finished, including when it produced nothing
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
  // --- Open questions: what it has not finished thinking about. ---
  // These are what make the system driven rather than merely stored: a
  // judgment records a conclusion, a question records an obligation to keep
  // thinking. Without them nothing starts a cycle when no user is present.
  'question.opened',
  'question.touched',
  'question.closed',
  'question.abandoned',
  // --- Thinking cycles: proof that thinking happened, including when it
  // produced nothing. "Thought and had nothing to say" must be a first-class
  // outcome; a system that must emit something every turn is answering, not
  // thinking.
  'cycle.started',
  'cycle.ended',
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
 * Node kinds a `node.created` event may carry.
 *
 * ⚠️ This set and the KIND enum must never drift apart again. They did once:
 * `supersede.js` validated against `Object.values(KIND)` (which includes
 * `persona`) while `applyEvent` accepted only rule/insight, so
 * `memory_write({kind:'persona'})` stored `persona` in the ledger and folded
 * it back as `judgment` — with no problem recorded. The same class of bug had
 * already been fixed once for `insight` (see supersede.js), which is why this
 * is now derived from one place.
 *
 * `persona` is deliberately NOT a node kind: personality lives in the separate
 * `state.persona` map, where accept/reject/revise are governed. Letting a
 * plain node claim kind=persona would create a second, ungoverned path to a
 * personality change.
 */
export const NODE_KINDS = Object.freeze([KIND.JUDGMENT, KIND.RULE, KIND.INSIGHT])

/**
 * Status of an open question.
 *
 * `open`      still owed a thought; counts toward attention pressure
 * `closed`    resolved, with the resolving judgment recorded
 * `abandoned` deliberately dropped; kept for the record, not counted
 */
export const QUESTION_STATUS = Object.freeze({
  OPEN: 'open',
  CLOSED: 'closed',
  ABANDONED: 'abandoned',
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
    // Open questions: what it has not finished thinking about. This is the
    // drive; without it the system only reacts to whoever speaks last.
    questions: new Map(),
    // Completed thinking cycles, keyed by cycleId. Empty output is recorded.
    cycles: new Map(),
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
      // ⚠️ Derived from NODE_KINDS, never hand-written here. A hand-written
      // list is how `persona` once slipped through as `judgment` in silence.
      const kind = NODE_KINDS.includes(d.kind) ? d.kind : KIND.JUDGMENT
      if (typeof d.kind === 'string' && d.kind !== '' && !NODE_KINDS.includes(d.kind)) {
        // An unrecognized kind is still downgraded (never lose the record), but
        // it is no longer silent: a typo like `insite` must be visible.
        state.problems.push({ at: 'fold', reason: `未知节点类型 ${d.kind}，已按 judgment 存：${id}`, seq: ev.seq })
      }
      state.nodes.set(id, {
        id,
        kind,
        text: typeof d.text === 'string' ? d.text : '',
        // Triple used for deterministic supersession. If any component is missing, the node takes part in search only, never in supersession.
        subject: typeof d.subject === 'string' && d.subject !== '' ? d.subject : null,
        relation: typeof d.relation === 'string' && d.relation !== '' ? d.relation : null,
        object: typeof d.object === 'string' && d.object !== '' ? d.object : null,
        /**
         * Scope is the third dimension of the assertion key.
         *
         * Without it, `(subject, relation)` admits exactly one live answer, so
         * "dev runs on 8000" and "prod runs on 8080" get collapsed into a
         * supersession — the ledger then records a change of mind that never
         * happened. With it, both stay active and neither overturns the other.
         *
         * Absent or empty means the global scope, so every pre-existing ledger
         * keeps its exact current behaviour.
         */
        scope: typeof d.scope === 'string' ? d.scope : '',
        tags: Array.isArray(d.tags) ? d.tags.filter((t) => typeof t === 'string') : [],
        citations: Array.isArray(d.citations) ? d.citations.filter((c) => typeof c === 'string') : [],
        createdAt: at,
        // Bi-temporal ledger: validFrom/validTo say when the fact was true, createdAt says when the system learned it.
        validFrom: at,
        validTo: null,
        supersededBy: null,
        status: STATUS.ACTIVE,
        revision: 1,
        /**
         * Who started this thought.
         *
         *   'user'     the user said or corrected something
         *   'evidence' a newly observed fact pushed it
         *   'self'     it came up on its own, with no one in the room
         *
         * This is the only field that makes "it is evolving" checkable rather
         * than felt: count the `self` judgments and see how many survived.
         */
        trigger: d.trigger === 'self' || d.trigger === 'evidence' ? d.trigger : 'user',
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
      if (typeof d.scope === 'string') n.scope = d.scope
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

    case 'question.opened': {
      const id = typeof d.id === 'string' && d.id !== '' ? d.id : `q_${String(ev.seq ?? 0).padStart(4, '0')}`
      if (state.questions.has(id)) {
        state.problems.push({ at: 'fold', reason: `问题 id 重复：${id}`, seq: ev.seq })
        break
      }
      const urgency = Number(d.urgency)
      const confidence = Number(d.confidence)
      state.questions.set(id, {
        id,
        text: typeof d.text === 'string' ? d.text : '',
        status: QUESTION_STATUS.OPEN,
        // How much this matters to it. Self-assessed, so it is a judgment too —
        // but one about attention, not about the world.
        urgency: Number.isFinite(urgency) ? Math.max(0, Math.min(1, urgency)) : 0.5,
        // How settled it feels. The gap (1 - confidence) is what keeps pulling.
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.2,
        // Attempts are counted so that thinking about something ten times
        // without progress decays its priority. Without this the system can
        // loop on one question forever and burn every cycle on it.
        attempts: 0,
        sourceIds: Array.isArray(d.sourceIds) ? d.sourceIds.filter((x) => typeof x === 'string') : [],
        openedAt: at,
        lastTouchedAt: at,
        closedAt: null,
        resolvedBy: null,
        history: [{ at, action: 'opened', note: typeof d.reason === 'string' ? d.reason : '' }],
      })
      break
    }

    case 'question.touched': {
      const q = state.questions.get(d.id)
      if (q === undefined) {
        state.problems.push({ at: 'fold', reason: `思考记录指向不存在的问题：${String(d.id)}`, seq: ev.seq })
        break
      }
      q.attempts += 1
      q.lastTouchedAt = at
      if (Number.isFinite(Number(d.confidence))) q.confidence = Math.max(0, Math.min(1, Number(d.confidence)))
      if (Number.isFinite(Number(d.urgency))) q.urgency = Math.max(0, Math.min(1, Number(d.urgency)))
      q.history.push({ at, action: 'touched', note: typeof d.note === 'string' ? d.note : '' })
      break
    }

    case 'question.closed':
    case 'question.abandoned': {
      const q = state.questions.get(d.id)
      if (q === undefined) {
        state.problems.push({ at: 'fold', reason: `关闭指向不存在的问题：${String(d.id)}`, seq: ev.seq })
        break
      }
      q.status = ev.type === 'question.closed' ? QUESTION_STATUS.CLOSED : QUESTION_STATUS.ABANDONED
      q.closedAt = at
      q.resolvedBy = typeof d.resolvedBy === 'string' && d.resolvedBy !== '' ? d.resolvedBy : null
      q.history.push({
        at,
        action: ev.type === 'question.closed' ? 'closed' : 'abandoned',
        note: typeof d.note === 'string' ? d.note : '',
      })
      break
    }

    case 'cycle.started': {
      const id = typeof d.id === 'string' && d.id !== '' ? d.id : `c_${String(ev.seq ?? 0).padStart(4, '0')}`
      if (state.cycles.has(id)) {
        state.problems.push({ at: 'fold', reason: `周期 id 重复：${id}`, seq: ev.seq })
        break
      }
      state.cycles.set(id, {
        id,
        startedAt: at,
        endedAt: null,
        // 'self' means no user was present. This is the field that answers
        // "did it think on its own", so it is recorded, never inferred.
        trigger: d.trigger === 'self' ? 'self' : 'user',
        focus: Array.isArray(d.focus) ? d.focus.filter((x) => typeof x === 'string') : [],
        produced: null,
        note: '',
      })
      break
    }

    case 'cycle.ended': {
      const c = state.cycles.get(d.id)
      if (c === undefined) {
        state.problems.push({ at: 'fold', reason: `结束指向不存在的周期：${String(d.id)}`, seq: ev.seq })
        break
      }
      c.endedAt = at
      c.produced = Number.isFinite(Number(d.produced)) ? Number(d.produced) : 0
      c.note = typeof d.note === 'string' ? d.note : ''
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
  // Compare with the same key builder the write path uses, so a scoped
  // assertion and its global counterpart cannot be confused: a query for the
  // global key must not match a node that carries a scope.
  const { assertionKey } = assertionKeyOf()
  for (const n of state.nodes.values()) {
    if (n.status !== STATUS.ACTIVE) continue
    if (assertionKey(n) !== key) continue
    return n
  }
  return undefined
}

/**
 * Late-bound access to supersede.js's key builder.
 *
 * `ledger.js` must not import `supersede.js`: supersede imports KIND and
 * NODE_KINDS from ledger, and a static cycle between the two would make module
 * initialization order decide whether those constants exist yet. The lookup is
 * resolved lazily at call time instead, which keeps the dependency one-way.
 *
 * @returns {{assertionKey: (node: object) => string|null}} The key builder.
 */
function assertionKeyOf() {
  return { assertionKey: assertionKeyImpl }
}

/** Assigned once supersede.js loads; see assertionKeyOf(). */
let assertionKeyImpl = (node) => {
  const s = typeof node?.subject === 'string' ? node.subject.trim().toLowerCase() : ''
  const r = typeof node?.relation === 'string' ? node.relation.trim().toLowerCase() : ''
  if (s === '' || r === '') return null
  const sc = typeof node?.scope === 'string' ? node.scope.trim().toLowerCase() : ''
  return sc === '' ? `${s}\u0000${r}` : `${s}\u0000${r}\u0000${sc}`
}

/**
 * Let supersede.js install its own key builder, so both modules agree exactly.
 * @param {(node: object) => string|null} fn - The authoritative builder.
 * @returns {void}
 */
export function setAssertionKeyImpl(fn) {
  assertionKeyImpl = fn
}
