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

  test('does not touch the page body and does not read another plugin DOM', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(!/document\.body/.test(code), 'must not append to the page body')
    // querySelector / querySelectorAll are **allowed**, but only for two uses:
    //   1. finding script tags (to read this bundle's own rev)
    //   2. finding style tags carrying this plugin's data-plugin marker (to avoid double injection)
    // Reading another plugin's components, styles, or geometry is what is forbidden.
    const queries = [...code.matchAll(/querySelector(?:All)?\(\s*([^)]*)\)/g)].map((m) => m[1])
    for (const q of queries) {
      assert.ok(/script|data-plugin="dsh-ai-memory"/i.test(q),
        `only script tags or this plugin's own style marker may be queried, got: ${q}`)
    }
  })

  test('does not manipulate the document head directly (styles are inserted separately)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(!/document\.head/.test(code))
  })

  test('does not embed an iframe (an iframe cannot reach the theme tokens)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(!/createElement\(['"]iframe['"]/.test(code))
  })
})

describe('client · slot registration', () => {
  test('registers two slots: main and sidebar.panellist', () => {
    const { registered, injects } = loadClient()
    assert.deepEqual(injects.sort(), ['main', 'sidebar.panellist'])
    assert.deepEqual(registered.map((r) => r.options.name).sort(), ['main', 'sidebar.panellist'])
  })

  test('the main slot key pairs with the sidebar id (same PANEL_ID)', () => {
    const { registered } = loadClient()
    const main = registered.find((r) => r.options.name === 'main')
    const side = registered.find((r) => r.options.name === 'sidebar.panellist')
    assert.equal(main.options.key, side.options.id, 'main.key must equal sidebar.id, otherwise clicking the icon opens nothing')
    assert.equal(side.options.id, 'ai-memory')
  })

  test('the sidebar icon has an order and a label', () => {
    const { registered } = loadClient()
    const side = registered.find((r) => r.options.name === 'sidebar.panellist')
    assert.equal(typeof side.options.order, 'number')
    assert.ok(typeof side.options.label === 'string' && side.options.label.length > 0)
  })

  test('both slots received a component and render without throwing', () => {
    const { registered } = loadClient()
    for (const r of registered) {
      assert.equal(typeof r.component, 'function', `${r.options.name} received no component`)
      assert.doesNotThrow(() => r.component({}), `rendering the ${r.options.name} component threw`)
    }
  })
})

describe('client · styles (inserted as a <style> element, not via ctx.styles)', () => {
  test('**does not read ctx.styles** — 0.2.0-rc.2 does not provide that service and reading it throws', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    // Hard-won lesson: `if (ctx.styles !== undefined)` was written as an
    // "optional" check, but ctx is a restricted Proxy — **reading an
    // unprovided service name is itself the throw** → factory throws →
    // fiber=FAILED → **the whole application refuses to boot**.
    assert.ok(!/ctx\.styles/.test(stripped), 'must not read ctx.styles')
    assert.ok(!/styles\.insert/.test(stripped), 'must not call styles.insert')
  })

  test('apply touches only ctx.slots (the only declared service)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const applyBody = code.slice(code.indexOf('function apply(ctx)'))
    const used = [...applyBody.matchAll(/ctx\.(\w+)/g)].map((m) => m[1])
    assert.deepEqual([...new Set(used)], ['slots'],
      `apply may only touch ctx.slots, got: ${[...new Set(used)].join(', ')}`)
  })

  test('inject declares only slots (no service that does not exist)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const m = /return \{ name: 'dsh-ai-memory-client', inject: (\[[^\]]*\]), apply \}/.exec(code)
    assert.ok(m, 'export statement not found')
    assert.equal(m[1], "['slots']", `only slots may be declared, got ${m[1]}`)
  })

  test('styles are inserted as a <style> element carrying the data-plugin marker (as downloads-panel does)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/function ensureStyles/.test(code), 'ensureStyles should exist')
    assert.ok(/data-plugin="dsh-ai-memory"/.test(code), 'the data-plugin marker should be set (avoids double injection)')
    assert.ok(/doc\.createElement\('style'\)/.test(code), 'a style element should be created')
  })

  test('**ensureStyles is actually called** (defined but never called = bare HTML and no error)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const calls = [...code.matchAll(/ensureStyles\(/g)].length
    assert.ok(calls >= 2, `ensureStyles should have a definition plus at least one call, found ${calls}`)
  })

  test('style injection uses the container document, not the global document', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/ensureStyles\(canvas\.ownerDocument\)/.test(code),
      'canvas.ownerDocument should be passed instead of relying on the global document')
  })

  test('the whole style injection block is wrapped in try/catch (missing styles must not remove the panel)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const start = code.indexOf('function ensureStyles')
    const body = code.slice(start, start + 700)
    assert.ok(/try\s*\{/.test(body) && /catch/.test(body), 'ensureStyles must swallow its own exceptions')
  })

  test('the CSS constant carries the class names the component uses', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const cssMatch = code.match(/const CSS = `([\s\S]*?)`/)
    assert.ok(cssMatch, 'CSS constant not found')
    for (const cls of ['dsh-am-root', 'dsh-am-canvas', 'dsh-am-stage', 'dsh-am-chip', 'dsh-am-detail']) {
      assert.ok(cssMatch[1].includes(cls), `the CSS should contain .${cls}`)
    }
  })
})

