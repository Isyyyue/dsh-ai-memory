/**
 * 端到端验证：拿**真实记忆库路径**跑一遍完整生命周期。
 *
 * 这不是单元测试 —— 它验证的是"装进 profile 之后，真实环境下行为对不对"：
 *   写 → 检索 → 取代 → 轨迹 → 双链 → 规矩治理 → 图谱快照 → 统计
 * 每一步都断言，任何一步不对就非零退出。
 *
 * 用临时目录，不碰 ~/.dsh/ai-memory 的真实数据。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openLibrary, createOperations, buildIndexText } from '../src/index.js'
import { buildSnapshot } from '../src/graph.js'

const work = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-e2e-'))
let failures = 0
let checks = 0

/** 断言并打印。 */
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

  console.log('\n【1】形成判断')
  const j1 = ops.write({ text: '我认为确定性取代比相似度阈值可靠', subject: 'supersede', relation: '优于', object: 'similarity', tags: ['记忆'], citations: ['arXiv 2606.26511'] })
  check('写入成功', j1.action === 'created', j1.node_id)
  check('账本真的落盘', lib.load().state.nodes.size === 1)

  console.log('\n【2】写前必搜（先搜再写）')
  const s1 = ops.search({ query: '取代' })
  check('中文检索命中', s1.total >= 1, `total=${s1.total}`)
  const s2 = ops.search({ query: '不存在的词汇xyz' })
  check('无命中时诚实返回 0', s2.total === 0)

  console.log('\n【3】确定性取代（核心）')
  const j2 = ops.write({ text: '端口是 8000', subject: 'svc', relation: 'port', object: '8000' })
  const j3 = ops.write({ text: '端口是 8080', subject: 'svc', relation: 'port', object: '8080', reason: '服务迁移了' })
  check('同键不同 object → supersede', j3.action === 'supersede', `${j2.node_id} → ${j3.node_id}`)
  check('旧判断被退役', lib.load().state.nodes.get(j2.node_id).status === 'superseded')
  check('旧判断**仍在账本里**（双时态，不删）', lib.load().state.nodes.has(j2.node_id))
  check('新判断是 active', lib.load().state.nodes.get(j3.node_id).status === 'active')

  console.log('\n【4】复述不落盘（避免同一想法堆成十几张卡）')
  const dup = ops.write({ text: '端口还是 8080', subject: 'svc', relation: 'port', object: '8080' })
  check('同键同 object → duplicate', dup.action === 'duplicate')
  check('没有新建节点', lib.load().state.nodes.size === 3, `nodes=${lib.load().state.nodes.size}`)

  console.log('\n【5】检索默认只看活跃')
  const s3 = ops.search({ query: '端口' })
  check('默认只返回活跃的', s3.total === 1, `total=${s3.total}`)
  const s4 = ops.search({ query: '端口', include_retired: true })
  check('要求时能看到退役的', s4.total === 2, `total=${s4.total}`)

  console.log('\n【6】演化轨迹（能看见来路）')
  const h = ops.history({ id: j2.node_id })
  check('history 找得到', h.found === true)
  check('取代链走到底', h.chain.length === 2, `chain=${h.chain.length}`)
  check('链尾是当前活跃的', h.chain[h.chain.length - 1].status === 'active')

  console.log('\n【7】双链（两边都能看到）')
  const c = ops.connect({ from: j1.node_id, to: j3.node_id, type: 'complements', note: '两条都支持同一取向' })
  check('建链成功', c.ok === true)
  const state = lib.load().state
  // 注意：取代会**自动**建一条 supersedes 边（图谱上要看得见"谁取代了谁"），
  // 所以此刻边数是 2 而不是 1 —— 第 3 步的取代贡献了另一条。
  check('取代自动建的边 + 手工建的边都在', state.edges.length === 2, `edges=${state.edges.length}`)
  check('有一条 supersedes 边', state.edges.some((e) => e.type === 'supersedes'))
  check('有一条 complements 边', state.edges.some((e) => e.type === 'complements'))
  check('出链可见', state.edges.filter((e) => e.from === j1.node_id).length === 1)
  check('入链可见（反链）', state.edges.filter((e) => e.to === j3.node_id).length === 1)

  console.log('\n【8】规矩治理（改规矩必须给理由）')
  const noReason = ops.rule({ action: 'amend', id: 'r1', text: '要写判断', reason: '' })
  check('没理由被拒（可审计的前提）', noReason.ok === false)
  const made = ops.rule({ action: 'amend', id: 'r1', text: '只写判断，不写事实', reason: '初始建立' })
  check('给了理由就能建', made.ok === true)
  const rid = made.rules[0].id
  ops.rule({ action: 'amend', id: rid, text: '只写判断，不写事实；写不出就不写', reason: '补上"不写"的边界' })
  const read = ops.rule({ action: 'read' })
  check('规矩改到第 2 版', read.rules[0].revision === 2)
  check('变更历史留痕（可回滚）', read.rules[0].history.length >= 2)

  console.log('\n【9】图谱快照（导航层，不含全文）')
  const snap = buildSnapshot(lib.load().state)
  check('快照有节点', snap.nodes.length > 0, `nodes=${snap.nodes.length}`)
  check('节点带度数', snap.nodes.every((n) => typeof n.degree === 'number'))
  check('节点不含全文（只给 label）', snap.nodes.every((n) => n.text === undefined))
  const withRetired = buildSnapshot(lib.load().state, { includeRetired: true })
  // ⚠️ 曾经断言 `withRetired.nodes.length > snap.nodes.length`（默认不含退役）。
  // 但那个设计让默认视图变成「N 节点 · 0 连线」的空白图 —— 因为 supersedes 边
  // 全部指向退役节点，滤掉它们就等于滤掉所有边，而"看见来路"正是本插件的核心价值。
  // 现在默认视图**沿取代链带上整条来路**，所以两者可能相等（没有"孤立退役项"时）。
  check('默认视图保留取代链（边不为空）', snap.edges.length > 0, `edges=${snap.edges.length}`)
  check('includeRetired 是超集', withRetired.nodes.length >= snap.nodes.length, `${snap.nodes.length} → ${withRetired.nodes.length}`)
  check('默认视图里的退役节点都是"来路"', (() => {
    const chainTargets = new Set(snap.edges.filter((e) => e.type === 'supersedes').map((e) => e.to))
    return snap.nodes.filter((n) => n.status !== 'active').every((n) => chainTargets.has(n.id))
  })(), '不该把无关的退役节点也拉进来')

  console.log('\n【10】统计与注入')
  const st = ops.stats()
  check('统计出退役数', st.retired >= 1, `retired=${st.retired}`)
  check('统计出规矩数', st.rules === 1)
  check('无数据问题', st.problems.length === 0, st.problems.join('; '))
  const idx = buildIndexText(lib, 40)
  check('注入文本含规矩', idx.includes('只写判断'))
  check('注入文本含判断', idx.includes('确定性取代'))
  check('注入的是索引不是全文（长度可控）', idx.length < 3000, `${idx.length} 字符`)

  console.log('\n【11】持久化（重开进程还能读到）')
  const lib2 = openLibrary(work)
  const ops2 = createOperations(lib2, { now })
  check('重开后判断还在', ops2.search({ query: '取代' }).total >= 1)
  check('重开后取代状态还在', lib2.load().state.nodes.get(j2.node_id).status === 'superseded')
  check('重开后双链还在（supersedes + complements 两条）', lib2.load().state.edges.length === 2, `edges=${lib2.load().state.edges.length}`)
} finally {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

console.log(`\n${'='.repeat(60)}`)
console.log(`端到端验证：${checks - failures}/${checks} 通过`)
if (failures > 0) {
  console.log(`失败 ${failures} 项`)
  process.exit(1)
}
console.log('全部通过 ✓')
