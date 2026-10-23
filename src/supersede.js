/**
 * Deterministic supersession engine.
 *
 * Why similarity cannot decide contradiction — the plugin's most important
 * design rationale, with published evidence:
 *
 *   MemStrata (arXiv 2606.26511) measured 98 annotated pairs:
 *     cosine similarity separating contradiction from restatement gives
 *     AUROC = 0.59 (near random), and contradictions on average resemble the
 *     original fact more closely than restatements do (0.812 vs 0.800),
 *     because flipping a value (8000 → 8080) is a smaller edit than a genuine
 *     paraphrase.
 *   Conclusion: staleness detection must be structural. Neither a threshold nor
 *   an LLM judge will do. "When a new fact shares the (subject, relation) key
 *   with a stored fact but asserts a different object, the new one supersedes
 *   the old one — regardless of how similar their embeddings are."
 *
 * This module therefore contains no similarity computation at all. Decisions
 * rest entirely on string normalization plus triple comparison, which also
 * makes them testable, reproducible, dependency-free and LLM-free (the read
 * path makes no LLM call).
 *
 * Two symmetric ablations from the same paper set the engine's posture:
 *   - aggressive merging regresses below plain RAG (it discards the detail
 *     needed to answer follow-up questions);
 *   - never superseding multiplies the fabrication rate by six, which is less
 *     safe than being inaccurate, because the model sees both the old and the
 *     new value and starts inventing.
 *   → "retain first, then supersede": compress only along the contradiction
 *     axis, never merge distinct facts.
 */

import { randomBytes } from 'node:crypto'

import { KIND, NODE_KINDS, setAssertionKeyImpl } from './ledger.js'

/**
 * Whitelist of node kinds that a `node.created` may carry.
 *
 * ⚠️ Two separate silent-failure bugs lived here, both of the same shape:
 *
 *   1. It used to be `input.kind === 'rule' ? 'rule' : 'judgment'`, so adding
 *      `insight` silently downgraded it to judgment — no error, just a lost
 *      kind, and supersession then compared it as a judgment.
 *   2. It was then widened to `Object.values(KIND)`, which *includes*
 *      `persona`, while `ledger.js` still accepted only rule/insight. So
 *      `memory_write({kind:'persona'})` wrote `persona` into the ledger and
 *      folded it back as `judgment`, silently.
 *
 * It now derives from NODE_KINDS, the one list `ledger.js` also uses to fold.
 * The two can no longer disagree.
 */
const VALID_KINDS = new Set(NODE_KINDS)

/**
 * Normalize one triple component for deterministic comparison.
 *
 * Normalization is lossy and deliberately conservative: it applies only
 * transformations that cannot make distinct facts identical. No stemming, no
 * synonyms, no vectors — all of those introduce nondeterminism.
 *
 * @param {unknown} v - Raw component.
 * @returns {string} Normalized key component (empty string means "component absent").
 */
export function normalizeComponent(v) {
  if (typeof v !== 'string') return ''
  return v
    .normalize('NFKC')          // fold full-width/half-width and compatibility characters
    .trim()
    .replace(/\s+/g, ' ')       // collapse whitespace
    .toLowerCase()              // case-insensitive
}

/**
 * Build the assertion key: (subject, relation, scope).
 *
 * ## Why scope is part of the key
 *
 * With only `(subject, relation)`, exactly one answer can be live at a time. So
 * these two judgments — both true, in different contexts — were collapsed into
 * a supersession, and the ledger recorded a change of mind that never happened:
 *
 *     (svc, port, dev)  = 8000
 *     (svc, port, prod) = 8080   ← was treated as "I changed my mind"
 *
 * Making scope a dimension of the key fixes that structurally: same
 * subject/relation but a different scope is a *different assertion*, so both
 * stay active and neither overturns the other.
 *
 * Scope is optional. An absent or empty scope is the global scope, which is
 * exactly what every pre-existing ledger line means — so old data keeps its
 * current behaviour and no migration is needed.
 *
 * @param {{subject?: unknown, relation?: unknown, scope?: unknown}} node - Node carrying a triple.
 * @returns {string|null} Key; null when subject or relation is missing (= no supersession).
 */
