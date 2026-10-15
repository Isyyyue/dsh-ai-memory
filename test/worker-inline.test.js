/**
 * Verify that the inlined worker source matches the real source.
 *
 * Why this is required: the worker's **single source of truth** is
 * `lib/client.graph-worker.js`, which `test/inline-worker.mjs` synchronizes into
 * the marked region of `client.js`. If someone edits the worker by hand and
 * forgets to run the generator, the client runs **stale code** — and **reports
 * no error**, it just behaves incorrectly (the most expensive class of bug in
 * this plugin).
 *
 * Usage: node test/worker-inline.test.js
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(here, '..', 'lib', 'client.js')
const WORKER = join(here, '..', 'lib', 'client.graph-worker.js')

/** Extract the inlined worker source from client.js. */
function inlinedWorkerSource() {
  const src = readFileSync(CLIENT, 'utf8')
  const m = /const WORKER_SOURCE = (")/.exec(src)
  if (m === null) return null
  // Scan forward from the start of the literal to its matching closing quote (respecting escapes).
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

describe('worker · inlined source matches the real source', () => {
  test('client.js contains the WORKER_SOURCE marked region', () => {
    const src = readFileSync(CLIENT, 'utf8')
    assert.ok(src.includes('// >>> WORKER-SOURCE'), 'the opening marker is missing')
    assert.ok(src.includes('// <<< WORKER-SOURCE <<<'), 'the closing marker is missing')
    assert.ok(/const WORKER_SOURCE = "/.test(src), 'the WORKER_SOURCE constant is missing')
  })

  test('the inlined source is **byte-identical** to lib/client.graph-worker.js', () => {
    const expected = readFileSync(WORKER, 'utf8')
    const actual = inlinedWorkerSource()
    assert.ok(actual !== null, 'the inlined source could not be parsed')
    assert.equal(actual, expected,
      'the inlined worker does not match the real source — run `node test/inline-worker.mjs` to synchronize')
  })

  test('the inlined value is not an empty string (an empty string means no Worker)', () => {
    const actual = inlinedWorkerSource()
    assert.ok(typeof actual === 'string' && actual.length > 1000, `unexpected inlined length: ${actual?.length}`)
  })

  test('the worker source itself has an onmessage entry (it must still run once inlined)', () => {
    const actual = inlinedWorkerSource()
    assert.ok(actual.includes('self.onmessage'), 'the worker must have onmessage')
  })
})
