/**
 * Self-check of the manifest and syntax (the verification scope official verification.md
 * requires when no browser control is available).
 *
 * Only three permitted things are done: JavaScript syntax, manifest validation, and the live
 * Client slots that the caller queries separately.
 * **Not done**: simulating React/DOM, finding a renderer, extracting an SVG preview, or taking
 * screenshots — the official guidance explicitly forbids substituting those for real verification.
 */

import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let fails = 0
/** Assert and print. */
function check(label, cond, extra = '') {
  if (cond) console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`)
  else {
    fails += 1
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

console.log('\n[syntax]')
for (const rel of ['src/index.js', 'src/ledger.js', 'src/supersede.js', 'src/store.js', 'src/query.js', 'src/graph.js', 'src/tools.js', 'src/routes.js', 'lib/client.js']) {
  const p = join(root, rel)
  let ok = true
  let msg = ''
  try {
    execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' })
  } catch (err) {
    ok = false
    msg = String(err.stderr ?? err.message).split('\n')[0]
  }
  check(rel, ok, msg)
}

console.log('\n[manifest]')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check('name is dsh-ai-memory', pkg.name === 'dsh-ai-memory')
check('type = module', pkg.type === 'module')
check('dsh.bundle.patch points at an existing file', existsSync(join(root, pkg.dsh.bundle.patch)), pkg.dsh.bundle.patch)
check('dsh.client.platform = web', pkg.dsh.client.platform === 'web')
check('exports["./client"] points at a real file', existsSync(join(root, pkg.exports['./client'])), pkg.exports['./client'])
check('exports["."] points at a real file', existsSync(join(root, pkg.exports['.'])), pkg.exports['.'])
check('files includes lib/ (the client half must be packaged)', pkg.files.includes('lib/'))
check('files includes src/', pkg.files.includes('src/'))
check('cordis.patch.yml exists', existsSync(join(root, 'cordis.patch.yml')))
check('README.md exists', existsSync(join(root, 'README.md')))
check('LICENSE exists', existsSync(join(root, 'LICENSE')))
// MAINTAINING.md is intentionally NOT shipped (it is a maintainer-only log,
// see .gitignore). If it is present locally, it must still be parseable.
if (existsSync(join(root, 'MAINTAINING.md'))) {
  check('MAINTAINING.md is non-empty (local maintainer log)', readFileSync(join(root, 'MAINTAINING.md'), 'utf8').length > 1000)
}

console.log('\n[dsh.requires declarations (read by the self-check script)]')
const req = pkg.dsh.requires
check('a tested version is declared', typeof req.tested === 'string' && req.tested !== '')
check('checks is a non-empty array', Array.isArray(req.checks) && req.checks.length > 0, `${req.checks.length} entries`)
const kinds = new Set(['profileDep', 'clientBundle', 'patchRow', 'http', 'httpFields', 'process', 'patchMarker'])
const unknown = req.checks.map((c) => c.kind).filter((k) => !kinds.has(k))
check('every check kind is in the script vocabulary', unknown.length === 0, unknown.join(', '))
const httpChecks = req.checks.filter((c) => c.kind === 'http' || c.kind === 'httpFields')
check('every http-type check carries a path', httpChecks.every((c) => typeof c.path === 'string' && c.path.startsWith('/plugins/dsh-ai-memory/')), httpChecks.map((c) => c.path).join(', '))

console.log('\n[the client half contains no hard-constraint violation]')
const client = readFileSync(join(root, 'lib/client.js'), 'utf8')
/** Strip comments before judging "does the code use X" (doc comments document these pitfalls deliberately). */
const clientCode = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
check('does not require a Harness Client package', !/require\(['"]@deepseek-ai/.test(client))
check('does not touch the page body (no DOM attached to document.body)', !/document\.body/.test(client))
check('does not embed an iframe', !/createElement\(['"]iframe['"]/.test(client))
check('does not read another plugin DOM (only script tags or its own style marker)', (() => {
  const queries = [...client.matchAll(/querySelector(?:All)?\(\s*([^)]*)\)/g)].map((m) => m[1])
  return queries.every((q) => /script|data-plugin="dsh-ai-memory"/i.test(q))
})())

// ⚠️ This section was corrected **twice**; it is recorded here to avoid a third round:
//
//   First attempt (wrong): assuming a `<style>` element should be inserted directly, the
//   assertion was written as "must not read ctx.styles".
//   Second attempt (also wrong): seeing `styles` in the official Builtin list, the assertion
//   was changed to "must use styles.insert".
//                      — but **the list declares capabilities, which does not mean the current
//                      version provides that service**. DeepSeek Harness 0.2.0-rc.2 does **not**
//                      provide a client-side `styles` service.
//
// The truth (located by the maintainer and reproduced in a real Chrome):
//   `ctx` is a **restricted Proxy**, and reading a service name that was not injected **throws**
//   (it does not return undefined). So a "safe check" like `if (ctx.styles !== undefined)` **is
//   itself the throw site** → apply throws → fiber=FAILED → the host startup audit refuses to
//   start **the whole application**
//   (`web boot: 1 entry did not activate / dsh-ai-memory: failed`).
//
// The correct approach: follow `dsh-downloads-panel` (which has always worked) and insert a
// `<style>` element carrying the `data-plugin` marker directly, using the container's own
// `ownerDocument`, with the whole block wrapped in try/catch.
check('**does not read ctx.styles** (that service does not exist on 0.2.0-rc.2 and reading it throws)', !/ctx\.styles/.test(clientCode))
check('does not call styles.insert', !/styles\.insert/.test(clientCode))
check('styles are inserted as a <style> element with the data-plugin marker', /data-plugin="dsh-ai-memory"/.test(client))
check('ensureStyles is actually called (defined but never called = bare HTML and no error)', (client.match(/ensureStyles\(/g) ?? []).length >= 2)
check('style injection uses the container document', /ensureStyles\(canvas\.ownerDocument\)/.test(client))
check('style injection swallows its own exceptions (a missing style must not remove the panel)', (() => {
  const start = client.indexOf('function ensureStyles')
  const body = client.slice(start, start + 700)
  return /try\s*\{/.test(body) && /catch/.test(body)
})())
check('apply touches only ctx.slots (the only declared service)', (() => {
  const applyBody = clientCode.slice(clientCode.indexOf('function apply(ctx)'))
  const used = [...applyBody.matchAll(/ctx\.(\w+)/g)].map((m) => m[1])
  return [...new Set(used)].join(',') === 'slots'
})())

console.log('\n[Canvas + Worker architecture]')
const worker = readFileSync(join(root, 'lib/client.graph-worker.js'), 'utf8')
/** Likewise strip comments before judging (comments deliberately mention things like "no Math.random"). */
const workerCode = worker.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
check('the worker file name follows the client-modules chunk convention', /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test('client.graph-worker.js'))
check('the worker is a standalone script (no import; Workers have no module resolution)', !/^\s*import\s/m.test(worker))
check('the worker has an onmessage entry', /self\.onmessage\s*=/.test(worker))
check('the worker advances with setTimeout (not rAF — Workers have no rAF)', /setTimeout/.test(workerCode) && !/requestAnimationFrame/.test(workerCode))
check('the worker uses a deterministic hash for the initial layout (not Math.random)', /hash32/.test(workerCode) && !/Math\.random/.test(workerCode))
check('the client draws with Canvas 2D', /getContext\(['"]2d['"]\)/.test(client))
check('the client has a continuous animation loop', /requestAnimationFrame/.test(client) && /cancelAnimationFrame/.test(client))
check('the client terminates the worker on unmount', /terminate\(\)/.test(client))

console.log(`\n${'='.repeat(56)}`)
if (fails > 0) {
  console.log(`Manifest self-check failed on ${fails} item(s)`)
  process.exit(1)
}
console.log('Manifest self-check passed ✓')
console.log('\nNote: visual verification (what the panel actually renders) is unavailable without')
console.log('    browser control; as required by official verification.md, it is reported as unverified.')
