/**
 * Tests for bi-temporal queries.
 *
 * This is the **core capability** that ledger storage buys and file-based memory
 * cannot provide: "what did I think the port was back in March?", "what did this
 * judgment look like before it was overturned?"
 *
 * The basis: the ledger is append-only, so the state at any instant is a pure
 * function of the event prefix before it. That is not an approximation but an exact
 * reconstruction — matching DSH's official principle that everything must be
 * rebuildable from committed events.
 *
 * Note: the Chinese fixture strings below are kept byte-identical and written as
 * `\u` escapes, which keeps this source ASCII-only. They stand in for arbitrary
 * judgment bodies and supersession reasons.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { foldEvents, foldAsOf, activeAssertionAsOf, STATUS } from '../src/ledger.js'
import { assertionKey } from '../src/supersede.js'
import { openLibrary, createOperations } from '../src/index.js'

/** Build a controllable clock: each call advances one hour, keeping the timeline easy to test. */
function makeClock(startIso) {
  let t = Date.parse(startIso)
  const now = () => t
  return { now, advance: (ms) => { t += ms; return t } }
}

describe('bi-temporal · foldAsOf', () => {
  // Timeline: T1 creates v1 → T2 creates v2 and supersedes v1 → T3 creates v3 and supersedes v2
  const T1 = Date.parse('2026-03-01T00:00:00Z')
  const T2 = Date.parse('2026-06-01T00:00:00Z')
  const T3 = Date.parse('2026-09-01T00:00:00Z')

  const events = [
    { seq: 1, at: T1, type: 'node.created', data: { id: 'v1', text: '\u7aef\u53e3\u662f 8000', subject: 'svc', relation: 'port', object: '8000' } },
    { seq: 2, at: T2, type: 'node.created', data: { id: 'v2', text: '\u7aef\u53e3\u662f 8080', subject: 'svc', relation: 'port', object: '8080' } },
    { seq: 3, at: T2, type: 'node.superseded', data: { id: 'v1', byId: 'v2', reason: '\u8fc1\u79fb' } },
    { seq: 4, at: T3, type: 'node.created', data: { id: 'v3', text: '\u7aef\u53e3\u662f 9090', subject: 'svc', relation: 'port', object: '9090' } },
    { seq: 5, at: T3, type: 'node.superseded', data: { id: 'v2', byId: 'v3', reason: '\u518d\u6b21\u8fc1\u79fb' } },
  ]

  test('before T1: nothing exists yet', () => {
    const s = foldAsOf(events, T1 - 1)
    assert.equal(s.nodes.size, 0)
  })

  test('at T1: only v1, and it is active', () => {
    const s = foldAsOf(events, T1)
    assert.equal(s.nodes.size, 1)
    assert.equal(s.nodes.get('v1').status, STATUS.ACTIVE)
  })

  test('between T1 and T2: v1 is still active', () => {
    const s = foldAsOf(events, T1 + 1000)
    assert.equal(s.nodes.get('v1').status, STATUS.ACTIVE)
    assert.equal(s.nodes.has('v2'), false, 'v2 has not appeared yet')
  })

  test('at T2: v1 is retired and v2 is active (the supersession has happened)', () => {
    const s = foldAsOf(events, T2)
    assert.equal(s.nodes.get('v1').status, STATUS.SUPERSEDED)
    assert.equal(s.nodes.get('v2').status, STATUS.ACTIVE)
    assert.equal(s.nodes.size, 2, 'retired nodes are not deleted')
  })

  test('between T2 and T3: v2 is still the latest as of then', () => {
    const s = foldAsOf(events, T2 + 1000)
    assert.equal(s.nodes.get('v2').status, STATUS.ACTIVE)
    assert.equal(s.nodes.has('v3'), false)
  })

  test('at T3: v3 is active and the first two are both retired', () => {
    const s = foldAsOf(events, T3)
    assert.equal(s.nodes.get('v3').status, STATUS.ACTIVE)
    assert.equal(s.nodes.get('v2').status, STATUS.SUPERSEDED)
    assert.equal(s.nodes.get('v1').status, STATUS.SUPERSEDED)
    assert.equal(s.nodes.size, 3)
  })

  test('**the heart of bi-temporality**: the same question has three different answers at three instants', () => {
    const key = assertionKey({ subject: 'svc', relation: 'port' })
    assert.equal(activeAssertionAsOf(events, T1, key).object, '8000', 'the March answer is 8000')
    assert.equal(activeAssertionAsOf(events, T2, key).object, '8080', 'the June answer is 8080')
    assert.equal(activeAssertionAsOf(events, T3, key).object, '9090', 'the September answer is 9090')
  })

  test('a future instant = the current state (extrapolation is stable while the ledger is unchanged)', () => {
    const far = foldAsOf(events, Date.parse('2030-01-01T00:00:00Z'))
    assert.equal(far.nodes.get('v3').status, STATUS.ACTIVE)
    assert.equal(far.nodes.size, 3)
  })

  test('an empty event array does not crash', () => {
    assert.equal(foldAsOf([], 12345).nodes.size, 0)
  })

  test('an event missing the at field is treated as 0 (not silently dropped, but not pretending to have a time either)', () => {
    const s = foldAsOf([{ seq: 1, type: 'node.created', data: { id: 'x', text: '\u65e0\u65f6\u95f4' } }], 100)
    assert.equal(s.nodes.size, 1, 'at=0 events are collected by at<=T')
  })
})

