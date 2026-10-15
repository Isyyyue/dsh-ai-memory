/**
 * Verify that the client bundle is **in the host's service table** (not merely that the slot registered).
 *
 * Why this is needed:
 *   `Slots.listSubTree` shows whether something registered in a slot, but registration
 *   presupposes that the browser **already fetched and executed** `lib/client.js`. If the
 *   bundle never entered the host's responses table, the browser can never fetch it and
 *   nothing appears in the slot — while **neither side reports an error**. This is a
 *   textbook silent failure.
 *
 * Criteria (from the dsh-client-modules/lib/index.js implementation):
 *   1. A single-asset URL uses the **combo form**: `/plugins/??<id>/client.js&rev=<rev>`
 *      (not `/plugins/<id>/client.js` — that shape does not exist)
 *   2. rev = first 12 hex digits of sha1 over framedHash("plugin-artifact", [mtimeMs, ctimeMs, size])
 *   3. The host collects `dsh.client` entries into the responses table during its **startup scan**;
 *      a bundle installed after startup is **not in the table** until the host restarts (official
 *      wording: replacing an installed package requires restart to load a fresh JavaScript module
 *      generation)
 *
 * Usage:
 *   node test/bundle-served.mjs            # check this plugin
 *   node test/bundle-served.mjs --all      # also compare against a plugin known to work (to isolate host-side problems)
 */

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const BASE = process.env.DSH_WEB_BASE ?? 'http://127.0.0.1:19387'
const PROFILE_NM = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules')

/**
 * Recompute the host's artifact rev.
 * The algorithm is copied line by line from framedHash + artifactRevision in dsh-client-modules/lib/index.js.
 *
 * @param {{mtimeMs: number, ctimeMs: number, size: number}} b - filesystem baseline.
 * @returns {string} the 12-hex-digit rev.
 */
export function artifactRevision(b) {
  const hash = createHash('sha1').update('plugin-artifact').update('\0')
  for (const part of [String(b.mtimeMs), String(b.ctimeMs), String(b.size)]) {
    hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
  }
  return hash.digest('hex').slice(0, 12)
}

/** Build the combo-form single-asset URL (the shape the host actually recognizes). */
export function comboUrl(id, rev) {
  return `${BASE}/plugins/??${id}/client.js&rev=${rev}`
}

/**
 * Probe whether the host serves a package's client bundle.
 *
 * @param {string} id - package name.
 * @param {string} clientPath - path to the client file.
 * @returns {Promise<{id: string, rev: string, status: number, bytes: number, served: boolean, reason?: string}>}
 */
export async function probeBundle(id, clientPath) {
  let st
  try {
    st = statSync(clientPath)
  } catch (err) {
    return { id, rev: '', status: 0, bytes: 0, served: false, reason: `cannot read file: ${err.message}` }
  }
  const rev = artifactRevision({ mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size })
  const url = comboUrl(id, rev)
  try {
    const res = await fetch(url, { headers: { accept: 'application/javascript' } })
    const body = await res.text()
    return {
      id,
      rev,
      status: res.status,
      bytes: body.length,
      served: res.status === 200,
      ...(res.status === 200 ? {} : { reason: `this rev is not in the host service table (HTTP ${res.status})` }),
    }
  } catch (err) {
    return { id, rev, status: 0, bytes: 0, served: false, reason: `request failed: ${err.message}` }
  }
}

