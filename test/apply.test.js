/**
 * apply() 的接线测试 —— 专门抓"静默失效"。
 *
 * 这是本插件最危险的一类 bug：插件装了、不报错、但一个工具都没注册。
 * viya-memory 亲身踩过：`apply()` 用了 `ctx.systemPrompt` 却没写进 `inject`，
 * 于是整条插件不激活，而 mock ctx 自测全绿也抓不到。
 *
 * 所以这里**真的调用 apply()**，并断言：
 *   - 六个工具真的注册了（名字对得上）
 *   - 注入 section 真的注册了
 *   - webServer 缺席时，工具**照样**注册（局部可选依赖）
 *   - enabled:false 时什么都不注册
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
  try { rmSync(work, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

/**
 * 造一个**记录型**假 ctx。
 *
 * 刻意不实现真实 cordis 语义，只记录调用 —— 目的是证明"注册动作真的发生了"，
 * 而不是证明 cordis 本身工作正常（那是官方的事）。
 *
 * @param {{withWebServer?: boolean}} [opts] - 是否提供 webServer。
 * @returns {object} 假 ctx 与记录。
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
  // ctx.inject(services, cb) —— 只有全部服务都在时才回调（cordis 语义）。
  ctx.inject = (services, cb) => {
    rec.injects.push(services)
    const allPresent = services.every((s) => ctx.get(s) !== undefined)
    if (allPresent) cb(ctx)
  }
  return { ctx, rec }
}

describe('apply() · 工具真的注册了（防静默失效）', () => {
  test('六个工具全部注册，名字正确', () => {
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
      // 子集限制：不支持 oneOf/anyOf/allOf/$ref
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
    // 走一遍真实的"写 → 搜 → 统计"闭环
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
    assert.equal(rec.tools.length, 6, '关注入不该影响工具')
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
    assert.equal(rec.tools.length, 6, '缺 webServer 不能让工具消失')
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
    // 制造一个"目录变成文件"的损坏场景：读盘会失败
    const sec = rec.sections[0]
    // 直接把 dir 指向一个非法路径（含 NUL）以触发读取异常
    const broken = fakeCtx()
    apply(broken.ctx, { dir: '\u0000invalid' })
    assert.doesNotThrow(() => broken.rec.sections[0].text())
  })
})
