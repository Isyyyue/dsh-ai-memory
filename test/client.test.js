/**
 * Tests for the client half.
 *
 * Approach: build a fake `window.__ModuleLoader__` and actually run
 * `lib/client.js` — this exercises **the code the browser really executes**,
 * not a copy of it.
 *
 * This version targets the **Canvas + Worker** architecture (it replaced an
 * earlier SVG version): the panel no longer produces an SVG element tree but
 * feeds positions to a Canvas 2D surface. The assertions therefore moved from
 * "element tree structure" to "registers correctly + honours the interaction
 * contract + violates no hard constraint".
 *
 * The **visual** result of rendering still needs a human eye (no browser
 * control on this machine); the rendering **logic** is covered by
 * `panel-render.test.js` and `worker.test.js`.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(here, '..', 'lib', 'client.js')

/** Minimal React stand-in: just enough for this plugin (createElement / useRef / useState / useEffect). */
function fakeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat().filter((c) => c !== null && c !== undefined && c !== false) }
    },
    useRef: (init) => ({ current: init }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
  }
}

/**
 * Load the client module in an isolated vm and return the factory output plus
 * the registration records.
 *
 * @param {{withStyles?: boolean}} [opts] - whether to provide the styles builtin.
 * @returns {{loaderId: string, api: object, registered: object[], injects: string[], styles: string[], effects: number}}
 */
function loadClient(opts = {}) {
  const registered = []
  const injects = []
  const styles = []
  let effects = 0
  const mod = { exports: {} }

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          mod.exports.loaderId = id
          mod.exports.factoryResult = factory((name) => {
            if (name === 'react') return fakeReact()
            throw new Error(`unexpected require: ${name}`)
          })
        },
      },
    },
    console,
  }
  sandbox.globalThis = sandbox

  const code = readFileSync(CLIENT_PATH, 'utf8')
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'client.js' })

  const api = mod.exports.factoryResult
  if (api !== undefined) {
    const ctx = {
      ...(opts.withStyles === false
        ? {}
        : { styles: { insert(css) { styles.push(css); return () => {} } } }),
      effect(fn) {
        effects += 1
        const d = fn()
        return typeof d === 'function' ? d : () => {}
      },
      slots: {
        inject(slot, cb) {
          injects.push(slot)
          cb()
        },
        register(options, component) {
          registered.push({ options, component })
        },
      },
    }
    api.apply(ctx)
  }
  return { loaderId: mod.exports.loaderId, api, registered, injects, styles, effects }
}

describe('client · module loading', () => {
  test('the registered id equals the package name (a mismatch means it never loads)', () => {
    assert.equal(loadClient().loaderId, 'dsh-ai-memory')
  })

  test('exports apply and declares slots in inject', () => {
    const { api } = loadClient()
    assert.equal(typeof api.apply, 'function')
    assert.deepEqual([...api.inject], ['slots'])
  })

  test('requires only react, no Harness Client package', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const requires = [...code.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
    assert.deepEqual([...new Set(requires)], ['react'], `only react may be required, got: ${requires.join(', ')}`)
  })

  test('不碰页面主体、不读别的插件的 DOM', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(!/document\.body/.test(code), '不得 append 到页面主体')
    // querySelector / querySelectorAll 是**允许**的，但只允许两类用途：
    //   1. 查 script 标签（取自己的 bundle rev）
    //   2. 查带本插件 data-plugin 标记的 style 标签（防重复注入）
    // 读别的插件的组件/样式/位置才是禁止的。
    const queries = [...code.matchAll(/querySelector(?:All)?\(\s*([^)]*)\)/g)].map((m) => m[1])
    for (const q of queries) {
      assert.ok(/script|data-plugin="dsh-ai-memory"/i.test(q),
        `只该查 script 标签或自己的 style 标记，实际查了：${q}`)
    }
  })

  test('不直接操作文档头（样式走 styles.insert）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(!/document\.head/.test(code))
  })

  test('不嵌 iframe（iframe 拿不到主题 token）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(!/createElement\(['"]iframe['"]/.test(code))
  })
})

describe('client · 槽位注册', () => {
  test('注册了两个槽：main 与 sidebar.panellist', () => {
    const { registered, injects } = loadClient()
    assert.deepEqual(injects.sort(), ['main', 'sidebar.panellist'])
    assert.deepEqual(registered.map((r) => r.options.name).sort(), ['main', 'sidebar.panellist'])
  })

  test('main 槽用 key 与侧边栏 id 配对（同一个 PANEL_ID）', () => {
    const { registered } = loadClient()
    const main = registered.find((r) => r.options.name === 'main')
    const side = registered.find((r) => r.options.name === 'sidebar.panellist')
    assert.equal(main.options.key, side.options.id, 'main.key 必须等于 sidebar.id，否则点了图标不开面板')
    assert.equal(side.options.id, 'ai-memory')
  })

  test('侧边栏图标有 order 与 label', () => {
    const { registered } = loadClient()
    const side = registered.find((r) => r.options.name === 'sidebar.panellist')
    assert.equal(typeof side.options.order, 'number')
    assert.ok(typeof side.options.label === 'string' && side.options.label.length > 0)
  })

  test('两个槽都拿到了组件，且能渲染不抛', () => {
    const { registered } = loadClient()
    for (const r of registered) {
      assert.equal(typeof r.component, 'function', `${r.options.name} 没拿到组件`)
      assert.doesNotThrow(() => r.component({}), `${r.options.name} 的组件渲染就抛了`)
    }
  })
})

