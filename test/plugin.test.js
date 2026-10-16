/**
 * Integration-layer tests: config unwrapping, the six operations, index
 * injection, graph snapshots, and HTTP route security.
 *
 * This layer is where failures go silent most easily, so it gets dedicated
 * coverage:
 *   - volatile box unwrapping (viya-memory measured cards being written into
 *     `[object Object]`)
 *   - a missing `inject` declaration (the whole plugin fails to activate and
 *     reports no error)
 *   - the routes' origin checks (`/plugins/*` does not pass session cookie
 *     validation)
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig, openLibrary, createOperations, buildIndexText } from '../src/index.js'
import { buildSnapshot, countStats, nodeDetail } from '../src/graph.js'
import { createRoutes, isLoopback, originMatchesHost, ROUTE_BASE, WORKER_FILE } from '../src/routes.js'
import { foldEvents } from '../src/ledger.js'

const here = dirname(fileURLToPath(import.meta.url))

let work
let lib

before(() => {
  work = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-int-'))
  lib = openLibrary(work)
})

after(() => {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* ignore */ }
})

/** Build a controllable clock so ids and timestamps are reproducible. */
function clock(start = 1_700_000_000_000) {
  let t = start
  return () => (t += 1000)
}

describe('config · unwrapping (the volatile box trap)', () => {
  test('a plain object is read directly', () => {
    const c = resolveConfig({ dir: '/tmp/x', maxIndexEntries: 5 })
    assert.equal(c.dir, '/tmp/x')
    assert.equal(c.maxIndexEntries, 5)
  })

  test('a { get() } box is unwrapped — leaving it boxed yields "[object Object]"', () => {
    const c = resolveConfig({
      dir: { get: () => '/tmp/boxed' },
      maxIndexEntries: { get: () => 7 },
      injectIndex: { get: () => false },
    })
    assert.equal(c.dir, '/tmp/boxed')
    assert.equal(c.maxIndexEntries, 7)
    assert.equal(c.injectIndex, false)
  })

  test('a throwing get() falls back to the default instead of crashing', () => {
    const c = resolveConfig({ dir: { get: () => { throw new Error('boom') } } })
    assert.ok(typeof c.dir === 'string' && c.dir !== '' && !c.dir.includes('object'))
  })

  test('an invalid number falls back to the default (NaN must not take effect silently)', () => {
    assert.equal(resolveConfig({ maxIndexEntries: 'abc' }).maxIndexEntries, 40)
    assert.equal(resolveConfig({ maxIndexEntries: -1 }).maxIndexEntries, 40)
    assert.equal(resolveConfig({ maxGraphNodes: 0 }).maxGraphNodes, 500)
  })

  test('undefined / null config uses defaults', () => {
    const c = resolveConfig(undefined)
    assert.equal(c.enabled, true)
    assert.equal(c.injectIndex, true)
    assert.ok(c.dir.includes('ai-memory'))
  })

  test('enabled: false is recognized', () => {
    assert.equal(resolveConfig({ enabled: false }).enabled, false)
    assert.equal(resolveConfig({ enabled: { get: () => false } }).enabled, false)
  })
})

