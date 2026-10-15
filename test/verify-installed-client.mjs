/**
 * Assert that the client.js installed in the profile is the **fixed** version.
 *
 * Why this is separate: the incident was "the client half prevents the whole application from
 * opening", and both failure shapes are easy to miss (`failed` and `pending (waiting for
 * service: styles)`). After installing, it must be possible to **confirm quickly** that the copy
 * on disk contains no `ctx.styles` access.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const profileClient = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-ai-memory', 'lib', 'client.js')
const workspaceClient = join(import.meta.dirname, '..', 'lib', 'client.js')

let fails = 0
/** Assert and print. */
function check(label, cond, extra = '') {
  if (cond) console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`)
  else {
    fails += 1
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

for (const [label, path] of [['workspace', workspaceClient], ['profile (what the host actually loads)', profileClient]]) {
  console.log(`\n[${label}] ${path}`)
  let src
  try {
    src = readFileSync(path, 'utf8')
  } catch (err) {
    check('file is readable', false, err.message)
    continue
  }
  // Strip comments: they deliberately document these pitfalls and must not count as code.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  check('does not read ctx.styles (0.2.0-rc.2 does not provide that service and reading it throws)', !/ctx\.styles/.test(code))
  check('does not call styles.insert', !/styles\.insert/.test(code))
  check('inject declares only slots', /inject: \['slots'\]/.test(code))
  check('apply touches only ctx.slots', (() => {
    const body = code.slice(code.indexOf('function apply(ctx)'))
    const used = [...body.matchAll(/ctx\.(\w+)/g)].map((m) => m[1])
    return [...new Set(used)].join(',') === 'slots'
  })())
  check('styles are inserted as a <style> element with the data-plugin marker', /data-plugin="dsh-ai-memory"/.test(src))
  check('ensureStyles is defined and called', (src.match(/ensureStyles\(/g) ?? []).length >= 2)
  check('style injection uses the container document', /ensureStyles\(canvas\.ownerDocument\)/.test(src))
  check('the worker URL is evaluated lazily (no module-scope DOM read)', /let cachedWorkerPath = null/.test(src) && !/^\s*const WORKER_PATH = /m.test(src))
  check('byte count', true, String(src.length))
}

console.log(`\n${'='.repeat(56)}`)
if (fails > 0) {
  console.log(`${fails} item(s) failed — **do not restart yet**; fix the red items above first`)
  process.exit(1)
}
console.log('the client half is the fixed version ✓ (a restart can now be verified)')