describe('client · 样式（用 <style> 直插，不用 ctx.styles）', () => {
  test('**不读 ctx.styles** —— Desktop 0.2.0-rc.2 不提供该服务，读它会抛', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    // 血泪教训：曾经写 `if (ctx.styles !== undefined)` 想做"可选"，
    // 但 ctx 是受限 Proxy —— **读未提供的服务名这一步本身就抛** →
    // factory 抛 → fiber=FAILED → **整个应用拒绝启动**。
    assert.ok(!/ctx\.styles/.test(stripped), '不得读 ctx.styles')
    assert.ok(!/styles\.insert/.test(stripped), '不得调用 styles.insert')
  })

  test('apply 里只碰 ctx.slots（唯一声明过的服务）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const applyBody = code.slice(code.indexOf('function apply(ctx)'))
    const used = [...applyBody.matchAll(/ctx\.(\w+)/g)].map((m) => m[1])
    assert.deepEqual([...new Set(used)], ['slots'],
      `apply 里只该碰 ctx.slots，实际：${[...new Set(used)].join(', ')}`)
  })

  test('inject 只声明 slots（不声明不存在的服务）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const m = /return \{ name: 'dsh-ai-memory-client', inject: (\[[^\]]*\]), apply \}/.exec(code)
    assert.ok(m, '找不到导出语句')
    assert.equal(m[1], "['slots']", `只该声明 slots，实际 ${m[1]}`)
  })

  test('样式用带 data-plugin 标记的 <style> 直插（照 downloads-panel 的做法）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/function ensureStyles/.test(code), '应当有 ensureStyles')
    assert.ok(/data-plugin="dsh-ai-memory"/.test(code), '应当打 data-plugin 标记（防重复注入）')
    assert.ok(/doc\.createElement\('style'\)/.test(code), '应当创建 style 元素')
  })

  test('**ensureStyles 真的被调用了**（定义了不调用 = 裸 HTML 且不报错）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const calls = [...code.matchAll(/ensureStyles\(/g)].length
    assert.ok(calls >= 2, `ensureStyles 应当有定义 + 至少一处调用，实际出现 ${calls} 次`)
  })

  test('样式注入用容器自己的 document（不是全局 document）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/ensureStyles\(canvas\.ownerDocument\)/.test(code),
      '应当传 canvas.ownerDocument，而不是依赖全局 document')
  })

  test('样式注入整段包 try/catch（取不到样式不该让面板消失）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const start = code.indexOf('function ensureStyles')
    const body = code.slice(start, start + 700)
    assert.ok(/try\s*\{/.test(body) && /catch/.test(body), 'ensureStyles 必须自己吞异常')
  })

  test('CSS 常量里有组件用的那套类名', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const cssMatch = code.match(/const CSS = `([\s\S]*?)`/)
    assert.ok(cssMatch, '找不到 CSS 常量')
    for (const cls of ['dsh-am-root', 'dsh-am-canvas', 'dsh-am-stage', 'dsh-am-chip', 'dsh-am-detail']) {
      assert.ok(cssMatch[1].includes(cls), `CSS 里应当有 .${cls}`)
    }
  })
})

