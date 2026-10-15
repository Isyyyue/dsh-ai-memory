/**
 * Verify that per-kind coloring actually works end to end — from write, through
 * the snapshot, to the rendered style.
 *
 * Why it is separate: color and shape are **visual**, and a unit test cannot
 * assert that something "looks good", but it can assert that **the data path is
 * connected** (all three kinds can be written, read back, and resolve to their
 * own style).
 *
 * Usage: node test/kinds.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openLibrary, createOperations } from '../src/index.js'
import { buildSnapshot, countStats } from '../src/graph.js'
import { KIND } from '../src/ledger.js'

let fails = 0
/** Assert and print. */
function check(label, cond, extra = '') {
  if (cond) console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`)
  else {
    fails += 1
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'am-kinds-'))
let clock = 1_700_000_000_000
const lib = openLibrary(dir)
const ops = createOperations(lib, { now: () => (clock += 1000) })

console.log('\n[all three kinds can be written]')
const j = ops.write({ text: 'Judgment: this port should be 8080', subject: 'svc', relation: 'port', object: '8080' })
const i = ops.write({ text: 'Thought: perhaps the problem is not the port at all', kind: KIND.INSIGHT })
const r = ops.rule({ action: 'amend', text: 'Rule: write judgments, not facts', reason: 'set a constraint' })

check('judgment written', typeof j.node_id === 'string' && j.node_id !== '')
check('insight written', typeof i.node_id === 'string' && i.node_id !== '')
check('rule written', typeof r.node_id === 'string' || r.ok === true)

console.log('\n[the snapshot carries kind]')
const snap = buildSnapshot(lib.load().state)
check('the snapshot has 3 nodes', snap.nodes.length === 3, `actual ${snap.nodes.length}`)
const kinds = snap.nodes.map((n) => n.kind).sort()
check('all three kinds appear in the snapshot', kinds.join(',') === 'insight,judgment,rule', kinds.join(','))
check('every node has a kind field', snap.nodes.every((n) => typeof n.kind === 'string'))

console.log('\n[counts are tracked separately]')
const st = countStats(lib.load().state)
check('judgments counted separately', st.judgments === 1, `judgments=${st.judgments}`)
check('rules counted separately', st.rules === 1, `rules=${st.rules}`)
check('insights counted separately', st.insights === 1, `insights=${st.insights}`)

console.log('\n[insights take no part in supersession (a key design decision)]')
// A thought has no triple, so writing a second thought must not supersede the first
const i2 = ops.write({ text: 'Thought: or perhaps another angle is needed', kind: KIND.INSIGHT })
const st2 = countStats(lib.load().state)
check('the second insight did not supersede the first', st2.insights === 2, `insights=${st2.insights}`)
check('the first insight is still active', lib.load().state.nodes.get(i.node_id).status === 'active')
void i2

console.log('\n[judgments are still superseded (regression)]')
ops.write({ text: 'Judgment: the port changed to 9090', subject: 'svc', relation: 'port', object: '9090' })
const st3 = countStats(lib.load().state)
check('the old judgment was superseded', lib.load().state.nodes.get(j.node_id).status === 'superseded')
check('exactly 1 active judgment remains', st3.judgments === 1, `judgments=${st3.judgments}`)

console.log('\n[the client stylesheet covers all three kinds]')
const { readFileSync } = await import('node:fs')
const { fileURLToPath } = await import('node:url')
const { dirname } = await import('node:path')
const here = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
for (const k of ['judgment', 'insight', 'rule']) {
  check(`the stylesheet has ${k}`, new RegExp(`${k}:\\s*\\{`).test(clientSrc))
}
check('an unknown kind has a fallback style', /KIND_FALLBACK/.test(clientSrc))
// Explicit product requirement: "all of them ⚪" — shapes are unified to a circle, distinguished by color alone
check('all three kinds use a circular shape', (() => {
  const t = /const KIND_STYLE = Object\.freeze\(\{[\s\S]*?\n    \}\)/.exec(clientSrc)
  if (t === null) return false
  const shapes = [...t[0].matchAll(/shape:\s*'([a-z]+)'/g)].map((m) => m[1])
  return shapes.length === 3 && new Set(shapes).size === 1 && shapes[0] === 'circle'
})())
check('hit testing and drawing share the same extent factor', /shapeExtent\(kindStyle\(p\.node\.kind\)\.shape\)/.test(clientSrc))

rmSync(dir, { recursive: true, force: true })

console.log(`\n${'='.repeat(56)}`)
if (fails > 0) {
  console.log(`${fails} check(s) failed`)
  process.exit(1)
}
console.log('the data path for all three kinds is fully connected ✓')
