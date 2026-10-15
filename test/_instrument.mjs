/**
 * 给**测试副本** client.js 注入探针，回答一个问题：
 * **GraphRenderer 到底有没有被构造？为什么 canvas.width 停在 300×150？**
 *
 * 只改 `test/client.js`（浏览器加载的那份），**不动真源码**。
 * 用法：node _instrument.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'

const path = new URL('./client.js', import.meta.url)
let s = readFileSync(path, 'utf8')

let applied = 0

/**
 * 用**正则**插桩（比字面匹配宽容，不怕缩进/空行差异）。
 * @param {RegExp} re - 匹配锚点。
 * @param {(m: string) => string} build - 由匹配结果构造替换文本。
 * @param {string} label - 日志用。
 * @returns {void}
 */
function probe(re, build, label) {
  const m = re.exec(s)
  if (m === null) {
    console.log(`  ⚠ 找不到锚点：${label}`)
    return
  }
  s = s.slice(0, m.index) + build(m[0]) + s.slice(m.index + m[0].length)
  applied += 1
}

// ① 构造函数入口：canvas 到底长什么样 + ResizeObserver 可用吗
probe(
  /constructor\(canvas, handlers\) \{/,
  (m) => `${m}
        try {
          window.__probeHasRO = (typeof ResizeObserver === 'function')
          window.__probeCtor = (window.__probeCtor ?? 0) + 1
          const __r = canvas.getBoundingClientRect()
          window.__probeCtorInfo = 'ctor#' + window.__probeCtor
            + ' connected=' + canvas.isConnected
            + ' rect=' + Math.round(__r.width) + 'x' + Math.round(__r.height)
            + ' buffer=' + canvas.width + 'x' + canvas.height
        } catch (e) { window.__probeCtorInfo = 'probe fail: ' + e.message }`,
  'constructor',
)

// ② resize 每次调用都记一笔
probe(
  /resize\(\) \{\s*\n\s*const rect = this\.canvas\.getBoundingClientRect\(\)/,
  (m) => `${m}
        try {
          window.__probeResize = window.__probeResize ?? []
          if (window.__probeResize.length < 20) {
            window.__probeResize.push('rect=' + Math.round(rect.width) + 'x' + Math.round(rect.height)
              + ' → 设为 ' + Math.floor(Math.max(1, rect.width) * this.dpr) + 'x' + Math.floor(Math.max(1, rect.height) * this.dpr)
              + ' connected=' + this.canvas.isConnected)
          }
        } catch { /* 忽略 */ }`,
  'resize()',
)

// ③ effect 里到底有没有拿到 canvas
probe(
  /const canvas = canvasRef\.current\s*\n\s*if \(canvas === null\) return undefined/,
  () => `const canvas = canvasRef.current
        try {
          window.__probeEffect = (window.__probeEffect ?? 0) + 1
          window.__probeEffectInfo = 'effect#' + window.__probeEffect
            + ' canvasRef=' + (canvas === null ? 'NULL' : 'ok')
            + (canvas === null ? '' : (' connected=' + canvas.isConnected))
        } catch { /* 忽略 */ }
        if (canvas === null) return undefined`,
  'canvasRef effect',
)

// ④ ResizeObserver 是否建起来
probe(
  /this\.observer\.observe\(this\.canvas\)/,
  (m) => `${m}
          try { window.__probeRO = 'ResizeObserver 已建并 observe' } catch { /* 忽略 */ }`,
  'observer.observe',
)

// ⑤ **把 GraphRenderer 类暴露出来** —— 这样能绕开 React 直接测渲染器。
//
// 为什么需要：本鲸手搓的假 React 有不确定性 bug（同一个页面两次跑，effect
// 一次跑一次不跑），害本鲸反复误判。渲染器是个普通类，直接 `new` 它、喂数据、
// 读像素 —— 这才是对渲染层**可靠**的验证，不掺 React 的状态机。
probe(
  /^    class GraphRenderer \{/m,
  (m) => `${m}
      static __exposeForTest() { return GraphRenderer }`,
  'expose GraphRenderer',
)
probe(
  /return \{ name: 'dsh-ai-memory-client', inject: \['slots'\], apply \}/,
  () => `try { window.__GraphRenderer = GraphRenderer } catch { /* 忽略 */ }
    return { name: 'dsh-ai-memory-client', inject: ['slots'], apply }`,
  'expose at export',
)

writeFileSync(path, s)

const EXPECTED = 6
if (applied < EXPECTED) {
  console.log(`✗ 只应用了 ${applied}/${EXPECTED} 处插桩 —— 锚点没匹配上，先修锚点再继续`)
  console.log('  （插桩不全 = 验证结果不可信，本鲸在这上面栽过）')
  process.exit(1)
}
console.log(`已应用 ${applied}/${EXPECTED} 处插桩 ✓`)

// 再核一遍：关键探针真的在文件里
for (const key of ['__GraphRenderer', '__probeCtor', '__probeResize', '__probeEffect', '__probeRO']) {
  if (!s.includes(key)) {
    console.log(`✗ 插桩后找不到 ${key}`)
    process.exit(1)
  }
}
console.log('关键探针齐全 ✓')
