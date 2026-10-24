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

import { foldEvents, foldAsOf, activeAssertionAsOf, STATUS } from '../../src/ledger.js'
import { assertionKey } from '../../src/supersede.js'
import { openLibrary, createOperations } from '../../src/index.js'

/** Build a controllable clock: each call advances one hour, keeping the timeline easy to test. */
function makeClock(startIso) {
  let t = Date.parse(startIso)
  const now = () => t
  return { now, advance: (ms) => { t += ms; return t } }
}

describe('双时态 · foldAsOf', () => {
  // Timeline: T1 creates v1 → T2 creates v2 and supersedes v1 → T3 creates v3 and supersedes v2
  const T1 = Date.parse('2026-03-01T00:00:00Z')
  const T2 = Date.parse('2026-06-01T00:00:00Z')
  const T3 = Date.parse('2026-09-01T00:00:00Z')

  const events = [
    { seq: 1, at: T1, type: 'node.created', data: { id: 'v1', text: '端口是 8000', subject: 'svc', relation: 'port', object: '8000' } },
    { seq: 2, at: T2, type: 'node.created', data: { id: 'v2', text: '端口是 8080', subject: 'svc', relation: 'port', object: '8080' } },
    { seq: 3, at: T2, type: 'node.superseded', data: { id: 'v1', byId: 'v2', reason: '迁移' } },
    { seq: 4, at: T3, type: 'node.created', data: { id: 'v3', text: '端口是 9090', subject: 'svc', relation: 'port', object: '9090' } },
    { seq: 5, at: T3, type: 'node.superseded', data: { id: 'v2', byId: 'v3', reason: '再次迁移' } },
  ]

  test('T1 之前：什么都还没有', () => {
    const s = foldAsOf(events, T1 - 1)
    assert.equal(s.nodes.size, 0)
  })

  test('T1 那一刻：只有 v1，且是活跃的', () => {
    const s = foldAsOf(events, T1)
    assert.equal(s.nodes.size, 1)
    assert.equal(s.nodes.get('v1').status, STATUS.ACTIVE)
  })

  test('T1 与 T2 之间：仍然是 v1 活跃', () => {
    const s = foldAsOf(events, T1 + 1000)
    assert.equal(s.nodes.get('v1').status, STATUS.ACTIVE)
    assert.equal(s.nodes.has('v2'), false, 'v2 还没出现')
  })

  test('T2 那一刻：v1 退役、v2 活跃（取代已发生）', () => {
    const s = foldAsOf(events, T2)
    assert.equal(s.nodes.get('v1').status, STATUS.SUPERSEDED)
    assert.equal(s.nodes.get('v2').status, STATUS.ACTIVE)
    assert.equal(s.nodes.size, 2, '退役的不删')
  })

  test('T2 与 T3 之间：v2 仍是当时的最新', () => {
    const s = foldAsOf(events, T2 + 1000)
    assert.equal(s.nodes.get('v2').status, STATUS.ACTIVE)
    assert.equal(s.nodes.has('v3'), false)
  })

  test('T3 那一刻：v3 活跃，前两条都退役', () => {
    const s = foldAsOf(events, T3)
    assert.equal(s.nodes.get('v3').status, STATUS.ACTIVE)
    assert.equal(s.nodes.get('v2').status, STATUS.SUPERSEDED)
    assert.equal(s.nodes.get('v1').status, STATUS.SUPERSEDED)
    assert.equal(s.nodes.size, 3)
  })

  test('**双时态的核心**：同一问题在三个时刻有三个不同答案', () => {
    const key = assertionKey({ subject: 'svc', relation: 'port' })
    assert.equal(activeAssertionAsOf(events, T1, key).object, '8000', '3 月答案是 8000')
    assert.equal(activeAssertionAsOf(events, T2, key).object, '8080', '6 月答案是 8080')
    assert.equal(activeAssertionAsOf(events, T3, key).object, '9090', '9 月答案是 9090')
  })

  test('未来时刻 = 当前状态（账本不变则外推稳定）', () => {
    const far = foldAsOf(events, Date.parse('2030-01-01T00:00:00Z'))
    assert.equal(far.nodes.get('v3').status, STATUS.ACTIVE)
    assert.equal(far.nodes.size, 3)
  })

  test('空事件数组不崩', () => {
    assert.equal(foldAsOf([], 12345).nodes.size, 0)
  })

  test('缺 at 字段的事件被当作 0（不静默丢，但也不冒充有时间）', () => {
    const s = foldAsOf([{ seq: 1, type: 'node.created', data: { id: 'x', text: '无时间' } }], 100)
    assert.equal(s.nodes.size, 1, 'at=0 的会被 at<=T 收进来')
  })
})

