/**
 * Post-install check: whether the copy in the profile contains every fix from this round.
 * Usage: node test/verify-profile.mjs
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const p = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-ai-memory', 'lib', 'client.js')
const s = readFileSync(p, 'utf8')

let fails = 0
/** Assert and print. */
function check(label, cond, extra = '') {
  if (cond) console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`)
  else { fails += 1; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}

console.log(`\n[client copy in the profile] ${p}\n`)
check('contains the inlined worker source (no rev dependency)', s.includes('const WORKER_SOURCE = "'))
check('has workerBlobUrl (Blob-built Worker)', s.includes('function workerBlobUrl()'))
check('main-thread drag fallback (dragging works without a Worker)', s.includes('p.x = w.x') && s.includes('p.y = w.y'))
check('workerError is retained (not silent)', s.includes('this.workerError = '))
check('the node radius is a constant (all nodes the same size)', /radiusOf\(_node\) \{\s*\n\s*return \d/.test(s))
check('the three kinds are colour-coded', s.includes('KIND_STYLE'))
check('does not read ctx.styles', !/ctx\.styles/.test(s.replace(/\/\*[\s\S]*?\*\//g, '')))

// Does the inlined worker match the real source?
const worker = readFileSync(join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-ai-memory', 'lib', 'client.graph-worker.js'), 'utf8')
const m = /const WORKER_SOURCE = "/.exec(s)
if (m === null) {
  check('the inlined worker matches the real source', false, 'the literal was not found')
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
  try { inlined = JSON.parse(s.slice(start, i + 1)) } catch { /* ignore */ }
  check('the inlined worker matches the real source', inlined === worker, `${inlined?.length ?? 'null'} vs ${worker.length}`)
}

console.log(`\n${'='.repeat(50)}`)
if (fails > 0) { console.log(`${fails} item(s) failed`); process.exit(1) }
console.log('the profile holds the fixed version ✓')
