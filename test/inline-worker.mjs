/**
 * 把 `lib/client.graph-worker.js` 的源码**内联进 `lib/client.js`** 的标记区。
 *
 * ## 为什么要内联
 *
 * Worker 是拖拽的前提（拖拽要把坐标发给它钉住节点）。而建 Worker 需要一个 URL：
 *
 *   · **包内分块 URL** 要求 `?rev=<客户端 bundle 的 rev>` 精确匹配，不带就 404
 *   · rev 要从自己的 script 标签 / `__DSH_BOOT__` 里反查 —— 而**桌面版的传输方式
 *     不一定留下 script 标签**（走 `loadBundle`），于是拿不到 rev → 404 →
 *     Worker 建不起来 → **拖不动**（而且不报错）
 *
 * 内联成字符串后用 **Blob URL** 建 Worker：**不发任何网络请求**，
 * 不依赖 rev、不依赖路由、不依赖传输方式。桌面版与网页版都通。
 *
 * ## 为什么用生成器而不是手写
 *
 * 唯一真源仍然是 `lib/client.graph-worker.js`（好读、好测）。
 * 这个脚本把它同步进 `client.js` 的标记区，**并且测试会校验两者一致** ——
 * 手改了 worker 却忘了跑生成器，测试会红。
 *
 * 用法：node test/inline-worker.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'

const here = new URL('.', import.meta.url)
const workerPath = new URL('../lib/client.graph-worker.js', here)
const clientPath = new URL('../lib/client.js', here)

const workerSrc = readFileSync(workerPath, 'utf8')
const clientSrc = readFileSync(clientPath, 'utf8')

const BEGIN = '// >>> WORKER-SOURCE (由 test/inline-worker.mjs 生成，勿手改) >>>'
const END = '// <<< WORKER-SOURCE <<<'

const beginIdx = clientSrc.indexOf(BEGIN)
const endIdx = clientSrc.indexOf(END)
if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {
  console.log('✗ 找不到标记区。请先在 client.js 里放上：')
  console.log(`    ${BEGIN}`)
  console.log('    （worker 源码）')
  console.log(`    ${END}`)
  process.exit(1)
}

// 用 JSON.stringify 生成合法的 JS 字符串字面量 —— 反引号、${}、反斜杠全都不用操心
const literal = JSON.stringify(workerSrc)
const block = `${BEGIN}\n    const WORKER_SOURCE = ${literal}\n    ${END}`

const next = clientSrc.slice(0, beginIdx) + block + clientSrc.slice(endIdx + END.length)

if (next === clientSrc) {
  console.log(`✓ 已是最新（worker ${workerSrc.length} 字符）`)
} else {
  writeFileSync(clientPath, next)
  console.log(`✓ 已内联 worker 源码（${workerSrc.length} 字符 → client.js 现在 ${next.length} 字符）`)
}
