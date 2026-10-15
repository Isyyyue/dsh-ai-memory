/**
 * 验证「按类型分色」这套东西真的通了 —— 从写入到快照到渲染样式。
 *
 * 为什么单独做：颜色/形状是**视觉**的，单元测试断言不了"好不好看"，
 * 但能断言**数据链路是通的**（三种 kind 都能写、能读、能拿到各自的样式）。
 *
 * 用法：node test/kinds.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openLibrary, createOperations } from '../src/index.js'
import { buildSnapshot, countStats } from '../src/graph.js'
import { KIND } from '../src/ledger.js'

let fails = 0
/** 断言并打印。 */
function check(label, cond, extra = '') {
  if (cond) console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`)
  else {
    fails += 1
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'am-kinds-'))
let clock = 1_700_000_000_000
const lib = openLibrary(dir)
const ops = createOperations(lib, { now: () => (clock += 1000) })

console.log('\n【三种 kind 都能写】')
const j = ops.write({ text: '判断：这个端口该是 8080', subject: 'svc', relation: 'port', object: '8080' })
const i = ops.write({ text: '思考：也许问题根本不在端口上', kind: KIND.INSIGHT })
const r = ops.rule({ action: 'amend', text: '规矩：只写判断，不写事实', reason: '立个约束' })

check('judgment 写入成功', typeof j.node_id === 'string' && j.node_id !== '')
check('insight 写入成功', typeof i.node_id === 'string' && i.node_id !== '')
check('rule 写入成功', typeof r.node_id === 'string' || r.ok === true)

console.log('\n【快照里带上 kind】')
const snap = buildSnapshot(lib.load().state)
check('快照有 3 个节点', snap.nodes.length === 3, `实际 ${snap.nodes.length}`)
const kinds = snap.nodes.map((n) => n.kind).sort()
check('三种 kind 都出现在快照里', kinds.join(',') === 'insight,judgment,rule', kinds.join(','))
check('每个节点都有 kind 字段', snap.nodes.every((n) => typeof n.kind === 'string'))

console.log('\n【统计分开计】')
const st = countStats(lib.load().state)
check('judgments 独立计数', st.judgments === 1, `judgments=${st.judgments}`)
check('rules 独立计数', st.rules === 1, `rules=${st.rules}`)
check('insights 独立计数', st.insights === 1, `insights=${st.insights}`)

console.log('\n【insight 不参与取代（关键设计）】')
// 思考没有三元组，所以写第二条思考不该取代第一条
const i2 = ops.write({ text: '思考：或者该换个角度看', kind: KIND.INSIGHT })
const st2 = countStats(lib.load().state)
check('第二条 insight 没有取代第一条', st2.insights === 2, `insights=${st2.insights}`)
check('第一条 insight 仍然 active', lib.load().state.nodes.get(i.node_id).status === 'active')
void i2

console.log('\n【judgment 仍然会被取代（回归）】')
ops.write({ text: '判断：端口改成 9090', subject: 'svc', relation: 'port', object: '9090' })
const st3 = countStats(lib.load().state)
check('旧判断被取代', lib.load().state.nodes.get(j.node_id).status === 'superseded')
check('活跃判断仍为 1', st3.judgments === 1, `judgments=${st3.judgments}`)

console.log('\n【客户端那份样式表覆盖了三种 kind】')
const { readFileSync } = await import('node:fs')
const { fileURLToPath } = await import('node:url')
const { dirname } = await import('node:path')
const here = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
for (const k of ['judgment', 'insight', 'rule']) {
  check(`样式表里有 ${k}`, new RegExp(`${k}:\\s*\\{`).test(clientSrc))
}
check('未知 kind 有兜底样式', /KIND_FALLBACK/.test(clientSrc))
// 主人明确要求"全要 ⚪" —— 形状统一为圆，只用颜色区分
check('三种 kind 形状全是圆', (() => {
  const t = /const KIND_STYLE = Object\.freeze\(\{[\s\S]*?\n    \}\)/.exec(clientSrc)
  if (t === null) return false
  const shapes = [...t[0].matchAll(/shape:\s*'([a-z]+)'/g)].map((m) => m[1])
  return shapes.length === 3 && new Set(shapes).size === 1 && shapes[0] === 'circle'
})())
check('命中判定与绘制共用外接系数', /shapeExtent\(kindStyle\(p\.node\.kind\)\.shape\)/.test(clientSrc))

rmSync(dir, { recursive: true, force: true })

console.log(`\n${'='.repeat(56)}`)
if (fails > 0) {
  console.log(`失败 ${fails} 项`)
  process.exit(1)
}
console.log('三种 kind 的数据链路全通 ✓')