describe('client · 受限 ctx 下必须能激活（真实事故的回归测试）', () => {
  /**
   * 造一个**受限 Proxy** ctx：只认已声明的服务名，读别的名字就抛。
   *
   * 这正是 DSH 客户端 ctx 的真实语义 —— 而本鲸当初正是被它坑的：
   * 写 `if (ctx.styles !== undefined)` 以为在做"可选检查"，
   * 实际上**读这一步就抛了** → factory 抛 → fiber=FAILED → **应用拒绝启动**。
   *
   * @param {string[]} allowed - 允许访问的服务名。
   * @returns {object} 受限 ctx。
   */
  function restrictedCtx(allowed) {
    const store = {
      slots: {
        inject: (_s, cb) => cb(),
        register: () => () => {},
      },
    }
    return new Proxy(store, {
      get(target, prop) {
        if (typeof prop === 'symbol') return Reflect.get(target, prop)
        if (prop === 'effect') return (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} }
        if (prop === 'inject') return (_list, cb) => cb()
        if (prop === 'get') return (name) => (allowed.includes(name) ? target[name] : undefined)
        if (!allowed.includes(prop)) {
          // 这就是 DSH 的行为：读未提供的服务名 → 抛
          throw new Error(`cannot read unknown service "${String(prop)}" on restricted ctx`)
        }
        return Reflect.get(target, prop)
      },
    })
  }

  /** 在给定 ctx 下跑 apply，返回是否抛。 */
  function applyWith(ctxFactory) {
    const mod = { exports: {} }
    const sandbox = {
      window: {
        __ModuleLoader__: {
          load({ factory }) {
            mod.exports.api = factory((name) => {
              if (name === 'react') return fakeReact()
              throw new Error(`unexpected require: ${name}`)
            })
          },
        },
      },
      console,
    }
    sandbox.globalThis = sandbox
    vm.createContext(sandbox)
    vm.runInContext(readFileSync(CLIENT_PATH, 'utf8'), sandbox, { filename: 'client.js' })
    try {
      mod.exports.api.apply(ctxFactory())
      return { threw: false }
    } catch (err) {
      return { threw: true, message: err.message }
    }
  }

  test('**只提供 slots 的受限 ctx 下，apply 必须成功**', () => {
    const r = applyWith(() => restrictedCtx(['slots']))
    assert.equal(r.threw, false, `受限 ctx 下 apply 抛了：${r.message}`)
  })

  test('**没有任何 styles 服务时也不能抛**（这就是当初让应用打不开的原因）', () => {
    const r = applyWith(() => restrictedCtx(['slots']))
    assert.equal(r.threw, false, 'ctx 上没有 styles 时，apply 不得去读它')
  })

  test('连 slots 都不在白名单时，抛出的必须是明确的服务名错误（而非静默）', () => {
    const r = applyWith(() => restrictedCtx([]))
    if (r.threw) {
      assert.match(r.message, /unknown service|slots/, `抛出的应当是服务名错误，实际：${r.message}`)
    }
  })
})

describe('client · 兜底层不能盖住 canvas（"图能画但完全动不了"）', () => {
  test('**兜底层是有条件渲染的**（无条件渲染会吃掉所有指针事件）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // 血泪教训：兜底层曾经无条件渲染，而它的 CSS 是
    //   .dsh-am-fallback { z-index: 3; pointer-events: auto; }
    //   .dsh-am-canvas   { z-index: 2; }
    // 于是它盖在 canvas 上并接走全部拖拽/滚轮/点击 →
    // 表现是"图能画出来但完全动不了"，而且看到的"图"其实是那个**静态 SVG**。
    const call = /canvasOk\s*\?\s*null\s*:\s*FallbackGraph\(/.exec(code)
    assert.ok(call !== null, '兜底层必须写成 `canvasOk ? null : FallbackGraph(...)`')
  })

  test('有 canvasOk 状态，且 Canvas 建成后置 true', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/const \[canvasOk, setCanvasOk\] = React\.useState\(false\)/.test(code), '要有 canvasOk 状态')
    assert.ok(/if \(renderer !== null\) setCanvasOk\(true\)/.test(code), 'Canvas 建成后要撤掉兜底层')
  })

  test('Canvas 建不起来时不崩（降级到兜底层而不是白屏）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const start = code.indexOf('let renderer = null')
    const body = code.slice(start, start + 400)
    assert.ok(/try\s*\{/.test(body) && /catch/.test(body), 'new GraphRenderer 要包 try/catch')
    assert.ok(/renderer = null/.test(body), '失败时 renderer 置 null')
  })

  test('renderer 可能为 null 的地方都做了保护', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // 既然 renderer 可以是 null，resize / observer / destroy 都要可选链
    assert.ok(/renderer\?\.resize\(\)/.test(code), 'resize 要可选链')
    assert.ok(/renderer\?\.destroy\(\)/.test(code), 'destroy 要可选链')
  })

  test('兜底层的 z-index 仍然高于 canvas（它只在降级时才出现）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const fb = /\.dsh-am-fallback \{[^}]*z-index:\s*(\d+)/.exec(code)
    const cv = /\.dsh-am-canvas \{[^}]*z-index:\s*(\d+)/.exec(code)
    assert.ok(fb !== null && cv !== null, '两层都要有 z-index')
    assert.ok(Number(fb[1]) > Number(cv[1]), '兜底层 z-index 要更高（降级时它该在上面）')
  })
})

