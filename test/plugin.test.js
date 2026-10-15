/**
 * 集成层测试：配置解包、六个操作、索引注入、图谱快照、HTTP 路由安全。
 *
 * 这一层是最容易"静默失效"的地方 —— 所以专门覆盖：
 *   - volatile 盒子对象解包（viya-memory 实测把卡写进 `[object Object]` 的坑）
 *   - 缺 inject 声明（插件整条不激活且不报错）
 *   - 路由的来源检查（/plugins/* 不过会话 cookie 校验）
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
  try { rmSync(work, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

/** 造一个可控时钟，让 id 与时间戳可复现。 */
function clock(start = 1_700_000_000_000) {
  let t = start
  return () => (t += 1000)
}

describe('config · 解包（volatile 盒子对象的坑）', () => {
  test('普通对象直接读', () => {
    const c = resolveConfig({ dir: '/tmp/x', maxIndexEntries: 5 })
    assert.equal(c.dir, '/tmp/x')
    assert.equal(c.maxIndexEntries, 5)
  })

  test('{ get() } 盒子被解包 —— 不解包会得到 "[object Object]"', () => {
    const c = resolveConfig({
      dir: { get: () => '/tmp/boxed' },
      maxIndexEntries: { get: () => 7 },
      injectIndex: { get: () => false },
    })
    assert.equal(c.dir, '/tmp/boxed')
    assert.equal(c.maxIndexEntries, 7)
    assert.equal(c.injectIndex, false)
  })

  test('get() 抛异常时回落默认值，不崩', () => {
    const c = resolveConfig({ dir: { get: () => { throw new Error('boom') } } })
    assert.ok(typeof c.dir === 'string' && c.dir !== '' && !c.dir.includes('object'))
  })

  test('非法数字回落默认值（NaN 不该静默生效）', () => {
    assert.equal(resolveConfig({ maxIndexEntries: 'abc' }).maxIndexEntries, 40)
    assert.equal(resolveConfig({ maxIndexEntries: -1 }).maxIndexEntries, 40)
    assert.equal(resolveConfig({ maxGraphNodes: 0 }).maxGraphNodes, 500)
  })

  test('undefined / null 配置用默认值', () => {
    const c = resolveConfig(undefined)
    assert.equal(c.enabled, true)
    assert.equal(c.injectIndex, true)
    assert.ok(c.dir.includes('ai-memory'))
  })

  test('enabled: false 能被识别', () => {
    assert.equal(resolveConfig({ enabled: false }).enabled, false)
    assert.equal(resolveConfig({ enabled: { get: () => false } }).enabled, false)
  })
})

describe('operations · 写 / 取代 / 复述', () => {
  test('首次写入是 created', () => {
    const l = openLibrary(join(work, 'ops1'))
    const ops = createOperations(l, { now: clock() })
    const r = ops.write({ text: '我认为确定性取代优于相似度阈值' })
    assert.equal(r.action, 'created')
    assert.ok(r.node_id)
  })

  test('同三元组不同 object → supersede，且旧节点退役保留', () => {
    const l = openLibrary(join(work, 'ops2'))
    const ops = createOperations(l, { now: clock() })
    const a = ops.write({ text: '端口是 8000', subject: 'svc', relation: 'port', object: '8000' })
    const b = ops.write({ text: '端口是 8080', subject: 'svc', relation: 'port', object: '8080', reason: '迁移' })
    assert.equal(b.action, 'supersede')
    assert.equal(b.superseded_id, a.node_id)

    const { state } = l.load()
    assert.equal(state.nodes.get(a.node_id).status, 'superseded', '旧的退役')
    assert.equal(state.nodes.get(b.node_id).status, 'active')
    assert.equal(state.nodes.size, 2, '旧的仍在账本里（双时态，不删）')
  })

  test('同三元组同 object → duplicate，不落盘', () => {
    const l = openLibrary(join(work, 'ops3'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: '端口是 8000', subject: 'svc', relation: 'port', object: '8000' })
    const before = l.load().state.nodes.size
    const dup = ops.write({ text: '又是 8000', subject: 'svc', relation: 'port', object: '8000' })
    assert.equal(dup.action, 'duplicate')
    assert.equal(l.load().state.nodes.size, before, '复述不新建节点')
  })

  test('空判断被拒', () => {
    const l = openLibrary(join(work, 'ops4'))
    const ops = createOperations(l, { now: clock() })
    assert.equal(ops.write({ text: '   ' }).action, 'rejected')
  })

  test('写入真的落盘（重新打开还能读到）', () => {
    const dir = join(work, 'ops5')
    const ops1 = createOperations(openLibrary(dir), { now: clock() })
    ops1.write({ text: '一条会持久化的判断' })
    const ops2 = createOperations(openLibrary(dir), { now: clock() })
    const s = ops2.search({ query: '持久化' })
    assert.equal(s.total, 1)
  })
})

