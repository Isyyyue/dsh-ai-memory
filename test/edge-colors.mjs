/**
 * List every edge and mark **what color it will be drawn in**.
 *
 * The question "why is there a green line" came up: green = `complements`.
 * This script makes it obvious at a glance which edge is which type, what color
 * it gets, and what it connects.
 *
 * Usage: node test/edge-colors.mjs
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { openLibrary } from '../src/index.js'
import { buildSnapshot } from '../src/graph.js'

/** Kept in sync with the client `edgeColor()` (change both together). */
const COLOR_OF = {
  supersedes: '蓝（品牌色）—— 新的取代旧的，带箭头',
  complements: '绿 —— 互补，两条判断互相印证',
  tensions: '红 —— 矛盾，两条判断互相冲突',
  depends: '琥珀 —— 依据，一条依赖另一条',
}

const lib = openLibrary(join(homedir(), '.dsh', 'ai-memory'))
const { state } = lib.load()

const brief = (id) => {
  const n = state.nodes.get(id)
  if (n === undefined) return `${id}(不存在)`
  return `[${n.status}] ${n.text.slice(0, 26)}`
}

console.log(`=== 共 ${state.edges.length} 条边 ===\n`)
for (const e of state.edges) {
  const color = COLOR_OF[e.type] ?? '灰（未知类型）'
  console.log(`${e.type}  →  ${color}`)
  console.log(`   ${brief(e.from)}`)
  console.log(`   ${brief(e.to)}`)
  console.log('')
}

const all = buildSnapshot(state, { includeRetired: true })
console.log(`含退役视图: ${all.nodes.length} 节点 / ${all.edges.length} 边`)
const byType = {}
for (const e of all.edges) byType[e.type] = (byType[e.type] ?? 0) + 1
console.log('边类型分布:', JSON.stringify(byType))
