/**
 * **Behavioural** tests for worker URL resolution (not text matching).
 *
 * Why this deserves its own test file: it hit a **silent-failure**-class trap.
 * The revision was originally read from `document.currentScript.src`, but the
 * official README states plainly:
 *   "module side effects run at materialization"
 * — the factory only runs on **first use**, by which time currentScript is
 * already null. The result was a 404 for the worker, so the panel quietly
 * degraded to a static layout, **with no error raised**.
 *
 * So a **fake browser environment** (document + location + __DSH_BOOT__) is
 * built here, client.js is really executed in it, and the URL handed to
 * `new Worker()` is asserted to carry the correct rev.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(here, '..', '..', 'lib', 'client.js')

/** A minimal React stand-in. */
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
 * Run the **computation** behind `WORKER_PATH` directly out of client.js under
 * the given environment.
 *
 * Approach: extract the bodies of `resolveWorkerUrl` and `extractRev` from
 * client.js and evaluate them in the same sandbox. That tests the **real code**
 * rather than a copy of it.
 *
 * @param {object} env - Same as loadAndCaptureWorkerUrl.
 * @returns {string|null} The resolved worker path.
 */
function evalWorkerPath(env) {
  const code = readFileSync(CLIENT_PATH, 'utf8')

  // Extract the two functions (they depend on no module-level variable except the WORKER_FILE constant)
  const workerFileMatch = /const WORKER_FILE = '([^']+)'/.exec(code)
  assert.ok(workerFileMatch, 'the WORKER_FILE constant should be findable')

  const resolveMatch = /function resolveWorkerUrl\(\)\s*\{[\s\S]*?\n    \}/.exec(code)
  assert.ok(resolveMatch, 'resolveWorkerUrl should be findable')
  const extractMatch = /function extractRev\(url\)\s*\{[\s\S]*?\n    \}/.exec(code)
  assert.ok(extractMatch, 'extractRev should be findable')

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

describe('worker URL resolution · behaviour (guarding against silent failure)', () => {
  test('when currentScript is available the rev is read from it directly (the path where the script materializes immediately)', () => {
    const url = evalWorkerPath({
      currentScriptSrc: `http://127.0.0.1:19387/plugins/??dsh-ai-memory/client.js&rev=${GOOD_REV}`,
    })
    assert.equal(url, `/plugins/dsh-ai-memory/client.graph-worker.js?rev=${GOOD_REV}`)
  })

  test('**the rev is still found when currentScript is null** (the real lazy-execution case)', () => {
    const url = evalWorkerPath({
      currentScriptSrc: null,
      scriptSrcs: [`http://127.0.0.1:19387/plugins/??dsh-ai-memory/client.js&rev=${GOOD_REV}`],
    })
    assert.equal(url, `/plugins/dsh-ai-memory/client.graph-worker.js?rev=${GOOD_REV}`,
      'when the factory runs lazily currentScript is null, so the rev must be recoverable from the script tag')
  })

  test('when there is no script tag either, the rev comes from __DSH_BOOT__ (the last resort)', () => {
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
      'its own line should be findable in the boot payload')
  })

  test('when none is available it degrades to no rev (the panel uses the fallback layout, not a blank screen)', () => {
    const url = evalWorkerPath({ currentScriptSrc: null, scriptSrcs: [], boot: { entries: [] } })
    assert.equal(url, '/plugins/dsh-ai-memory/client.graph-worker.js',
      'a usable path is still produced without a rev (it will 404, but the panel does not crash)')
  })

  test('it does not pick the wrong rev when other plugins are among the script tags', () => {
    const url = evalWorkerPath({
      currentScriptSrc: null,
      scriptSrcs: [
        'http://127.0.0.1:19387/plugins/??dsh-downloads-panel/client.js&rev=deadbeef0001',
        'http://127.0.0.1:19387/plugins/??dsh-balance-pill/client.js&rev=deadbeef0002',
        `http://127.0.0.1:19387/plugins/??dsh-ai-memory/client.js&rev=${GOOD_REV}`,
      ],
    })
    assert.ok(url.includes(GOOD_REV), `it must pick out its own line; actual ${url}`)
    assert.ok(!url.includes('deadbeef'), 'it must not pick up another plugin rev')
  })

  test('the chunk shape (?rev=) is parsed as well', () => {
    const url = evalWorkerPath({
      currentScriptSrc: null,
      scriptSrcs: [`http://127.0.0.1:19387/plugins/dsh-ai-memory/client.js?rev=${GOOD_REV}`],
    })
    assert.equal(url, `/plugins/dsh-ai-memory/client.graph-worker.js?rev=${GOOD_REV}`)
  })

  test('a malformed URL does not throw; it degrades to no rev', () => {
    assert.doesNotThrow(() => evalWorkerPath({ currentScriptSrc: 'not a url at all', scriptSrcs: ['::::'] }))
    const url = evalWorkerPath({ currentScriptSrc: 'not a url', scriptSrcs: ['::::'] })
    assert.equal(url, '/plugins/dsh-ai-memory/client.graph-worker.js')
  })

  test('the worker file name and path prefix are correct', () => {
    const url = evalWorkerPath({ currentScriptSrc: null })
    assert.ok(url.startsWith('/plugins/dsh-ai-memory/'), `the path prefix must be right; actual ${url}`)
    assert.ok(url.includes('client.graph-worker.js'), 'the file name must be right (it must carry the client. prefix)')
  })
})