export function assertionKey(node) {
  const s = normalizeComponent(node?.subject)
  const r = normalizeComponent(node?.relation)
  if (s === '' || r === '') return null
  const sc = normalizeComponent(node?.scope)
  // ⚠️ The third segment is appended only when a scope is present, so a global
  // assertion key stays byte-identical to what older ledgers and callers
  // already hold. Adding a trailing separator unconditionally would silently
  // invalidate every key passed in from outside (activeAssertionAsOf).
  return sc === '' ? `${s}\u0000${r}` : `${s}\u0000${r}\u0000${sc}`
}

// Install this builder as the one ledger.js uses for as-of assertions, so the
// two modules can never disagree about what counts as the same key. See
// assertionKeyOf() in ledger.js for why this is late-bound rather than imported.
setAssertionKeyImpl(assertionKey)

/**
 * Classify the relation between an incoming judgment and existing judgments.
 *
 * Returns one of four values, matching the paper's annotation classes:
 *   'duplicate'   same key, same object: restatement (create nothing, reinforce the citation)
 *   'supersede'   same key, different object: contradiction (the new one replaces the old)
 *   'novel'       no matching key: a new fact
 *   'unkeyed'     triple incomplete: cannot take part in supersession, stored as a plain node
 *
 * @param {object} incoming - New judgment (needs subject/relation/object, optionally scope).
 * @param {object[]} active - Currently active nodes.
 * @returns {{relation: string, target?: object}} Verdict and the existing node it matched.
 */
export function classify(incoming, active) {
  const key = assertionKey(incoming)
  if (key === null) return { relation: 'unkeyed' }

  const obj = normalizeComponent(incoming.object)
  if (obj === '') return { relation: 'unkeyed' }
  /**
   * Pick the **newest** same-key node as the supersession target, not the first
   * one encountered.
   *
   * A Map iterates in insertion order, so the original `sameKey = n` kept
   * overwriting nothing and returned the *oldest* match. Measured: with two
   * live same-key judgments (one from an insight that never takes part in
   * supersession, one a judgment), writing a third superseded the oldest
   * judgment rather than the most recent position it was actually replacing.
   * The newest node is the position currently held; that is the one being
   * contradicted.
   */
  let sameKey = null
  for (const n of active) {
    if (normalizeComponent(n.object) === '') continue
    if (assertionKey(n) !== key) continue
    // Same complete key and object means a restatement.
    if (normalizeComponent(n.object) === obj) return { relation: 'duplicate', target: n }
    if (sameKey === null || (Number(n.createdAt) || 0) >= (Number(sameKey.createdAt) || 0)) sameKey = n
  }
  if (sameKey !== null) return { relation: 'supersede', target: sameKey }
  return { relation: 'novel' }
}

/**
 * Compute the event sequence a new judgment should produce.
 *
 * Pure function: state plus new judgment in, event array out. It writes nothing
 * and mutates nothing, so the caller can inspect, test or review the events
 * before deciding whether to commit them.
 *
 * @param {object} state - Current folded state.
 * @param {object} input - `{ text, subject, relation, object, kind, tags, citations, reason }`.
 * @param {{at: number, nextSeq: number, newId: string}} ctx - Time, sequence number, new id.
 * @returns {{events: object[], outcome: object}} Events and outcome summary.
 */
