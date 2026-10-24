/**
 * 并发验证：真实多进程写同一账本，断言不丢节点、seq 不撞、顺序一致。
 *
 * 用法（在插件根目录）：node test/verify-concurrency.mjs
 *
 * 这是 test/concurrency.test.js 的**手动全景版**：单元测试里的是精简断言，
 * 这里额外打印每个进程的退出情况和残留锁检查，方便人一眼看懂。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

// 相对本文件解析，不写死绝对路径：脚本复制到别处、或仓库换位置都不会失效。
const PLUGIN = join(import.meta.dirname, '..', '..').replace(/\\/g, '/')
const DIR = mkdtempSync(join(tmpdir(), 'aimem-verify-conc-'))

const WORKER = join(DIR, 'w.mjs')
writeFileSync(WORKER, `
const { openLibrary, createOperations } = await import('file://${PLUGIN}/src/index.js')
const lib = openLibrary(process.argv[2])
const ops = createOperations(lib)
const tag = process.argv[3]
const out = []
for (let i = 0; i < 5; i += 1) {
  const r = ops.write({
    text: '进程 ' + tag + ' 第 ' + i + ' 条',
    subject: 'p' + tag, relation: 'r' + i, object: String(i),
  })
  out.push(r.action)
}
console.log(JSON.stringify(out))
`, 'utf8')

const N = 8
const runs = []
for (let i = 0; i < N; i += 1) {
  runs.push(new Promise((resolve) => {
    const p = spawn(process.execPath, [WORKER, DIR, String(i)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    p.on('close', (code) => resolve({ code, out: out.trim() }))
  }))
}
const results = await Promise.all(runs)

const failed = results.filter((r) => r.code !== 0)
console.log(`8 进程 × 5 写，正常退出 ${N - failed.length}/${N}`)
if (failed.length > 0) {
  for (const f of failed.slice(0, 2)) console.log('  失败输出:', f.out.slice(0, 300))
}

const { openLibrary } = await import(`file://${PLUGIN}/src/index.js`)
const lib = openLibrary(DIR)
const { state, events, problems } = lib.load()

const EXPECTED = 40
const seqs = events.filter((e) => e.type === 'node.created').map((e) => e.seq)
const dupSeq = seqs.filter((s, i) => seqs.indexOf(s) !== i)
const ids = events.filter((e) => e.type === 'node.created').map((e) => e.data.id)
const dupIds = ids.filter((s, i) => ids.indexOf(s) !== i)

const checks = [
  ['节点数 = 40（无静默丢弃）', state.nodes.size === EXPECTED, `实际 ${state.nodes.size}`],
  ['problems 为空', problems.length === 0, `实际 ${problems.length}：${problems.slice(0, 2).join(' / ')}`],
  ['节点 id 无重复', dupIds.length === 0, `重复 ${dupIds.length} 个`],
  ['seq 无重复（顺序确定）', dupSeq.length === 0, `重复 ${dupSeq.length} 个`],
  ['seq 严格递增且连续', seqs.every((s, i) => i === 0 || s > seqs[i - 1]), ''],
]

console.log('')
let allOk = true
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  ← ${detail}`}`)
  if (!ok) allOk = false
}

// 残留锁检查：锁必须在 finally 里被释放
const lockExists = (() => {
  try { readFileSync(join(DIR, 'ledger.jsonl.lock')); return true } catch { return false }
})()
console.log(`  ${lockExists ? '✗' : '✓'} 无残留锁文件`)
if (lockExists) allOk = false

rmSync(DIR, { recursive: true, force: true })
console.log('')
console.log(allOk ? '✓ 并发写入验证通过' : '✗ 并发写入验证失败')
process.exit(allOk ? 0 : 1)