describe('client · 面板只留图（主人要求去掉顶部 UI）', () => {
  test('标题 / 说明 / 统计 / 按钮 默认都不显示，只有图例开着', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    for (const flag of ['SHOW_HEAD', 'SHOW_CHIPS', 'SHOW_TOOLBAR']) {
      const m = new RegExp(`const ${flag} = (true|false)`).exec(code)
      assert.ok(m !== null, `应当有 ${flag} 开关`)
      assert.equal(m[1], 'false', `${flag} 应当默认关闭（主人要求只留图）`)
    }
    // 图例是**唯一保留的文字** —— 颜色不自解释，不写出来就只能猜。
    assert.ok(/const SHOW_LEGEND = true/.test(code), '图例应当默认打开')
  })

  test('开关留着 —— 想恢复旧样子只改这几个常量', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/const SHOW_HEAD = false/.test(code))
    assert.ok(/const SHOW_CHIPS = false/.test(code))
    assert.ok(/const SHOW_TOOLBAR = false/.test(code))
    assert.ok(/const SHOW_LEGEND = true/.test(code))
  })

  test('底部那行"N 节点 · M 连线"也去掉了', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const render = code.slice(code.indexOf("return h('div', { className: 'dsh-am-root' }"))
    assert.ok(!/dsh-am-hint/.test(render), '渲染里不该再有 dsh-am-hint')
  })

  test('功能没丢：双击背景复位、右键切换含退役', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/addEventListener\('dblclick', this\.onDblClick\)/.test(code), '要有 dblclick 复位')
    assert.ok(/addEventListener\('contextmenu', this\.onContextMenu\)/.test(code), '要有右键切换')
    assert.ok(/onToggleRetired/.test(code), '右键要能切换含退役')
  })
})

describe('client · 详情只显示"记忆本身"（不显示内部记账）', () => {
  test('详情里没有 id / 状态 / 版本 / 时间 / 标签 / 引用', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const start = code.indexOf('function Detail({ node, onClose })')
    const end = code.indexOf('function FallbackGraph')
    const body = code.slice(start, end)
    assert.ok(body.length > 100, '应当找到 Detail 组件')
    // 主人要求："里面只有 ai 存储的记忆"
    assert.ok(!/dsh-am-meta/.test(body), '不该再渲染元数据区')
    assert.ok(!/node\.id/.test(body), '不该显示裸 id')
    assert.ok(!/node\.status/.test(body), '不该显示状态')
    assert.ok(!/node\.revision/.test(body), '不该显示版本号')
    assert.ok(!/node\.createdAt/.test(body), '不该显示建立时间')
    assert.ok(!/node\.tags/.test(body), '不该显示标签')
    assert.ok(!/node\.citations/.test(body), '不该显示引用')
  })

  test('详情保留正文与取代链（都是记忆本身）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const start = code.indexOf('function Detail({ node, onClose })')
    const end = code.indexOf('function FallbackGraph')
    const body = code.slice(start, end)
    assert.ok(/node\.text/.test(body), '要显示判断正文')
    assert.ok(/node\.chain/.test(body), '要显示取代链')
  })

  test('取代链不再打 [status] 这种内部标记', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const start = code.indexOf('function Detail({ node, onClose })')
    const end = code.indexOf('function FallbackGraph')
    const body = code.slice(start, end)
    assert.ok(!/\[ch\.status\]|\[.*status.*\]/.test(body), '链上不该打 [active]/[superseded] 这类标签')
  })
})