describe('client · must activate under a restricted ctx (regression test for a real incident)', () => {
  /**
   * Build a **restricted Proxy** ctx: only declared service names resolve;
   * reading any other name throws.
   *
   * This is the real semantics of the DSH client ctx, and it is what caused a
   * boot failure: `if (ctx.styles !== undefined)` was written as an "optional
   * check", but **the read itself throws** → factory throws → fiber=FAILED →
   * **the application refuses to boot**.
   *
   * @param {string[]} allowed - service names that may be accessed.
   * @returns {object} the restricted ctx.
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
          // This mirrors DSH behaviour: reading an unprovided service name throws.
          throw new Error(`cannot read unknown service "${String(prop)}" on restricted ctx`)
        }
        return Reflect.get(target, prop)
      },
    })
  }

  /** Run apply under the given ctx and report whether it threw. */
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

  test('**apply must succeed under a restricted ctx that provides only slots**', () => {
    const r = applyWith(() => restrictedCtx(['slots']))
    assert.equal(r.threw, false, `apply threw under the restricted ctx: ${r.message}`)
  })

  test('**must not throw when no styles service exists** (this is what once made the app unopenable)', () => {
    const r = applyWith(() => restrictedCtx(['slots']))
    assert.equal(r.threw, false, 'when ctx has no styles, apply must not read it')
  })

  test('when even slots is not whitelisted, the throw must be an explicit service-name error, not silence', () => {
    const r = applyWith(() => restrictedCtx([]))
    if (r.threw) {
      assert.match(r.message, /unknown service|slots/, `an unknown-service error is expected, got: ${r.message}`)
    }
  })
})

describe('client · the fallback layer must not cover the canvas ("the graph draws but nothing moves")', () => {
  test('**the fallback layer is rendered conditionally** (unconditional rendering swallows every pointer event)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // Hard-won lesson: the fallback layer once rendered unconditionally, and its CSS was
    //   .dsh-am-fallback { z-index: 3; pointer-events: auto; }
    //   .dsh-am-canvas   { z-index: 2; }
    // so it covered the canvas and absorbed all drag/wheel/click input →
    // the symptom was "the graph draws but nothing moves", and the "graph"
    // actually being looked at was that **static SVG**.
    const call = /canvasOk\s*\?\s*null\s*:\s*FallbackGraph\(/.exec(code)
    assert.ok(call !== null, 'the fallback layer must be written as `canvasOk ? null : FallbackGraph(...)`')
  })

  test('a canvasOk state exists and is set true once the canvas is built', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/const \[canvasOk, setCanvasOk\] = React\.useState\(false\)/.test(code), 'a canvasOk state is required')
    assert.ok(/if \(renderer !== null\) setCanvasOk\(true\)/.test(code), 'the fallback layer must be removed once the canvas is built')
  })

  test('does not crash when the canvas cannot be built (degrades to the fallback layer, not a blank screen)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const start = code.indexOf('let renderer = null')
    const body = code.slice(start, start + 400)
    assert.ok(/try\s*\{/.test(body) && /catch/.test(body), 'new GraphRenderer must be wrapped in try/catch')
    assert.ok(/renderer = null/.test(body), 'renderer is set to null on failure')
  })

  test('every place where renderer may be null is guarded', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // Since renderer can be null, resize / observer / destroy all need optional chaining.
    assert.ok(/renderer\?\.resize\(\)/.test(code), 'resize needs optional chaining')
    assert.ok(/renderer\?\.destroy\(\)/.test(code), 'destroy needs optional chaining')
  })

  test('the fallback layer still sits above the canvas (it only appears while degraded)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const fb = /\.dsh-am-fallback \{[^}]*z-index:\s*(\d+)/.exec(code)
    const cv = /\.dsh-am-canvas \{[^}]*z-index:\s*(\d+)/.exec(code)
    assert.ok(fb !== null && cv !== null, 'both layers need a z-index')
    assert.ok(Number(fb[1]) > Number(cv[1]), 'the fallback layer needs the higher z-index (it belongs on top while degraded)')
  })
})

