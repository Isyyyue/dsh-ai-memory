/**
 * 校验「内联 worker 源码」与真源一致。
 *
 * 为什么必须有这条：worker 的**唯一真源**是 `lib/client.graph-worker.js`，
 * 它由 `test/inline-worker.mjs` 同步进 `client.js` 的标记区。
 * 如果有人手改了 worker 却忘了跑生成器，客户端用的就是**旧代码** ——
 * 而且**不报错**，只是行为不对（本插件最贵的一类 bug）。
 *
 * 用法：node test/worker-inline.test.js
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(here, '..', 'lib', 'client.js')
const WORKER = join(here, '..', 'lib', 'client.graph-worker.js')

/** 从 client.js 里取出内联的 worker 源码。 */
function inlinedWorkerSource() {
  const src = readFileSync(CLIENT, 'utf8')
  const m = /const WORKER_SOURCE = (")/.exec(src)
  if (m === null) return null
  // 从字面量起点往后扫，找到配对的结束引号（尊重转义）
  let i = m.index + m[0].length - 1
  const start = i
  i += 1
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '"') break
    i += 1
  }
  const literal = src.slice(start, i + 1)
  try {
    return JSON.parse(literal)
  } catch {
    return null
  }
}

describe('worker · 内联源码与真源一致', () => {
  test('client.js 里有 WORKER_SOURCE 标记区', () => {
    const src = readFileSync(CLIENT, 'utf8')
    assert.ok(src.includes('// >>> WORKER-SOURCE'), '缺少开始标记')
    assert.ok(src.includes('// <<< WORKER-SOURCE <<<'), '缺少结束标记')
    assert.ok(/const WORKER_SOURCE = "/.test(src), '缺少 WORKER_SOURCE 常量')
  })

  test('内联的源码**逐字等于** lib/client.graph-worker.js', () => {
    const expected = readFileSync(WORKER, 'utf8')
    const actual = inlinedWorkerSource()
    assert.ok(actual !== null, '解析不出内联源码')
    assert.equal(actual, expected,
      '内联的 worker 与真源不一致 —— 跑 `node test/inline-worker.mjs` 同步')
  })

  test('内联的不是空串（空串等于没有 Worker）', () => {
    const actual = inlinedWorkerSource()
    assert.ok(typeof actual === 'string' && actual.length > 1000, `内联长度异常：${actual?.length}`)
  })

  test('worker 源码本身有 onmessage 入口（内联后仍要能跑）', () => {
    const actual = inlinedWorkerSource()
    assert.ok(actual.includes('self.onmessage'), 'worker 必须有 onmessage')
  })
})
