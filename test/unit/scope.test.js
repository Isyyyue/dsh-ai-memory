/**
 * 断言键第三维 `scope` 的回归测试。
 *
 * 这些测试补的是 UPGRADE-SPEC.md §0 里「已完成、不要重做」那批改动的专用
 * 覆盖。在此之前，302 项测试全绿只能证明**旧行为没被破坏**，不能证明
 * scope 这条新维度是对的 —— `grep scope test/` 命中的 6 处全是「作用域」
 * 这个词，与断言键无关。
 *
 * 核心要防的错：`(subject, relation)` 只有两维时，同一主语只能有一个活答案，
 * 于是「dev 用 8000」「prod 用 8080」会被压成「我改主意了」，账本上留下一条
 * 根本不存在的改变。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openLibrary, createOperations } from '../../src/index.js'
import { assertionKey, classify, planWrite } from '../../src/supersede.js'
import { foldEvents, activeNodes } from '../../src/ledger.js'

/** 建一个用完即删的临时记忆库。 */
function withLibrary(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-am-scope-'))
  try {
    let clock = 1_730_000_000_000
    const lib = openLibrary(dir)
    const ops = createOperations(lib, { now: () => (clock += 60_000) })
    return fn({ lib, ops })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('assertionKey · scope 是第三维', () => {
  test('空 scope 与旧格式**逐字节相同**（老账本与外部调用方的兼容底线）', () => {
    // 无条件追加分隔符会让所有外部传入的 key 静默失效，这一条是硬约束。
    assert.equal(assertionKey({ subject: 'a', relation: 'b' }), 'a\u0000b')
    assert.equal(assertionKey({ subject: 'a', relation: 'b', scope: '' }), 'a\u0000b')
    assert.equal(assertionKey({ subject: 'a', relation: 'b', scope: '   ' }), 'a\u0000b')
  })

  test('有 scope 时是第三段', () => {
    assert.equal(assertionKey({ subject: 'a', relation: 'b', scope: 'dev' }), 'a\u0000b\u0000dev')
  })

  test('同 subject/relation、不同 scope → 不同的键', () => {
    const dev = assertionKey({ subject: 'svc', relation: 'port', scope: 'dev' })
    const prod = assertionKey({ subject: 'svc', relation: 'port', scope: 'prod' })
    assert.notEqual(dev, prod)
  })

  test('subject 或 relation 缺失时仍然没有键（scope 不能凭空造出一个断言）', () => {
    assert.equal(assertionKey({ subject: 'a', scope: 'dev' }), null)
    assert.equal(assertionKey({ relation: 'b', scope: 'dev' }), null)
    assert.equal(assertionKey({ scope: 'dev' }), null)
  })

  test('scope 也做 NFKC + 小写 + 空白折叠（与其它分量同一套规范化）', () => {
    const a = assertionKey({ subject: 'S', relation: 'R', scope: 'DEV' })
    const b = assertionKey({ subject: 's', relation: 'r', scope: ' dev ' })
    assert.equal(a, b)
  })
})

describe('scope · 不同语境的两个答案可以并存（本改动的全部意义）', () => {
  test('dev 8000 与 prod 8080 **两条都 active**，谁也不取代谁', () => {
    withLibrary(({ lib, ops }) => {
      const dev = ops.write({
        text: '开发环境端口 8000',
        subject: 'svc', relation: 'port', object: '8000', scope: 'dev',
      })
      const prod = ops.write({
        text: '生产端口 8080',
        subject: 'svc', relation: 'port', object: '8080', scope: 'prod',
      })

      assert.equal(dev.action, 'created')
      // 关键断言：第二条必须是 created，不能是 supersede
      assert.equal(prod.action, 'created', '不同 scope 不该触发取代')
      assert.equal(prod.superseded_id, undefined, '不该有被取代的节点')

      const state = lib.load().state
      assert.equal(state.nodes.get(dev.node_id).status, 'active')
      assert.equal(state.nodes.get(prod.node_id).status, 'active')
      assert.equal(activeNodes(state).length, 2)
    })
  })

  test('**同一 scope 内**不同 object 才 supersede', () => {
    withLibrary(({ lib, ops }) => {
      const first = ops.write({
        text: 'dev 端口 8000', subject: 'svc', relation: 'port', object: '8000', scope: 'dev',
      })
      const second = ops.write({
        text: 'dev 端口 8080', subject: 'svc', relation: 'port', object: '8080', scope: 'dev',
        reason: '实测改了',
      })

      assert.equal(second.action, 'supersede')
      assert.equal(second.superseded_id, first.node_id)

      const state = lib.load().state
      assert.equal(state.nodes.get(first.node_id).status, 'superseded')
      assert.equal(state.nodes.get(second.node_id).status, 'active')
    })
  })

  test('全局（无 scope）与 scoped 可以并存，且互不取代', () => {
    withLibrary(({ lib, ops }) => {
      const global = ops.write({
        text: '默认端口 8000', subject: 'svc', relation: 'port', object: '8000',
      })
      const prod = ops.write({
        text: '生产端口 8080', subject: 'svc', relation: 'port', object: '8080', scope: 'prod',
      })

      assert.equal(global.action, 'created')
      assert.equal(prod.action, 'created', 'scoped 不该取代全局')

      const state = lib.load().state
      assert.equal(activeNodes(state).length, 2)
    })
  })

  test('老账本（全无 scope）行为完全不变：同键不同 object 仍然取代', () => {
    // 这条是回归保护：改动前所有数据都是这个形状，行为不能变。
    withLibrary(({ lib, ops }) => {
      const a = ops.write({ text: '端口 8000', subject: 'svc', relation: 'port', object: '8000' })
      const b = ops.write({ text: '端口 8080', subject: 'svc', relation: 'port', object: '8080' })
      assert.equal(b.action, 'supersede')
      assert.equal(b.superseded_id, a.node_id)
    })
  })
})

describe('classify · 同键多活跃时取最新的那条', () => {
  test('取代目标是 createdAt 最大的，不是 Map 里的第一条', () => {
    // 原实现 `sameKey = n` 每轮覆盖，实际留下的是**最旧**那条。
    const active = [
      { id: 'oldest', subject: 'svc', relation: 'port', object: '1', status: 'active', createdAt: 100 },
      { id: 'newest', subject: 'svc', relation: 'port', object: '2', status: 'active', createdAt: 900 },
      { id: 'middle', subject: 'svc', relation: 'port', object: '3', status: 'active', createdAt: 500 },
    ]
    const verdict = classify({ subject: 'svc', relation: 'port', object: '9' }, active)
    assert.equal(verdict.relation, 'supersede')
    assert.equal(verdict.target.id, 'newest')
  })

  test('不同 scope 的节点不参与同一键的比较', () => {
    const active = [
      { id: 'dev', subject: 'svc', relation: 'port', object: '8000', scope: 'dev', status: 'active', createdAt: 100 },
    ]
    const verdict = classify({ subject: 'svc', relation: 'port', object: '8080', scope: 'prod' }, active)
    assert.equal(verdict.relation, 'novel', '不同 scope 是不同断言')
  })

  test('同 scope 同 object 仍是 duplicate（复述不新建节点）', () => {
    const active = [
      { id: 'x', subject: 'svc', relation: 'port', object: '8000', scope: 'dev', status: 'active', createdAt: 100 },
    ]
    const verdict = classify({ subject: 'svc', relation: 'port', object: '8000', scope: 'dev' }, active)
    assert.equal(verdict.relation, 'duplicate')
    assert.equal(verdict.target.id, 'x')
  })
})

describe('scope · planWrite 把 scope 写进事件', () => {
  test('node.created 的 data 带 scope，fold 后节点也带', () => {
    const state = foldEvents([])
    const { events } = planWrite(
      state,
      { text: 'dev 端口', subject: 'svc', relation: 'port', object: '8000', scope: 'dev' },
      { at: 100, nextSeq: 0, newId: 'n1' },
    )
    const created = events.find((e) => e.type === 'node.created')
    assert.equal(created.data.scope, 'dev')

    const folded = foldEvents(events)
    assert.equal(folded.nodes.get('n1').scope, 'dev')
  })

  test('没给 scope 时事件里是空串，不是 undefined（避免 JSON 里字段消失）', () => {
    const state = foldEvents([])
    const { events } = planWrite(
      state,
      { text: '全局', subject: 'svc', relation: 'port', object: '8000' },
      { at: 100, nextSeq: 0, newId: 'n2' },
    )
    const created = events.find((e) => e.type === 'node.created')
    assert.equal(created.data.scope, '')
    assert.equal(foldEvents(events).nodes.get('n2').scope, '')
  })
})