describe('client · the panel keeps only the graph (the top UI was dropped)', () => {
  test('title / description / stats / toolbar are all hidden by default; only the legend stays on', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    for (const flag of ['SHOW_HEAD', 'SHOW_CHIPS', 'SHOW_TOOLBAR']) {
      const m = new RegExp(`const ${flag} = (true|false)`).exec(code)
      assert.ok(m !== null, `${flag} switch should exist`)
      assert.equal(m[1], 'false', `${flag} should default to off (only the graph is kept)`)
    }
    // The legend is the **only remaining text** — colours do not explain
    // themselves, and without it they can only be guessed.
    assert.ok(/const SHOW_LEGEND = true/.test(code), 'the legend should default to on')
  })

  test('the switches stay in place — restoring the old look only means flipping these constants', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/const SHOW_HEAD = false/.test(code))
    assert.ok(/const SHOW_CHIPS = false/.test(code))
    assert.ok(/const SHOW_TOOLBAR = false/.test(code))
    assert.ok(/const SHOW_LEGEND = true/.test(code))
  })

  test('the bottom "N nodes · M links" line is gone too', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const render = code.slice(code.indexOf("return h('div', { className: 'dsh-am-root' }"))
    assert.ok(!/dsh-am-hint/.test(render), 'dsh-am-hint should no longer appear in the render output')
  })

  test('no functionality was lost: double-click on the background resets, right-click toggles retired nodes', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/addEventListener\('dblclick', this\.onDblClick\)/.test(code), 'a dblclick reset is required')
    assert.ok(/addEventListener\('contextmenu', this\.onContextMenu\)/.test(code), 'a right-click toggle is required')
    assert.ok(/onToggleRetired/.test(code), 'right-click must toggle retired nodes')
  })
})

describe('client · the detail view shows only the memory itself (no internal bookkeeping)', () => {
  test('the detail view has no id / status / revision / time / tags / citations', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const start = code.indexOf('function Detail({ node, onClose })')
    const end = code.indexOf('function FallbackGraph')
    const body = code.slice(start, end)
    assert.ok(body.length > 100, 'the Detail component should be found')
    // The detail view is meant to contain only the memory the AI stored.
    assert.ok(!/dsh-am-meta/.test(body), 'the metadata block should no longer render')
    assert.ok(!/node\.id/.test(body), 'the bare id should not be shown')
    assert.ok(!/node\.status/.test(body), 'the status should not be shown')
    assert.ok(!/node\.revision/.test(body), 'the revision number should not be shown')
    assert.ok(!/node\.createdAt/.test(body), 'the creation time should not be shown')
    assert.ok(!/node\.tags/.test(body), 'the tags should not be shown')
    assert.ok(!/node\.citations/.test(body), 'the citations should not be shown')
  })

  test('the detail view keeps the body text and the supersession chain (both are the memory itself)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const start = code.indexOf('function Detail({ node, onClose })')
    const end = code.indexOf('function FallbackGraph')
    const body = code.slice(start, end)
    assert.ok(/node\.text/.test(body), 'the judgment body text must be shown')
    assert.ok(/node\.chain/.test(body), 'the supersession chain must be shown')
  })

  test('the supersession chain no longer carries internal [status] markers', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const start = code.indexOf('function Detail({ node, onClose })')
    const end = code.indexOf('function FallbackGraph')
    const body = code.slice(start, end)
    assert.ok(!/\[ch\.status\]|\[.*status.*\]/.test(body), 'the chain must not carry [active]/[superseded] style labels')
  })
})