describe('operations · write / supersede / restatement', () => {
  test('a first write is created', () => {
    const l = openLibrary(join(work, 'ops1'))
    const ops = createOperations(l, { now: clock() })
    const r = ops.write({ text: 'I hold that deterministic supersession beats a similarity threshold' })
    assert.equal(r.action, 'created')
    assert.ok(r.node_id)
  })

  test('same triple, different object → supersede, and the old node is retired but kept', () => {
    const l = openLibrary(join(work, 'ops2'))
    const ops = createOperations(l, { now: clock() })
    const a = ops.write({ text: 'the port is 8000', subject: 'svc', relation: 'port', object: '8000' })
    const b = ops.write({ text: 'the port is 8080', subject: 'svc', relation: 'port', object: '8080', reason: 'migration' })
    assert.equal(b.action, 'supersede')
    assert.equal(b.superseded_id, a.node_id)

    const { state } = l.load()
    assert.equal(state.nodes.get(a.node_id).status, 'superseded', 'the old one is retired')
    assert.equal(state.nodes.get(b.node_id).status, 'active')
    assert.equal(state.nodes.size, 2, 'the old one stays in the ledger (bi-temporal, never deleted)')
  })

  test('same triple, same object → duplicate, nothing written to disk', () => {
    const l = openLibrary(join(work, 'ops3'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: 'the port is 8000', subject: 'svc', relation: 'port', object: '8000' })
    const before = l.load().state.nodes.size
    const dup = ops.write({ text: '8000 again', subject: 'svc', relation: 'port', object: '8000' })
    assert.equal(dup.action, 'duplicate')
    assert.equal(l.load().state.nodes.size, before, 'a restatement creates no node')
  })

  test('an empty judgment is rejected', () => {
    const l = openLibrary(join(work, 'ops4'))
    const ops = createOperations(l, { now: clock() })
    assert.equal(ops.write({ text: '   ' }).action, 'rejected')
  })

  test('a write really persists (it can be read after reopening)', () => {
    const dir = join(work, 'ops5')
    const ops1 = createOperations(openLibrary(dir), { now: clock() })
    ops1.write({ text: 'a judgment that will persist' })
    const ops2 = createOperations(openLibrary(dir), { now: clock() })
    const s = ops2.search({ query: 'persist' })
    assert.equal(s.total, 1)
  })
})

describe('operations · search and connect', () => {
  test('a query matches the stored judgment', () => {
    const l = openLibrary(join(work, 'ops6'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: 'the graph only navigates; it carries no facts' })
    assert.equal(ops.search({ query: 'navigates' }).total, 1)
  })

  test('retired judgments are not returned by default', () => {
    const l = openLibrary(join(work, 'ops7'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: 'older description', subject: 'a', relation: 'b', object: '1' })
    ops.write({ text: 'newer description', subject: 'a', relation: 'b', object: '2' })
    const activeOnly = ops.search({ query: 'description' })
    assert.equal(activeOnly.total, 1, 'by default only active ones are considered')
    const withRetired = ops.search({ query: 'description', include_retired: true })
    assert.equal(withRetired.total, 2, 'retired ones are visible on request')
  })

  test('link two judgments', () => {
    const l = openLibrary(join(work, 'ops8'))
    const ops = createOperations(l, { now: clock() })
    const a = ops.write({ text: 'judgment A' })
    const b = ops.write({ text: 'judgment B' })
    const r = ops.connect({ from: a.node_id, to: b.node_id, type: 'complements', note: 'they reinforce each other' })
    assert.equal(r.ok, true)
    const s = l.load().state
    assert.equal(s.edges.length, 1)
    assert.equal(s.edges[0].type, 'complements')
  })

  test('linking a nonexistent id → an explicit failure, not silence', () => {
    const l = openLibrary(join(work, 'ops9'))
    const ops = createOperations(l, { now: clock() })
    const a = ops.write({ text: 'A' })
    const r = ops.connect({ from: a.node_id, to: 'nope' })
    assert.equal(r.ok, false)
    assert.match(r.note, /找不到判断/)
  })

  test('a self-link is rejected', () => {
    const l = openLibrary(join(work, 'ops10'))
    const ops = createOperations(l, { now: clock() })
    const a = ops.write({ text: 'A' })
    assert.equal(ops.connect({ from: a.node_id, to: a.node_id }).ok, false)
  })
})

