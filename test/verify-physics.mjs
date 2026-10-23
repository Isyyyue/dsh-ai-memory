/**
 * 改完之后验证：我们的力公式与 Obsidian 在关键距离上必须完全一致。
 * 这个脚本从 worker 源码里**直接读常量**，不是抄的，所以改错会立刻发现。
 *
 * 用法（在插件根目录）：node test/verify-physics.mjs
 *
 * 这是 test/graph-physics.test.js 的**手动补充**：单元测试断言源码里存在
 * 正确的常量和公式，这里则把我们的数值与 Obsidian sim.js 的 d3 公式逐个比对。
 * 两者覆盖的角度不同，都保留。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 相对本文件解析，不写死绝对路径：脚本复制到别处、或仓库换位置都不会失效。
const SRC = join(import.meta.dirname, '..', 'lib', 'client.graph-worker.js')
const src = readFileSync(SRC, 'utf8')

// 从源码里读常量，避免脚本与实际实现脱节
const getNum = (name) => {
  const m = new RegExp(`(?:let|const)\\s+${name}\\s*=\\s*(-?[\\d.]+)`).exec(src)
  if (!m) throw new Error(`源码里找不到常量 ${name}`)
  return Number(m[1])
}
const REPEL = getNum('repelStrength')
const DIST_MIN = getNum('REPEL_DISTANCE_MIN')
const LINK_DIST = getNum('linkDistance')
console.log('从源码读出：repelStrength =', REPEL, ' REPEL_DISTANCE_MIN =', DIST_MIN, ' linkDistance =', LINK_DIST)

const alpha = 1

/** 我们的实现（复刻 worker 里的公式） */
function ours(d) {
  const d2 = d * d
  const min2 = DIST_MIN * DIST_MIN
  const eff = d2 < min2 ? Math.sqrt(min2 * d2) : d2
  return Math.abs((REPEL * alpha) / eff)
}

/** Obsidian / d3：distanceMin(30) 夹子 */
function obsidian(d) {
  let l = d * d
  const a = 30 * 30
  if (l < a) l = Math.sqrt(a * l)
  return Math.abs((-1000 * alpha) / l)
}

console.log('')
console.log('=== 排斥力：改后 vs Obsidian（必须全部 1.00×） ===')
console.log('  d      我们        Obsidian     比值')
let allMatch = true
for (const d of [1, 2, 5, 10, 20, 30, 50, 100, 250]) {
  const o = ours(d)
  const b = obsidian(d)
  const ratio = o / b
  const ok = Math.abs(ratio - 1) < 1e-9
  if (!ok) allMatch = false
  console.log(
    String(d).padStart(4),
    o.toFixed(4).padStart(10),
    b.toFixed(4).padStart(12),
    ratio.toFixed(2).padStart(8) + '×',
    ok ? '✓' : '✗',
  )
}

console.log('')
console.log('=== 弹簧强度：改后 vs Obsidian ===')
// 我们：k = ((d - linkDistance) / d) * alpha * linkStrength / min(degA, degB)
// Obsidian：strength = 1 / min(degA, degB)，d3 内部同式
function oursLink(d, degA, degB) {
  const degMin = Math.min(degA, degB) || 1
  return Math.abs(((d - LINK_DIST) / d) * alpha * 1 / degMin)
}
function obsidianLink(d, degA, degB) {
  const strength = 1 / Math.min(degA, degB)
  return Math.abs(((d - 250) / d) * alpha * strength)
}
console.log(' degA degB    d     我们      Obsidian   比值')
let linkMatch = true
for (const [da, db] of [[1, 1], [1, 5], [1, 20], [5, 5], [20, 20]]) {
  for (const d of [100, 300]) {
    const o = oursLink(d, da, db)
    const b = obsidianLink(d, da, db)
    const ratio = o / b
    const ok = Math.abs(ratio - 1) < 1e-9
    if (!ok) linkMatch = false
    console.log(
      String(da).padStart(5), String(db).padStart(4), String(d).padStart(5),
      o.toFixed(4).padStart(9), b.toFixed(4).padStart(11),
      ratio.toFixed(2).padStart(7) + '×',
      ok ? '✓' : '✗',
    )
  }
}

console.log('')
console.log('=== 结论 ===')
console.log('排斥力全一致：', allMatch ? '✓ 是' : '✗ 否')
console.log('弹簧强度全一致：', linkMatch ? '✓ 是' : '✗ 否')
if (!allMatch || !linkMatch) {
  console.log('')
  console.log('✗ 与 Obsidian 仍有差异，不要提交')
  process.exit(1)
}
console.log('')
console.log('✓ 两项 P0 已与 Obsidian 数值一致')