describe('client · colour by kind (one colour per judgment kind, all shapes ⚪)', () => {
  test('the three kinds each have their own colour, and **every shape is a circle**', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const table = /const KIND_STYLE = Object\.freeze\(\{[\s\S]*?\n    \}\)/.exec(code)
    assert.ok(table !== null, 'the KIND_STYLE table should exist')
    const t = table[0]
    // All shapes are deliberately identical; kind is distinguished by colour alone.
    const shapes = [...t.matchAll(/shape:\s*'([a-z]+)'/g)].map((m) => m[1])
    assert.equal(shapes.length, 3, `there should be 3 shapes, got ${shapes.length}`)
    assert.deepEqual([...new Set(shapes)], ['circle'], `all three should be circles, got ${shapes.join(', ')}`)
    // The colours must differ from each other, otherwise "colour by kind" means nothing.
    const falls = [...t.matchAll(/fallback:\s*'(#[0-9a-fA-F]{6})'/g)].map((m) => m[1].toLowerCase())
    assert.equal(falls.length, 3, `there should be 3 fallback colours, got ${falls.length}`)
    assert.equal(new Set(falls).size, 3, `the three colours must be distinct, got ${falls.join(', ')}`)
  })

  test('the three colours are also visually distinguishable from each other (distinct hues)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const table = /const KIND_STYLE = Object\.freeze\(\{[\s\S]*?\n    \}\)/.exec(code)
    const falls = [...table[0].matchAll(/fallback:\s*'(#[0-9a-fA-F]{6})'/g)].map((m) => m[1])
    /** Convert #rrggbb to a hue angle (0-360). */
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
    // Two colours only "look different" if their hues are at least 30° apart.
    for (let i = 0; i < hues.length; i += 1) {
      for (let j = i + 1; j < hues.length; j += 1) {
        const diff = Math.min(Math.abs(hues[i] - hues[j]), 360 - Math.abs(hues[i] - hues[j]))
        assert.ok(diff >= 30, `hues are too close (${falls[i]} vs ${falls[j]}, ${diff.toFixed(0)}° apart)`)
      }
    }
  })

  test('an unknown kind falls back to grey rather than becoming invisible', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const m = /const KIND_FALLBACK = Object\.freeze\(\{([^}]*)\}\)/.exec(code)
    assert.ok(m !== null, 'KIND_FALLBACK should exist')
    assert.ok(/shape:\s*'circle'/.test(m[1]), 'the fallback shape must be a circle too')
    assert.ok(/#[0-9a-fA-F]{6}/.test(m[1]), 'the fallback needs a colour (it cannot be empty)')
    assert.ok(/KIND_STYLE\[kind\] \?\? KIND_FALLBACK/.test(code), 'an unknown kind must land on the fallback')
  })

  test('**nodes are not drawn with a background token** (the old "invisible node" bug)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const fn = /function nodeColor\(node, c\) \{[\s\S]*?\n    \}/.exec(code)
    assert.ok(fn !== null, 'nodeColor should be found')
    assert.ok(!/layer2/.test(fn[0]), 'nodeColor must not use bg-layer-2 (a background colour on a background is invisible)')
  })

  test('hit testing and drawing share **one** extent factor (otherwise clicks land in the wrong place)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/function shapeExtent\(shape\)/.test(code), 'shapeExtent should exist (shared by both paths)')
    assert.ok(/this\.radiusOf\(p\.node\) \* shapeExtent\(kindStyle\(p\.node\.kind\)\.shape\)/.test(code),
      'hitTest must use shapeExtent')
  })

  test('**all nodes are the same size** (no large and small nodes)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const fn = /radiusOf\(_?node\) \{([\s\S]*?)\n      \}/.exec(code)
    assert.ok(fn !== null, 'radiusOf should be found')
    const body = fn[1]
    // The radius must not depend on degree — that would make hubs large and orphans small, which is unwanted.
    assert.ok(!/degree/.test(body), `radiusOf must not consult degree, got: ${body.trim()}`)
    const m = /return\s+([\d.]+)/.exec(body)
    assert.ok(m !== null, 'it should return a constant')
    assert.ok(Number(m[1]) >= 5 && Number(m[1]) <= 10, `the radius should sit in a sensible range, got ${m[1]}`)
  })

  test('draw errors are **not swallowed silently** (the most expensive class of bug in this plugin)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const loop = /loop\(\) \{[\s\S]*?\n      \}/.exec(code)
    assert.ok(loop !== null, 'loop should be found')
    assert.ok(/catch \(err\)/.test(loop[0]), 'catch must receive the error object')
    assert.ok(/console\.error/.test(loop[0]), 'a failed first frame must be logged (otherwise it "draws nothing but reports nothing")')
    assert.ok(/lastDrawError/.test(loop[0]), 'the error must be kept on the instance for diagnosis')
  })
})

describe('client · opaque nodes and automatic viewport fitting', () => {
  test('**nodes are always opaque** — retired nodes are expressed by colour mixing, not alpha', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const draw = code.slice(code.indexOf('      draw() {'), code.indexOf('    /** Statistics chip. */'))
    // Inside the node-drawing section, globalAlpha may only ever be set to 1.
    const alphas = [...draw.matchAll(/ctx\.globalAlpha = ([^;\n]+)/g)].map((m) => m[1].trim())
    assert.ok(alphas.length > 0, 'globalAlpha should be set explicitly')
    for (const a of alphas) {
      assert.equal(a, '1', `the canvas layer must not use alpha ${a} (nodes are meant to be opaque)`)
    }
  })

  test('retired nodes are dimmed by **colour mixing**, not by transparency', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/function nodeFill\(node, c\)/.test(code), 'nodeFill should exist')
    const fn = /function nodeFill\(node, c\) \{[\s\S]*?\n    \}/.exec(code)
    assert.ok(/status === 'active'\) return base/.test(fn[0]), 'active nodes keep the base colour')
    assert.ok(/mixWith\(base, c\.canvasBg,/.test(fn[0]), 'retired nodes are mixed toward the background (solid colour)')
  })

  test('canvas-related opacity is gone from the CSS too', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const css = /const CSS = `([\s\S]*?)`/.exec(code)[1]
    const fbEdge = /\.dsh-am-fallback-edge \{([^}]*)\}/.exec(css)
    assert.ok(fbEdge !== null && !/opacity/.test(fbEdge[1]), 'fallback edges must not carry opacity')
    const fbNode = /\.dsh-am-fallback-node\.superseded \{([^}]*)\}/.exec(css)
    assert.ok(fbNode !== null && !/opacity/.test(fbNode[1]), 'fallback retired nodes must not carry opacity')
  })

  test('**the viewport fits its content automatically** (otherwise nodes pushed apart drift off-screen and look broken)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/fitToContent\(\) \{/.test(code), 'fitToContent should exist')
    assert.ok(/this\.autoFit = true/.test(code), 'auto-fit should start enabled')
    assert.ok(/if \(this\.autoFit === true\) this\.fitToContent\(\)/.test(code), 'the physics loop must keep fitting')
  })

  test('**the user takes over the viewport on first interaction** (no fighting the user for control)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const down = /this\.onPointerDown = \(e\) => \{([\s\S]*?)\n        \}/.exec(code)
    assert.ok(down !== null && /this\.autoFit = false/.test(down[1]), 'dragging must disable auto-fit')
    const wheel = /this\.onWheel = \(e\) => \{([\s\S]*?)\n        \}/.exec(code)
    assert.ok(wheel !== null && /this\.autoFit = false/.test(wheel[1]), 'zooming must disable auto-fit')
  })

  test('resetView re-enables auto-fit (otherwise reset is a no-op)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const fn = /resetView\(\) \{[\s\S]*?\n      \}/.exec(code)
    assert.ok(fn !== null && /this\.autoFit = true/.test(fn[0]), 'resetView must re-enable autoFit')
    assert.ok(/this\.fitToContent\(\)/.test(fn[0]), 'resetView must actually fit')
  })

  test('**the canvas size is retried until it matches the CSS** (otherwise the drawing buffer stays at 300×150)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/resizeSoon\(attempt = 0\)/.test(code), 'resizeSoon should exist (with a retry counter)')
    assert.ok(/if \(attempt > 10\) return/.test(code), 'retries must be bounded (no spinning)')
    assert.ok(/this\.resizeSoon\(\)/.test(code), 'the constructor must call it')
    // When resize changes the size, the viewport must be recomputed.
    const rs = /resize\(\) \{[\s\S]*?\n      \}/.exec(code)
    assert.ok(rs !== null && /changed && this\.autoFit === true/.test(rs[0]), 'the viewport must be recomputed after a resize')
  })
})

