/**
 * Tests for the ledger and the supersession engine.
 *
 * Testing philosophy (following viya-memory's practice): **being importable does
 * not mean it runs**. Every assertion must actually fold an event sequence and
 * actually compute a verdict, rather than merely checking that a function
 * exists.
 *
 * The community-recognized "silent failure" paths get dedicated coverage too —
 * the most dangerous bug in a memory plugin is the one that raises no error.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  createState,
  applyEvent,
  foldEvents,
  activeNodes,
  nodeOf,
  backlinksOf,
  outlinksOf,
  supersedeChain,
  STATUS,
  KIND,
} from '../src/ledger.js'
import { normalizeComponent, assertionKey, classify, planWrite, makeNodeId } from '../src/supersede.js'

/** Build a node.created event, so each test does not repeat the whole shape. */
function created(seq, at, data) {
  return { seq, at, type: 'node.created', data }
}

describe('ledger · 折叠事件成状态', () => {
  test('空账本折叠出空状态，没有 problem', () => {
    const s = foldEvents([])
    assert.equal(s.nodes.size, 0)
    assert.deepEqual(s.problems, [])
  })

  test('node.created 建节点，默认 active 且 revision 1', () => {
    const s = foldEvents([created(1, 1000, { id: 'a', text: '我认为 X' })])
    const n = nodeOf(s, 'a')
    assert.ok(n)
    assert.equal(n.text, '我认为 X')
    assert.equal(n.status, STATUS.ACTIVE)
    assert.equal(n.revision, 1)
    assert.equal(n.validFrom, 1000)
    assert.equal(n.validTo, null)
    assert.equal(n.kind, KIND.JUDGMENT, '不指定 kind 时默认 judgment')
  })

  test('未知事件类型记进 problems，绝不静默吞掉', () => {
    const s = foldEvents([{ seq: 1, at: 1, type: 'node.exploded', data: {} }])
    assert.equal(s.problems.length, 1)
    assert.match(s.problems[0].reason, /未知事件类型/)
  })

  test('一条坏事件不让整个库读不出来（其余事件照常生效）', () => {
    const s = foldEvents([
      created(1, 10, { id: 'good', text: '好节点' }),
      { seq: 2, at: 20, type: 'nonsense', data: {} },
      created(3, 30, { id: 'also-good', text: '另一个好节点' }),
    ])
    assert.equal(s.nodes.size, 2, '两个好节点都要在')
    assert.equal(s.problems.length, 1, '坏事件被记录')
  })

  test('id 重复被记为 problem，不覆盖已有节点', () => {
    const s = foldEvents([
      created(1, 10, { id: 'dup', text: '第一版' }),
      created(2, 20, { id: 'dup', text: '想覆盖' }),
    ])
    assert.equal(nodeOf(s, 'dup').text, '第一版', '先到的赢，不被覆盖')
    assert.equal(s.problems.length, 1)
  })

  test('node.revised 保留历史，revision 递增', () => {
    const s = foldEvents([
      created(1, 10, { id: 'a', text: '初版' }),
      { seq: 2, at: 20, type: 'node.revised', data: { id: 'a', text: '改过的', reason: '措辞更准' } },
    ])
    const n = nodeOf(s, 'a')
    assert.equal(n.text, '改过的')
    assert.equal(n.revision, 2)
    assert.equal(n.history.length, 2)
    assert.equal(n.history[1].before, '初版')
    assert.equal(n.history[1].reason, '措辞更准')
  })
})