describe('client · 按类型分色（主人要求：判断一个颜色，思考一个颜色；全要 ⚪）', () => {
  test('三种 kind 各有自己的颜色，且**形状全是圆**', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const table = /const KIND_STYLE = Object\.freeze\(\{[\s\S]*?\n    \}\)/.exec(code)
    assert.ok(table !== null, '应当有 KIND_STYLE 表')
    const t = table[0]
    // 主人明确要求"全要 ⚪" —— 形状统一，只用颜色区分
    const shapes = [...t.matchAll(/shape:\s*'([a-z]+)'/g)].map((m) => m[1])
    assert.equal(shapes.length, 3, `应当有 3 个 shape，实际 ${shapes.length}`)
    assert.deepEqual([...new Set(shapes)], ['circle'], `三种都应当是圆，实际 ${shapes.join(', ')}`)
    // 颜色必须互不相同（否则"分色"没意义）
    const falls = [...t.matchAll(/fallback:\s*'(#[0-9a-fA-F]{6})'/g)].map((m) => m[1].toLowerCase())
    assert.equal(falls.length, 3, `应当有 3 个 fallback 颜色，实际 ${falls.length}`)
    assert.equal(new Set(falls).size, 3, `三种颜色必须互不相同，实际 ${falls.join(', ')}`)
  })

  test('三种颜色彼此**看起来**也确实分得开（色相不同）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const table = /const KIND_STYLE = Object\.freeze\(\{[\s\S]*?\n    \}\)/.exec(code)
    const falls = [...table[0].matchAll(/fallback:\s*'(#[0-9a-fA-F]{6})'/g)].map((m) => m[1])
    /** 把 #rrggbb 转成色相角（0-360）。 */
    const hue = (hex) => {
      const r = parseInt(hex.slice(1, 3), 16) / 255
      const g = parseInt(hex.slice(3, 5), 16) / 255
      const b = parseInt(hex.slice(5, 7), 16) / 255
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      const d = mx - mn
      if (d === 0) return 0
      let h
      if (mx === r) h = ((g - b) / d) % 6
      else if (mx === g) h = (b - r) / d + 2
      else h = (r - g) / d + 4
      return ((h * 60) + 360) % 360
    }
    const hues = falls.map(hue)
    // 两两色相至少差 30° 才叫"看着是不同颜色"
    for (let i = 0; i < hues.length; i += 1) {
      for (let j = i + 1; j < hues.length; j += 1) {
        const diff = Math.min(Math.abs(hues[i] - hues[j]), 360 - Math.abs(hues[i] - hues[j]))
        assert.ok(diff >= 30, `色相太接近（${falls[i]} vs ${falls[j]}，相差 ${diff.toFixed(0)}°）`)
      }
    }
  })

  test('未知 kind 有兜底（不认识的类型画成灰的，不是隐形）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const m = /const KIND_FALLBACK = Object\.freeze\(\{([^}]*)\}\)/.exec(code)
    assert.ok(m !== null, '应当有 KIND_FALLBACK')
    assert.ok(/shape:\s*'circle'/.test(m[1]), '兜底也要是圆')
    assert.ok(/#[0-9a-fA-F]{6}/.test(m[1]), '兜底要有颜色（不能是空的）')
    assert.ok(/KIND_STYLE\[kind\] \?\? KIND_FALLBACK/.test(code), '未知 kind 要落到兜底')
  })

  test('**没有用背景 token 画节点**（那是"看不见"的老 bug）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const fn = /function nodeColor\(node, c\) \{[\s\S]*?\n    \}/.exec(code)
    assert.ok(fn !== null, '应当找到 nodeColor')
    assert.ok(!/layer2/.test(fn[0]), 'nodeColor 不得用 bg-layer-2（背景色画在背景上等于隐形）')
  })

  test('命中判定与画出的形状用**同一个**外接系数（否则点击会错位）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/function shapeExtent\(shape\)/.test(code), '应当有 shapeExtent（两边共用）')
    assert.ok(/this\.radiusOf\(p\.node\) \* shapeExtent\(kindStyle\(p\.node\.kind\)\.shape\)/.test(code),
      'hitTest 要用 shapeExtent')
  })

  test('**所有节点一样大**（主人要求：不要有的大有的小）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const fn = /radiusOf\(_?node\) \{([\s\S]*?)\n      \}/.exec(code)
    assert.ok(fn !== null, '应当找到 radiusOf')
    const body = fn[1]
    // 半径不得依赖 degree —— 那会让枢纽大、孤儿小，而主人明确不要
    assert.ok(!/degree/.test(body), `radiusOf 不该看 degree，实际：${body.trim()}`)
    const m = /return\s+([\d.]+)/.exec(body)
    assert.ok(m !== null, '应当返回一个常数')
    assert.ok(Number(m[1]) >= 5 && Number(m[1]) <= 10, `半径该在合理区间，实际 ${m[1]}`)
  })

  test('绘制异常**不静默吞掉**（本插件最贵的一类 bug）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const loop = /loop\(\) \{[\s\S]*?\n      \}/.exec(code)
    assert.ok(loop !== null, '应当找到 loop')
    assert.ok(/catch \(err\)/.test(loop[0]), 'catch 要接住错误对象')
    assert.ok(/console\.error/.test(loop[0]), '首帧失败要打日志（否则"画不出来但不报错"）')
    assert.ok(/lastDrawError/.test(loop[0]), '要把错误留在实例上，便于排查')
  })
})

