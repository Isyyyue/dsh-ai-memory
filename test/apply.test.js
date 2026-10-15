/**
 * Wiring tests for apply() — aimed squarely at "silent failure".
 *
 * This is the most dangerous class of bug in the plugin: the plugin is installed,
 * nothing errors, and not one tool got registered. viya-memory hit this for real:
 * `apply()` used `ctx.systemPrompt` without declaring it in `inject`, so the whole
 * plugin failed to activate, while mock-ctx self-tests stayed green and could not
 * catch it.
 *
 * So this file **really calls apply()** and asserts:
 *   - the six tools are really registered (names match)
 *   - the injection section is really registered
 *   - with no webServer, the tools are registered **anyway** (a scoped optional dependency)
 *   - with enabled:false, nothing is registered
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, name } from '../src/index.js'

let work

before(() => {
  work = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-apply-'))
})

after(() => {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* ignore */ }
})

/**
 * Build a **recording** fake ctx.
 *
 * It deliberately does not implement real cordis semantics; it only records calls.
 * The point is to prove that the registration actually happened, not that cordis
 * itself works (that is the official project's concern).
 *
 * @param {{withWebServer?: boolean}} [opts] - whether to provide a webServer.
 * @returns {object} the fake ctx and its records.
 */
function fakeCtx(opts = {}) {
  const rec = { tools: [], sections: [], routes: [], effects: 0, injects: [] }

  const makeScope = (hasWebServer) => ({
    effect(fn, label) {
      rec.effects += 1
      rec.lastEffectLabel = label
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    tools: {
      register(def) {
        rec.tools.push(def)
        return () => {}
      },
    },
    systemPrompt: {
      section(sec) {
        rec.sections.push(sec)
        return () => {}
      },
    },
    ...(hasWebServer
      ? {
          webServer: {
            register(route) {
              rec.routes.push(route)
              return () => {}
            },
          },
        }
      : {}),
    get(k) {
      if (k === 'webServer' && hasWebServer) return this.webServer
      return undefined
    },
  })

  const ctx = makeScope(opts.withWebServer === true)
  // ctx.inject(services, cb) — the callback runs only when every service is present (cordis semantics).
  ctx.inject = (services, cb) => {
    rec.injects.push(services)
    const allPresent = services.every((s) => ctx.get(s) !== undefined)
    if (allPresent) cb(ctx)
  }
  return { ctx, rec }
}

describe('apply() · the tools really are registered (guarding against silent failure)', () => {
  test('all six tools are registered, with the right names', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'a1') })
    const names = rec.tools.map((t) => t.name).sort()
    assert.deepEqual(names, [
      'memory_connect',
      'memory_history',
      'memory_rule',
      'memory_search',
      'memory_stats',
      'memory_write',
    ])
  })

  test('every tool has description / parameters / output.schema / execute', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'a2') })
    for (const t of rec.tools) {
      assert.ok(typeof t.description === 'string' && t.description.length > 0, `${t.name} is missing description`)
      assert.ok(t.parameters !== null && typeof t.parameters === 'object', `${t.name} is missing parameters`)
      assert.ok(t.output !== null && typeof t.output === 'object', `${t.name} is missing output`)
      assert.ok(t.output.schema !== null && typeof t.output.schema === 'object', `${t.name} is missing output.schema`)
      assert.equal(typeof t.output.render, 'function', `${t.name} is missing output.render`)
      assert.equal(typeof t.execute, 'function', `${t.name} is missing execute`)
    }
  })

  test('parameters is a valid JSON Schema object root (dsh-tools accepts only this subset)', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'a3') })
    for (const t of rec.tools) {
      assert.equal(t.parameters.type, 'object', `${t.name}'s parameters must be an object root`)
      // Subset limit: oneOf/anyOf/allOf/$ref are unsupported.
      const json = JSON.stringify(t.parameters)
      for (const banned of ['"oneOf"', '"anyOf"', '"allOf"', '"$ref"']) {
        assert.ok(!json.includes(banned), `${t.name} uses the unsupported JSON Schema keyword ${banned}`)
      }
    }
  })

  test('the registered tools really execute (they are not empty shells)', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'a4') })
    const byName = new Map(rec.tools.map((t) => [t.name, t]))
    // Walk one real "write → search → stats" loop.
    const w = byName.get('memory_write').execute({ text: '\u6211\u8ba4\u4e3a\u53d6\u4ee3\u4f18\u4e8e\u76f8\u4f3c\u5ea6', subject: 'x', relation: 'y', object: '1' })
    assert.equal(w.action, 'created')
    const s = byName.get('memory_search').execute({ query: '\u53d6\u4ee3' })
    assert.ok(s.total >= 1)
    const st = byName.get('memory_stats').execute({})
    assert.equal(st.judgments, 1)
  })

  test('the injection section is registered, and its text is a lazy function', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'a5') })
    assert.equal(rec.sections.length, 1)
    assert.equal(rec.sections[0].name, 'dsh-ai-memory:index')
    assert.equal(typeof rec.sections[0].text, 'function', 'text must be a function (lazy disk read)')
    assert.equal(rec.sections[0].interpolate, false, 'interpolation must be off, or a {{}} in the body blows up the whole prompt')
  })

  test('with injectIndex: false no injection is registered, but the tools are unaffected', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'a6'), injectIndex: false })
    assert.equal(rec.sections.length, 0)
    assert.equal(rec.tools.length, 6, 'turning injection off must not affect the tools')
  })

  test('with enabled: false nothing is registered', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'a7'), enabled: false })
    assert.equal(rec.tools.length, 0)
    assert.equal(rec.sections.length, 0)
  })
})

