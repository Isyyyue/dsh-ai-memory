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

import { KIND } from './ledger.js'

/**
 * Whitelist of valid kinds.
 *
 * ⚠️ This used to be hardcoded as `input.kind === 'rule' ? 'rule' : 'judgment'`,
 * so adding `insight` silently downgraded it to judgment: no error, just a lost
 * kind, and supersession then compared it as a judgment. With a whitelist,
 * adding a kind means adding one entry here — and since it derives from the KIND
 * enum directly, it can never fall behind again.
 */
const VALID_KINDS = new Set(Object.values(KIND))

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
 * Build the (subject, relation) key. Supersession compares this key plus object.
 *
 * @param {{subject?: unknown, relation?: unknown}} node - Node carrying a triple.
 * @returns {string|null} Key; null when either component is missing (= no supersession).
 */
export function assertionKey(node) {
  const s = normalizeComponent(node?.subject)
  const r = normalizeComponent(node?.relation)
  if (s === '' || r === '') return null
  return `${s}\u0000${r}`
}

/**
 * Classify the relation between an incoming judgment and existing judgments.
 *
 * Returns one of four values, matching the paper's annotation classes:
 *   'duplicate'   same key, same object: restatement (create nothing, reinforce the citation)
 *   'supersede'   same key, different object: contradiction (the new one replaces the old)
 *   'novel'       no matching key: a new fact
 *   'unkeyed'     triple incomplete: cannot take part in supersession, stored as a plain node
 *
 * @param {object} incoming - New judgment (needs subject/relation/object).
 * @param {object[]} active - Currently active nodes.
 * @returns {{relation: string, target?: object}} Verdict and the existing node it matched.
 */
export function classify(incoming, active) {
  const key = assertionKey(incoming)
  if (key === null) return { relation: 'unkeyed' }

  const obj = normalizeComponent(incoming.object)
  let sameKey = null
  for (const n of active) {
    if (assertionKey(n) !== key) continue
    // Same key, same object → restatement. An empty object means there is no assertable difference, which also counts as a restatement.
    if (normalizeComponent(n.object) === obj) return { relation: 'duplicate', target: n }
    sameKey = n
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
  const verdict = classify(input, active)
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
        note: 'Same assertion as an existing judgment (identical subject/relation/object); no node was created.',
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
      data: { id: old.id, byId: ctx.newId, reason: input.reason ?? 'updated value for the same assertion' },
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
        note: `Deterministic supersession: same (subject, relation) key, different object. The old judgment is retired but kept in the ledger.`,
      },
    }
  }

  return {
    events,
    outcome: { action: 'created', nodeId: ctx.newId, note: 'New judgment recorded.' },
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
 * Deliberately free of randomness beyond the timestamp: the same content yields
 * different ids at different times (they are two distinct judgments), while ids
 * generated at one moment are reproducible for tests.
 *
 * @param {number} at - Millisecond timestamp.
 * @param {number} seq - Sequence number.
 * @returns {string} An id shaped like `n_0007_1a2b3c`.
 */
export function makeNodeId(at, seq) {
  const t = at.toString(36).slice(-6)
  const s = String(seq).padStart(4, '0')
  return `n_${s}_${t}`
}