describe('ledger · 双时态取代（退役而不删除）', () => {
  test('node.superseded 关掉 valid_to 并记 supersededBy，节点仍在', () => {
    const s = foldEvents([
      created(1, 100, { id: 'old', text: '端口是 8000', subject: 'svc', relation: 'port', object: '8000' }),
      created(2, 200, { id: 'new', text: '端口是 8080', subject: 'svc', relation: 'port', object: '8080' }),
      { seq: 3, at: 200, type: 'node.superseded', data: { id: 'old', byId: 'new', reason: '迁移' } },
    ])
    const old = nodeOf(s, 'old')
    assert.equal(old.status, STATUS.SUPERSEDED)
    assert.equal(old.validTo, 200, 'valid_to 被关上')
    assert.equal(old.supersededBy, 'new')
    assert.ok(nodeOf(s, 'old'), '旧节点**仍在账本里**，没有删除')
    assert.equal(s.nodes.size, 2)
  })

  test('只有 active 节点参与检索', () => {
    const s = foldEvents([
      created(1, 100, { id: 'old', text: 'A' }),
      created(2, 200, { id: 'new', text: 'B' }),
      { seq: 3, at: 200, type: 'node.superseded', data: { id: 'old', byId: 'new' } },
    ])
    const act = activeNodes(s)
    assert.equal(act.length, 1)
    assert.equal(act[0].id, 'new')
  })

  test('取代链能一路追到底（进化轨迹）', () => {
    const s = foldEvents([
      created(1, 100, { id: 'v1', text: '第一版想法' }),
      created(2, 200, { id: 'v2', text: '第二版想法' }),
      created(3, 300, { id: 'v3', text: '第三版想法' }),
      { seq: 4, at: 200, type: 'node.superseded', data: { id: 'v1', byId: 'v2' } },
      { seq: 5, at: 300, type: 'node.superseded', data: { id: 'v2', byId: 'v3' } },
    ])
    const { chain, terminal } = supersedeChain(s, 'v1')
    assert.deepEqual(chain.map((n) => n.id), ['v1', 'v2', 'v3'])
    assert.equal(terminal.id, 'v3')
    assert.equal(terminal.status, STATUS.ACTIVE)
  })

  test('取代链有环也不会死循环（脏数据防护）', () => {
    const s = foldEvents([
      created(1, 100, { id: 'a', text: 'A' }),
      created(2, 200, { id: 'b', text: 'B' }),
      { seq: 3, at: 200, type: 'node.superseded', data: { id: 'a', byId: 'b' } },
      { seq: 4, at: 300, type: 'node.superseded', data: { id: 'b', byId: 'a' } },
    ])
    const { chain } = supersedeChain(s, 'a')
    assert.equal(chain.length, 2, '有环时停下，不无限循环')
  })

  test('node.withdrawn 是另一种退役（撤回，未被谁取代）', () => {
    const s = foldEvents([
      created(1, 10, { id: 'x', text: '我错了' }),
      { seq: 2, at: 20, type: 'node.withdrawn', data: { id: 'x', reason: '证据不足' } },
    ])
    const n = nodeOf(s, 'x')
    assert.equal(n.status, STATUS.WITHDRAWN)
    assert.equal(n.supersededBy, null, '撤回不等于被取代')
    assert.equal(activeNodes(s).length, 0)
  })

  test('取代指向不存在的节点 → problem，不崩', () => {
    const s = foldEvents([{ seq: 1, at: 1, type: 'node.superseded', data: { id: 'ghost', byId: 'nope' } }])
    assert.equal(s.problems.length, 1)
    assert.match(s.problems[0].reason, /不存在/)
  })
})

describe('ledger · 双链与反链', () => {
  const base = foldEvents([
    created(1, 10, { id: 'a', text: 'A' }),
    created(2, 20, { id: 'b', text: 'B' }),
    { seq: 3, at: 30, type: 'edge.linked', data: { from: 'a', to: 'b', type: 'complements' } },
  ])

  test('反向链接 = 谁引用了我', () => {
    const back = backlinksOf(base, 'b')
    assert.equal(back.length, 1)
    assert.equal(back[0].from, 'a')
    assert.equal(back[0].type, 'complements')
  })

  test('出链 = 我引用了谁', () => {
    const out = outlinksOf(base, 'a')
    assert.equal(out.length, 1)
    assert.equal(out[0].to, 'b')
  })

  test('同一对节点可以并存多种关系（互补与矛盾不互斥）', () => {
    const s = foldEvents([
      created(1, 10, { id: 'a', text: 'A' }),
      created(2, 20, { id: 'b', text: 'B' }),
      { seq: 3, at: 30, type: 'edge.linked', data: { from: 'a', to: 'b', type: 'complements' } },
      { seq: 4, at: 40, type: 'edge.linked', data: { from: 'a', to: 'b', type: 'tensions' } },
    ])
    assert.equal(s.edges.length, 2)
  })

  test('完全相同的边被去重', () => {
    const s = foldEvents([
      created(1, 10, { id: 'a', text: 'A' }),
      created(2, 20, { id: 'b', text: 'B' }),
      { seq: 3, at: 30, type: 'edge.linked', data: { from: 'a', to: 'b', type: 'related' } },
      { seq: 4, at: 40, type: 'edge.linked', data: { from: 'a', to: 'b', type: 'related' } },
    ])
    assert.equal(s.edges.length, 1)
  })

  test('自连被拒绝并记为 problem', () => {
    const s = foldEvents([
      created(1, 10, { id: 'a', text: 'A' }),
      { seq: 2, at: 20, type: 'edge.linked', data: { from: 'a', to: 'a' } },
    ])
    assert.equal(s.edges.length, 0)
    assert.equal(s.problems.length, 1)
  })

  test('指向不存在节点的边被拒（防单向悬空边）', () => {
    const s = foldEvents([created(1, 10, { id: 'a', text: 'A' }), { seq: 2, at: 20, type: 'edge.linked', data: { from: 'a', to: 'ghost' } }])
    assert.equal(s.edges.length, 0)
    assert.equal(s.problems.length, 1)
  })

  test('edge.unlinked 能解除指定关系', () => {
    const s = foldEvents([
      created(1, 10, { id: 'a', text: 'A' }),
      created(2, 20, { id: 'b', text: 'B' }),
      { seq: 3, at: 30, type: 'edge.linked', data: { from: 'a', to: 'b', type: 'complements' } },
      { seq: 4, at: 40, type: 'edge.linked', data: { from: 'a', to: 'b', type: 'tensions' } },
      { seq: 5, at: 50, type: 'edge.unlinked', data: { from: 'a', to: 'b', type: 'complements' } },
    ])
    assert.equal(s.edges.length, 1)
    assert.equal(s.edges[0].type, 'tensions')
  })
})