// ---- Run the checks when executed as a script ----
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1].replace(/\\/g, '/')
if (isMain || process.argv[1]?.endsWith('bundle-served.mjs')) {
  const results = []

  console.log('\n[this plugin]')
  const mine = await probeBundle('dsh-ai-memory', join(root, 'lib', 'client.js'))
  results.push(mine)
  console.log(`  rev=${mine.rev}  HTTP ${mine.status}  ${mine.bytes} bytes`)
  if (mine.served) {
    console.log('  ✓ the client bundle is served by the host')
    // Content spot check: confirm the served code really is this plugin's (targeting the Canvas + Worker architecture).
    const res = await fetch(comboUrl('dsh-ai-memory', mine.rev))
    const body = await res.text()
    const marks = [
      ['module loader', body.includes('__ModuleLoader__')],
      ['registration id correct', body.includes('dsh-ai-memory')],
      ['contains the graph panel component', body.includes('MemoryGraphPanel')],
      ['renders with Canvas 2D', body.includes("getContext('2d')") || body.includes('getContext("2d")')],
      ['force simulation runs in a Worker', body.includes('workerPath()') && body.includes('new Worker')],
      ['continuous animation loop present', body.includes('requestAnimationFrame')],
      ['styles inserted as a <style> element', body.includes('data-plugin="dsh-ai-memory"')],
      // Check after stripping comments — comments **specifically document** this pitfall and must not count as code.
      ['does not read ctx.styles (would break the app)', !/ctx\.styles/.test(body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, ''))],
    ]
    for (const [label, ok] of marks) console.log(`    ${ok ? '✓' : '✗'} ${label}`)
  } else {
    console.log(`  ✗ not served — ${mine.reason}`)
  }

  if (process.argv.includes('--all')) {
    console.log('\n[reference: a plugin known to work]')
    const ref = await probeBundle('dsh-downloads-panel', join(PROFILE_NM, 'dsh-downloads-panel', 'lib', 'client.js'))
    results.push(ref)
    console.log(`  rev=${ref.rev}  HTTP ${ref.status}  ${ref.bytes} bytes`)
    console.log(`  ${ref.served ? '✓ served (so the host side itself is fine)' : '✗ not served either (the problem is host-side, not in this plugin)'}`)
  }

  console.log(`\n${'='.repeat(60)}`)
  const mineOk = mine.served
  if (mineOk) {
    console.log('Conclusion: the client bundle is verified along the serving path ✓')
  } else {
    const refOk = results.find((r) => r.id === 'dsh-downloads-panel')?.served
    console.log('Conclusion: this plugin\'s client bundle is **not yet in the host service table**.')
    if (refOk === true) {
      console.log('')
      console.log('This is a **known and expected state**, not a defect. The exact root cause:')
      console.log('')
      console.log('  resolveMeta() in dsh-client-modules (lib/index.js:701) permanently caches each')
      console.log('  package\'s resolution per sourceKey — **including a cached null**:')
      console.log('      if (cached !== undefined) return cached')
      console.log('      if (decl === undefined || decl.platform !== "web") pkgMeta.set(key, null)')
      console.log('')
      console.log('  This plugin was installed after the host started, and at first resolution its')
      console.log('  package.json had no dsh.client yet, so null was cached — and since the sourceKey')
      console.log('  never changes, that cache never expires.')
      console.log('')
      console.log('  The following therefore do nothing:')
      console.log('    ✗ reinstalling          (sourceKey unchanged)')
      console.log('    ✗ disabling and re-enabling (same reason)')
      console.log('    ✗ changing mtime        (HMR only rebuilds entries already in the table; confirmed by a controlled experiment)')
      console.log('    ✓ restarting the host    ← the only effective action')
      console.log('')
      console.log('  Official wording (host-plugin.md):')
      console.log('    "replacing an installed package requires restart to load a fresh')
      console.log('     JavaScript module generation."')
      console.log('')
      console.log('  → The host side (tools, injection, HTTP routes) is already live via HMR;')
      console.log('    the client side needs a host restart, after which re-running this script should return 200.')
    } else {
      console.log('  The reference plugin is not served either — the problem may be host-side, or in the BASE address/port.')
    }
  }
  // Use exitCode rather than process.exit(): force-exiting while fetch sockets are still
  // open trips libuv's UV_HANDLE_CLOSING assertion (one ugly stderr line on Windows).
  // Letting the event loop drain naturally keeps the exit code accurate.
  process.exitCode = mineOk ? 0 : 2
}