describe('client · styles use theme tokens only', () => {
  test('the CSS contains no hard-coded colours (a literal colour is allowed only inside a var() fallback)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const cssMatch = code.match(/const CSS = `([\s\S]*?)`/)
    assert.ok(cssMatch, 'CSS constant not found')
    const hardCoded = cssMatch[1]
      .split('\n')
      .filter((line) => !line.includes('var(--dsw-alias-'))
      .filter((line) => /#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(line))
    assert.deepEqual(hardCoded, [], `these lines use hard-coded colours:\n${hardCoded.join('\n')}`)
  })

  test('every token used appears in the official list', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const used = [...new Set([...code.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1]))]
    // The complete set returned by Theme.listTokens
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
    assert.deepEqual(unknown, [], `tokens outside the official list were used: ${unknown.join(', ')}`)
  })

  test('the canvas reads real token values through getComputedStyle (a canvas cannot resolve CSS variables)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/getComputedStyle/.test(code), 'the canvas must resolve tokens into concrete colours')
    assert.ok(/getPropertyValue/.test(code))
  })

  test('theme colours are re-read when the light/dark mode switches', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/MutationObserver/.test(code), 'theme changes should be observed')
    assert.ok(/refreshTheme/.test(code))
  })
})

describe('client · Canvas + Worker architecture (the key to smooth interaction)', () => {
  test('renders with Canvas 2D (the panel no longer draws with SVG)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/getContext\(['"]2d['"]\)/.test(code), 'Canvas 2D should be used')
    assert.ok(/h\(['"]canvas['"]/.test(code), 'a canvas element should be rendered')
    // The panel keeps the canvas, with SVG as the visible fallback when the Worker's first frame fails; plus the sidebar icon.
    const svgCount = (code.match(/h\(['"]svg['"]/g) ?? []).length
    assert.equal(svgCount, 2, `SVG should be used for the sidebar icon and the visible fallback, found ${svgCount}`)
  })

  test('the force simulation runs in a Worker (following the Obsidian approach)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/new Worker\(url, \{ name: 'dsh-ai-memory-graph' \}\)/.test(code), 'a Worker should be created')
    assert.ok(/\.postMessage\(/.test(code), 'messages must be postable to the worker')
    assert.ok(/w\.onmessage = /.test(code), 'coordinates must be receivable from the worker')
  })

  test('**the Worker prefers a Blob URL built from the inlined source** (no rev dependency; the desktop build needs this to drag)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // Hard-won lesson: only the packaged chunk URL `/plugins/<id>/client.graph-worker.js?rev=X`
    // used to be tried, and rev had to be recovered from a script tag — the
    // desktop build goes through loadBundle and does not necessarily leave one,
    // so without rev the request 404s → the Worker cannot be created →
    // **dragging is completely dead** (optional chaining skips silently, no error).
    assert.ok(/function workerBlobUrl\(\)/.test(code), 'workerBlobUrl should exist')
    assert.ok(/new Blob\(\[WORKER_SOURCE\]/.test(code), 'a Blob should be built from the inlined source')
    assert.ok(/URL\.createObjectURL\(blob\)/.test(code), 'it should be turned into an object URL')
    // Candidate order: Blob first, packaged URL as fallback.
    const i = code.indexOf('const blob = workerBlobUrl()')
    const j = code.indexOf('candidates.push(workerPath())')
    assert.ok(i > 0 && j > i, 'the Blob should be ordered before the packaged URL')
  })

  test('**dragging still works without a Worker** (main-thread fallback)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // Dragging once only posted a message; with a null worker nothing moved silently, so every node became undraggable.
    const move = /this\.onPointerMove = \(e\) => \{([\s\S]*?)\n        \}/.exec(code)
    assert.ok(move !== null, 'onPointerMove should be found')
    assert.ok(/this\.worker !== null/.test(move[1]), 'the with/without worker cases must be distinguished')
    assert.ok(/p\.x = w\.x/.test(move[1]) && /p\.y = w\.y/.test(move[1]),
      'without a worker the local position must be updated directly')
  })

  test('**the worker URL is evaluated lazily** (a module-level DOM read prevents the whole application from opening)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // Hard-won lesson: `const WORKER_PATH = resolveWorkerUrl()` read the document
    // in the factory's module scope → DSH web boot threw
    // "1 entry did not activate / dsh-ai-memory: failed" → **the application refused to start**.
    // For comparison: dsh-downloads-panel (which works) does no module-level DOM read in its factory.
    assert.ok(!/^\s*const WORKER_PATH = resolveWorkerUrl\(\)/m.test(code),
      'the worker URL must not be evaluated at module scope')
    assert.ok(/let cachedWorkerPath = null/.test(code), 'a cache variable should provide lazy evaluation')
    assert.ok(/function workerPath\(\)/.test(code), 'a workerPath() accessor should exist')
  })

  test('the worker URL carries ?rev= — otherwise the DSH chunk route returns 404', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/resolveWorkerUrl/.test(code), 'the worker URL should be resolved')
    assert.ok(/extractRev/.test(code), 'a rev extractor should exist')
    assert.ok(/searchParams\.get\(['"]rev['"]\)/.test(code), 'the rev parameter should be extracted')
  })

  test('**rev is not taken from document.currentScript** (the factory runs lazily, when it is already null)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // Official README: "module side effects run at materialization" — by the time
    // the factory executes, currentScript is null. rev must therefore be
    // recovered from **persistent DOM / the boot payload**.
    assert.ok(/querySelectorAll/.test(code), 'rev should be recovered from script tags (persistent DOM)')
    assert.ok(/__DSH_BOOT__/.test(code), 'rev should be recoverable from the boot payload')
    // currentScript is only the first-choice fast path, never the only path.
    const csIdx = code.indexOf('currentScript')
    const qsIdx = code.indexOf('querySelectorAll')
    assert.ok(csIdx > 0 && qsIdx > csIdx, 'querySelectorAll must still follow currentScript as a fallback')
  })

  test('rev extraction handles both the combo and chunk URL shapes', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // Combo uses &rev=, chunks use ?rev=; the URL parser handles both.
    assert.ok(/new URL\(url, location\.href\)/.test(code), 'the URL parser should be used (it covers both shapes)')
  })

  test('without a rev it degrades to a rev-less URL (fallback layout, not a blank screen)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/return base\s*$/m.test(code) || /return base/.test(code), 'the fallback must return a path without rev')
  })

  test('the worker uses the DSH chunk route; this plugin does not define its own', () => {
    const routes = readFileSync(join(here, '..', 'src', 'routes.js'), 'utf8')
    assert.ok(!/WORKER_PATH/.test(routes), 'routes.js should no longer contain a worker route')
    assert.ok(/WORKER_FILE/.test(routes), 'but it must still export the file name constant for the client and tests')
  })

  test('a continuous animation loop (not compute-once-and-freeze)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/requestAnimationFrame/.test(code), 'an rAF loop is required')
    assert.ok(/cancelAnimationFrame/.test(code), 'the loop must be stopped on unmount')
  })

  test('node dragging uses the Obsidian forceNode protocol', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/forceNode/.test(code), 'forceNode must be sent')
    assert.ok(/alphaTarget/.test(code), 'the simulation must be re-heated')
  })

  test('when the Worker is unavailable it degrades to a static layout rather than a blank screen', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/layoutFallback/.test(code), 'a fallback layout is required')
    // The createWorker body must contain try/catch (a Worker can be blocked by CSP or the environment).
    const start = code.indexOf('createWorker() {')
    assert.ok(start > 0, 'the createWorker method was not found')
    const body = code.slice(start, start + 2000)
    assert.ok(/try\s*\{/.test(body) && /catch/.test(body), 'a Worker construction failure must be caught')
    // ⚠️ And it must **not be silent**: the reason must be retained (this is how a 404 URL was found).
    assert.ok(/this\.workerError = /.test(body), 'the failure reason must be kept on workerError')
  })

  test('coordinates travel as binary (not one object per node)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/Float32Array/.test(code), 'coordinates should be carried in a Float32Array')
    assert.ok(/coords/.test(code), 'a coords field should exist')
  })

  test('devicePixelRatio scaling (otherwise high-DPI screens blur)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/devicePixelRatio/.test(code))
  })
})