describe('supersede · 规范化', () => {
  test('全角与半角归一（中文场景关键）', () => {
    assert.equal(normalizeComponent('ＡＢＣ'), 'abc')
    assert.equal(normalizeComponent('abc'), 'abc')
  })

  test('大小写与空白压平', () => {
    assert.equal(normalizeComponent('  Hello   World  '), 'hello world')
  })

  test('非字符串得到空串（不抛）', () => {
    assert.equal(normalizeComponent(undefined), '')
    assert.equal(normalizeComponent(null), '')
    assert.equal(normalizeComponent(42), '')
  })

  test('缺任一分量则没有断言键', () => {
    assert.equal(assertionKey({ subject: 'a', relation: 'b' }), 'a\u0000b')
    assert.equal(assertionKey({ subject: 'a' }), null)
    assert.equal(assertionKey({ relation: 'b' }), null)
    assert.equal(assertionKey({}), null)
  })
})

describe('supersede · 确定性判定（本插件的核心）', () => {
  const existing = [
    { id: 'old', subject: 'svc', relation: 'port', object: '8000', status: 'active', text: '端口 8000' },
  ]

  test('同键不同 object → supersede（矛盾）', () => {
    const v = classify({ subject: 'svc', relation: 'port', object: '8080' }, existing)
    assert.equal(v.relation, 'supersede')
    assert.equal(v.target.id, 'old')
  })

  test('同键同 object → duplicate（复述）', () => {
    const v = classify({ subject: 'svc', relation: 'port', object: '8000' }, existing)
    assert.equal(v.relation, 'duplicate')
  })

  test('判定与"文字写得多像"完全无关 —— 这正是学术结论要求的', () => {
    // These two sentences are nearly identical in wording, but the object differs → this must be a contradiction
    const a = classify({ subject: 'svc', relation: 'port', object: '8000' }, existing)
    const b = classify({ subject: 'svc', relation: 'port', object: '8080' }, existing)
    assert.equal(a.relation, 'duplicate')
    assert.equal(b.relation, 'supersede')
    // Conversely: very different wording with the same object → still a restatement
    const c = classify(
      { subject: '服务', relation: '监听端口', object: '8000' },
      [{ id: 'x', subject: 'svc', relation: 'port', object: '8000', status: 'active' }],
    )
    assert.equal(c.relation, 'novel', '不同的 subject/relation 是不同断言，不该混为一谈')
  })

  test('不同键 → novel', () => {
    const v = classify({ subject: 'svc', relation: 'host', object: 'localhost' }, existing)
    assert.equal(v.relation, 'novel')
  })

  test('缺三元组 → unkeyed（不参与取代，但仍可存）', () => {
    const v = classify({ text: '一句没有三元组的判断' }, existing)
    assert.equal(v.relation, 'unkeyed')
  })
})