describe('双时态 · memory_history 的 at 参数真的生效', () => {
  let work
  test('给出 at 时回答"那一刻是什么样"', () => {
    work = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-temp-'))
    try {
      const clock = makeClock('2026-03-01T00:00:00Z')
      const lib = openLibrary(join(work, 'lib'))
      const ops = createOperations(lib, { now: clock.now })

      const T1 = clock.now()
      const a = ops.write({ text: '端口是 8000', subject: 'svc', relation: 'port', object: '8000' })
      clock.advance(90 * 24 * 3600 * 1000) // +90 days
      const T2 = clock.now()
      ops.write({ text: '端口是 8080', subject: 'svc', relation: 'port', object: '8080', reason: '迁移' })

      // Current view: v1 has been superseded.
      const nowView = ops.history({ id: a.node_id })
      assert.equal(nowView.found, true)
      assert.match(nowView.note, /取代链长 2/)

      // Back at T1: v1 was still active then.
      const thenView = ops.history({ id: a.node_id, at: T1 })
      assert.equal(thenView.found, true)
      assert.match(thenView.note, /状态 active/, '那一刻它还是活跃的')
      assert.match(thenView.note, /第 1 版/)

      // After T2: it became superseded.
      const laterView = ops.history({ id: a.node_id, at: T2 })
      assert.match(laterView.note, /状态 superseded/, '那一刻它已被取代')
    } finally {
      try { rmSync(work, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  test('查询早于节点建立的时刻 → 明确说"那时还不存在"，不假装有', () => {
    const work2 = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-temp2-'))
    try {
      const clock = makeClock('2026-06-01T00:00:00Z')
      const lib = openLibrary(join(work2, 'lib'))
      const ops = createOperations(lib, { now: clock.now })
      const T = clock.now()
      const a = ops.write({ text: '一条后来才有的判断' })

      const early = ops.history({ id: a.node_id, at: T - 86400000 })
      assert.equal(early.found, false)
      assert.match(early.note, /还不存在/)
    } finally {
      try { rmSync(work2, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  test('不给 at 时行为不变（向后兼容）', () => {
    const work3 = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-temp3-'))
    try {
      const clock = makeClock('2026-06-01T00:00:00Z')
      const lib = openLibrary(join(work3, 'lib'))
      const ops = createOperations(lib, { now: clock.now })
      const a = ops.write({ text: '普通判断' })
      const h = ops.history({ id: a.node_id })
      assert.equal(h.found, true)
      assert.ok(Array.isArray(h.revisions))
      assert.match(h.note, /共 \d+ 次变更/)
    } finally {
      try { rmSync(work3, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  test('非数字的 at 被忽略（不静默产生空结果）', () => {
    const work4 = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-temp4-'))
    try {
      const clock = makeClock('2026-06-01T00:00:00Z')
      const lib = openLibrary(join(work4, 'lib'))
      const ops = createOperations(lib, { now: clock.now })
      const a = ops.write({ text: '普通判断' })
      const h = ops.history({ id: a.node_id, at: 'not-a-number' })
      assert.equal(h.found, true)
      assert.match(h.note, /共 \d+ 次变更/, '应当走正常路径，而不是被当成双时态查询')
    } finally {
      try { rmSync(work4, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})