describe('bi-temporal · the at parameter of memory_history really takes effect', () => {
  let work
  test('given at, it answers "what did it look like at that instant"', () => {
    work = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-temp-'))
    try {
      const clock = makeClock('2026-03-01T00:00:00Z')
      const lib = openLibrary(join(work, 'lib'))
      const ops = createOperations(lib, { now: clock.now })

      const T1 = clock.now()
      const a = ops.write({ text: '\u7aef\u53e3\u662f 8000', subject: 'svc', relation: 'port', object: '8000' })
      clock.advance(90 * 24 * 3600 * 1000) // +90 days
      const T2 = clock.now()
      ops.write({ text: '\u7aef\u53e3\u662f 8080', subject: 'svc', relation: 'port', object: '8080', reason: '\u8fc1\u79fb' })

      // Current view: v1 has been superseded.
      const nowView = ops.history({ id: a.node_id })
      assert.equal(nowView.found, true)
      assert.match(nowView.note, /supersession chain length 2/)

      // Back at T1: v1 was still active then.
      const thenView = ops.history({ id: a.node_id, at: T1 })
      assert.equal(thenView.found, true)
      assert.match(thenView.note, /status active/, 'at that instant it was still active')
      assert.match(thenView.note, /revision 1/)

      // After T2: it became superseded.
      const laterView = ops.history({ id: a.node_id, at: T2 })
      assert.match(laterView.note, /status superseded/, 'at that instant it had already been superseded')
    } finally {
      try { rmSync(work, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  test('a query earlier than the node was created → says plainly "it did not exist yet", without pretending', () => {
    const work2 = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-temp2-'))
    try {
      const clock = makeClock('2026-06-01T00:00:00Z')
      const lib = openLibrary(join(work2, 'lib'))
      const ops = createOperations(lib, { now: clock.now })
      const T = clock.now()
      const a = ops.write({ text: '\u4e00\u6761\u540e\u6765\u624d\u6709\u7684\u5224\u65ad' })

      const early = ops.history({ id: a.node_id, at: T - 86400000 })
      assert.equal(early.found, false)
      assert.match(early.note, /did not exist yet/)
    } finally {
      try { rmSync(work2, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  test('with no at, behaviour is unchanged (backward compatible)', () => {
    const work3 = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-temp3-'))
    try {
      const clock = makeClock('2026-06-01T00:00:00Z')
      const lib = openLibrary(join(work3, 'lib'))
      const ops = createOperations(lib, { now: clock.now })
      const a = ops.write({ text: '\u666e\u901a\u5224\u65ad' })
      const h = ops.history({ id: a.node_id })
      assert.equal(h.found, true)
      assert.ok(Array.isArray(h.revisions))
      assert.match(h.note, /change\(s\)/)
    } finally {
      try { rmSync(work3, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  test('a non-numeric at is ignored (it must not silently produce an empty result)', () => {
    const work4 = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-temp4-'))
    try {
      const clock = makeClock('2026-06-01T00:00:00Z')
      const lib = openLibrary(join(work4, 'lib'))
      const ops = createOperations(lib, { now: clock.now })
      const a = ops.write({ text: '\u666e\u901a\u5224\u65ad' })
      const h = ops.history({ id: a.node_id, at: 'not-a-number' })
      assert.equal(h.found, true)
      assert.match(h.note, /change\(s\)/, 'it must take the normal path rather than be treated as a bi-temporal query')
    } finally {
      try { rmSync(work4, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})
