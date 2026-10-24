/**
 * `trigger` 字段与 kind 白名单的回归测试。
 *
 * 补的是 UPGRADE-SPEC.md §0 里另外两处「已完成」改动的专用覆盖：
 *
 *   1. `node.created` 新增 `trigger`（user / evidence / self）。这是唯一让
 *      「它是不是在自己长」变成**可查**的字段 —— 没有它，进化只能靠感觉。
 *   2. kind 白名单从 `Object.values(KIND)` 改为 `NODE_KINDS`。旧写法把
 *      `persona` 也算了进去，于是 `memory_write({kind:'persona'})` 会写进账本
 *      再被静默折成 `judgment`，不报任何错。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openLibrary, createOperations } from '../../src/index.js'
import { KIND, NODE_KINDS, EVENT_TYPES } from '../../src/ledger.js'
import { foldEvents } from '../../src/ledger.js'

function withLibrary(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-am-trigger-'))
  try {
    let clock = 1_730_000_000_000
    const lib = openLibrary(dir)
    const ops = createOperations(lib, { now: () => (clock += 60_000) })
    return fn({ lib, ops })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('trigger · 谁发起了这个想法', () => {
  test('默认是 user（不传就是用户触发的，不假装是自发的）', () => {
    withLibrary(({ lib, ops }) => {
      const r = ops.write({ text: '一条普通判断', subject: 'a', relation: 'b', object: '1' })
      assert.equal(lib.load().state.nodes.get(r.node_id).trigger, 'user')
    })
  })

  test('显式 self 会被记录', () => {
    withLibrary(({ lib, ops }) => {
      const r = ops.write({
        text: '我自己想到的', kind: 'insight', subject: 'a', relation: 'b', object: '2', trigger: 'self', citations: [process.execPath],
      })
      assert.equal(lib.load().state.nodes.get(r.node_id).trigger, 'self')
    })
  })

  test('self 只能写 insight，不能写 judgment 或 rule', () => {
    withLibrary(({ ops }) => {
      assert.equal(ops.write({ text: 'bad rule', kind: 'rule', trigger: 'self', citations: [process.execPath] }).action, 'rejected')
      assert.equal(ops.write({ text: 'bad judgment', trigger: 'self', citations: [process.execPath] }).action, 'rejected')
    })
  })

  test('显式 evidence 会被记录', () => {
    withLibrary(({ lib, ops }) => {
      const r = ops.write({
        text: '被新证据推出来的', subject: 'a', relation: 'b', object: '3', trigger: 'evidence',
      })
      assert.equal(lib.load().state.nodes.get(r.node_id).trigger, 'evidence')
    })
  })

  test('无法识别的 trigger 值退回 user（不静默接受垃圾值）', () => {
    withLibrary(({ lib, ops }) => {
      const r = ops.write({
        text: '乱填的 trigger', subject: 'a', relation: 'b', object: '4', trigger: 'bogus',
      })
      assert.equal(lib.load().state.nodes.get(r.node_id).trigger, 'user')
    })
  })

  test('trigger 落进账本事件里（不只活在内存状态中）', () => {
    withLibrary(({ lib, ops }) => {
      ops.write({ text: 'x', kind: 'insight', subject: 'a', relation: 'b', object: '5', trigger: 'self', citations: [process.execPath] })
      const created = lib.load().events.filter((e) => e.type === 'node.created').pop()
      assert.equal(created.data.trigger, 'self')
    })
  })

  test('selfRatio 可算：3 条里 1 条 self → 1/3', () => {
    // 这条不测实现，只固定「用 trigger 算比例」这件事是可能的。
    withLibrary(({ lib, ops }) => {
      ops.write({ text: 'u1', subject: 'a', relation: 'r1', object: '1' })
      ops.write({ text: 'u2', subject: 'a', relation: 'r2', object: '2' })
      ops.write({ text: 's1', kind: 'insight', subject: 'a', relation: 'r3', object: '3', trigger: 'self', citations: [process.execPath] })
      const all = [...lib.load().state.nodes.values()]
      const selfCount = all.filter((n) => n.trigger === 'self').length
      assert.equal(selfCount, 1)
      assert.equal(all.length, 3)
    })
  })
})

describe('kind 白名单 · 单一来源，不再两处漂移', () => {
  test('NODE_KINDS 不含 persona（人格走独立的受治理通道）', () => {
    assert.ok(NODE_KINDS.includes(KIND.JUDGMENT))
    assert.ok(NODE_KINDS.includes(KIND.RULE))
    assert.ok(NODE_KINDS.includes(KIND.INSIGHT))
    assert.ok(!NODE_KINDS.includes(KIND.PERSONA), 'persona 不是节点类型')
  })

  test('**kind=persona 不再静默降级**：要么被拒，要么至少留下 problem', () => {
    // 旧行为：账本写 persona、fold 成 judgment、零错误。这是最坏的一种失败。
    const events = [{
      seq: 1, at: 100, type: 'node.created',
      data: { id: 'p1', kind: 'persona', text: '想当个人格' },
    }]
    const state = foldEvents(events)
    const node = state.nodes.get('p1')
    assert.equal(node.kind, KIND.JUDGMENT, '记录不能丢，所以仍然降级存储')
    assert.ok(
      state.problems.length > 0,
      '但必须留下 problem —— 静默降级正是要消灭的失败模式',
    )
    assert.ok(state.problems.some((p) => p.reason.includes('persona')))
  })

  test('拼错的 kind 留下 problem（以前完全无声）', () => {
    const events = [{
      seq: 1, at: 100, type: 'node.created',
      data: { id: 'x1', kind: 'insite', text: '拼错了' },
    }]
    const state = foldEvents(events)
    assert.equal(state.nodes.get('x1').kind, KIND.JUDGMENT)
    assert.ok(state.problems.some((p) => p.reason.includes('insite')))
  })

  test('三个合法 kind 都不留 problem', () => {
    const events = [
      { seq: 1, at: 100, type: 'node.created', data: { id: 'j', kind: 'judgment', text: 'a' } },
      { seq: 2, at: 100, type: 'node.created', data: { id: 'r', kind: 'rule', text: 'b' } },
      { seq: 3, at: 100, type: 'node.created', data: { id: 'i', kind: 'insight', text: 'c' } },
    ]
    const state = foldEvents(events)
    assert.deepEqual(state.problems, [])
    assert.equal(state.nodes.get('j').kind, KIND.JUDGMENT)
    assert.equal(state.nodes.get('r').kind, KIND.RULE)
    assert.equal(state.nodes.get('i').kind, KIND.INSIGHT)
  })

  test('insight 带三元组也不参与取代（刻意设计：想法不该被判定为矛盾）', () => {
    withLibrary(({ lib, ops }) => {
      const j = ops.write({ text: '端口是 8000', subject: 'svc', relation: 'port', object: '8000' })
      const i = ops.write({
        text: '端口可能是 9000', kind: 'insight',
        subject: 'svc', relation: 'port', object: '9000',
      })
      assert.equal(i.action, 'created', 'insight 不该触发取代')
      const state = lib.load().state
      assert.equal(state.nodes.get(j.node_id).status, 'active')
      assert.equal(state.nodes.get(i.node_id).status, 'active')
    })
  })
})

describe('新增事件类型已注册', () => {
  test('question.* 与 cycle.* 都在 EVENT_TYPES 里', () => {
    for (const t of [
      'question.opened', 'question.touched', 'question.closed', 'question.abandoned',
      'cycle.started', 'cycle.ended',
    ]) {
      assert.ok(EVENT_TYPES.includes(t), `${t} 必须注册，否则会被当成未知事件丢进 problems`)
    }
  })

  test('未注册的事件类型仍然留下 problem（不静默吞掉）', () => {
    const state = foldEvents([{ seq: 1, at: 1, type: 'question.invented', data: {} }])
    assert.ok(state.problems.length > 0)
  })
})
