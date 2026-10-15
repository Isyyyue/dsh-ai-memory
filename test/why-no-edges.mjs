/**
 * 回答"没有连线是没有关系还是 bug"。
 *
 * 逐条列出所有边，标出两端节点的状态，并说明它为什么在默认视图里出现/消失。
 *
 * 用法：node test/why-no-edges.mjs
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { openLibrary } from '../src/index.js'
import { buildSnapshot } from '../src/graph.js'

const lib = openLibrary(join(homedir(), '.dsh', 'ai-memory'))
const { state } = lib.load()

const label = (id) => {
  const n = state.nodes.get(id)
  if (n === undefined) return `${id}(不存在)`
  return `${id} [${n.status}] ${n.text.slice(0, 22)}`
}

console.log('=== 全部边（' + state.edges.length + ' 条）===\n')
for (const e of state.edges) {
  const from = state.nodes.get(e.from)
  const to = state.nodes.get(e.to)
  const bothActive = from?.status === 'active' && to?.status === 'active'
  console.log(`${e.type}`)
  console.log(`  起点: ${label(e.from)}`)
  console.log(`  终点: ${label(e.to)}`)
  console.log(`  两端都活跃? ${bothActive ? '是 → 默认视图里会画出来' : '否 → 默认视图里被滤掉'}`)
  console.log('')
}

const def = buildSnapshot(state)
const all = buildSnapshot(state, { includeRetired: true })
console.log('=== 结果 ===')
console.log(`默认视图（只画活跃）: ${def.nodes.length} 节点 / ${def.edges.length} 边`)
console.log(`含退役              : ${all.nodes.length} 节点 / ${all.edges.length} 边`)

const activeIds = new Set(def.nodes.map((n) => n.id))
const crossEdges = state.edges.filter((e) => activeIds.has(e.from) !== activeIds.has(e.to))
console.log('')
console.log(`跨越"活跃↔退役"的边: ${crossEdges.length} 条（这些就是默认视图里看不到的）`)