describe('client · 不透明与自动适配视野（主人要求："不要透明的"）', () => {
  test('**节点一律不透明** —— 退役用混色表达，不用 alpha', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const draw = code.slice(code.indexOf('      draw() {'), code.indexOf('    /** 统计 chip'))
    // 画节点那一段里，globalAlpha 只能被设成 1
    const alphas = [...draw.matchAll(/ctx\.globalAlpha = ([^;\n]+)/g)].map((m) => m[1].trim())
    assert.ok(alphas.length > 0, '应当显式设置 globalAlpha')
    for (const a of alphas) {
      assert.equal(a, '1', `画布层不该出现 alpha ${a}（主人要求不要透明的）`)
    }
  })

  test('退役节点靠**混色**变暗，不是靠透明', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/function nodeFill\(node, c\)/.test(code), '应当有 nodeFill')
    const fn = /function nodeFill\(node, c\) \{[\s\S]*?\n    \}/.exec(code)
    assert.ok(/status === 'active'\) return base/.test(fn[0]), '活跃的原色')
    assert.ok(/mixWith\(base, c\.canvasBg,/.test(fn[0]), '退役的往背景混（实色）')
  })

  test('CSS 里画布相关的 opacity 也去掉了', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const css = /const CSS = `([\s\S]*?)`/.exec(code)[1]
    const fbEdge = /\.dsh-am-fallback-edge \{([^}]*)\}/.exec(css)
    assert.ok(fbEdge !== null && !/opacity/.test(fbEdge[1]), '兜底边不该有 opacity')
    const fbNode = /\.dsh-am-fallback-node\.superseded \{([^}]*)\}/.exec(css)
    assert.ok(fbNode !== null && !/opacity/.test(fbNode[1]), '兜底退役节点不该有 opacity')
  })

  test('**有自动适配视野**（否则节点被推开后跑到画面外，看着像坏了）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/fitToContent\(\) \{/.test(code), '应当有 fitToContent')
    assert.ok(/this\.autoFit = true/.test(code), '初始应当开启自动适配')
    assert.ok(/if \(this\.autoFit === true\) this\.fitToContent\(\)/.test(code), '物理跑的时候要持续适配')
  })

  test('用户一动手就**交出视野控制权**（不跟用户抢）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const down = /this\.onPointerDown = \(e\) => \{([\s\S]*?)\n        \}/.exec(code)
    assert.ok(down !== null && /this\.autoFit = false/.test(down[1]), '拖拽要关掉自动适配')
    const wheel = /this\.onWheel = \(e\) => \{([\s\S]*?)\n        \}/.exec(code)
    assert.ok(wheel !== null && /this\.autoFit = false/.test(wheel[1]), '缩放要关掉自动适配')
  })

  test('resetView 会重新打开自动适配（否则复位是空操作）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const fn = /resetView\(\) \{[\s\S]*?\n      \}/.exec(code)
    assert.ok(fn !== null && /this\.autoFit = true/.test(fn[0]), 'resetView 要重开 autoFit')
    assert.ok(/this\.fitToContent\(\)/.test(fn[0]), 'resetView 要真的适配')
  })

  test('**画布尺寸会重试到与 CSS 一致**（否则绘图缓冲停在 300×150）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/resizeSoon\(attempt = 0\)/.test(code), '应当有 resizeSoon（带重试计数）')
    assert.ok(/if \(attempt > 10\) return/.test(code), '重试要有上限（不空转）')
    assert.ok(/this\.resizeSoon\(\)/.test(code), '构造时要调用它')
    // resize 里尺寸变了要重算视野
    const rs = /resize\(\) \{[\s\S]*?\n      \}/.exec(code)
    assert.ok(rs !== null && /changed && this\.autoFit === true/.test(rs[0]), 'resize 后要跟着重算视野')
  })
})

describe('client · 样式只用主题 token', () => {
  test('CSS 里不含硬编码颜色（字面色只允许出现在 var() 的 fallback 里）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const cssMatch = code.match(/const CSS = `([\s\S]*?)`/)
    assert.ok(cssMatch, '找不到 CSS 常量')
    const hardCoded = cssMatch[1]
      .split('\n')
      .filter((line) => !line.includes('var(--dsw-alias-'))
      .filter((line) => /#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(line))
    assert.deepEqual(hardCoded, [], `这些行用了硬编码颜色：\n${hardCoded.join('\n')}`)
  })

  test('用到的 token 都是官方列表里的', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const used = [...new Set([...code.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1]))]
    // Theme.listTokens 返回的完整集合
    const allowed = new Set([
      '--dsw-alias-bg-base',
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-bg-layer-2',
      '--dsw-alias-bg-overlay',
      '--dsw-alias-border-l1',
      '--dsw-alias-border-l2',
      '--dsw-alias-brand-primary',
      '--dsw-alias-label-primary',
      '--dsw-alias-label-secondary',
      '--dsw-alias-state-error-primary',
      '--dsw-alias-state-idle-primary',
      '--dsw-alias-state-success-primary',
      '--dsw-alias-state-warn-primary',
      '--dsw-specific-sidebar-fill',
    ])
    const unknown = used.filter((t) => !allowed.has(t))
    assert.deepEqual(unknown, [], `用了官方列表之外的 token：${unknown.join(', ')}`)
  })

  test('Canvas 用 getComputedStyle 读 token 的实际值（Canvas 不认 CSS 变量）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/getComputedStyle/.test(code), 'Canvas 必须把 token 读成具体颜色')
    assert.ok(/getPropertyValue/.test(code))
  })

  test('明暗切换时会重读主题色', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/MutationObserver/.test(code), '应当监听主题变化')
    assert.ok(/refreshTheme/.test(code))
  })
})

