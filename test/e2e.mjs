/**
 * End-to-end verification: run the whole lifecycle against a **real memory-store path**.
 *
 * This is not a unit test — it verifies "once installed into a profile, does it
 * behave correctly in a real environment":
 *   write → search → supersede → history → bidirectional links → rule governance →
 *   graph snapshot → stats
 * Every step asserts; a single wrong step exits non-zero.
 *
 * Uses a temporary directory and never touches the real data in ~/.dsh/ai-memory.
 *
 * Note: the Chinese fixture strings below are kept byte-identical and written as
 * `\u` escapes, which keeps this source ASCII-only. Several of them are the payload
 * of the Chinese-search checks (a judgment's own text is what
 * `ops.search({ query: ... })` has to hit), so rewording them would change what
 * those checks exercise.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openLibrary, createOperations, buildIndexText } from '../src/index.js'
import { buildSnapshot } from '../src/graph.js'

const work = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-e2e-'))
let failures = 0
let checks = 0

/** Assert and print. */
function check(label, cond, extra = '') {
  checks += 1
  if (cond) {
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`)
  } else {
    failures += 1
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

let t = 1_700_000_000_000
const now = () => (t += 60_000)

try {
  const lib = openLibrary(work)
  const ops = createOperations(lib, { now })

  console.log('\n[1] Forming a judgment')
  const j1 = ops.write({ text: '\u6211\u8ba4\u4e3a\u786e\u5b9a\u6027\u53d6\u4ee3\u6bd4\u76f8\u4f3c\u5ea6\u9608\u503c\u53ef\u9760', subject: 'supersede', relation: '\u4f18\u4e8e', object: 'similarity', tags: ['\u8bb0\u5fc6'], citations: ['arXiv 2606.26511'] })
  check('write succeeded', j1.action === 'created', j1.node_id)
  check('the ledger really hit disk', lib.load().state.nodes.size === 1)

  console.log('\n[2] Search before write (search first, then write)')
  const s1 = ops.search({ query: '\u53d6\u4ee3' })
  check('a Chinese query hits', s1.total >= 1, `total=${s1.total}`)
  const s2 = ops.search({ query: '\u4e0d\u5b58\u5728\u7684\u8bcd\u6c47xyz' })
  check('no hits is reported honestly as 0', s2.total === 0)

  console.log('\n[3] Deterministic supersession (the core)')
  const j2 = ops.write({ text: '\u7aef\u53e3\u662f 8000', subject: 'svc', relation: 'port', object: '8000' })
  const j3 = ops.write({ text: '\u7aef\u53e3\u662f 8080', subject: 'svc', relation: 'port', object: '8080', reason: '\u670d\u52a1\u8fc1\u79fb\u4e86' })
  check('same key, different object → supersede', j3.action === 'supersede', `${j2.node_id} → ${j3.node_id}`)
  check('the old judgment is retired', lib.load().state.nodes.get(j2.node_id).status === 'superseded')
  check('the old judgment **is still in the ledger** (bi-temporal, not deleted)', lib.load().state.nodes.has(j2.node_id))
  check('the new judgment is active', lib.load().state.nodes.get(j3.node_id).status === 'active')

  console.log('\n[4] A restatement is not written (so one idea does not pile up into a dozen cards)')
  const dup = ops.write({ text: '\u7aef\u53e3\u8fd8\u662f 8080', subject: 'svc', relation: 'port', object: '8080' })
  check('same key, same object → duplicate', dup.action === 'duplicate')
  check('no node was created', lib.load().state.nodes.size === 3, `nodes=${lib.load().state.nodes.size}`)

  console.log('\n[5] Search looks at active nodes only by default')
  const s3 = ops.search({ query: '\u7aef\u53e3' })
  check('only active ones are returned by default', s3.total === 1, `total=${s3.total}`)
  const s4 = ops.search({ query: '\u7aef\u53e3', include_retired: true })
  check('retired ones are visible when asked for', s4.total === 2, `total=${s4.total}`)

  console.log('\n[6] Evolution history (provenance is visible)')
  const h = ops.history({ id: j2.node_id })
  check('history is found', h.found === true)
  check('the supersession chain runs to its end', h.chain.length === 2, `chain=${h.chain.length}`)
  check('the chain tail is the currently active node', h.chain[h.chain.length - 1].status === 'active')

  console.log('\n[7] Bidirectional links (visible from both sides)')
  const c = ops.connect({ from: j1.node_id, to: j3.node_id, type: 'complements', note: '\u4e24\u6761\u90fd\u652f\u6301\u540c\u4e00\u53d6\u5411' })
  check('the link was created', c.ok === true)
  const state = lib.load().state
  // Note: supersession **automatically** creates a supersedes edge (the graph has to
  // show who superseded whom), so the edge count here is 2 rather than 1 — the
  // supersession in step 3 contributed the other one.
  check('both the auto-created supersedes edge and the manual edge are present', state.edges.length === 2, `edges=${state.edges.length}`)
  check('there is a supersedes edge', state.edges.some((e) => e.type === 'supersedes'))
  check('there is a complements edge', state.edges.some((e) => e.type === 'complements'))
  check('the outlink is visible', state.edges.filter((e) => e.from === j1.node_id).length === 1)
  check('the backlink is visible', state.edges.filter((e) => e.to === j3.node_id).length === 1)

  console.log('\n[8] Rule governance (changing a rule requires a reason)')
  const noReason = ops.rule({ action: 'amend', id: 'r1', text: '\u8981\u5199\u5224\u65ad', reason: '' })
  check('a missing reason is refused (the precondition for auditability)', noReason.ok === false)
  const made = ops.rule({ action: 'amend', id: 'r1', text: '\u53ea\u5199\u5224\u65ad\uff0c\u4e0d\u5199\u4e8b\u5b9e', reason: '\u521d\u59cb\u5efa\u7acb' })
  check('with a reason it can be created', made.ok === true)
  const rid = made.rules[0].id
  ops.rule({ action: 'amend', id: rid, text: '\u53ea\u5199\u5224\u65ad\uff0c\u4e0d\u5199\u4e8b\u5b9e\uff1b\u5199\u4e0d\u51fa\u5c31\u4e0d\u5199', reason: '\u8865\u4e0a"\u4e0d\u5199"\u7684\u8fb9\u754c' })
  const read = ops.rule({ action: 'read' })
  check('the rule advanced to revision 2', read.rules[0].revision === 2)
  check('the change history is on record (rollback-able)', read.rules[0].history.length >= 2)

  console.log('\n[9] Graph snapshot (the navigation layer; no full text)')
  const snap = buildSnapshot(lib.load().state)
  check('the snapshot has nodes', snap.nodes.length > 0, `nodes=${snap.nodes.length}`)
  check('nodes carry a degree', snap.nodes.every((n) => typeof n.degree === 'number'))
  check('nodes carry no full text (a label only)', snap.nodes.every((n) => n.text === undefined))
  const withRetired = buildSnapshot(lib.load().state, { includeRetired: true })
  // Supersession edges require a retired endpoint, so they belong only in
  // the history view. Active-to-active semantic links may still be visible.
  check('默认视图只包含活跃节点', snap.nodes.every((n) => n.status === 'active'))
  check('历史视图包含退役节点', withRetired.nodes.length > snap.nodes.length, `${snap.nodes.length} → ${withRetired.nodes.length}`)
  check('取代关系只出现在历史视图', !snap.edges.some((e) => e.type === 'supersedes') && withRetired.edges.some((e) => e.type === 'supersedes'))

  console.log('\n[10] Stats and injection')
  const st = ops.stats()
  check('the retired count is reported', st.retired >= 1, `retired=${st.retired}`)
  check('the rule count is reported', st.rules === 1)
  check('no data problems', st.problems.length === 0, st.problems.join('; '))
  const idx = buildIndexText(lib, 40)
  check('the injected text contains the rule', idx.includes('\u53ea\u5199\u5224\u65ad'))
  check('the injected text contains the judgment', idx.includes('\u786e\u5b9a\u6027\u53d6\u4ee3'))
  check('what is injected is an index, not full text (bounded length)', idx.length < 3000, `${idx.length} chars`)

  console.log('\n[11] Persistence (still readable after the process reopens)')
  const lib2 = openLibrary(work)
  const ops2 = createOperations(lib2, { now })
  check('the judgment is still there after reopening', ops2.search({ query: '\u53d6\u4ee3' }).total >= 1)
  check('the superseded status is still there after reopening', lib2.load().state.nodes.get(j2.node_id).status === 'superseded')
  check('both links are still there after reopening (supersedes + complements)', lib2.load().state.edges.length === 2, `edges=${lib2.load().state.edges.length}`)
} finally {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log(`\n${'='.repeat(60)}`)
console.log(`End-to-end verification: ${checks - failures}/${checks} passed`)
if (failures > 0) {
  console.log(`${failures} failed`)
  process.exit(1)
}
console.log('all passed ✓')