describe('operations · 检索与连接', () => {
  test('检索中文能命中', () => {
    const l = openLibrary(join(work, 'ops6'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: '图谱只做导航不做事实载荷' })
    assert.equal(ops.search({ query: '导航' }).total, 1)
  })

  test('默认不返回已退役的判断', () => {
    const l = openLibrary(join(work, 'ops7'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: '旧版本说明', subject: 'a', relation: 'b', object: '1' })
    ops.write({ text: '新版本说明', subject: 'a', relation: 'b', object: '2' })
    const activeOnly = ops.search({ query: '版本说明' })
    assert.equal(activeOnly.total, 1, '默认只看活跃')
    const withRetired = ops.search({ query: '版本说明', include_retired: true })
    assert.equal(withRetired.total, 2, '要求时能看到退役的')
  })

  test('连接两条判断', () => {
    const l = openLibrary(join(work, 'ops8'))
    const ops = createOperations(l, { now: clock() })
    const a = ops.write({ text: '判断甲' })
    const b = ops.write({ text: '判断乙' })
    const r = ops.connect({ from: a.node_id, to: b.node_id, type: 'complements', note: '互相补强' })
    assert.equal(r.ok, true)
    const s = l.load().state
    assert.equal(s.edges.length, 1)
    assert.equal(s.edges[0].type, 'complements')
  })

  test('连接不存在的 id → 明确失败，不静默', () => {
    const l = openLibrary(join(work, 'ops9'))
    const ops = createOperations(l, { now: clock() })
    const a = ops.write({ text: '甲' })
    const r = ops.connect({ from: a.node_id, to: 'nope' })
    assert.equal(r.ok, false)
    assert.match(r.note, /No judgment/)
  })

  test('自连被拒', () => {
    const l = openLibrary(join(work, 'ops10'))
    const ops = createOperations(l, { now: clock() })
    const a = ops.write({ text: '甲' })
    assert.equal(ops.connect({ from: a.node_id, to: a.node_id }).ok, false)
  })
})

describe('operations · 演化轨迹', () => {
  test('history 显示取代链与修订历史', () => {
    const l = openLibrary(join(work, 'ops11'))
    const ops = createOperations(l, { now: clock() })
    const a = ops.write({ text: '第一版', subject: 's', relation: 'r', object: '1' })
    const b = ops.write({ text: '第二版', subject: 's', relation: 'r', object: '2' })
    ops.write({ text: '第三版', subject: 's', relation: 'r', object: '3' })

    const h = ops.history({ id: a.node_id })
    assert.equal(h.found, true)
    assert.equal(h.chain.length, 3, '取代链要走到底')
    assert.equal(h.chain[2].status, 'active')
    assert.equal(h.chain[0].status, 'superseded')
  })

  test('history 找不到时明确说明', () => {
    const l = openLibrary(join(work, 'ops12'))
    const ops = createOperations(l, { now: clock() })
    assert.equal(ops.history({ id: 'ghost' }).found, false)
  })
})