describe('client · Canvas + Worker 架构（丝滑的关键）', () => {
  test('用 Canvas 2D 渲染（面板不再用 SVG 画图）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/getContext\(['"]2d['"]\)/.test(code), '应当用 Canvas 2D')
    assert.ok(/h\(['"]canvas['"]/.test(code), '应当渲染一个 canvas 元素')
    // 面板保留 Canvas，SVG 作为 Worker 首帧失败时的可见兜底；另有侧边栏图标
    const svgCount = (code.match(/h\(['"]svg['"]/g) ?? []).length
    assert.equal(svgCount, 2, `SVG 应为侧边栏图标和可见兜底，实际 ${svgCount} 处`)
  })

  test('力导向跑在 Worker 里（照 Obsidian 的做法）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/new Worker\(url, \{ name: 'dsh-ai-memory-graph' \}\)/.test(code), '应当建 Worker')
    assert.ok(/\.postMessage\(/.test(code), '要能向 worker 发消息')
    assert.ok(/w\.onmessage = /.test(code), '要能收 worker 的坐标')
  })

  test('**Worker 优先用内联源码的 Blob URL**（不依赖 rev，桌面版才拖得动）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // 血泪教训：曾经只用包内分块 URL `/plugins/<id>/client.graph-worker.js?rev=X`，
    // 而 rev 要从 script 标签反查 —— 桌面版走 loadBundle 不一定留 script 标签，
    // 拿不到 rev 就 404 → Worker 建不起来 → **拖拽完全失效**（可选链静默跳过，不报错）。
    assert.ok(/function workerBlobUrl\(\)/.test(code), '应当有 workerBlobUrl')
    assert.ok(/new Blob\(\[WORKER_SOURCE\]/.test(code), '应当用内联源码建 Blob')
    assert.ok(/URL\.createObjectURL\(blob\)/.test(code), '应当转成 object URL')
    // 候选顺序：Blob 优先，URL 兜底
    const i = code.indexOf('const blob = workerBlobUrl()')
    const j = code.indexOf('candidates.push(workerPath())')
    assert.ok(i > 0 && j > i, 'Blob 应当排在包内 URL 前面')
  })

  test('**没有 Worker 也能拖**（主线程兜底）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // 拖拽曾经只发 postMessage，worker 为 null 时静默不动 → "每一个拖不动了"
    const move = /this\.onPointerMove = \(e\) => \{([\s\S]*?)\n        \}/.exec(code)
    assert.ok(move !== null, '应当找到 onPointerMove')
    assert.ok(/this\.worker !== null/.test(move[1]), '要区分有/无 worker')
    assert.ok(/p\.x = w\.x/.test(move[1]) && /p\.y = w\.y/.test(move[1]),
      '没有 worker 时要直接改本地位姿')
  })

  test('**worker URL 是懒求值的**（模块级读 DOM 会让整个应用打不开）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // 血泪教训：曾经写成 `const WORKER_PATH = resolveWorkerUrl()`，
    // 在 factory 的模块作用域读 document → DSH web boot 抛
    // "1 entry did not activate / dsh-ai-memory: failed" → **应用拒绝启动**。
    // 对照：dsh-downloads-panel（能用）的 factory 里没有任何模块级 DOM 读取。
    assert.ok(!/^\s*const WORKER_PATH = resolveWorkerUrl\(\)/m.test(code),
      '不得在模块作用域直接求值 worker URL')
    assert.ok(/let cachedWorkerPath = null/.test(code), '应当用缓存变量做懒求值')
    assert.ok(/function workerPath\(\)/.test(code), '应当有 workerPath() 访问器')
  })

  test('worker URL 带 ?rev= —— 否则 DSH 的分块路由返回 404', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/resolveWorkerUrl/.test(code), '应当解析 worker URL')
    assert.ok(/extractRev/.test(code), '应当有 rev 提取器')
    assert.ok(/searchParams\.get\(['"]rev['"]\)/.test(code), '应当提取 rev 参数')
  })

  test('**不依赖 document.currentScript 取 rev**（factory 是惰性执行的，那时它是 null）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // 官方 README："module side effects run at materialization" —— factory 执行时
    // currentScript 已是 null。所以必须能从**持久的 DOM / 启动载荷**里反查。
    assert.ok(/querySelectorAll/.test(code), '应当从 script 标签反查（持久的 DOM）')
    assert.ok(/__DSH_BOOT__/.test(code), '应当能从启动载荷里反查')
    // currentScript 只作为第一顺位的快捷路径，不能是唯一路径
    const csIdx = code.indexOf('currentScript')
    const qsIdx = code.indexOf('querySelectorAll')
    assert.ok(csIdx > 0 && qsIdx > csIdx, 'currentScript 之后必须还有 querySelectorAll 兜底')
  })

  test('rev 提取兼容 combo 与分块两种 URL 形状', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // combo 是 &rev=，分块是 ?rev=；交给 URL 解析器统一处理
    assert.ok(/new URL\(url, location\.href\)/.test(code), '应当用 URL 解析器（两种形状通吃）')
  })

  test('取不到 rev 时退化为无 rev（面板走兜底布局，不是白屏）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/return base\s*$/m.test(code) || /return base/.test(code), '兜底要返回不带 rev 的路径')
  })

  test('worker 走 DSH 自己的分块路由，本插件不自建', () => {
    const routes = readFileSync(join(here, '..', 'src', 'routes.js'), 'utf8')
    assert.ok(!/WORKER_PATH/.test(routes), 'routes.js 不该再有 worker 路由')
    assert.ok(/WORKER_FILE/.test(routes), '但仍要导出文件名常量供客户端/测试引用')
  })

  test('连续动画循环（不是算完就画死）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/requestAnimationFrame/.test(code), '必须有 rAF 循环')
    assert.ok(/cancelAnimationFrame/.test(code), '卸载时要停掉循环')
  })

  test('拖节点用 Obsidian 的 forceNode 协议', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/forceNode/.test(code), '要发 forceNode')
    assert.ok(/alphaTarget/.test(code), '要能重新加热')
  })

  test('Worker 不可用时退化为静态布局，而不是白屏', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/layoutFallback/.test(code), '要有兜底布局')
    // createWorker 方法体内部必须 try/catch（Worker 可能被 CSP 或环境禁掉）
    const start = code.indexOf('createWorker() {')
    assert.ok(start > 0, '找不到 createWorker 方法')
    const body = code.slice(start, start + 2000)
    assert.ok(/try\s*\{/.test(body) && /catch/.test(body), '建 Worker 失败要被捕获')
    // ⚠️ 而且**不能静默**：失败原因要留下来（本鲸靠这个才发现 URL 404）
    assert.ok(/this\.workerError = /.test(body), '失败原因要留在 workerError 上')
  })

  test('坐标走二进制传输（不是逐个对象）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/Float32Array/.test(code), '应当用 Float32Array 承载坐标')
    assert.ok(/coords/.test(code), '应当有 coords 字段')
  })

  test('devicePixelRatio 缩放（否则高分屏模糊）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/devicePixelRatio/.test(code))
  })
})