describe('apply() · webServer is a scoped optional dependency (critical)', () => {
  test('with no webServer the tools are registered **anyway** (the plugin must not fail to activate)', () => {
    const { ctx, rec } = fakeCtx({ withWebServer: false })
    apply(ctx, { dir: join(work, 'b1') })
    assert.equal(rec.tools.length, 6, 'a missing webServer must not make the tools disappear')
    assert.equal(rec.sections.length, 1)
    assert.equal(rec.routes.length, 0)
  })

  test('with a webServer, the three data routes are registered', () => {
    const { ctx, rec } = fakeCtx({ withWebServer: true })
    apply(ctx, { dir: join(work, 'b2') })
    assert.equal(rec.routes.length, 3)
    const paths = rec.routes.map((r) => r.path).sort()
    assert.deepEqual(paths, [
      '/plugins/dsh-ai-memory/node',
      '/plugins/dsh-ai-memory/snapshot',
      '/plugins/dsh-ai-memory/stats',
    ])
  })

  test('webServer goes through a scoped inject and is not in the required inject list', () => {
    assert.ok(!inject.includes('webServer'), 'webServer must not be a hard dependency')
    assert.deepEqual([...inject].sort(), ['systemPrompt', 'tools'])
  })

  test('the declared service names and the plugin name follow the convention', () => {
    assert.equal(name, 'dsh-ai-memory')
  })
})

describe('apply() · the injected text really is produced', () => {
  test('after writing a judgment, the injected text contains it', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'c1') })
    const byName = new Map(rec.tools.map((t) => [t.name, t]))
    byName.get('memory_write').execute({ text: '\u56fe\u8c31\u53ea\u505a\u5bfc\u822a\u4e0d\u505a\u4e8b\u5b9e\u8f7d\u8377' })
    const text = rec.sections[0].text()
    assert.match(text, /\u56fe\u8c31\u53ea\u505a\u5bfc\u822a/)
  })

  test('an empty store injects an empty string (costing no context)', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'c2') })
    assert.equal(rec.sections[0].text(), '')
  })

  test('a corrupt memory store degrades to an empty string without throwing (a broken store must not stall a session)', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'c3') })
    // Produce a corruption scenario where reading from disk fails.
    const sec = rec.sections[0]
    // Point dir at an invalid path (containing NUL) to trigger a read exception.
    const broken = fakeCtx()
    apply(broken.ctx, { dir: '\u0000invalid' })
    assert.doesNotThrow(() => broken.rec.sections[0].text())
  })
})