describe('operations · 规矩治理', () => {
  test('read 空库返回空列表', () => {
    const l = openLibrary(join(work, 'rule1'))
    const ops = createOperations(l, { now: clock() })
    const r = ops.rule({ action: 'read' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.rules, [])
  })

  test('改规矩必须给理由 —— 没有理由不予受理（可审计的前提）', () => {
    const l = openLibrary(join(work, 'rule2'))
    const ops = createOperations(l, { now: clock() })
    const r = ops.rule({ action: 'amend', id: 'r1', text: '新规矩', reason: '' })
    assert.equal(r.ok, false)
    assert.match(r.note, /reason/)
  })

  test('规矩可以建立并读取', () => {
    const l = openLibrary(join(work, 'rule3'))
    const ops = createOperations(l, { now: clock() })
    const made = ops.rule({ action: 'amend', id: 'r1', text: '只写判断，不写事实', reason: '初始' })
    assert.equal(made.ok, true)
    const read = ops.rule({ action: 'read' })
    assert.equal(read.rules.length, 1)
    assert.equal(read.rules[0].text, '只写判断，不写事实')
  })

  test('规矩改多次，revision 递增且历史留痕', () => {
    const l = openLibrary(join(work, 'rule4'))
    const ops = createOperations(l, { now: clock() })
    const made = ops.rule({ action: 'amend', id: 'r1', text: '第一版规矩', reason: '建立' })
    const id = made.rules[0].id
    ops.rule({ action: 'amend', id, text: '第二版规矩', reason: '发现第一版太宽' })
    const read = ops.rule({ action: 'read' })
    assert.equal(read.rules[0].text, '第二版规矩')
    assert.equal(read.rules[0].revision, 2)
    assert.ok(read.rules[0].history.length >= 2, '历史要留痕（可回滚）')
  })

  test('规矩与判断分开统计', () => {
    const l = openLibrary(join(work, 'rule5'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: '一条判断' })
    ops.rule({ action: 'amend', id: 'r1', text: '一条规矩', reason: '建立' })
    const s = ops.stats()
    assert.equal(s.judgments, 1)
    assert.equal(s.rules, 1)
  })
})

describe('operations · stats', () => {
  test('空库是诚实的空，不假装有内容', () => {
    const l = openLibrary(join(work, 'stats1'))
    const ops = createOperations(l, { now: clock() })
    const s = ops.stats()
    assert.equal(s.judgments, 0)
    assert.equal(s.orphans, 0)
    assert.match(s.note, /empty/)
  })

  test('孤立判断被数出来', () => {
    const l = openLibrary(join(work, 'stats2'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: '孤零零一条' })
    assert.equal(ops.stats().orphans, 1)
  })

  test('连接后不再是孤立', () => {
    const l = openLibrary(join(work, 'stats3'))
    const ops = createOperations(l, { now: clock() })
    const a = ops.write({ text: '甲' })
    const b = ops.write({ text: '乙' })
    ops.connect({ from: a.node_id, to: b.node_id })
    assert.equal(ops.stats().orphans, 0)
  })
})

describe('index text · 会话开始注入', () => {
  test('空库注入空串（不占上下文）', () => {
    const l = openLibrary(join(work, 'idx1'))
    assert.equal(buildIndexText(l, 40), '')
  })

  test('有判断时注入规矩与判断摘要', () => {
    const l = openLibrary(join(work, 'idx2'))
    const ops = createOperations(l, { now: clock() })
    ops.rule({ action: 'amend', id: 'r1', text: '只写判断', reason: '建立' })
    ops.write({ text: '我认为图谱只做导航' })
    const text = buildIndexText(l, 40)
    assert.match(text, /Rules you set for yourself/)
    assert.match(text, /只写判断/)
    assert.match(text, /图谱只做导航/)
  })

  test('注入的是索引不是全文 —— 长正文被截断（防上下文膨胀）', () => {
    const l = openLibrary(join(work, 'idx3'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: '很长的判断'.repeat(200) })
    const text = buildIndexText(l, 40)
    assert.ok(text.length < 2000, `注入不该把全文塞进去，实际 ${text.length}`)
  })

  test('maxEntries 生效', () => {
    const l = openLibrary(join(work, 'idx4'))
    const ops = createOperations(l, { now: clock() })
    for (let i = 0; i < 10; i += 1) ops.write({ text: `判断编号 ${i}` })
    const text = buildIndexText(l, 3)
    assert.match(text, /first 3 listed/)
  })

  test('**想法（insight）也要注入** —— 否则等于白写', () => {
    const l = openLibrary(join(work, 'idx5'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: '想法：也许问题不在端口上', kind: 'insight' })
    const text = buildIndexText(l, 40)
    // insight 的价值就是"被想起来"；不注入的话它只躺在账本里，永远没人看。
    assert.match(text, /也许问题不在端口上/)
    assert.match(text, /想法/)
  })

  test('三种 kind 能同时出现在注入里，且分节清楚', () => {
    const l = openLibrary(join(work, 'idx6'))
    const ops = createOperations(l, { now: clock() })
    ops.rule({ action: 'amend', id: 'r1', text: '规矩：只写判断', reason: '建立' })
    ops.write({ text: '判断：端口是 8080', subject: 'svc', relation: 'port', object: '8080' })
    ops.write({ text: '想法：或许该换个角度看', kind: 'insight' })
    const text = buildIndexText(l, 40)
    assert.match(text, /Rules you set for yourself/)
    assert.match(text, /Active judgments \(1 total\)/)
    assert.match(text, /Ideas not yet settled into judgments/)
  })

  test('想法的预算更小（不挤占判断的位置）', () => {
    const l = openLibrary(join(work, 'idx7'))
    const ops = createOperations(l, { now: clock() })
    for (let i = 0; i < 10; i += 1) ops.write({ text: `想法编号 ${i}`, kind: 'insight' })
    // maxEntries=4 → 想法预算 2 条
    const text = buildIndexText(l, 4)
    assert.match(text, /newest 2 listed/)
  })
})

describe('graph · 快照（导航层，不含全文）', () => {
  test('空库快照是空的', () => {
    const s = buildSnapshot(foldEvents([]))
    assert.deepEqual(s.nodes, [])
    assert.deepEqual(s.edges, [])
  })

  test('节点带 label / status / degree，不含全文', () => {
    const l = openLibrary(join(work, 'g1'))
    const ops = createOperations(l, { now: clock() })
    const a = ops.write({ text: '判断甲'.repeat(100) })
    const b = ops.write({ text: '判断乙' })
    ops.connect({ from: a.node_id, to: b.node_id })
    const snap = buildSnapshot(l.load().state)
    assert.equal(snap.nodes.length, 2)
    assert.equal(snap.edges.length, 1)
    const na = snap.nodes.find((n) => n.id === a.node_id)
    assert.equal(na.degree, 1, '度数算出来')
    assert.ok(na.label.length <= 61, 'label 是摘要不是全文')
    assert.equal(na.text, undefined, '不该带全文')
  })

  test('默认视图**只画活跃**（退役的直接消失 —— 主人明确要求）', () => {
    const l = openLibrary(join(work, 'g2'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: '旧', subject: 'a', relation: 'b', object: '1' })
    ops.write({ text: '新', subject: 'a', relation: 'b', object: '2' })
    const def = buildSnapshot(l.load().state)
    // ⚠️ 这条断言**改过两次**，两次都是被主人的实际观感纠正的：
    //   1. 最初断言 `nodes.length === 1` —— 结果图是「1 节点 · 0 连线」的空白，
    //      因为每条 supersedes 边都指向退役节点，滤掉退役 = 滤掉所有边。
    //   2. 于是改成"默认带上整条取代链" —— 图能看了，但满屏**灰点**，
    //      主人问「为什么有灰的有白的」。
    //   3. 最终（主人定的）：默认**只画活跃**。图是"我现在相信什么"，
    //      不是"我历史上想过什么"。要看进化史就右键切 `?retired=1`。
    assert.equal(def.nodes.length, 1, '默认只该有活跃的那条')
    assert.equal(def.nodes[0].status, 'active')
    assert.equal(def.edges.length, 0, '没有活跃之间的边，就是 0 条（干净）')
  })

  test('要求时（includeRetired）才带出**整条**取代链', () => {
    const l = openLibrary(join(work, 'g2b'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: 'v1', subject: 'x', relation: 'y', object: '1' })
    ops.write({ text: 'v2', subject: 'x', relation: 'y', object: '2' })
    ops.write({ text: 'v3', subject: 'x', relation: 'y', object: '3' })
    const def = buildSnapshot(l.load().state)
    assert.equal(def.nodes.length, 1, '默认只有最新那代')
    const all = buildSnapshot(l.load().state, { includeRetired: true })
    assert.equal(all.nodes.length, 3, '要求时三代都在（这才是"进化轨迹"）')
    assert.equal(all.edges.length, 2, '两条取代边都在')
  })

  test('includeRetired 给出全部节点（含未被取代的孤立退役项）', () => {
    const l = openLibrary(join(work, 'g2c'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: '被取代的', subject: 'a', relation: 'b', object: '1' })
    ops.write({ text: '取代它的', subject: 'a', relation: 'b', object: '2' })
    ops.write({ text: '与取代链无关的第三条' })
    const def = buildSnapshot(l.load().state)
    const all = buildSnapshot(l.load().state, { includeRetired: true })
    assert.equal(all.nodes.length, 3, 'includeRetired 含全部 3 个')
    assert.ok(def.nodes.length <= all.nodes.length)
  })

  test('maxNodes 截断并标记 truncated', () => {
    const l = openLibrary(join(work, 'g3'))
    const ops = createOperations(l, { now: clock() })
    for (let i = 0; i < 5; i += 1) ops.write({ text: `判断 ${i}` })
    const snap = buildSnapshot(l.load().state, { maxNodes: 2 })
    assert.equal(snap.nodes.length, 2)
    assert.equal(snap.truncated, true)
  })

  test('截断后只保留两端都在图内的边', () => {
    const l = openLibrary(join(work, 'g4'))
    const ops = createOperations(l, { now: clock() })
    const a = ops.write({ text: '甲' })
    const b = ops.write({ text: '乙' })
    ops.connect({ from: a.node_id, to: b.node_id })
    const snap = buildSnapshot(l.load().state, { maxNodes: 1 })
    assert.equal(snap.edges.length, 0, '端点被裁掉的边不能留下')
  })

  test('countStats 统计正确', () => {
    const l = openLibrary(join(work, 'g5'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: '旧', subject: 'a', relation: 'b', object: '1' })
    ops.write({ text: '新', subject: 'a', relation: 'b', object: '2' })
    ops.rule({ action: 'amend', id: 'r', text: '规矩', reason: 'x' })
    const c = countStats(l.load().state)
    assert.equal(c.active, 2)
    assert.equal(c.retired, 1)
    assert.equal(c.judgments, 1)
    assert.equal(c.rules, 1)
  })

  test('nodeDetail 给出反链与取代链（可解释性的核心）', () => {
    const l = openLibrary(join(work, 'g6'))
    const ops = createOperations(l, { now: clock() })
    const a = ops.write({ text: '甲', subject: 's', relation: 'r', object: '1' })
    const b = ops.write({ text: '乙', subject: 's', relation: 'r', object: '2' })
    const d = nodeDetail(l.load().state, a.node_id)
    assert.equal(d.supersededBy, b.node_id)
    assert.equal(d.chain.length, 2)
    assert.ok(d.history.length >= 2)
  })

  test('nodeDetail 找不到返回 null', () => {
    assert.equal(nodeDetail(foldEvents([]), 'ghost'), null)
  })
})

describe('routes · 安全（/plugins/* 不过会话 cookie 校验）', () => {
  test('回环地址判定', () => {
    assert.equal(isLoopback('127.0.0.1'), true)
    assert.equal(isLoopback('::1'), true)
    assert.equal(isLoopback('::ffff:127.0.0.1'), true)
    assert.equal(isLoopback('192.168.1.5'), false)
    assert.equal(isLoopback(undefined), false)
  })

  test('同源判定', () => {
    assert.equal(originMatchesHost('http://127.0.0.1:19387', '127.0.0.1:19387'), true)
    assert.equal(originMatchesHost('http://evil.com', '127.0.0.1:19387'), false)
    assert.equal(originMatchesHost('not-a-url', '127.0.0.1:19387'), false)
  })

  test('非回环来源被 403 拒绝', () => {
    const l = openLibrary(join(work, 'r1'))
    const routes = createRoutes(l)
    const res = fakeRes()
    routes[0].handler({ url: '/x', socket: { remoteAddress: '10.0.0.9' }, headers: {} }, res)
    assert.equal(res.statusCode, 403)
    assert.match(res.body, /loopback/)
  })

  test('跨源 Origin 被 403 拒绝', () => {
    const l = openLibrary(join(work, 'r2'))
    const routes = createRoutes(l)
    const res = fakeRes()
    routes[0].handler(
      { url: '/x', socket: { remoteAddress: '127.0.0.1' }, headers: { origin: 'http://evil.com', host: '127.0.0.1:19387' } },
      res,
    )
    assert.equal(res.statusCode, 403)
  })

  test('回环 + 同源 → 200 且返回快照', () => {
    const l = openLibrary(join(work, 'r3'))
    const ops = createOperations(l, { now: clock() })
    ops.write({ text: '一条判断' })
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

  test('无 Origin 头时按同源处理（curl / 本机探测）', () => {
    const l = openLibrary(join(work, 'r4'))
    const routes = createRoutes(l)
    const res = fakeRes()
    byPath(routes, `${ROUTE_BASE}/stats`).handler(
      { url: `${ROUTE_BASE}/stats`, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:19387' } },
      res,
    )
    assert.equal(res.statusCode, 200)
  })

  test('三条数据路由（worker 走 DSH 自己的分块路由）的路径都带 /plugins/dsh-ai-memory 前缀', () => {
    const routes = createRoutes(openLibrary(join(work, 'r5')))
    assert.equal(routes.length, 3)
    for (const r of routes) {
      assert.ok(r.path.startsWith(ROUTE_BASE), `${r.path} 必须以 ${ROUTE_BASE} 开头`)
      assert.equal(r.kind, 'exact')
    }
  })

  test('/node 找不到时返回 ok:false 而不是 500', () => {
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

  test('记忆库损坏时路由报 500 而不是崩掉进程', () => {
    const bad = {
      load() {
        throw new Error('磁盘炸了')
      },
    }
    const routes = createRoutes(bad)
    const res = fakeRes()
    byPath(routes, `${ROUTE_BASE}/snapshot`).handler(
      { url: `${ROUTE_BASE}/snapshot`, socket: { remoteAddress: '127.0.0.1' }, headers: {} },
      res,
    )
    assert.equal(res.statusCode, 500)
    assert.match(res.body, /reading the memory store failed/)
  })
})

describe('routes · Worker 走 DSH 自己的分块路由（不自建）', () => {
  test('worker 文件名符合 client-modules 的分块命名约定', () => {
    // 正则来自 dsh-client-modules/lib/index.js:169
    const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/
    assert.ok(CLIENT_CHUNK.test(WORKER_FILE), `${WORKER_FILE} 应当匹配 ${CLIENT_CHUNK}`)
  })

  test('worker 文件真的存在于 lib/ 下（命名对了但文件不在也没用）', () => {
    const p = join(here, '..', 'lib', WORKER_FILE)
    assert.ok(existsSync(p), `找不到 ${p}`)
  })

  test('本插件**不**为 worker 自建路由（走官方通道更好）', () => {
    const routes = createRoutes(openLibrary(join(work, 'w1')))
    const paths = routes.map((r) => r.path)
    assert.ok(!paths.some((p) => p.includes('graph-worker')), `不该有 worker 路由，实际：${paths.join(', ')}`)
    assert.equal(routes.length, 3, '只剩三个数据端点')
  })

  test('worker 源码里有力导向实现与物理常量', () => {
    const src = readFileSync(join(here, '..', 'lib', WORKER_FILE), 'utf8')
    assert.ok(src.includes('self.onmessage'), '要有 onmessage 入口')
    assert.ok(/function tick/.test(src), '要有 tick 实现')
    assert.ok(/ALPHA_DECAY/.test(src), '要有 alpha 衰减常量')
    assert.ok(/linkDistance/.test(src), '要有 linkDistance 参数')
  })

  test('worker 不 import 任何东西（Worker 里没有模块解析）', () => {
    const src = readFileSync(join(here, '..', 'lib', WORKER_FILE), 'utf8')
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    assert.ok(!/^\s*import\s/m.test(stripped), '不得有 import')
    assert.ok(!/require\(/.test(stripped), '不得有 require')
  })
})

/** 按路径取路由（不依赖数组下标 —— 加路由不会打乱测试）。 */
function byPath(routes, path) {
  const r = routes.find((x) => x.path === path)
  assert.ok(r, `找不到路由 ${path}（现有：${routes.map((x) => x.path).join(', ')}）`)
  return r
}

/** 造一个最小的假 res，记录状态码与响应体。 */
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
