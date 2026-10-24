/**
 * 并发写入与账本锁的回归测试。
 *
 * 这里固定两件事，都是实测出来的，不是推演：
 *
 *   1. **节点 id 必须唯一**。旧实现用 `n_<seq>_<时间末6位>`，两个进程读到同一
 *      `seq` 且落在同一毫秒就生成相同 id，`applyEvent` 判重后丢弃。实测
 *      8 进程 × 5 写：账本 40 行，折叠后只有 **29 个节点**，11 条判断在文件里
 *      却对检索和注入不可见。
 *
 *   2. **seq 顺序必须等于提交顺序**。唯一 id 只解决「不丢节点」，不解决
 *      「顺序确定」：`foldEvents` 按 seq 排序，`supersedeChain` 沿取代链按
 *      这个顺序走，所以并发取代同一断言时，顺序乱了链就是错的。
 *
 * 第 2 条的锁实现曾经有真实竞态：`openSync(path,'wx')` 之后才写持有者信息，
 * 中间那一瞬锁文件存在但内容为空，第二个进程读到空串 → 判为僵尸锁 → 删掉，
 * 两个进程都以为自己持锁。实测最大并发深度为 **2**，并且 4 进程 × 3 写时
 * 两个进程拿到了同一个 seq。修法是先用 `link()` 把已写好内容的临时文件
 * 原子挂上去，消灭空文件窗口。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const here = import.meta.dirname
const PLUGIN_ROOT = join(here, '..', '..').replace(/\\/g, '/')

import { acquireLock, releaseLock, withLedgerLock, isPidAlive, LOCK_STALE_MS } from '../../src/store.js'
import { openLibrary } from '../../src/index.js'

/** 建临时目录，用完删掉。 */
function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 起 N 个子进程，各跑一段脚本，收集 stdout。 */
function runWorkers(dir, workerSource, count) {
  const worker = join(dir, 'worker.mjs')
  writeFileSync(worker, workerSource, 'utf8')
  const runs = []
  for (let i = 0; i < count; i += 1) {
    runs.push(new Promise((resolve) => {
      const p = spawn(process.execPath, [worker, dir, String(i)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      p.stdout.on('data', (d) => { out += d })
      p.stderr.on('data', (d) => { out += d })
      p.on('close', (code) => resolve({ code, out: out.trim() }))
    }))
  }
  return Promise.all(runs)
}

describe('账本锁 · 语义', () => {
  test('拿到锁能执行回调，结束后锁文件消失', () => {
    const dir = tempDir('dsh-am-lock-')
    try {
      const ledger = join(dir, 'ledger.jsonl')
      const r = withLedgerLock(ledger, () => 42)
      assert.equal(r.ok, true)
      assert.equal(r.value, 42)
      assert.equal(existsSync(`${ledger}.lock`), false, '锁必须被释放')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('**回调抛错时锁也必须释放**（否则一次异常就永久锁死账本）', () => {
    const dir = tempDir('dsh-am-lock-throw-')
    try {
      const ledger = join(dir, 'ledger.jsonl')
      assert.throws(() => withLedgerLock(ledger, () => { throw new Error('boom') }), /boom/)
      assert.equal(existsSync(`${ledger}.lock`), false, '异常路径必须走 finally')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('活锁不会被抢走', () => {
    const dir = tempDir('dsh-am-lock-live-')
    try {
      const lockPath = join(dir, 'x.lock')
      const first = acquireLock(lockPath, { waitMs: 100, staleMs: 10_000 })
      assert.equal(first.ok, true)
      const second = acquireLock(lockPath, { waitMs: 150, staleMs: 10_000 })
      assert.equal(second.ok, false, '持有者仍活着时不能抢锁')
      releaseLock(lockPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('僵尸锁（持有进程已死）会被回收 —— 否则一次崩溃就永久锁死', () => {
    const dir = tempDir('dsh-am-lock-dead-')
    try {
      const lockPath = join(dir, 'x.lock')
      // 999999 这个 pid 几乎不可能存在
      writeFileSync(lockPath, JSON.stringify({ pid: 999_999, at: Date.now() }))
      const r = acquireLock(lockPath, { waitMs: 500, staleMs: 10_000 })
      assert.equal(r.ok, true, '死进程的锁必须能被回收')
      releaseLock(lockPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('过期锁（超过 staleMs）会被回收', () => {
    const dir = tempDir('dsh-am-lock-stale-')
    try {
      const lockPath = join(dir, 'x.lock')
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }))
      const r = acquireLock(lockPath, { waitMs: 500, staleMs: 1000 })
      assert.equal(r.ok, true)
      releaseLock(lockPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('**刚创建但内容为空**的锁不能被立刻抢走（这是曾经的竞态）', () => {
    // 旧实现 openSync('wx') 后才写内容，中间有空文件窗口：第二个进程读到空串
    // → JSON.parse 抛错 → 判为僵尸锁 → 删掉 → 两个进程都持锁。
    // 现在：空内容且未过期 → 视为「可能正在写入」，必须等，不能抢。
    const dir = tempDir('dsh-am-lock-empty-')
    try {
      const lockPath = join(dir, 'x.lock')
      writeFileSync(lockPath, '') // 模拟空文件窗口
      const r = acquireLock(lockPath, { waitMs: 120, staleMs: 10_000 })
      assert.equal(r.ok, false, '空内容 + 未过期 → 不能抢')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('isPidAlive 对当前进程返回 true，对不存在的 pid 返回 false', () => {
    assert.equal(isPidAlive(process.pid), true)
    assert.equal(isPidAlive(999_999), false)
    assert.equal(isPidAlive(0), false)
    assert.equal(isPidAlive(-1), false)
  })

  test('LOCK_STALE_MS 是正数且远大于一次正常写入', () => {
    assert.ok(LOCK_STALE_MS >= 1000, '太短会误抢活锁')
    assert.ok(LOCK_STALE_MS <= 60_000, '太长会让崩溃后卡很久')
  })
})

describe('并发写入 · 真实多进程', () => {
  test('**8 进程 × 5 写：节点不丢、id 不撞、seq 不撞、无残留锁**', async () => {
    const dir = tempDir('dsh-am-conc-')
    try {
      const worker = `
const { openLibrary, createOperations } = await import('file://${PLUGIN_ROOT}/src/index.js')
const lib = openLibrary(process.argv[2])
const ops = createOperations(lib)
const tag = process.argv[3]
for (let i = 0; i < 5; i += 1) {
  ops.write({ text: 'p' + tag + '-' + i, subject: 'p' + tag, relation: 'r' + i, object: String(i) })
}
`
      const results = await runWorkers(dir, worker, 8)
      const bad = results.filter((r) => r.code !== 0)
      assert.equal(bad.length, 0, `有进程异常退出：${bad[0]?.out.slice(0, 300) ?? ''}`)

      const lib = openLibrary(dir)
      const { state, events, problems } = lib.load()

      assert.equal(state.nodes.size, 40, '40 条判断必须全部折叠出来（旧实现只剩 29）')
      assert.deepEqual(problems, [], '不该有任何 problem')

      const ids = events.filter((e) => e.type === 'node.created').map((e) => e.data.id)
      assert.equal(new Set(ids).size, 40, '节点 id 不能重复')

      const seqs = events.filter((e) => e.type === 'node.created').map((e) => e.seq)
      assert.equal(new Set(seqs).size, 40, 'seq 不能重复 —— 顺序必须确定')
      // seq 必须严格递增（排序后相邻差为 1），否则 fold 的排序会不稳定
      const sorted = seqs.slice().sort((a, b) => a - b)
      for (let i = 1; i < sorted.length; i += 1) {
        assert.equal(sorted[i], sorted[i - 1] + 1, `seq 不连续：${sorted[i - 1]} → ${sorted[i]}`)
      }

      assert.equal(existsSync(join(dir, 'ledger.jsonl.lock')), false, '不能残留锁文件')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('**锁的互斥深度必须是 1**（有重叠就说明锁是假的）', async () => {
    const dir = tempDir('dsh-am-mutex-')
    try {
      const lockPath = join(dir, 'crit.lock').replace(/\\/g, '/')
      const logPath = join(dir, 'crit.log').replace(/\\/g, '/')
      const worker = `
const { withLedgerLock } = await import('file://${PLUGIN_ROOT}/src/store.js')
const { appendFileSync } = await import('node:fs')
const tag = process.argv[3]
for (let i = 0; i < 3; i += 1) {
  const r = withLedgerLock('${lockPath}', () => {
    appendFileSync('${logPath}', tag + ' IN\\n')
    // 在临界区里停一下，让重叠有机会发生
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12)
    appendFileSync('${logPath}', tag + ' OUT\\n')
  })
  if (!r.ok) appendFileSync('${logPath}', tag + ' FAIL\\n')
}
`
      await runWorkers(dir, worker, 5)
      const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
      assert.equal(lines.filter((l) => l.endsWith('FAIL')).length, 0, '不该有抢锁失败')

      let depth = 0
      let maxDepth = 0
      for (const line of lines) {
        if (line.endsWith('IN')) {
          depth += 1
          maxDepth = Math.max(maxDepth, depth)
        } else if (line.endsWith('OUT')) {
          depth -= 1
        }
      }
      assert.equal(maxDepth, 1, `临界区出现重叠（最大深度 ${maxDepth}），锁没起作用`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('并发 connect · 边写入也必须走同一把锁', () => {
  test('8 个进程各建一条边：边数正确且 seq 不重复', async () => {
    const dir = tempDir('dsh-am-connect-')
    try {
      const setup = openLibrary(dir)
      const { createOperations } = await import('../../src/index.js')
      const setupOps = createOperations(setup)
      const nodes = []
      for (let i = 0; i < 16; i += 1) {
        const result = setupOps.write({ text: 'node-' + i, subject: 'node-' + i, relation: 'kind', object: String(i) })
        assert.equal(result.action, 'created')
        nodes.push(result.node_id)
      }
      const pairs = []
      for (let i = 0; i < 8; i += 1) pairs.push([nodes[2 * i], nodes[2 * i + 1]])
      const worker = `
const { openLibrary, createOperations } = await import('file://${PLUGIN_ROOT}/src/index.js')
const pair = ${JSON.stringify(pairs)}[Number(process.argv[3])]
const result = createOperations(openLibrary(process.argv[2])).connect({ from: pair[0], to: pair[1], type: 'complements' })
if (!result.ok) throw new Error(result.note)
`
      const results = await runWorkers(dir, worker, 8)
      const bad = results.filter((r) => r.code !== 0)
      assert.equal(bad.length, 0, `有进程异常退出：${bad[0]?.out.slice(0, 300) ?? ''}`)

      const { state, events, problems } = openLibrary(dir).load()
      assert.equal(state.edges.length, 8, '8 条边都必须写入')
      assert.deepEqual(problems, [], '不该有任何 problem')
      const seqs = events.map((e) => e.seq)
      assert.equal(new Set(seqs).size, seqs.length, '所有事件 seq 必须唯一')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('节点 id · 唯一性优先于可复现性', () => {
  test('同一 (at, seq) 两次调用必须给出不同 id', async () => {
    const { makeNodeId } = await import('../../src/supersede.js')
    assert.notEqual(makeNodeId(1000, 7), makeNodeId(1000, 7))
  })

  test('10000 次批量生成无碰撞', async () => {
    const { makeNodeId } = await import('../../src/supersede.js')
    const ids = new Set()
    for (let i = 0; i < 10000; i += 1) ids.add(makeNodeId(1000, 7))
    assert.equal(ids.size, 10000)
  })

  test('id 仍然可读：n_<seq>_<时间前缀><随机后缀>', async () => {
    const { makeNodeId } = await import('../../src/supersede.js')
    assert.match(makeNodeId(1730000000000, 7), /^n_0007_[a-z0-9]{6}[0-9a-f]{16}$/)
  })
})