describe('supersede · planWrite 产生的事件', () => {
  const ctx = { at: 1000, nextSeq: 0, newId: 'n_new' }

  test('novel → 只产生 node.created', () => {
    const s = createState()
    const { events, outcome } = planWrite(s, { text: '新想法', subject: 'a', relation: 'b', object: 'c' }, ctx)
    assert.equal(outcome.action, 'created')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'node.created')
  })

  test('supersede → created + superseded + 一条 supersedes 边', () => {
    const s = foldEvents([created(1, 100, { id: 'old', text: '旧', subject: 'svc', relation: 'port', object: '8000' })])
    const { events, outcome } = planWrite(s, { text: '新', subject: 'svc', relation: 'port', object: '8080', reason: '迁移' }, ctx)
    assert.equal(outcome.action, 'supersede')
    assert.equal(outcome.supersededId, 'old')
    assert.deepEqual(events.map((e) => e.type), ['node.created', 'node.superseded', 'edge.linked'])
    assert.equal(events[2].data.type, 'supersedes')
  })

  test('duplicate → 不产生任何事件，不新建节点', () => {
    const s = foldEvents([created(1, 100, { id: 'old', text: '旧', subject: 'svc', relation: 'port', object: '8000' })])
    const { events, outcome } = planWrite(s, { text: '一样的话', subject: 'svc', relation: 'port', object: '8000' }, ctx)
    assert.equal(outcome.action, 'duplicate')
    assert.deepEqual(events, [], '复述不落盘')
    assert.equal(outcome.nodeId, 'old')
  })

  test('产生的全部事件 fold 后自洽（无 problem，状态正确）', () => {
    const s0 = foldEvents([created(1, 100, { id: 'old', text: '旧', subject: 'svc', relation: 'port', object: '8000' })])
    const { events } = planWrite(s0, { text: '新', subject: 'svc', relation: 'port', object: '8080' }, ctx)
    const s1 = foldEvents([
      created(1, 100, { id: 'old', text: '旧', subject: 'svc', relation: 'port', object: '8000' }),
      ...events,
    ])
    assert.deepEqual(s1.problems, [], '自己的输出喂回 fold 不能有 problem')
    assert.equal(activeNodes(s1).length, 1)
    assert.equal(nodeOf(s1, 'old').status, STATUS.SUPERSEDED)
    assert.equal(nodeOf(s1, 'n_new').status, STATUS.ACTIVE)
  })

  test('序号递增，不与既有事件撞号', () => {
    const s = foldEvents([created(1, 100, { id: 'old', text: '旧', subject: 'a', relation: 'b', object: '1' })])
    const { events } = planWrite(s, { text: '新', subject: 'a', relation: 'b', object: '2' }, { at: 200, nextSeq: 1, newId: 'x' })
    const seqs = events.map((e) => e.seq)
    assert.deepEqual(seqs, [2, 3, 4], '从 nextSeq 之后接着排')
  })
})

describe('supersede · id 生成', () => {
  test('同一时刻同一序号 → 可复现', () => {
    assert.equal(makeNodeId(1000, 7), makeNodeId(1000, 7))
  })

  test('不同序号 → 不同 id', () => {
    assert.notEqual(makeNodeId(1000, 7), makeNodeId(1000, 8))
  })
})

describe('静默失效专项（社区公认的头号危险）', () => {
  test('applyEvent 就地改同一个对象（fold 的 reduce 语义）', () => {
    const s = createState()
    const r = applyEvent(s, created(1, 1, { id: 'a', text: 'A' }))
    assert.equal(r, s, '必须返回同一个引用，否则 reduce 会丢状态')
    assert.equal(s.nodes.size, 1)
  })

  test('fold 不依赖事件数组的顺序之外的东西（纯函数）', () => {
    const evs = [created(1, 1, { id: 'a', text: 'A' }), created(2, 2, { id: 'b', text: 'B' })]
    const s1 = foldEvents(evs)
    const s2 = foldEvents(evs)
    assert.deepEqual([...s1.nodes.keys()], [...s2.nodes.keys()])
    assert.notEqual(s1, s2, '每次 fold 出新状态，不复用全局')
  })

  test('problems 是可观察的 —— 坏数据不会假装成功', () => {
    const s = foldEvents([{ seq: 1, at: 1, type: 'bogus', data: {} }])
    assert.ok(s.problems.length > 0, '有问题必须能看见')
  })
})