describe('client · interaction contract', () => {
  test('supports wheel zoom, background pan, and click selection', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'click']) {
      assert.ok(code.includes(`'${ev}'`), `${ev} should be listened for`)
    }
    assert.ok(/hitTest/.test(code), 'click hit testing is required')
    assert.ok(/resetView/.test(code), 'view reset is required')
  })

  test('pointer capture (dragging outside the canvas does not drop the pointer)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/setPointerCapture/.test(code))
  })

  test('unmount releases every listener and the worker (no leaks)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/removeEventListener/.test(code))
    assert.ok(/terminate/.test(code))
    assert.ok(/destroy\(\)/.test(code))
  })

  test('hover highlighting plus labels fading with zoom (following the Obsidian textFade)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/hoverId/.test(code))

    // ⚠️ This used to assert that the literal string `showLabel` existed. That
    // was a tautology dressed as a test: it only proved an identifier was
    // present, never that labels fade. It passed happily while the code used a
    // hard `scale > 0.85` threshold, which is exactly the "sudden jump" the
    // Obsidian approach avoids.
    //
    // The behaviour now asserted is the real curve. It has TWO factors:
    //   zoom:       clamp(log2(scale) + 1 - TEXT_FADE_MULTIPLIER, 0, 1)
    //   importance: every degree point lowers the threshold by a fixed amount
    // The importance factor is what keeps a 30-node graph readable; see
    // graph-physics.test.js for the measured numbers behind it.
    assert.ok(/labelAlphaFor\(id, degree = 0\) \{/.test(code), 'labelAlphaFor(id, degree) should exist')
    assert.ok(/Math\.log2\(this\.scale\)/.test(code), 'the fade must follow log2(scale), per Obsidian')
    assert.ok(/TEXT_FADE_MULTIPLIER/.test(code), 'the curve needs its shift constant')
    assert.ok(/const importance = /.test(code), 'the curve needs its importance gate')

    // Reproduce the curve and check it is genuinely gradual, not a step.
    const mult = Number(/const TEXT_FADE_MULTIPLIER = ([\d.]+)/.exec(code)[1])
    const perDegree = Number(/Number\.isFinite\(this\.importancePerDegree\) \? this\.importancePerDegree : ([\d.]+)/.exec(code)[1])
    const alphaAt = (scale, degree = 0) => Math.max(
      0,
      Math.min(1, Math.log2(scale) + 1 - mult + Math.min(4, Math.max(0, degree)) * perDegree),
    )

    assert.equal(alphaAt(0.25), 0, 'far out, labels are hidden')
    assert.equal(alphaAt(8), 1, 'zoomed in, labels are fully opaque')
    // The middle must be strictly between: that is what "fade" means.
    //
    // ⚠️ The probe has to sit in the curve's transition region for the CURRENT
    // constants, and that region moves whenever either the fade multiplier or
    // the layout changes. Hard-coding a scale here has now needed two updates:
    //   - with mult 2.2, degree 2 was hidden at scale 1 and partial at scale 2
    //   - with mult 1.5 (recalibrated for the corrected 1/d repulsion, where
    //     auto-fit lands near scale 0.9), degree 2 is partial at scale 1
    // So the probe is found numerically instead of encoded: scan for a zoom
    // where a degree-2 node is genuinely mid-fade. If no such zoom exists the
    // curve has collapsed into a step, which is the regression this guards.
    let midScale = null
    for (let s = 0.2; s <= 8; s += 0.02) {
      const a = alphaAt(s, 2)
      if (a > 0.2 && a < 0.8) { midScale = s; break }
    }
    assert.ok(midScale !== null, 'the curve must have a gradual region for degree-2 nodes')
    const mid = alphaAt(midScale, 2)
    assert.ok(mid > 0 && mid < 1, `degree-2 alpha should be partial at scale ${midScale.toFixed(2)}, got ${mid}`)
    // And it must be monotonic: no jump back and forth as the user zooms.
    let prev = -1
    for (let s = 0.1; s <= 8; s += 0.1) {
      const a = alphaAt(s)
      assert.ok(a >= prev - 1e-9, `alpha must not decrease while zooming in (scale ${s.toFixed(1)})`)
      prev = a
    }
  })

  test('a drag is not misread as a click (dragMoved guard)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/dragMoved/.test(code))
  })
})

