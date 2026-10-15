/**
 * Assert that the client bundle **the host is actually serving** contains every critical fix.
 *
 * Why this is separate: nearly every pitfall in this plugin is **silent** — the code changed but
 * the host serves an old bundle, or a fix never made it into the served copy, and nothing reports
 * an error. This script fetches the served content over HTTP and asserts on it, which is the
 * closest available check to "what the user actually receives".
 *
 * Usage: node test/verify-served-bundle.mjs
 */

const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:19387'
const ID = 'dsh-ai-memory'

const list = await (await fetch(`${BASE}/plugins/${ID}/snapshot`)).json().catch(() => null)
if (list === null) {
  console.log('✗ the host is unreachable or the plugin is not enabled')
  process.exit(1)
}

// The snapshot route does not expose rev, so derive it the way the bundle probe script does.
const probe = await (await fetch(`${BASE}/plugins/${ID}/snapshot`)).text()
void probe

/** Try the usual rev source: compute it from the plugin directory's mtime. */
import { createHash } from 'node:crypto'
import { statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const profileClient = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', ID, 'lib', 'client.js')
const st = statSync(profileClient)
const h = createHash('sha1').update('plugin-artifact').update('\0')
for (const x of [String(st.mtimeMs), String(st.ctimeMs), String(st.size)]) {
  h.update(String(Buffer.byteLength(x)) + ':').update(x)
}
const rev = h.digest('hex').slice(0, 12)

const res = await fetch(`${BASE}/plugins/??${ID}/client.js&rev=${rev}`)
if (!res.ok) {
  console.log(`✗ bundle unavailable (HTTP ${res.status}, rev=${rev})`)
  process.exit(1)
}
const body = await res.text()
/** Strip comments — they **deliberately document** these pitfalls and must not count as code. */
const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

console.log(`\n[bundle currently served by the host] rev=${rev}  ${body.length} bytes\n`)

let fails = 0
/** Assert and print. */
function check(label, cond) {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    fails += 1
    console.log(`  ✗ ${label}`)
  }
}

console.log('— application stability (a violation prevents the whole app from opening) —')
check('does not read ctx.styles', !/ctx\.styles/.test(code))
check('inject declares only slots', /inject: \['slots'\]/.test(code))

console.log('\n— whether the canvas can draw —')
check('the renderer effect depends on state.phase (otherwise the renderer is never created)', /\}, \[state\.phase\]\)/.test(code))
check('the data effect depends on canvasOk', /\[state\.snapshot, canvasOk\]/.test(code))
check('resizeSoon retries exist (otherwise the drawing buffer stays at 300×150)', /resizeSoon\(attempt = 0\)/.test(code))
check('ResizeObserver present (the root fix for size changes)', /new ResizeObserver\(/.test(code))
check('the viewport is recomputed after a resize', /changed && this\.autoFit === true/.test(code))
check('every node id is sent to the Worker (otherwise the node set is emptied)', /coords\[id\] = p\.placed === true \? \[p\.x, p\.y\] : null/.test(code))

console.log('\n— whether interaction works —')
check('the fallback layer is conditionally rendered (otherwise it covers the canvas and eats pointer events)', /canvasOk \? null : FallbackGraph/.test(code))
check('dblclick reset present', /addEventListener\('dblclick'/.test(code))
check('contextmenu toggle for retired nodes present', /addEventListener\('contextmenu'/.test(code))

console.log('\n— UI reduction (only the graph is kept) —')
check('SHOW_HEAD = false', /const SHOW_HEAD = false/.test(code))
check('SHOW_CHIPS = false', /const SHOW_CHIPS = false/.test(code))
check('SHOW_TOOLBAR = false', /const SHOW_TOOLBAR = false/.test(code))
check('SHOW_LEGEND = false', /const SHOW_LEGEND = false/.test(code))
const detail = code.slice(code.indexOf('function Detail('), code.indexOf('function FallbackGraph'))
check('the detail view does not show the bare id', detail.length > 100 && !/node\.id/.test(detail))
check('the detail view does not show revision/time', !/node\.revision|node\.createdAt/.test(detail))
check('the detail view keeps the body text', /node\.text/.test(detail))
check('the detail view keeps the supersession chain', /node\.chain/.test(detail))

console.log('\n— style injection —')
check('a <style> element carrying the data-plugin marker is used', /data-plugin="dsh-ai-memory"/.test(body))
check('ensureStyles is defined and called', (body.match(/ensureStyles\(/g) ?? []).length >= 2)

console.log(`\n${'='.repeat(56)}`)
if (fails > 0) {
  console.log(`${fails} item(s) failed`)
  process.exit(1)
}
console.log('the host-served bundle contains every critical fix ✓')