describe('operations · provenance', () => {
  test('history shows the supersession chain and revision history', () => {
    const l = openLibrary(join(work, 'ops11'))
    const ops = createOperations(l, { now: clock() })
    const a = ops.write({ text: 'version one', subject: 's', relation: 'r', object: '1' })
    const b = ops.write({ text: 'version two', subject: 's', relation: 'r', object: '2' })
    ops.write({ text: 'version three', subject: 's', relation: 'r', object: '3' })

    const h = ops.history({ id: a.node_id })
    assert.equal(h.found, true)
    assert.equal(h.chain.length, 3, 'the supersession chain is walked to its end')
    assert.equal(h.chain[2].status, 'active')
    assert.equal(h.chain[0].status, 'superseded')
  })

  test('history says so explicitly when the id is not found', () => {
    const l = openLibrary(join(work, 'ops12'))
    const ops = createOperations(l, { now: clock() })
    assert.equal(ops.history({ id: 'ghost' }).found, false)
  })
})

describe('operations · rule governance', () => {
  test('read on an empty store returns an empty list', () => {
    const l = openLibrary(join(work, 'rule1'))
    const ops = createOperations(l, { now: clock() })
    const r = ops.rule({ action: 'read' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.rules, [])
  })

  test('amending a rule requires a reason — without one the change is refused (the precondition for auditability)', () => {
    const l = openLibrary(join(work, 'rule2'))
    const ops = createOperations(l, { now: clock() })
    const r = ops.rule({ action: 'amend', id: 'r1', text: 'new rule', reason: '' })
    assert.equal(r.ok, false)
    assert.match(r.note, /reason/)
  })

  test('a rule can be created and read back', () => {
    const l = openLibrary(join(work, 'rule3'))
    const ops = createOperations(l, { now: clock() })
    const made = ops.rule({ action: 'amend', id: 'r1', text: 'Write judgments, not facts', reason: 'initial' })
    assert.equal(made.ok, true)
    const read = ops.rule({ action: 'read' })
    assert.equal(read.rules.length, 1)
    assert.equal(read.rules[0].text, 'Write judgments, not facts')
  })

  test('amending a rule repeatedly increments revision and leaves history', () => {
    const l = openLibrary(join(work, 'rule4'))
    const ops = createOperations(l, { now: clock() })
    const made = ops.rule({ action: 'amend', id: 'r1', text: 'rule version one', reason: 'created' })
    const id = made.rules[0].id
    ops.rule({ action: 'amend', id, text: 'rule version two', reason: 'the first version was too broad' })
    const read = ops.rule({ action: 'read' })
    assert.equal(read.rules[0].text, 'rule version two')
    assert.equal(read.rules[0].revision, 2)
    assert.ok(read.rules[0].history.length >= 2, 'history must be on record (so it can be rolled back)')
  })

  test('rules and judgments are counted separately', () => {
    const l = openLibrary(join(work, 'rule5'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: 'a judgment' })
    ops.rule({ action: 'amend', id: 'r1', text: 'a rule', reason: 'created' })
    const s = ops.stats()
    assert.equal(s.judgments, 1)
    assert.equal(s.rules, 1)
  })
})

describe('operations · persona growth', () => {
  test('a proposed trait stays provisional until explicitly accepted', () => {
    const l = openLibrary(join(work, 'persona1'))
    const ops = createOperations(l, { now: clock() })
    const p = ops.persona({ action: 'propose', text: '会自然使用鱼类拟声词', evidence: ['用户多次使用“噗”'], confidence: 0.7 })
    assert.equal(p.ok, true)
    assert.equal(ops.persona({ action: 'read' }).active.length, 0)
    assert.equal(ops.persona({ action: 'read' }).candidates.length, 1)
    assert.equal(buildIndexText(l, 40), '', '未确认候选不应进入普通会话注入')
  })

  test('accept, revise and reject are all recorded in the trait history', () => {
    const l = openLibrary(join(work, 'persona2'))
    const ops = createOperations(l, { now: clock() })
    const p = ops.persona({ action: 'propose', text: '喜欢自然使用“噗”', reason: 'observed' })
    assert.equal(ops.persona({ action: 'accept', id: p.id, reason: '用户明确认可' }).status, 'active')
    assert.equal(ops.persona({ action: 'revise', id: p.id, text: '喜欢自然使用“噗”和鱼类拟声词，但不机械重复', reason: '表达需要更自然' }).action, 'revised')
    const read = ops.persona({ action: 'read' })
    assert.equal(read.active[0].history.length, 3)
    assert.match(buildIndexText(l, 40), /已确认的人格/)

    const q = ops.persona({ action: 'propose', text: '每句话都重复同一个口头禅' })
    assert.equal(ops.persona({ action: 'reject', id: q.id, reason: '会让表达僵硬' }).status, 'rejected')
    assert.equal(ops.stats().persona, 1)
    assert.equal(ops.stats().persona_candidates, 0)
    assert.equal(ops.stats().persona_rejected, 1)
  })

  test('changing a trait without a reason is refused', () => {
    const l = openLibrary(join(work, 'persona3'))
    const ops = createOperations(l, { now: clock() })
    const p = ops.persona({ action: 'propose', text: '会观察用户喜欢的词语' })
    assert.equal(ops.persona({ action: 'accept', id: p.id }).ok, false)
  })

  test('personality candidates can cite concrete memories and appear in search', () => {
    const l = openLibrary(join(work, 'persona4'))
    const ops = createOperations(l, { now: clock() })
    const memory = ops.write({ text: '我喜欢自然地使用鱼类拟声词' })
    const p = ops.persona({ action: 'propose', text: '会自然使用鱼类拟声词', source_ids: [memory.node_id] })
    assert.equal(p.ok, true)
    const found = ops.search({ query: '拟声词' })
    assert.ok(found.results.some((r) => r.id === p.id && r.kind === 'persona'))
    assert.deepEqual(ops.persona({ action: 'read' }).candidates[0].source_ids, [memory.node_id])
    const reflection = ops.reflect({ limit: 5 })
    assert.equal(reflection.ok, true)
    assert.ok(reflection.memories.some((m) => m.id === memory.node_id))
    assert.match(reflection.instruction, /source_ids/)
  })

  test('invalid personality state transitions are refused', () => {
    const l = openLibrary(join(work, 'persona5'))
    const ops = createOperations(l, { now: clock() })
    const p = ops.persona({ action: 'propose', text: '候选特征' })
    assert.equal(ops.persona({ action: 'accept', id: p.id, reason: '确认' }).status, 'active')
    assert.equal(ops.persona({ action: 'accept', id: p.id, reason: '重复确认' }).ok, false)
    assert.equal(ops.persona({ action: 'reject', id: p.id, reason: '拒绝已确认特征' }).ok, false)
    assert.equal(ops.persona({ action: 'revise', id: p.id, text: '修订后的特征', reason: '反馈' }).ok, true)
  })
})

describe('operations · stats', () => {
  test('an empty store is honestly empty; it does not pretend to have content', () => {
    const l = openLibrary(join(work, 'stats1'))
    const ops = createOperations(l, { now: clock() })
    const s = ops.stats()
    assert.equal(s.judgments, 0)
    assert.equal(s.orphans, 0)
    assert.match(s.note, /空的/)
  })

  test('orphan judgments are counted', () => {
    const l = openLibrary(join(work, 'stats2'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: 'one lonely judgment' })
    assert.equal(ops.stats().orphans, 1)
  })

  test('a node is no longer an orphan once linked', () => {
    const l = openLibrary(join(work, 'stats3'))
    const ops = createOperations(l, { now: clock() })
    const a = ops.write({ text: 'A' })
    const b = ops.write({ text: 'B' })
    ops.connect({ from: a.node_id, to: b.node_id })
    assert.equal(ops.stats().orphans, 0)
  })
})

describe('index text · injected at session start', () => {
  test('an empty store injects an empty string (costing no context)', () => {
    const l = openLibrary(join(work, 'idx1'))
    assert.equal(buildIndexText(l, 40), '')
  })

  test('with judgments present, rules and judgment summaries are injected', () => {
    const l = openLibrary(join(work, 'idx2'))
    const ops = createOperations(l, { now: clock() })
    ops.rule({ action: 'amend', id: 'r1', text: 'Write judgments, not facts', reason: 'created' })
    ops.write({ text: 'The graph only navigates; it carries no facts' })
    const text = buildIndexText(l, 40)
    assert.match(text, /规矩（你给自己定的/)
    assert.match(text, /Write judgments, not facts/)
    assert.match(text, /graph only navigates/)
  })

  test('an index is injected, not full text — long bodies are truncated (guarding against context bloat)', () => {
    const l = openLibrary(join(work, 'idx3'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: 'a very long judgment'.repeat(200) })
    const text = buildIndexText(l, 40)
    assert.ok(text.length < 2000, `the injection must not carry the full text; actual ${text.length}`)
  })

  test('maxEntries takes effect', () => {
    const l = openLibrary(join(work, 'idx4'))
    const ops = createOperations(l, { now: clock() })
    for (let i = 0; i < 10; i += 1) ops.write({ text: `judgment number ${i}` })
    const text = buildIndexText(l, 3)
    assert.match(text, /此处列前 3 条/)
  })

  test('**insights are injected too** — otherwise writing one is pointless', () => {
    const l = openLibrary(join(work, 'idx5'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: 'Insight: maybe the problem is not the port', kind: 'insight' })
    const text = buildIndexText(l, 40)
    // The whole point of an insight is being recalled; without injection it just sits unread in the ledger.
    assert.match(text, /maybe the problem is not the port/)
    assert.match(text, /Insight/)
  })

  test('all three kinds can appear in the injection at once, in clearly separated sections', () => {
    const l = openLibrary(join(work, 'idx6'))
    const ops = createOperations(l, { now: clock() })
    ops.rule({ action: 'amend', id: 'r1', text: 'Rule: write judgments only', reason: 'created' })
    ops.write({ text: 'Judgment: the port is 8080', subject: 'svc', relation: 'port', object: '8080' })
    ops.write({ text: 'Insight: perhaps another angle is needed', kind: 'insight' })
    const text = buildIndexText(l, 40)
    assert.match(text, /规矩（你给自己定的/)
    assert.match(text, /活跃判断（共 1 条）/)
    assert.match(text, /还没成形到能当判断的想法/)
  })

  test('insights get a smaller budget (they must not crowd out judgments)', () => {
    const l = openLibrary(join(work, 'idx7'))
    const ops = createOperations(l, { now: clock() })
    for (let i = 0; i < 10; i += 1) ops.write({ text: `insight number ${i}`, kind: 'insight' })
    // maxEntries=4 → an insight budget of 2
    const text = buildIndexText(l, 4)
    assert.match(text, /此处列最新 2 条/)
  })
})

describe('graph · snapshot (a navigation layer, no full text)', () => {
  test('an empty store yields an empty snapshot', () => {
    const s = buildSnapshot(foldEvents([]))
    assert.deepEqual(s.nodes, [])
    assert.deepEqual(s.edges, [])
  })

  test('nodes carry label / status / degree, never full text', () => {
    const l = openLibrary(join(work, 'g1'))
    const ops = createOperations(l, { now: clock() })
    const a = ops.write({ text: 'judgment A'.repeat(100) })
    const b = ops.write({ text: 'judgment B' })
    ops.connect({ from: a.node_id, to: b.node_id })
    const snap = buildSnapshot(l.load().state)
    assert.equal(snap.nodes.length, 2)
    assert.equal(snap.edges.length, 1)
    const na = snap.nodes.find((n) => n.id === a.node_id)
    assert.equal(na.degree, 1, 'degree is computed')
    assert.ok(na.label.length <= 61, 'the label is a summary, not the full text')
    assert.equal(na.text, undefined, 'must not carry full text')
  })

  test('the default view draws **active nodes only** (retired ones simply disappear — an explicit product requirement)', () => {
    const l = openLibrary(join(work, 'g2'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: 'old', subject: 'a', relation: 'b', object: '1' })
    ops.write({ text: 'new', subject: 'a', relation: 'b', object: '2' })
    const def = buildSnapshot(l.load().state)
    // ⚠️ This assertion **changed twice**, both times because the rendered graph
    //   corrected the design:
    //   1. It first asserted `nodes.length === 1` — the result was a blank
    //      "1 node · 0 links" graph, because every supersedes edge points at a
    //      retired node, so filtering retired nodes filters out every edge.
    //   2. The default then carried the whole supersession chain — the graph was
    //      readable but covered in grey dots, prompting "why are some grey and
    //      some white".
    //   3. Final decision: default to **active only**. The graph is "what I
    //      believe now", not "what I have historically thought". The evolution
    //      history is one right-click away via `?retired=1`.
    assert.equal(def.nodes.length, 1, 'only the active one should be present by default')
    assert.equal(def.nodes[0].status, 'active')
    assert.equal(def.edges.length, 0, 'with no edges between active nodes there are 0 (clean)')
  })

  test('only on request (includeRetired) does the **whole** supersession chain appear', () => {
    const l = openLibrary(join(work, 'g2b'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: 'v1', subject: 'x', relation: 'y', object: '1' })
    ops.write({ text: 'v2', subject: 'x', relation: 'y', object: '2' })
    ops.write({ text: 'v3', subject: 'x', relation: 'y', object: '3' })
    const def = buildSnapshot(l.load().state)
    assert.equal(def.nodes.length, 1, 'by default only the newest generation')
    const all = buildSnapshot(l.load().state, { includeRetired: true })
    assert.equal(all.nodes.length, 3, 'all three generations are present on request (that is the evolution history)')
    assert.equal(all.edges.length, 2, 'both supersession edges are present')
  })

  test('includeRetired returns every node (including retired orphans not in any supersession chain)', () => {
    const l = openLibrary(join(work, 'g2c'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: 'the superseded one', subject: 'a', relation: 'b', object: '1' })
    ops.write({ text: 'the one that superseded it', subject: 'a', relation: 'b', object: '2' })
    ops.write({ text: 'a third judgment unrelated to the supersession chain' })
    const def = buildSnapshot(l.load().state)
    const all = buildSnapshot(l.load().state, { includeRetired: true })
    assert.equal(all.nodes.length, 3, 'includeRetired contains all 3')
    assert.ok(def.nodes.length <= all.nodes.length)
  })

  test('maxNodes truncates and flags truncated', () => {
    const l = openLibrary(join(work, 'g3'))
    const ops = createOperations(l, { now: clock() })
    for (let i = 0; i < 5; i += 1) ops.write({ text: `judgment ${i}` })
    const snap = buildSnapshot(l.load().state, { maxNodes: 2 })
    assert.equal(snap.nodes.length, 2)
    assert.equal(snap.truncated, true)
  })

  test('after truncation only edges with both endpoints in the graph are kept', () => {
    const l = openLibrary(join(work, 'g4'))
    const ops = createOperations(l, { now: clock() })
    const a = ops.write({ text: 'A' })
    const b = ops.write({ text: 'B' })
    ops.connect({ from: a.node_id, to: b.node_id })
    const snap = buildSnapshot(l.load().state, { maxNodes: 1 })
    assert.equal(snap.edges.length, 0, 'an edge with a truncated endpoint must not remain')
  })

  test('countStats counts correctly', () => {
    const l = openLibrary(join(work, 'g5'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: 'old', subject: 'a', relation: 'b', object: '1' })
    ops.write({ text: 'new', subject: 'a', relation: 'b', object: '2' })
    ops.rule({ action: 'amend', id: 'r', text: 'a rule', reason: 'x' })
    const c = countStats(l.load().state)
    assert.equal(c.active, 2)
    assert.equal(c.retired, 1)
    assert.equal(c.judgments, 1)
    assert.equal(c.rules, 1)
  })

  test('graph snapshot and stats include confirmed personality traits', () => {
    const l = openLibrary(join(work, 'g7'))
    const ops = createOperations(l, { now: clock() })
    const memory = ops.write({ text: '用户喜欢自然的鱼类拟声词' })
    const p = ops.persona({ action: 'propose', text: '会自然使用鱼类拟声词', source_ids: [memory.node_id] })
    ops.persona({ action: 'accept', id: p.id, reason: '用户确认' })

    const state = l.load().state
    const snap = buildSnapshot(state)
    assert.ok(snap.nodes.some((n) => n.id === p.id && n.kind === 'persona'))
    assert.ok(snap.edges.some((e) => e.from === p.id && e.to === memory.node_id && e.type === 'inferred-from'))
    assert.equal(snap.stats.persona, 1)
    assert.equal(countStats(state).persona, 1)
    assert.equal(nodeDetail(state, p.id).kind, 'persona')
  })

  test('nodeDetail returns backlinks and the supersession chain (the core of explainability)', () => {
    const l = openLibrary(join(work, 'g6'))
    const ops = createOperations(l, { now: clock() })
    const a = ops.write({ text: 'A', subject: 's', relation: 'r', object: '1' })
    const b = ops.write({ text: 'B', subject: 's', relation: 'r', object: '2' })
    const d = nodeDetail(l.load().state, a.node_id)
    assert.equal(d.supersededBy, b.node_id)
    assert.equal(d.chain.length, 2)
    assert.ok(d.history.length >= 2)
  })

  test('nodeDetail returns null when not found', () => {
    assert.equal(nodeDetail(foldEvents([]), 'ghost'), null)
  })
})

describe('routes · security (/plugins/* does not pass session cookie validation)', () => {
  test('loopback address detection', () => {
    assert.equal(isLoopback('127.0.0.1'), true)
    assert.equal(isLoopback('::1'), true)
    assert.equal(isLoopback('::ffff:127.0.0.1'), true)
    assert.equal(isLoopback('192.168.1.5'), false)
    assert.equal(isLoopback(undefined), false)
  })

  test('same-origin detection', () => {
    assert.equal(originMatchesHost('http://127.0.0.1:19387', '127.0.0.1:19387'), true)
    assert.equal(originMatchesHost('http://evil.com', '127.0.0.1:19387'), false)
    assert.equal(originMatchesHost('not-a-url', '127.0.0.1:19387'), false)
  })

  test('a non-loopback source is rejected with 403', () => {
    const l = openLibrary(join(work, 'r1'))
    const routes = createRoutes(l)
    const res = fakeRes()
    routes[0].handler({ url: '/x', socket: { remoteAddress: '10.0.0.9' }, headers: {} }, res)
    assert.equal(res.statusCode, 403)
    assert.match(res.body, /回环/)
  })

  test('a cross-origin Origin header is rejected with 403', () => {
    const l = openLibrary(join(work, 'r2'))
    const routes = createRoutes(l)
    const res = fakeRes()
    routes[0].handler(
      { url: '/x', socket: { remoteAddress: '127.0.0.1' }, headers: { origin: 'http://evil.com', host: '127.0.0.1:19387' } },
      res,
    )
    assert.equal(res.statusCode, 403)
  })

  test('loopback + same-origin → 200 with a snapshot', () => {
    const l = openLibrary(join(work, 'r3'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: 'a judgment' })
    const routes = createRoutes(l)
    const res = fakeRes()
    byPath(routes, `${ROUTE_BASE}/snapshot`).handler(
      { url: `${ROUTE_BASE}/snapshot`, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:19387' } },
      res,
    )
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.nodes.length, 1)
  })

  test('a missing Origin header is treated as same-origin (curl / local probing)', () => {
    const l = openLibrary(join(work, 'r4'))
    const routes = createRoutes(l)
    const res = fakeRes()
    byPath(routes, `${ROUTE_BASE}/stats`).handler(
      { url: `${ROUTE_BASE}/stats`, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:19387' } },
      res,
    )
    assert.equal(res.statusCode, 200)
  })

  test('all three data routes (the worker goes through DSH\'s own chunk route) carry the /plugins/dsh-ai-memory prefix', () => {
    const routes = createRoutes(openLibrary(join(work, 'r5')))
    assert.equal(routes.length, 3)
    for (const r of routes) {
      assert.ok(r.path.startsWith(ROUTE_BASE), `${r.path} must start with ${ROUTE_BASE}`)
      assert.equal(r.kind, 'exact')
    }
  })

  test('/node returns ok:false rather than 500 when not found', () => {
    const l = openLibrary(join(work, 'r6'))
    const routes = createRoutes(l)
    const res = fakeRes()
    byPath(routes, `${ROUTE_BASE}/node`).handler(
      { url: `${ROUTE_BASE}/node?id=ghost`, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'h' } },
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(JSON.parse(res.body).ok, false)
  })

  test('a corrupt memory store yields 500 rather than crashing the process', () => {
    const bad = {
      load() {
        throw new Error('disk failure')
      },
    }
    const routes = createRoutes(bad)
    const res = fakeRes()
    byPath(routes, `${ROUTE_BASE}/snapshot`).handler(
      { url: `${ROUTE_BASE}/snapshot`, socket: { remoteAddress: '127.0.0.1' }, headers: {} },
      res,
    )
    assert.equal(res.statusCode, 500)
    assert.match(res.body, /读取记忆库失败/)
  })
})

describe('routes · the worker goes through DSH\'s own chunk route (no route of our own)', () => {
  test('the worker file name follows client-modules chunk naming convention', () => {
    // The regex comes from dsh-client-modules/lib/index.js:169
    const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/
    assert.ok(CLIENT_CHUNK.test(WORKER_FILE), `${WORKER_FILE} should match ${CLIENT_CHUNK}`)
  })

  test('the worker file actually exists under lib/ (a correct name is useless without the file)', () => {
    const p = join(here, '..', 'lib', WORKER_FILE)
    assert.ok(existsSync(p), `cannot find ${p}`)
  })

  test('this plugin does **not** register its own worker route (the official channel is better)', () => {
    const routes = createRoutes(openLibrary(join(work, 'w1')))
    const paths = routes.map((r) => r.path)
    assert.ok(!paths.some((p) => p.includes('graph-worker')), `there should be no worker route; actual: ${paths.join(', ')}`)
    assert.equal(routes.length, 3, 'only three data endpoints remain')
  })

  test('the worker source contains a force-directed implementation and physics constants', () => {
    const src = readFileSync(join(here, '..', 'lib', WORKER_FILE), 'utf8')
    assert.ok(src.includes('self.onmessage'), 'an onmessage entry point is required')
    assert.ok(/function tick/.test(src), 'a tick implementation is required')
    assert.ok(/ALPHA_DECAY/.test(src), 'an alpha decay constant is required')
    assert.ok(/linkDistance/.test(src), 'a linkDistance parameter is required')
  })

  test('the worker imports nothing (a Worker has no module resolution)', () => {
    const src = readFileSync(join(here, '..', 'lib', WORKER_FILE), 'utf8')
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    assert.ok(!/^\s*import\s/m.test(stripped), 'must not contain import')
    assert.ok(!/require\(/.test(stripped), 'must not contain require')
  })
})

/** Look up a route by path (no array index — adding a route cannot break these tests). */
function byPath(routes, path) {
  const r = routes.find((x) => x.path === path)
  assert.ok(r, `cannot find route ${path} (present: ${routes.map((x) => x.path).join(', ')})`)
  return r
}

/** Build a minimal fake res that records status code and body. */
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(chunk) {
      this.body = chunk ?? ''
    },
  }
}