describe('client · data channel', () => {
  test("uses this plugin's own /plugins/dsh-ai-memory routes", () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(code.includes("'/plugins/dsh-ai-memory/snapshot'"))
    assert.ok(code.includes("'/plugins/dsh-ai-memory/node'"))
  })

  test('the snapshot response is checked for the ok field (an error is not treated as success)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/body\.ok !== true/.test(code), 'ok must be checked, otherwise a backend error looks like an empty graph')
  })

  test('the detail lookup is by id and URL-encodes the value', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/encodeURIComponent\(selected\)/.test(code), 'the node id must be encoded before entering a URL')
  })

  test('error and empty states exist (not a blank screen)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(/读不到记忆库/.test(code), 'an error-state string is required')
    assert.ok(/还没有任何判断/.test(code), 'an empty-state string is required')
  })

  test('the legend lists only the **four edge kinds that can actually be drawn**', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // `derives` / `restates` have no writer (the tools expose only the first four),
    // so listing them only invites the question "why is there no such line".
    for (const label of ['互补', '矛盾', '取代', '依据']) {
      assert.ok(code.includes(label), `the legend should include "${label}"`)
    }
    const edgeLabel = code.slice(code.indexOf('const EDGE_LABEL'), code.indexOf('function edgeLegend'))
    for (const dead of ['衍生', '复述']) {
      assert.ok(!edgeLabel.includes(dead), `EDGE_LABEL should no longer contain "${dead}" (it cannot be created)`)
    }
  })

  test('legend colours share one source with the canvas (both go through edgeColor)', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // Hard-won lesson: the legend once wrote var(--dsw-alias-brand-primary), while
    // supersedes on the canvas fell back to a hard-coded blue whenever the brand
    // colour was not saturated enough → the two sides disagreed.
    const body = code.slice(code.indexOf('function edgeLegend'), code.indexOf('const CSS ='))
    for (const t of ['supersedes', 'complements', 'tensions', 'depends']) {
      assert.ok(new RegExp(`edgeColor\\('${t}'`).test(body), `the legend entry for ${t} must come from edgeColor()`)
    }
    assert.ok(!/var\(--/.test(body), 'the legend must no longer name CSS variables (it would disagree with the canvas)')
  })

  test('**the dominant relation draws neutral, not a saturated hue**', () => {
    /**
     * Colour is a scarce signal and must be spent on the exception.
     *
     * Measured on a real ledger: complements is 17 of 22 edges (77%), so when
     * it was green the whole canvas was green — pixel sampling showed green as
     * the single largest non-background region at 17.9%. A colour covering most
     * of the image cannot encode anything; it is the background.
     *
     * This test pins the decision so a later "make every relation a pretty
     * colour" change has to argue with it.
     */
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const fn = /function edgeColor\(type, c\) \{[\s\S]*?\n    \}/.exec(code)
    assert.ok(fn !== null, 'edgeColor should exist')
    const body = fn[0]

    // complements must not be given a saturated token; it falls through to the
    // neutral default.
    assert.ok(
      !/complements.*return c\.(success|brand|error|warn|info)/.test(body),
      'complements is the default relation — it must not be coloured',
    )
    assert.ok(/return c\.borderL2/.test(body), 'the fallback must be the neutral border colour')

    // The rare relations keep their colours.
    for (const [type, token] of [
      ['tensions', 'error'],
      ['supersedes', 'brand'],
      ['depends', 'warn'],
      ['derives', 'info'],
    ]) {
      assert.ok(
        new RegExp(`if \\(type === '${type}'\\) return c\\.${token}`).test(body),
        `${type} should map to c.${token}`,
      )
    }
  })

  test('**the neutral edge colour is legible, not a faint border token**', () => {
    /**
     * The dominant relation now draws with this colour for 77% of edges, so it
     * is the graph's main line rather than a border accent.
     *
     * The original value was `rgba(128,128,128,.6)`, which over #0d1117 measures
     * ≈#5a5a5a — barely above the background, so the graph looked empty where it
     * should look connected. A themed border token is deliberately too faint for
     * this job, which is why the colour is now a literal.
     */
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const fb = /function fallbackColors\(\)[\s\S]*?\n    \}/.exec(code)
    assert.ok(fb !== null, 'fallbackColors should exist')
    const m = /borderL2: '([^']+)'/.exec(fb[0])
    assert.ok(m !== null, 'borderL2 should be a literal colour')
    assert.ok(!/rgba/.test(m[1]), `the neutral edge colour must be opaque, got ${m[1]}`)

    // Rough luminance check: must be clearly above the canvas background.
    const hex = /^#([0-9a-f]{6})$/i.exec(m[1])
    assert.ok(hex !== null, `expected a #rrggbb literal, got ${m[1]}`)
    const v = Number.parseInt(hex[1], 16)
    const lum = ((v >> 16) & 0xff) * 0.299 + ((v >> 8) & 0xff) * 0.587 + (v & 0xff) * 0.114
    assert.ok(lum > 80, `neutral edge luminance ${lum.toFixed(0)} is too close to the dark background`)

    // And the theme path must not silently revert to the faint token.
    assert.ok(
      !/borderL2: pick\('--dsw-alias-border-l2'/.test(code),
      'borderL2 must not come from the border theme token',
    )
  })

  test('legend lists the coloured relations before the neutral default', () => {
    // The legend explains what a reader cannot decode alone; grey needs no
    // explanation, so it goes last.
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const body = code.slice(code.indexOf('function edgeLegend'), code.indexOf('const CSS ='))
    const idx = (t) => body.indexOf(`'${t}'`)
    assert.ok(idx('tensions') < idx('complements'), 'tensions before complements')
    assert.ok(idx('depends') < idx('complements'), 'depends before complements')
    assert.ok(idx('supersedes') < idx('complements'), 'supersedes before complements')
  })
})
