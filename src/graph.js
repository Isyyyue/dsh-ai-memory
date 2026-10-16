/**
 * Graph snapshot: turn the folded state into the minimal structure the client
 * needs to draw a graph.
 *
 * Design rationale (community and official agreement):
 *   graph-memory's documentation states that **graph nodes navigate, they do not
 *   carry facts**:
 *     "Summary, SPO, and communities only navigate; original question and final
 *      answer remain the evidence."
 *   The official practices.md likewise requires that derived views be computed
 *   on the Host before reaching the Client:
 *     "The value reaches the Client already computed; the Client does not fold
 *      session events itself."
 *
 * So this module emits **nodes and edges only** (with status, degree and a short
 * summary), never full bodies. Bodies are fetched on demand through
 * memory_search / memory_history, so the graph cannot overflow the context or
 * the transport however large it grows.
 *
 * It is also the data source for the explainability UI: every node carries
 * status / supersededBy / degree, so it is visible which idea superseded it and
 * what it connects to.
 */

import { activeNodes, supersedeChain, backlinksOf, outlinksOf, STATUS, KIND } from './ledger.js'
import { summarize } from './query.js'

/**
 * Build a graph snapshot.
 *
 * @param {object} state - Folded state.
 * @param {{includeRetired?: boolean, maxNodes?: number}} [opts] - Options.
 * @returns {object} `{ nodes, edges, stats, truncated }`.
 */
export function buildSnapshot(state, opts = {}) {
  const includeRetired = opts.includeRetired === true
  const maxNodes = Number.isInteger(opts.maxNodes) && opts.maxNodes > 0 ? opts.maxNodes : 500

  const active = activeNodes(state)

  /**
   * Node selection policy.
   *
   * ## Default: **active nodes only** (an explicit product requirement: retired
   * nodes simply disappear)
   *
   * The graph answers "what do I believe now", not "what have I thought
   * historically". Retired nodes (superseded or self-withdrawn) are **not drawn
   * at all** by default — clean, no clutter.
   *
   * ## Only `?retired=1` brings retired nodes back, along with the supersession chain
   *
   * That view is about evolution history: how many times a judgment was
   * overturned and how it changed. Walking `supersedes` edges (`from` = newer,
   * `to` = the superseded older node) generation by generation carries the whole
   * provenance.
   *
   * ## ⚠️ This went back and forth twice; recorded here to avoid a third time
   *
   * 1. **Active only at first** → because every `supersedes` edge points at a
   *    retired node, filtering retired nodes out filters out **every edge**,
   *    leaving a blank "3 nodes · 0 links" graph.
   * 2. So the default became **include the supersession chain** → the graph was
   *    visible but covered in grey dots, prompting the question "why are some
   *    grey and some white".
   * 3. **Final decision**: default to **active only**, with retired nodes
   *    available on request (a right-click toggle). Grey dots no longer mix into
   *    the default view.
   */
  const personaNodes = [...state.persona.values()]
    .filter((p) => p.status === 'active')
    .map((p) => ({
      id: p.id,
      text: p.text,
      kind: KIND.PERSONA,
      status: STATUS.ACTIVE,
      createdAt: p.createdAt,
      revision: p.history.length,
      supersededBy: null,
      subject: null,
      relation: null,
      object: null,
      sourceIds: p.sourceIds,
    }))
  const byId = new Map([...state.nodes.values(), ...personaNodes].map((n) => [n.id, n]))
  const chainIds = new Set()
  if (includeRetired) {
    for (const n of active) {
      const seen = new Set([n.id])
      let frontier = [n.id]
      while (frontier.length > 0) {
        const next = []
        for (const fromId of frontier) {
          for (const e of state.edges) {
            // Direction: from is the newer node, to is the older one it superseded → follow from downwards.
            if (e.type !== 'supersedes' || e.from !== fromId) continue
            if (seen.has(e.to)) continue
            seen.add(e.to)
            chainIds.add(e.to)
            next.push(e.to)
          }
        }
        frontier = next
      }
    }
  }

  const pool = includeRetired
    ? [...state.nodes.values(), ...personaNodes]
    : [...active, ...personaNodes, ...[...chainIds].map((id) => byId.get(id)).filter((n) => n !== undefined)]

  const personaEdges = personaNodes.flatMap((p) => (p.sourceIds ?? [])
    .filter((sourceId) => byId.has(sourceId))
    .map((sourceId) => ({ from: p.id, to: sourceId, type: 'inferred-from' })))
  const graphEdges = [...state.edges, ...personaEdges]

  // Stable sort: newest first, so the panel shows recent ideas at the top.
  pool.sort((a, b) => b.createdAt - a.createdAt || String(a.id).localeCompare(String(b.id)))

  const truncated = pool.length > maxNodes
  const chosen = pool.slice(0, maxNodes)
  const chosenIds = new Set(chosen.map((n) => n.id))

  // Degree: shows at a glance which judgment is a hub and which is an orphan.
  const degree = new Map()
    for (const e of graphEdges) {
    if (!chosenIds.has(e.from) || !chosenIds.has(e.to)) continue
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1)
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1)
  }

  const nodes = chosen.map((n) => ({
    id: n.id,
    // Summary rather than full text: the graph is a navigation layer, bodies are fetched on demand.
    label: summarize(n.text, 60),
    kind: n.kind,
    status: n.status,
    degree: degree.get(n.id) ?? 0,
    createdAt: n.createdAt,
    revision: n.revision,
    ...(n.supersededBy != null ? { supersededBy: n.supersededBy } : {}),
    ...(n.subject != null ? { subject: n.subject } : {}),
    ...(n.relation != null ? { relation: n.relation } : {}),
    ...(n.object != null ? { object: n.object } : {}),
  }))

  const edges = graphEdges
    .filter((e) => chosenIds.has(e.from) && chosenIds.has(e.to))
    .map((e) => ({ from: e.from, to: e.to, type: e.type }))

  return {
    nodes,
    edges,
    stats: countStats(state, nodes, edges),
    truncated,
  }
}

