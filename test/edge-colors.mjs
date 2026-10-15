/**
 * List every edge and mark **what color it will be drawn in**.
 *
 * The question "why is there a green line" came up: green = `complements`.
 * This script makes it obvious at a glance which edge is which type, what color
 * it gets, and what it connects.
 *
 * Usage: node test/edge-colors.mjs
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { openLibrary } from '../src/index.js'
import { buildSnapshot } from '../src/graph.js'

/** Kept in sync with the client `edgeColor()` (change both together). */
const COLOR_OF = {
  supersedes: 'blue (brand) — the new one supersedes the old, drawn with an arrowhead',
  complements: 'green — complement, two judgments reinforcing each other',
  tensions: 'red — tension, two judgments conflicting',
  depends: 'amber — depends-on, one relying on the other',
}

const lib = openLibrary(join(homedir(), '.dsh', 'ai-memory'))
const { state } = lib.load()

const brief = (id) => {
  const n = state.nodes.get(id)
  if (n === undefined) return `${id}(missing)`
  return `[${n.status}] ${n.text.slice(0, 26)}`
}

console.log(`=== ${state.edges.length} edge(s) ===\n`)
for (const e of state.edges) {
  const color = COLOR_OF[e.type] ?? 'grey (unknown type)'
  console.log(`${e.type}  →  ${color}`)
  console.log(`   ${brief(e.from)}`)
  console.log(`   ${brief(e.to)}`)
  console.log('')
}

const all = buildSnapshot(state, { includeRetired: true })
console.log(`view including retired: ${all.nodes.length} nodes / ${all.edges.length} edges`)
const byType = {}
for (const e of all.edges) byType[e.type] = (byType[e.type] ?? 0) + 1
console.log('edge type distribution:', JSON.stringify(byType))
