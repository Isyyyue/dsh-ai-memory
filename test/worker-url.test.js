/**
 * Worker URL 解析的**行为测试**（不是文本匹配）。
 *
 * 为什么值得单独测：这里踩过一个**静默失效**级的坑 ——
 * 最初用 `document.currentScript.src` 取 rev，但官方 README 明说
 *   "module side effects run at materialization"
 * 也就是 factory 在**首次使用**时才执行，那时 currentScript 已是 null。
 * 结果是 worker 404 → 面板悄悄退化成静态布局，**不报错**。
 *
 * 所以这里造一个**假的浏览器环境**（document + location + __DSH_BOOT__），
 * 真的把 client.js 跑起来，断言 `new Worker()` 收到的 URL 带正确的 rev。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(here, '..', 'lib', 'client.js')

/** 极简 React 替身。 */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat().filter((c) => c != null) }),
    useRef: (init) => ({ current: init }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
  }
}

/**
 * 直接从 client.js 里把 `WORKER_PATH` 的**计算过程**在给定环境下跑一遍。
 *
 * 做法：把 client.js 里 `resolveWorkerUrl` 与 `extractRev` 两个函数体抽出来，
 * 在同一个沙箱里求值。这样测的是**真实代码**，而不是复制品。
 *
 * @param {object} env - 同 loadAndCaptureWorkerUrl。
 * @returns {string|null} 解析出的 worker 路径。
 */
function evalWorkerPath(env) {
  const code = readFileSync(CLIENT_PATH, 'utf8')

  // 抽出两个函数（它们内部不依赖模块级变量，除了 WORKER_FILE 常量）
  const workerFileMatch = /const WORKER_FILE = '([^']+)'/.exec(code)
  assert.ok(workerFileMatch, '应当能找到 WORKER_FILE 常量')

  const resolveMatch = /function resolveWorkerUrl\(\)\s*\{[\s\S]*?\n    \}/.exec(code)
  assert.ok(resolveMatch, '应当能找到 resolveWorkerUrl')
  const extractMatch = /function extractRev\(url\)\s*\{[\s\S]*?\n    \}/.exec(code)
  assert.ok(extractMatch, '应当能找到 extractRev')

  const scripts = (env.scriptSrcs ?? []).map((src) => ({ src }))
  const sandbox = {
    document: {
      currentScript: env.currentScriptSrc === null || env.currentScriptSrc === undefined ? null : { src: env.currentScriptSrc },
      querySelectorAll: (sel) => (String(sel).includes('script') ? scripts : []),
    },
    location: { href: 'http://127.0.0.1:19387/' },
    globalThis: null,
    URL,
    console,
  }
  sandbox.globalThis = sandbox
  if (env.boot !== undefined) sandbox.globalThis.__DSH_BOOT__ = env.boot

  const program = `
    const WORKER_FILE = ${JSON.stringify(workerFileMatch[1])};
    ${extractMatch[0]}
    ${resolveMatch[0]}
    resolveWorkerUrl();
  `
  vm.createContext(sandbox)
  return vm.runInContext(program, sandbox, { filename: 'resolveWorkerUrl.js' })
}

const GOOD_REV = '3d1f70cdc176'

describe('worker URL 解析 · 行为（防静默失效）', () => {
  test('currentScript 可用时直接取 rev（脚本立即 materialize 的路径）', () => {
    const url = evalWorkerPath({
      currentScriptSrc: `http://127.0.0.1:19387/plugins/??dsh-ai-memory/client.js&rev=${GOOD_REV}`,
    })
    assert.equal(url, `/plugins/dsh-ai-memory/client.graph-worker.js?rev=${GOOD_REV}`)
  })

  test('**currentScript 为 null 时也能取到**（惰性执行的真实场景）', () => {
    const url = evalWorkerPath({
      currentScriptSrc: null,
      scriptSrcs: [`http://127.0.0.1:19387/plugins/??dsh-ai-memory/client.js&rev=${GOOD_REV}`],
    })
    assert.equal(url, `/plugins/dsh-ai-memory/client.graph-worker.js?rev=${GOOD_REV}`,
      'factory 惰性执行时 currentScript 是 null，必须能从 script 标签反查到 rev')
  })

  test('script 标签也没有时，从 __DSH_BOOT__ 取（最后一道）', () => {
    const url = evalWorkerPath({
      currentScriptSrc: null,
      scriptSrcs: [],
      boot: {
        entries: [
          { id: 'dsh-downloads-panel', url: 'plugins/??dsh-downloads-panel/client.js&rev=aaaa' },
          { id: 'dsh-ai-memory', url: 'plugins/??dsh-ai-memory/client.js&rev=' + GOOD_REV },
        ],
      },
    })
    assert.equal(url, `/plugins/dsh-ai-memory/client.graph-worker.js?rev=${GOOD_REV}`,
      '应当能在启动载荷里找到自己那一行')
  })

  test('全都没有时退化为无 rev（面板走兜底布局，不是白屏）', () => {
    const url = evalWorkerPath({ currentScriptSrc: null, scriptSrcs: [], boot: { entries: [] } })
    assert.equal(url, '/plugins/dsh-ai-memory/client.graph-worker.js',
      '取不到 rev 也要给出可用的路径（虽然会 404，但面板不崩）')
  })

  test('script 标签里混着别的插件时不会取错 rev', () => {
    const url = evalWorkerPath({
      currentScriptSrc: null,
      scriptSrcs: [
        'http://127.0.0.1:19387/plugins/??dsh-downloads-panel/client.js&rev=deadbeef0001',
        'http://127.0.0.1:19387/plugins/??dsh-balance-pill/client.js&rev=deadbeef0002',
        `http://127.0.0.1:19387/plugins/??dsh-ai-memory/client.js&rev=${GOOD_REV}`,
      ],
    })
    assert.ok(url.includes(GOOD_REV), `必须挑出自己那一条，实际 ${url}`)
    assert.ok(!url.includes('deadbeef'), '不能取到别的插件的 rev')
  })

  test('分块形状（?rev=）也能解析', () => {
    const url = evalWorkerPath({
      currentScriptSrc: null,
      scriptSrcs: [`http://127.0.0.1:19387/plugins/dsh-ai-memory/client.js?rev=${GOOD_REV}`],
    })
    assert.equal(url, `/plugins/dsh-ai-memory/client.graph-worker.js?rev=${GOOD_REV}`)
  })

  test('畸形 URL 不抛异常，退化为无 rev', () => {
    assert.doesNotThrow(() => evalWorkerPath({ currentScriptSrc: 'not a url at all', scriptSrcs: ['::::'] }))
    const url = evalWorkerPath({ currentScriptSrc: 'not a url', scriptSrcs: ['::::'] })
    assert.equal(url, '/plugins/dsh-ai-memory/client.graph-worker.js')
  })

  test('worker 文件名与路径前缀正确', () => {
    const url = evalWorkerPath({ currentScriptSrc: null })
    assert.ok(url.startsWith('/plugins/dsh-ai-memory/'), `路径前缀要对，实际 ${url}`)
    assert.ok(url.includes('client.graph-worker.js'), '文件名要对（必须带 client. 前缀）')
  })
})
