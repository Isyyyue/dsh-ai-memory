/**
 * 装后核对：profile 里那份客户端是否含本轮全部修复。
 * 用法：node test/verify-profile.mjs
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const p = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-ai-memory', 'lib', 'client.js')
const s = readFileSync(p, 'utf8')

let fails = 0
/** 断言并打印。 */
function check(label, cond, extra = '') {
  if (cond) console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`)
  else { fails += 1; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}

console.log(`\n【profile 里的客户端】${p}\n`)
check('含内联 worker 源码（不依赖 rev）', s.includes('const WORKER_SOURCE = "'))
check('有 workerBlobUrl（Blob 建 Worker）', s.includes('function workerBlobUrl()'))
check('主线程拖拽兜底（没 Worker 也能拖）', s.includes('p.x = w.x') && s.includes('p.y = w.y'))
check('workerError 会留下来（不静默）', s.includes('this.workerError = '))
check('节点半径是常数（全部一样大）', /radiusOf\(_node\) \{\s*\n\s*return \d/.test(s))
check('三种 kind 分色', s.includes('KIND_STYLE'))
check('不读 ctx.styles', !/ctx\.styles/.test(s.replace(/\/\*[\s\S]*?\*\//g, '')))

// 内联的 worker 与真源一致吗
const worker = readFileSync(join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-ai-memory', 'lib', 'client.graph-worker.js'), 'utf8')
const m = /const WORKER_SOURCE = "/.exec(s)
if (m === null) {
  check('内联 worker 与真源一致', false, '找不到字面量')
} else {
  let i = m.index + m[0].length - 1
  const start = i
  i += 1
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue }
    if (s[i] === '"') break
    i += 1
  }
  let inlined = null
  try { inlined = JSON.parse(s.slice(start, i + 1)) } catch { /* 忽略 */ }
  check('内联 worker 与真源一致', inlined === worker, `${inlined?.length ?? 'null'} vs ${worker.length}`)
}

console.log(`\n${'='.repeat(50)}`)
if (fails > 0) { console.log(`失败 ${fails} 项`); process.exit(1) }
console.log('profile 里是修复后的版本 ✓')
