/**
 * 独立验证三条护栏是否真的挡住了。
 * 不信任"测试全绿"——护栏失效通常是静默的，要主动尝试越界。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const P = join(import.meta.dirname, '..').replace(/\\\\/g, '/')
const { openLibrary, createOperations } = await import(`file://${P}/src/index.js`)

const dir = mkdtempSync(join(tmpdir(), 'aimem-guard-'))
let clock = 1730000000000
const lib = openLibrary(dir)
const ops = createOperations(lib, { now: () => (clock += 60000) })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  ← ${detail}`}`)
  if (ok) pass += 1
  else fail += 1
}

console.log('=== 护栏 1：self 写入只能写 insight ===')

// 先建一条 user 判断，作为后续 self 写入的合法引用来源
const userJudgment = ops.write({
  text: '用户说的判断', kind: 'judgment', trigger: 'user',
  subject: 'c', relation: 'd', object: '2',
})
const userJudgmentId = userJudgment.node_id

const selfJudgment = ops.write({
  text: '我自己想到的一条判断', kind: 'judgment', trigger: 'self',
  subject: 'a', relation: 'b', object: '1',
  citations: [userJudgmentId],
})
check('self + judgment 被拒绝（即使有合法引用）', selfJudgment.action === 'rejected', `实际 ${selfJudgment.action}`)
check('拒绝理由可读', typeof selfJudgment.note === 'string' && selfJudgment.note.length > 0, selfJudgment.note)

const selfInsight = ops.write({
  text: '我自己冒出来的一个想法', kind: 'insight', trigger: 'self',
  // 护栏 2 要求 self 写入必须带真实引用，所以这里必须给一个：
  // 只测「kind 限制」时忘了引用，会被护栏 2 正确地拦下（两条护栏叠加）。
  citations: [userJudgmentId],
})
check('self + insight（带真实引用）允许', selfInsight.action === 'created', `实际 ${selfInsight.action} ${selfInsight.note ?? ''}`)

const selfRule = ops.write({ text: 'self 想立规矩', kind: 'rule', trigger: 'self', citations: [userJudgmentId] })
check('self + rule 被拒绝', selfRule.action === 'rejected', `实际 ${selfRule.action}`)

check('user + judgment 允许', userJudgment.action === 'created', `实际 ${userJudgment.action}`)

console.log('')
console.log('=== 护栏 2：self 写入必须带真实引用 ===')
const noCite = ops.write({ text: '没有依据的想法', kind: 'insight', trigger: 'self' })
check('self + 无 citations 被拒绝', noCite.action === 'rejected', `实际 ${noCite.action}`)

const fakeCite = ops.write({
  text: '编造依据的想法', kind: 'insight', trigger: 'self',
  citations: ['n_9999_doesnotexist'],
})
check('self + 不存在的记忆引用被拒绝', fakeCite.action === 'rejected', `实际 ${fakeCite.action}`)

const fakePath = ops.write({
  text: '编造路径的想法', kind: 'insight', trigger: 'self',
  citations: ['D:/nonexistent/never/here.txt'],
})
check('self + 不存在的文件路径被拒绝', fakePath.action === 'rejected', `实际 ${fakePath.action}`)

// 真实文件
const realFile = join(dir, 'evidence.txt')
writeFileSync(realFile, 'real evidence', 'utf8')
const realCite = ops.write({
  text: '有真实文件依据的想法', kind: 'insight', trigger: 'self',
  citations: [realFile],
})
check('self + 真实文件路径允许', realCite.action === 'created', `实际 ${realCite.action} ${realCite.note ?? ''}`)

// 真实记忆
const realMem = ops.write({
  text: '有真实记忆依据的想法', kind: 'insight', trigger: 'self',
  citations: [userJudgment.node_id],
})
check('self + 真实记忆 id 允许', realMem.action === 'created', `实际 ${realMem.action} ${realMem.note ?? ''}`)

console.log('')
console.log('=== 护栏 3：persona accept 不能由 self 触发 ===')
const cand = ops.persona({ action: 'propose', text: '候选人格特征', reason: '测试' })
check('propose 成功', cand.ok === true, JSON.stringify(cand).slice(0, 100))

const selfAccept = ops.persona({
  action: 'accept', id: cand.id, reason: 'self 想确认', by: 'self',
})
check('self 触发 accept 被拒绝', selfAccept.ok === false, `实际 ok=${selfAccept.ok}`)

const userAccept = ops.persona({
  action: 'accept', id: cand.id, reason: '用户确认', by: 'user',
})
check('user 触发 accept 允许', userAccept.ok === true, `实际 ok=${userAccept.ok}`)

console.log('')
console.log('=== 附加：connect 不能手工建 supersedes ===')
const a = ops.write({ text: 'A', subject: 'x1', relation: 'y', object: '1' })
const b = ops.write({ text: 'B', subject: 'x2', relation: 'y', object: '2' })
const manualSuper = ops.connect({ from: a.node_id, to: b.node_id, type: 'supersedes' })
check('手工 supersedes 被拒绝', manualSuper.ok === false, JSON.stringify(manualSuper).slice(0, 120))

const okLink = ops.connect({ from: a.node_id, to: b.node_id, type: 'complements' })
check('complements 允许', okLink.ok === true, JSON.stringify(okLink).slice(0, 120))

const unlink = ops.connect({ action: 'unlink', from: a.node_id, to: b.node_id, type: 'complements' })
check('unlink 可用', unlink.ok === true, JSON.stringify(unlink).slice(0, 120))
const edgesAfter = lib.load().state.edges.filter((e) => e.from === a.node_id || e.to === a.node_id)
check('unlink 后边确实消失', edgesAfter.length === 0, `剩 ${edgesAfter.length} 条`)

console.log('')
console.log('=== 附加：question / cycle 基本链路 ===')
const q = ops.question({ action: 'open', text: '为什么静默失效更危险？', urgency: 0.8 })
check('question open 成功', q.ok === true, JSON.stringify(q).slice(0, 120))

const badSrc = ops.question({
  action: 'open', text: '引用不存在节点', source_ids: ['n_nope'],
})
check('question 引用不存在节点被拒绝', badSrc.ok === false, `实际 ok=${badSrc.ok}`)

const cyc = ops.cycle({ action: 'begin', trigger: 'self' })
check('cycle begin 成功', cyc.ok === true, JSON.stringify(cyc).slice(0, 120))
check('cycle begin 返回 focus 数组', Array.isArray(cyc.focus), typeof cyc.focus)

const end = ops.cycle({ action: 'end', id: cyc.id, produced: 0 })
check('cycle end(produced=0) 成功（空产出是一等结果）', end.ok === true, JSON.stringify(end).slice(0, 120))

const sm = ops.selfModel()
check('selfModel 返回 ok', sm.ok === true, JSON.stringify(sm).slice(0, 100))
check('selfRatio 是数字不是 NaN', Number.isFinite(sm.selfRatio), String(sm.selfRatio))
check('selfSurvival 是数字不是 NaN', Number.isFinite(sm.selfSurvival), String(sm.selfSurvival))

console.log('')
console.log('=== 结果 ===')
console.log(`${pass} 通过, ${fail} 失败`)
rmSync(dir, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