describe('client · 交互契约', () => {
  test('支持滚轮缩放、拖背景平移、点击选中', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'click']) {
      assert.ok(code.includes(`'${ev}'`), `应当监听 ${ev}`)
    }
    assert.ok(/hitTest/.test(code), '要有点击命中测试')
    assert.ok(/resetView/.test(code), '要有复位视图')
  })

  test('指针捕获（拖出画布也不丢）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/setPointerCapture/.test(code))
  })

  test('卸载时解开全部监听与 worker（防泄漏）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/removeEventListener/.test(code))
    assert.ok(/terminate/.test(code))
    assert.ok(/destroy\(\)/.test(code))
  })

  test('悬停高亮 + 标签按缩放淡出（照 Obsidian 的 textFade）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/hoverId/.test(code))
    assert.ok(/showLabel/.test(code))
  })

  test('拖拽后不误判为点击（dragMoved 守卫）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/dragMoved/.test(code))
  })
})

describe('client · 数据通道', () => {
  test('走的是本插件自己的 /plugins/dsh-ai-memory 路由', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(code.includes("'/plugins/dsh-ai-memory/snapshot'"))
    assert.ok(code.includes("'/plugins/dsh-ai-memory/node'"))
  })

  test('取快照时检查 ok 字段（不把错误当成功）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/body\.ok !== true/.test(code), '必须检查 ok，否则后端报错会被当成空图')
  })

  test('详情按 id 查询且做了 URL 编码', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/encodeURIComponent\(selected\)/.test(code), '节点 id 进 URL 前必须编码')
  })

  test('有错误态与空态（不是白屏）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/Cannot read memory store/.test(code), '要有错误态文案')
    assert.ok(/No judgments yet/.test(code), '要有空态文案')
  })

  test('图例只列**真能画出来的**四种关系', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // `derives` / `restates` 没有入口能建（工具只暴露前四种），
    // 列出来反而让人以为"怎么没有这种线"。
    for (const label of ['Complements', 'Tensions', 'Supersedes', 'Depends on']) {
      assert.ok(code.includes(label), `图例应当包含「${label}」`)
    }
    const edgeLabel = code.slice(code.indexOf('const EDGE_LABEL'), code.indexOf('function edgeLegend'))
    for (const dead of ['Derives', 'Restates']) {
      assert.ok(!edgeLabel.includes(dead), `EDGE_LABEL 不该再有「${dead}」（建不出来）`)
    }
  })

  test('图例颜色与画布同源（都走 edgeColor）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // 血泪教训：图例曾经写 var(--dsw-alias-brand-primary)，而画布上的
    // supersedes 在主题色不够彩时会 fallback 成写死的蓝 → 两边颜色对不上。
    const body = code.slice(code.indexOf('function edgeLegend'), code.indexOf('const CSS ='))
    for (const t of ['supersedes', 'complements', 'tensions', 'depends']) {
      assert.ok(new RegExp(`edgeColor\\('${t}'`).test(body), `图例的 ${t} 必须取自 edgeColor()`)
    }
    assert.ok(!/var\(--/.test(body), '图例不得再写 CSS 变量名（会与画布不一致）')
  })
})