/**
 * Statistics. Shared by the panel header and the /stats route.
 *
 * @param {object} state - State.
 * @param {object[]} [nodes] - Already-truncated nodes (recomputed when omitted).
 * @param {object[]} [edges] - Already-truncated edges (recomputed when omitted).
 * @returns {object} Statistics object.
 */
export function countStats(state, nodes, edges) {
  const persona = [...state.persona.values()]
    .filter((p) => p.status === 'active')
    .map((p) => ({ id: p.id, status: STATUS.ACTIVE, kind: KIND.PERSONA, sourceIds: p.sourceIds }))
  const all = [...state.nodes.values(), ...persona]
  const active = activeNodes(state)
  const activeAll = [...active, ...persona]
  const graphEdges = [...state.edges, ...persona.flatMap((p) => (p.sourceIds ?? []).map((sourceId) => ({ from: p.id, to: sourceId })))]
  const connected = new Set()
  for (const e of graphEdges) {
    connected.add(e.from)
    connected.add(e.to)
  }
  return {
    nodes: nodes === undefined ? all.length : nodes.length,
    edges: edges === undefined ? graphEdges.length : edges.length,
    active: activeAll.length,
    retired: all.filter((n) => n.status !== STATUS.ACTIVE).length,
    judgments: activeAll.filter((n) => n.kind === KIND.JUDGMENT).length,
    rules: activeAll.filter((n) => n.kind === KIND.RULE).length,
    insights: activeAll.filter((n) => n.kind === KIND.INSIGHT).length,
    persona: activeAll.filter((n) => n.kind === KIND.PERSONA).length,
    orphans: activeAll.filter((n) => !connected.has(n.id)).length,
    problems: state.problems.length,
  }
}

/**
 * Details for a single judgment (shown when the panel selects one).
 *
 * @param {object} state - State.
 * @param {string} id - Node id.
 * @returns {object|null} Details; null when not found.
 */
export function nodeDetail(state, id) {
  const n = state.nodes.get(id)
  if (n === undefined) {
    const p = state.persona.get(id)
    if (p === undefined) return null
    return {
      id: p.id,
      text: p.text,
      kind: KIND.PERSONA,
      status: p.status,
      revision: p.history.length,
      createdAt: p.createdAt,
      sourceIds: p.sourceIds,
      evidence: p.evidence,
      confidence: p.confidence,
      history: p.history.map((h) => ({ at: h.at, text: summarize(h.text, 300), reason: h.reason, action: h.action })),
      backlinks: [],
      outlinks: (p.sourceIds ?? []).map((sourceId) => ({ to: sourceId, type: 'inferred-from', note: '' })),
      chain: [],
    }
  }
  const { chain } = supersedeChain(state, id)
  return {
    id: n.id,
    text: n.text,
    kind: n.kind,
    status: n.status,
    revision: n.revision,
    createdAt: n.createdAt,
    validFrom: n.validFrom,
    validTo: n.validTo,
    supersededBy: n.supersededBy,
    tags: n.tags,
    citations: n.citations,
    // Backlinks are the core of explainability: who references this node.
    backlinks: backlinksOf(state, id).map((e) => ({ from: e.from, type: e.type, note: e.note })),
    outlinks: outlinksOf(state, id).map((e) => ({ to: e.to, type: e.type, note: e.note })),
    history: n.history.map((h) => ({ at: h.at, text: summarize(h.text, 300), reason: h.reason })),
    chain: chain.map((c) => ({ id: c.id, text: summarize(c.text, 200), status: c.status })),
  }
}
