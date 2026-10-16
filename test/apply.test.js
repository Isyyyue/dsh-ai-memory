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

describe('apply() · 工具真的注册了（防静默失效）', () => {
  test('七个工具全部注册，名字正确', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'a1') })
    const names = rec.tools.map((t) => t.name).sort()
    assert.deepEqual(names, [
      'memory_connect',
      'memory_history',
      'memory_persona',
      'memory_rule',
      'memory_search',
      'memory_stats',
      'memory_write',
    ])
  })

  test('每个工具都有 description / parameters / output.schema / execute', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'a2') })
    for (const t of rec.tools) {
      assert.ok(typeof t.description === 'string' && t.description.length > 0, `${t.name} 缺 description`)
      assert.ok(t.parameters !== null && typeof t.parameters === 'object', `${t.name} 缺 parameters`)
      assert.ok(t.output !== null && typeof t.output === 'object', `${t.name} 缺 output`)
      assert.ok(t.output.schema !== null && typeof t.output.schema === 'object', `${t.name} 缺 output.schema`)
      assert.equal(typeof t.output.render, 'function', `${t.name} 缺 output.render`)
      assert.equal(typeof t.execute, 'function', `${t.name} 缺 execute`)
    }
  })

  test('parameters 是合法 JSON Schema 对象根（dsh-tools 只收这个子集）', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'a3') })
    for (const t of rec.tools) {
      assert.equal(t.parameters.type, 'object', `${t.name} 的 parameters 必须是 object 根`)
      // Subset limit: oneOf/anyOf/allOf/$ref are unsupported.
      const json = JSON.stringify(t.parameters)
      for (const banned of ['"oneOf"', '"anyOf"', '"allOf"', '"$ref"']) {
        assert.ok(!json.includes(banned), `${t.name} 用了不支持的 JSON Schema 关键字 ${banned}`)
      }
    }
  })

  test('注册的工具真的可执行（不是空壳）', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'a4') })
    const byName = new Map(rec.tools.map((t) => [t.name, t]))
    // Walk one real "write → search → stats" loop.
    const w = byName.get('memory_write').execute({ text: '我认为取代优于相似度', subject: 'x', relation: 'y', object: '1' })
    assert.equal(w.action, 'created')
    const s = byName.get('memory_search').execute({ query: '取代' })
    assert.ok(s.total >= 1)
    const st = byName.get('memory_stats').execute({})
    assert.equal(st.judgments, 1)
  })

  test('注入 section 注册了，且 text 是惰性函数', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'a5') })
    assert.equal(rec.sections.length, 1)
    assert.equal(rec.sections[0].name, 'dsh-ai-memory:index')
    assert.equal(typeof rec.sections[0].text, 'function', 'text 必须是函数（惰性读盘）')
    assert.equal(rec.sections[0].interpolate, false, '必须关掉插值，否则正文里的 {{}} 会炸整个 prompt')
  })

  test('injectIndex: false 时不注册注入，但工具照常', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'a6'), injectIndex: false })
    assert.equal(rec.sections.length, 0)
    assert.equal(rec.tools.length, 7, '关注入不该影响工具')
  })

  test('enabled: false 时什么都不注册', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'a7'), enabled: false })
    assert.equal(rec.tools.length, 0)
    assert.equal(rec.sections.length, 0)
  })
})

describe('apply() · webServer 是局部可选依赖（关键）', () => {
  test('没有 webServer 时，工具**照样**注册（不该整条不激活）', () => {
    const { ctx, rec } = fakeCtx({ withWebServer: false })
    apply(ctx, { dir: join(work, 'b1') })
    assert.equal(rec.tools.length, 7, '缺 webServer 不能让工具消失')
    assert.equal(rec.sections.length, 1)
    assert.equal(rec.routes.length, 0)
  })

  test('有 webServer 时，三条数据路由注册了', () => {
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

  test('webServer 走的是局部 inject，不在必需 inject 列表里', () => {
    assert.ok(!inject.includes('webServer'), 'webServer 不该是硬依赖')
    assert.deepEqual([...inject].sort(), ['systemPrompt', 'tools'])
  })

  test('注入声明的服务名与插件名符合约定', () => {
    assert.equal(name, 'dsh-ai-memory')
  })
})

describe('apply() · 注入文本真的能生成', () => {
  test('写一条判断后，注入文本包含它', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'c1') })
    const byName = new Map(rec.tools.map((t) => [t.name, t]))
    byName.get('memory_write').execute({ text: '图谱只做导航不做事实载荷' })
    const text = rec.sections[0].text()
    assert.match(text, /图谱只做导航/)
  })

  test('空库时注入空串（不占上下文）', () => {
    const { ctx, rec } = fakeCtx()
    apply(ctx, { dir: join(work, 'c2') })
    assert.equal(rec.sections[0].text(), '')
  })

  test('记忆库损坏时注入降级为空串，不抛（不能因为记忆坏了让会话跑不动）', () => {
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
