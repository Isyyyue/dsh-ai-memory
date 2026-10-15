/**
 * 双时态查询的测试。
 *
 * 这是账本式存储换来的**核心能力** —— 文件式记忆做不到：
 * 「3 月的时候我认为端口是多少？」「这条判断在被推翻之前是什么样？」
 *
 * 依据：账本只追加，所以任意时刻的状态都是「它之前事件前缀」的纯函数。
 * 这不是近似，是精确重建 —— 正合 DSH 官方「一切必须能从已提交事件重建」那条原则。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { foldEvents, foldAsOf, activeAssertionAsOf, STATUS } from '../src/ledger.js'
import { assertionKey } from '../src/supersede.js'
import { openLibrary, createOperations } from '../src/index.js'

/** 造一个可控时钟：每次调用前进一小时，让时间轴清晰可测。 */
function makeClock(startIso) {
  let t = Date.parse(startIso)
  const now = () => t
  return { now, advance: (ms) => { t += ms; return t } }
}

describe('双时态 · foldAsOf', () => {
  // 时间轴：T1 建 v1 → T2 建 v2 并取代 v1 → T3 建 v3 并取代 v2
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
      clock.advance(90 * 24 * 3600 * 1000) // +90 天
      const T2 = clock.now()
      ops.write({ text: '端口是 8080', subject: 'svc', relation: 'port', object: '8080', reason: '迁移' })

      // 当前视角：v1 已被取代
      const nowView = ops.history({ id: a.node_id })
      assert.equal(nowView.found, true)
      assert.match(nowView.note, /取代链长 2/)

      // 回到 T1：那时 v1 还是活跃的
      const thenView = ops.history({ id: a.node_id, at: T1 })
      assert.equal(thenView.found, true)
      assert.match(thenView.note, /状态 active/, '那一刻它还是活跃的')
      assert.match(thenView.note, /第 1 版/)

      // T2 之后：它变成 superseded
      const laterView = ops.history({ id: a.node_id, at: T2 })
      assert.match(laterView.note, /状态 superseded/, '那一刻它已被取代')
    } finally {
      try { rmSync(work, { recursive: true, force: true }) } catch { /* 忽略 */ }
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
      try { rmSync(work2, { recursive: true, force: true }) } catch { /* 忽略 */ }
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
      try { rmSync(work3, { recursive: true, force: true }) } catch { /* 忽略 */ }
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
      try { rmSync(work4, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  })
})
