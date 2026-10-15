/**
 * Answers "are there no links because nothing is related, or because of a bug?".
 *
 * Lists every edge one by one, marks the status of the node at each end, and explains
 * why it appears or disappears in the default view.
 *
 * Usage: node test/why-no-edges.mjs
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { openLibrary } from '../src/index.js'
import { buildSnapshot } from '../src/graph.js'

const lib = openLibrary(join(homedir(), '.dsh', 'ai-memory'))
const { state } = lib.load()

const label = (id) => {
  const n = state.nodes.get(id)
  if (n === undefined) return `${id} (does not exist)`
  return `${id} [${n.status}] ${n.text.slice(0, 22)}`
}

console.log('=== all edges (' + state.edges.length + ') ===\n')
for (const e of state.edges) {
  const from = state.nodes.get(e.from)
  const to = state.nodes.get(e.to)
  const bothActive = from?.status === 'active' && to?.status === 'active'
  console.log(`${e.type}`)
  console.log(`  from: ${label(e.from)}`)
  console.log(`  to:   ${label(e.to)}`)
  console.log(`  both ends active? ${bothActive ? 'yes → drawn in the default view' : 'no → filtered out of the default view'}`)
  console.log('')
}

const def = buildSnapshot(state)
const all = buildSnapshot(state, { includeRetired: true })
console.log('=== result ===')
console.log(`default view (active only): ${def.nodes.length} nodes / ${def.edges.length} edges`)
console.log(`including retired         : ${all.nodes.length} nodes / ${all.edges.length} edges`)

const activeIds = new Set(def.nodes.map((n) => n.id))
const crossEdges = state.edges.filter((e) => activeIds.has(e.from) !== activeIds.has(e.to))
console.log('')
console.log(`edges crossing "active↔retired": ${crossEdges.length} (these are the ones invisible in the default view)`)