export function planWrite(state, input, ctx) {
  const active = activeNodesOf(state)
  // Only complete judgments participate in automatic supersession. Rules
  // require governance, and an insight is intentionally provisional.
  const kind = VALID_KINDS.has(input.kind) ? input.kind : KIND.JUDGMENT
  const verdict = kind === KIND.JUDGMENT
    ? classify(input, active.filter((n) => n.kind === KIND.JUDGMENT))
    : { relation: 'unkeyed' }
  const at = ctx.at
  let seq = ctx.nextSeq
  const events = []
  const take = () => (seq += 1)

  if (verdict.relation === 'duplicate') {
    // Restatement: create no node and emit no event. One assertion does not need two cards.
    // Deliberately no edge from ctx.newId: that node does not exist, and emitting one would make fold report a problem.
    // The restatement is itself a confirmation; its value is telling the caller the assertion already exists, so nothing needs writing.
    return {
      events: [],
      outcome: {
        action: 'duplicate',
        nodeId: verdict.target.id,
        text: verdict.target.text,
        note: '这条判断与既有判断是同一断言（同 subject/relation/object），未新建节点。',
      },
    }
  }

  const nodeEvent = {
    seq: take(),
    at,
    type: 'node.created',
    data: {
      id: ctx.newId,
      // ⚠️ This was once hardcoded as `input.kind === 'rule' ? 'rule' : 'judgment'`, so a new `insight` was silently downgraded to judgment: no error, just a lost kind. Now validated against the KIND whitelist; only unknown kinds fall back to judgment.
      kind: VALID_KINDS.has(input.kind) ? input.kind : 'judgment',
      text: input.text,
      subject: input.subject ?? null,
      relation: input.relation ?? null,
      object: input.object ?? null,
      // The third dimension of the assertion key must travel with the event,
      // otherwise `assertionKey` has nothing to read back when the ledger is
      // folded and every scoped assertion collapses into the global one.
      //
      // ⚠️ Written as an empty string rather than `undefined`: JSON.stringify
      // drops undefined members, so the field would vanish from the ledger line
      // entirely and a hand-editing reader could not tell "no scope" from
      // "field forgotten".
      scope: typeof input.scope === 'string' ? input.scope : '',
      // Who started this thought. Recorded, never inferred, because it is the
      // only field that makes "it is evolving on its own" checkable later.
      trigger: input.trigger === 'self' || input.trigger === 'evidence' ? input.trigger : 'user',
      tags: input.tags ?? [],
      citations: input.citations ?? [],
    },
  }
  events.push(nodeEvent)

  if (verdict.relation === 'supersede') {
    const old = verdict.target
    // Bi-temporal: close the old node's valid_to, never delete it. The old judgment stays available to as-of-time queries and provenance views.
    events.push({
      seq: take(),
      at,
      type: 'node.superseded',
      data: { id: old.id, byId: ctx.newId, reason: input.reason ?? '同一断言的更新值' },
    })
    // Supersession also leaves an edge, so the graph shows which node replaced which.
    events.push({
      seq: take(),
      at,
      type: 'edge.linked',
      data: { from: ctx.newId, to: old.id, type: 'supersedes', note: input.reason ?? '' },
    })
    return {
      events,
      outcome: {
        action: 'supersede',
        nodeId: ctx.newId,
        supersededId: old.id,
        supersededText: old.text,
        note: `确定性取代：同 (subject, relation) 键、不同 object。旧判断退役但保留在账本里。`,
      },
    }
  }

  return {
    events,
    outcome: { action: 'created', nodeId: ctx.newId, note: '新判断已记录。' },
  }
}

/**
 * Lightweight active-node lookup, so this module depends only on state.nodes being a Map, not on ledger.js internals.
 * @param {object} state - Folded state.
 * @returns {object[]} Active nodes.
 */
function activeNodesOf(state) {
  const out = []
  for (const n of state.nodes.values()) {
    if (n.status === 'active') out.push(n)
  }
  return out
}

/**
 * Generate a stable node id.
 *
 * ⚠️ The suffix **must** be random, and this was measured, not assumed:
 *
 * The previous form was `n_<seq>_<last 6 base36 chars of the timestamp>`.
 * Two processes that read the same `state.seq` compute the same `seq + 1`,
 * and if their clocks land in the same millisecond they also compute the same
 * timestamp suffix — so both produce a byte-identical id. `applyEvent` then
 * treats the second `node.created` as a duplicate and drops it.
 *
 * Measured: 8 processes × 5 writes produced 40 ledger lines but only **29
 * folded nodes** — 11 judgments existed in the file and were invisible to
 * search and injection, with a single "节点 id 重复" problem as the only trace.
 *
 * The truncation also collided on its own: `36^6 = 2176782336 ms ≈ 25.19 days`,
 * so the same `seq` produced the same id again three and a half weeks later.
 *
 * The timestamp prefix is kept because it makes ids human-scannable in the
 * ledger; it is no longer load-bearing for uniqueness.
 *
 * @param {number} at - Millisecond timestamp.
 * @param {number} seq - Sequence number.
 * @returns {string} An id shaped like `n_0007_1a2b3c4d`.
 */
export function makeNodeId(at, seq) {
  const t = at.toString(36).slice(-6)
  const s = String(seq).padStart(4, '0')
  // 8 hex chars = 32 bits of entropy: collisions between concurrently written
  // nodes are not a practical concern, and the value stays short enough to read.
  return `n_${s}_${t}${randomBytes(4).toString('hex')}`
}
