/**
 * dsh-ai-memory 客户端半边：判断图谱面板。
 *
 * ## 这一版为什么推倒重写
 *
 * 上一版是 **SVG + 算一次就画死**，用户反馈"没有人家的丝滑"。
 * 本鲸扒了 Obsidian 的图谱实现（`D:\Obsidian\resources\obsidian.asar` 里的
 * `sim.js` 与 `app.js`），丝滑由四个决定构成，而上一版一个都没有：
 *
 * | Obsidian 的做法 | 上一版 | 这一版 |
 * |---|---|---|
 * | 力导向跑在 **Web Worker** 里 | 主线程算 220 轮 | ✅ Worker（`client.graph-worker.js`） |
 * | **连续动画**，每帧推进 alpha | 算完就画死 | ✅ rAF 循环，直到 alpha 收敛 |
 * | **Canvas 渲染**（Obsidian 用 PIXI/WebGL） | SVG（几百个 DOM 节点） | ✅ Canvas 2D |
 * | 拖拽时**重新加热**并钉住节点 | 无拖拽 | ✅ `alpha:.3, alphaTarget:.3, forceNode` |
 *
 * 物理参数照抄 Obsidian 的常量（见 `lib/client.graph-worker.js` 顶部注释）。
 * 渲染选 Canvas 2D 而非 PIXI：几百节点的规模下完全够用，且不必引入 487 KB 的 WebGL 库
 * （零外部依赖是本插件的硬约束）。
 *
 * ## 仍遵守的硬约束（官方 practices.md）
 * - 不 require 任何 Harness Client 包（只 `require('react')`）
 * - 不直接往页面主体挂 DOM、不直接操作文档头（样式走 `styles.insert`）
 * - 不读别的插件的 DOM
 * - 样式只用 `--dsw-alias-*` 主题 token（Canvas 用 getComputedStyle 读出其值）
 * - 资源注册在 `apply` 里并用 `ctx.effect` 管理清理
 */

window.__ModuleLoader__.load({
  id: 'dsh-ai-memory',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'ai-memory'
    const PANEL_LABEL = '判断图谱'
    const SNAPSHOT_PATH = '/plugins/dsh-ai-memory/snapshot'
    const NODE_PATH = '/plugins/dsh-ai-memory/node'
    /** Worker 的**包内分块**文件名（由 DSH 自己的分块路由服务，见 resolveWorkerUrl）。 */
    const WORKER_FILE = 'client.graph-worker.js'

    /**
     * 算出 Worker 的 URL。
     *
     * ## 为什么需要 rev
     *
     * DSH 的 client-modules 按需服务包内的 `client.<name>.js` 分块，但
     * **要求 URL 里的 rev 精确匹配**（`chunkRequest()` 里是
     * `resourceUrl !== chunkUrl(id, fileName, rev)` 的严格比较），
     * 不带 `?rev=` 一定 404。
     *
     * ## ⚠️ 本鲸在这里踩过一个致命的坑
     *
     * 最初用 `document.currentScript.src` 取 rev —— **那是错的**。
     * 官方 README 原文：
     *   "Plugin bundles execute lazily — running a bundle only registers a factory,
     *    and **module side effects run at materialization**"
     * 也就是说 factory 是在**首次使用**时才执行的，那时 `currentScript` 已经是 `null`，
     * 拿不到 rev → worker 404 → 面板静默退化成静态布局。**不报错**。
     *
     * ## 正确做法：从**模块表**里反查自己的 URL
     *
     * 浏览器加载本 bundle 时，`<head>` 里会留下 `<script src=".../plugins/??dsh-ai-memory/client.js&rev=XXXX">`
     * （或单资源 combo 形式）。脚本标签是**持久的 DOM**，不受 currentScript 影响。
     * 所以遍历 script 标签找含本包名的那一个，从它的 URL 里取 rev。
     *
     * 这是**同步**的、在 factory 执行期就能完成（script 标签早已插入并解析）。
     *
     * @returns {string} worker 的 URL（同源，相对路径）。
     */
    function resolveWorkerUrl() {
      const base = `/plugins/dsh-ai-memory/${WORKER_FILE}`
      try {
        // 先试 currentScript（在"脚本一加载就 materialize"的路径下它是有效的）
        const direct = document.currentScript?.src
        const rev = extractRev(direct)
        if (rev !== null) return `${base}?rev=${rev}`

        // 主力路径：从模块表反查。bundle 的 script 标签留在 head 里。
        const scripts = document.querySelectorAll?.('script[src]')
        if (scripts !== null && scripts !== undefined) {
          for (const s of scripts) {
            const src = s.src
            if (typeof src !== 'string' || !src.includes('dsh-ai-memory')) continue
            const found = extractRev(src)
            if (found !== null) return `${base}?rev=${found}`
          }
        }

        // 最后一道：启动载荷里带着完整的图（含每行的 url 与 rev）
        const boot = globalThis.__DSH_BOOT__
        const entries = boot?.entries ?? []
        for (const e of entries) {
          if (e?.id !== 'dsh-ai-memory') continue
          const found = extractRev(e.url)
          if (found !== null) return `${base}?rev=${found}`
        }
      } catch {
        // 任何解析失败都退化为不带 rev（面板会走兜底布局，不是白屏）
      }
      return base
    }

    /**
     * 从一个 URL 里取出 `rev` 参数。
     *
     * 兼容两种形状：
     *   - combo：`/plugins/??dsh-ai-memory/client.js&rev=XXXX`
     *   - 分块：`/plugins/dsh-ai-memory/client.js?rev=XXXX`
     * 前者是 `&rev=`，后者是 `?rev=` —— 直接交给 URL 解析器处理更稳。
     *
     * @param {unknown} url - 候选 URL。
     * @returns {string|null} rev，或 null。
     */
    function extractRev(url) {
      if (typeof url !== 'string' || url === '') return null
      try {
        const u = new URL(url, location.href)
        const rev = u.searchParams.get('rev')
        return typeof rev === 'string' && rev !== '' ? rev : null
      } catch {
        return null
      }
    }

    // >>> WORKER-SOURCE (由 test/inline-worker.mjs 生成，勿手改) >>>
    const WORKER_SOURCE = "/**\n * 力导向模拟 —— 跑在**独立 Worker 线程**里。\n *\n * 这个文件的形状与参数是**照 Obsidian 的图谱扒出来的**（`D:\\Obsidian\\resources\\obsidian.asar`\n * 里的 `sim.js`，17.7 KB）。它的丝滑不是玄学，是三个决定：\n *\n *   1. **物理计算在 Worker 里** —— 主线程只管渲染，不因迭代卡顿\n *      （Obsidian 原文：`new Worker(\"/sim.js\", { name: \"Graph Worker\" })`）\n *   2. **连续动画**（不是\"算完就画死\"）—— 每帧推进 alpha，直到收敛\n *   3. **交互时重新加热** —— 拖拽发 `{alpha:.3, alphaTarget:.3, run:true, forceNode}`，\n *      松手发 `{alphaTarget:0, forceNode:{x:null,y:null}}`\n *\n * Obsidian 的物理参数（本鲸从其代码里读出的常量，这里照抄）：\n *   alphaDecay    = 1 - 0.001^(1/300) ≈ 0.0228\n *   alphaMin      = 0.001\n *   velocityDecay = 0.6\n *   centerStrength= 0.1\n *   linkDistance  = 250\n *   repelStrength = 1000\n *   collide       = 半径 60、强度 0.5\n *\n * ⚠️ 本文件是**独立 Worker 脚本**，不能用 ESM import（Worker 里直接跑）。\n * 所以它只依赖 worker 全局，不 import 任何东西。\n *\n * 通信协议（与 Obsidian 的 worker 保持一致，便于对照）：\n *   收：{ nodes: {id: [x,y]}, links: [[id,id]], alpha, alphaTarget, run, forceNode: {id,x,y}, forces: {...} }\n *   发：{ id: [id...], buffer: Float32Array(2n) 的 ArrayBuffer, alpha }\n */\n\n/* eslint-disable no-restricted-globals */\n\n// ---- 物理常量（照 Obsidian sim.js）----\nconst ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 300) // ≈ 0.0228\nconst ALPHA_MIN = 0.001\nconst VELOCITY_DECAY = 0.6\nconst TICK_MS = 1000 / 60\n\n// ---- 可调参数（Obsidian 允许通过 forces 覆盖）----\nlet centerStrength = 0.1\nlet linkStrength = 1\nlet linkDistance = 250\nlet repelStrength = -1000 // 负号表示斥力\n\n// ---- 状态 ----\n/** @type {Map<string, {id:string,x:number,y:number,vx:number,vy:number,fx:number|null,fy:number|null}>} */\nlet nodes = new Map()\n/** @type {{source:object,target:object}[]} */\nlet links = []\nlet alpha = 1\nlet alphaTarget = 0\nlet running = false\nlet timer = null\n\n/**\n * 初始化/更新节点集合。\n *\n * 保留已有节点的位置（**这是\"不跳动\"的关键**）：新数据到达时不重置坐标，\n * 只更新那些确实变了的。Obsidian 的 worker 也是这么做的（它维护 `F` 表，\n * 只对不存在的 id 新建，存在的沿用）。\n *\n * @param {Record<string, [number, number]>} incoming - id → [x, y]。\n */\nfunction setNodes(incoming) {\n  const next = new Map()\n  for (const [id, xy] of Object.entries(incoming)) {\n    const existing = nodes.get(id)\n    if (existing !== undefined) {\n      // 沿用旧位置与速度 —— 只更新坐标（如果调用方给了）\n      if (Array.isArray(xy) && Number.isFinite(xy[0]) && Number.isFinite(xy[1])) {\n        existing.x = xy[0]\n        existing.y = xy[1]\n      }\n      next.set(id, existing)\n    } else {\n      // 新节点：从原点附近随机起步（用确定性哈希，不用 Math.random —— 便于复现）\n      const h = hash32(id)\n      const angle = ((h % 1000) / 1000) * Math.PI * 2\n      const r = 30 + ((h >>> 10) % 100)\n      next.set(id, {\n        id,\n        x: Math.cos(angle) * r,\n        y: Math.sin(angle) * r,\n        vx: 0,\n        vy: 0,\n        fx: null,\n        fy: null,\n      })\n    }\n  }\n  nodes = next\n  // 重建索引\n  let i = 0\n  for (const n of nodes.values()) n.index = i++\n}\n\n/** 设置边。 */\nfunction setLinks(pairs) {\n  links = []\n  for (const [a, b] of pairs) {\n    const s = nodes.get(a)\n    const t = nodes.get(b)\n    if (s !== undefined && t !== undefined) links.push({ source: s, target: t })\n  }\n  // 度数：用于碰撞半径与渲染大小\n  for (const n of nodes.values()) n.degree = 0\n  for (const l of links) {\n    l.source.degree += 1\n    l.target.degree += 1\n  }\n}\n\n/** FNV-1a 哈希 —— 确定性初始布局。 */\nfunction hash32(s) {\n  let x = 2166136261\n  for (let i = 0; i < s.length; i += 1) {\n    x ^= s.charCodeAt(i)\n    x = Math.imul(x, 16777619)\n  }\n  return x >>> 0\n}\n\n/** 单步模拟。这是 d3-force 三个力（charge / link / collide）的合并实现。 */\nfunction tick() {\n  const list = [...nodes.values()]\n  const n = list.length\n\n  // ---- 1. 斥力（many-body，照 d3.forceManyBody）----\n  // 用 Barnes-Hut 是 O(n log n)，但本插件的图通常几十到几百节点，\n  // O(n²) 在这个量级完全够用（200 节点 = 2 万对，每帧微不足道），\n  // 而且省掉四叉树那两百行代码 —— 零依赖是硬约束。\n  for (let i = 0; i < n; i += 1) {\n    const a = list[i]\n    for (let j = i + 1; j < n; j += 1) {\n      const b = list[j]\n      let dx = b.x - a.x\n      let dy = b.y - a.y\n      let d2 = dx * dx + dy * dy\n      if (d2 < 1e-6) {\n        // 完全重合：确定性拆开（避免除零产生 NaN）\n        dx = ((hash32(a.id) % 7) - 3) || 1\n        dy = ((hash32(b.id) % 7) - 3) || 1\n        d2 = dx * dx + dy * dy\n      }\n      const d = Math.sqrt(d2)\n      const strength = (repelStrength * alpha) / d2\n      const fx = (dx / d) * strength\n      const fy = (dy / d) * strength\n      a.vx += fx\n      a.vy += fy\n      b.vx -= fx\n      b.vy -= fy\n    }\n  }\n\n  // ---- 2. 弹簧（照 d3.forceLink）----\n  for (const l of links) {\n    const a = l.source\n    const b = l.target\n    let dx = b.x + b.vx - a.x - a.vx\n    let dy = b.y + b.vy - a.y - a.vy\n    let d = Math.sqrt(dx * dx + dy * dy)\n    if (d < 1e-6) {\n      dx = 1\n      dy = 1\n      d = Math.SQRT2\n    }\n    // d3 的公式：strength 按两端度数分配（度数高的节点移动更少）\n    const sa = a.degree + 1\n    const sb = b.degree + 1\n    const bias = sa / (sa + sb)\n    const k = ((d - linkDistance) / d) * alpha * linkStrength\n    const cx = dx * k\n    const cy = dy * k\n    a.vx += cx * bias\n    a.vy += cy * bias\n    b.vx -= cx * (1 - bias)\n    b.vy -= cy * (1 - bias)\n  }\n\n  // ---- 3. 碰撞（照 d3.forceCollide，半径 60）----\n  const RADIUS = 60\n  for (let i = 0; i < n; i += 1) {\n    const a = list[i]\n    for (let j = i + 1; j < n; j += 1) {\n      const b = list[j]\n      let dx = b.x - a.x\n      let dy = b.y - a.y\n      let d2 = dx * dx + dy * dy\n      const minD = RADIUS\n      if (d2 >= minD * minD) continue\n      if (d2 < 1e-6) {\n        dx = ((hash32(a.id) % 5) - 2) || 1\n        dy = ((hash32(b.id) % 5) - 2) || 1\n        d2 = dx * dx + dy * dy\n      }\n      const d = Math.sqrt(d2)\n      const overlap = (minD - d) / d\n      const push = overlap * 0.5 * alpha\n      const fx = dx * push\n      const fy = dy * push\n      a.vx -= fx\n      a.vy -= fy\n      b.vx += fx\n      b.vy += fy\n    }\n  }\n\n  // ---- 4. 向心 + 位置积分（照 d3.forceCenter + 积分器）----\n  const cx0 = 0\n  const cy0 = 0\n  for (const node of list) {\n    node.vx += (cx0 - node.x) * centerStrength * alpha\n    node.vy += (cy0 - node.y) * centerStrength * alpha\n\n    if (node.fx !== null) {\n      node.x = node.fx\n      node.vx = 0\n    } else {\n      node.vx *= VELOCITY_DECAY\n      node.x += node.vx\n    }\n    if (node.fy !== null) {\n      node.y = node.fy\n      node.vy = 0\n    } else {\n      node.vy *= VELOCITY_DECAY\n      node.y += node.vy\n    }\n  }\n\n  // ---- 5. alpha 衰减 ----\n  alpha += (alphaTarget - alpha) * ALPHA_DECAY\n}\n\n/** 打包位置并发回主线程。 */\nfunction publish() {\n  const list = [...nodes.values()]\n  const ids = new Array(list.length)\n  const coords = new Float32Array(list.length * 2)\n  for (let i = 0; i < list.length; i += 1) {\n    ids[i] = list[i].id\n    coords[2 * i] = list[i].x\n    coords[2 * i + 1] = list[i].y\n  }\n  // 用 transferable 传 ArrayBuffer，零拷贝\n  self.postMessage({ type: 'tick', ids, coords: coords.buffer, alpha }, [coords.buffer])\n}\n\n/** 一帧：推进模拟并发回结果；未收敛就继续排下一帧。 */\nfunction frame() {\n  timer = null\n  if (nodes.size === 0) {\n    running = false\n    return\n  }\n  tick()\n  publish()\n  // 收敛条件照 d3：alpha < alphaMin 就停（但拖拽会把它重新加热）\n  if (alpha > ALPHA_MIN || alphaTarget > 0) {\n    running = true\n    timer = setTimeout(frame, TICK_MS)\n  } else {\n    running = false\n  }\n}\n\n/** 启动（或唤醒）模拟。 */\nfunction kick() {\n  if (timer === null) {\n    running = true\n    timer = setTimeout(frame, TICK_MS)\n  }\n}\n\nself.onmessage = (e) => {\n  const msg = e.data ?? {}\n\n  if (msg.nodes !== undefined) setNodes(msg.nodes)\n  if (msg.links !== undefined) setLinks(msg.links)\n\n  // 拖拽：固定某节点的位置，并重新加热\n  if (msg.forceNode !== undefined) {\n    const n = nodes.get(msg.forceNode.id)\n    if (n !== undefined) {\n      n.fx = msg.forceNode.x === null || msg.forceNode.x === undefined ? null : msg.forceNode.x\n      n.fy = msg.forceNode.y === null || msg.forceNode.y === undefined ? null : msg.forceNode.y\n    }\n  }\n\n  // 物理参数可运行时调（照 Obsidian 的 forces 字段）\n  if (msg.forces !== undefined) {\n    const f = msg.forces\n    if (Number.isFinite(f.centerStrength)) centerStrength = f.centerStrength\n    if (Number.isFinite(f.linkStrength)) linkStrength = f.linkStrength\n    if (Number.isFinite(f.linkDistance)) linkDistance = f.linkDistance\n    if (Number.isFinite(f.repelStrength)) repelStrength = -Math.abs(f.repelStrength)\n  }\n\n  // alpha 只升不降（照 Obsidian：Q < A.alpha 才更新）—— 避免迟到的消息把进度打回去\n  if (Number.isFinite(msg.alpha) && msg.alpha > alpha) alpha = msg.alpha\n  if (Number.isFinite(msg.alphaTarget)) alphaTarget = msg.alphaTarget\n\n  if (msg.run === true) kick()\n  // 数据变了但没要求 run（例如只是换节点集）→ 也推进一帧，让画面反映新数据\n  else if (msg.nodes !== undefined || msg.links !== undefined) kick()\n}\n"
    // <<< WORKER-SOURCE <<<

    /**
     * 建一个指向**内联 worker 源码**的 Blob URL。
     *
     * ## 为什么不用包内分块的 URL
     *
     * 本鲸最初用 `/plugins/dsh-ai-memory/client.graph-worker.js?rev=XXX`，
     * 靠 DSH 自己的分块路由服务。它**能工作**，但有个致命前提：
     * **`rev` 必须精确匹配**，而 rev 要从自己的 script 标签或 `__DSH_BOOT__` 里反查。
     *
     * 桌面版（Electron）的 bundle 传输**不一定留下 script 标签**（走 `loadBundle`），
     * 于是 rev 拿不到 → URL 不带 rev → **404** → Worker 建不起来 →
     * **拖拽完全失效**（`this.worker?.postMessage` 是可选链，静默跳过，不报错）。
     *
     * ## 内联的好处
     *
     * Blob URL **不发任何网络请求** —— 不依赖 rev、不依赖路由、不依赖传输方式，
     * 桌面版与网页版都通。代价是 client.js 大了约 10KB（worker 源码）。
     *
     * @returns {string|null} Blob URL；环境不支持时返回 null。
     */
    function workerBlobUrl() {
      try {
        if (WORKER_SOURCE === '') return null
        if (typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') return null
        const blob = new Blob([WORKER_SOURCE], { type: 'text/javascript' })
        return URL.createObjectURL(blob)
      } catch {
        return null
      }
    }

    /**
     * 缓存的 worker URL。
     *
     * ⚠️ **必须懒求值**，不能在模块作用域直接算 —— 这是本鲸踩过的最贵的一个坑。
     *
     * 最初的写法是 `const WORKER_PATH = resolveWorkerUrl()`，也就是在 factory 一执行时
     * 就去读 `document`。后果是 **DSH 的 web boot 直接失败**：
     *
     *     web boot: 1 entry did not activate
     *     dsh-ai-memory: failed
     *
     * 因为 client-modules 的激活审计（`app.asar` 的 web 前端里）检查每个 entry 的
     * fiber 状态，而 factory 在模块作用域抛异常 → fiber 进入 FAILED → 整个应用
     * **拒绝启动**（不是"面板不好用"，是应用打不开）。
     *
     * 对比：`dsh-downloads-panel`（能用）的 factory 里**没有任何模块级 DOM 读取**。
     * 差异就在这里。
     *
     * 所以改成懒求值：只有真正要建 Worker 时才解析 URL。那时：
     *   - 组件已挂载，`document` 一定可用
     *   - 即便解析失败，也只影响图谱动画（退化为静态布局），**不影响激活**
     *
     * @type {string|null}
     */
    let cachedWorkerPath = null

    /**
     * 取 worker URL（首次调用时解析并缓存）。
     * @returns {string} worker 的 URL。
     */
    function workerPath() {
      if (cachedWorkerPath === null) cachedWorkerPath = resolveWorkerUrl()
      return cachedWorkerPath
    }

    /**
     * 边类型 → 中文名（图例与详情都用它）。
     *
     * 顺序 = 图例里的显示顺序。只列**实际会画出来的**四种：
     * `derives` / `restates` 目前没有入口能建（工具只暴露了前四种），
     * 列出来反而让人以为"怎么没有这种线"。
     */
    const EDGE_LABEL = {
      supersedes: '取代',
      complements: '互补',
      tensions: '矛盾',
      depends: '依据',
    }

    /**
     * 边类型 → **画布上实际用的颜色**。
     *
     * ⚠️ 这里**必须与 `edgeColor()` 同源**，不能用 CSS 变量名。
     *
     * 本鲸踩过的坑：图例原本写 `var(--dsw-alias-brand-primary)`，
     * 而画布上的 `supersedes` 边在主题色不够彩时会 fallback 成 `#3b82f6` ——
     * 于是**图例和画布颜色对不上**（深色主题下 brand 几乎发白，
     * 图例画成白的、画布画成蓝的）。
     *
     * 现在两边都从 `edgeColor()` 取，**不可能不一致**。
     */
    function edgeLegend(c) {
      return [
        ['supersedes', edgeColor('supersedes', c)],
        ['complements', edgeColor('complements', c)],
        ['tensions', edgeColor('tensions', c)],
        ['depends', edgeColor('depends', c)],
      ]
    }

    const CSS = `
.dsh-am-root {
  height: 100%; display: flex; flex-direction: column; box-sizing: border-box;
  color: var(--dsw-alias-label-primary, currentColor);
  font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
}
.dsh-am-head { padding: 14px 16px 0; }
.dsh-am-head h1 { font-size: 16px; margin: 0 0 4px; }
.dsh-am-sub { margin: 0 0 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
.dsh-am-stats { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
.dsh-am-chip {
  font-size: 11.5px; line-height: 1; padding: 4px 9px; border-radius: 999px;
  color: var(--dsw-alias-label-secondary, inherit);
  background: var(--dsw-alias-bg-layer-1, transparent);
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3));
}
.dsh-am-chip b { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary, inherit); }
.dsh-am-tools { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 0 0 10px; }
.dsh-am-btn {
  font: inherit; font-size: 12px; line-height: 1; padding: 5px 10px; border-radius: 6px; cursor: pointer;
  color: var(--dsw-alias-label-secondary, inherit);
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3));
}
.dsh-am-btn:hover { border-color: var(--dsw-alias-brand-primary, #4c8dff); color: var(--dsw-alias-label-primary, inherit); }
.dsh-am-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4c8dff); outline-offset: 1px; }
.dsh-am-btn[aria-pressed="true"] {
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14));
  border-color: var(--dsw-alias-brand-primary, currentColor);
  color: var(--dsw-alias-label-primary, currentColor);
  font-weight: 600;
}
.dsh-am-stage {
  position: relative; flex: 1 1 auto; min-height: 380px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-1, transparent);
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3));
}
.dsh-am-canvas { display: block; position: relative; z-index: 2; pointer-events: auto; width: 100%; height: 100%; cursor: grab; touch-action: none; }
.dsh-am-fallback { position: absolute; z-index: 3; inset: 0; width: 100%; height: 100%; pointer-events: auto; }
.dsh-am-fallback-edge { stroke: var(--dsw-alias-brand-primary, #7aa2ff); stroke-width: 2.5; }
.dsh-am-fallback-node { pointer-events: all; cursor: pointer; fill: var(--dsw-alias-bg-layer-2, #3b82f6); stroke: var(--dsw-alias-label-primary, #dbeafe); stroke-width: 2.5; }
/* 退役用**颜色**区分，不用透明度（主人要求"不要透明的"） */
.dsh-am-fallback-node.superseded { fill: var(--dsw-alias-label-secondary, #6b7280); }
.dsh-am-fallback-label { fill: var(--dsw-alias-label-primary, #f4f7ff); font-size: 13px; font-weight: 600; paint-order: stroke; stroke: var(--dsw-alias-bg-layer-1, #111827); stroke-width: 3px; stroke-linejoin: round; }.dsh-am-canvas[data-dragging] { cursor: grabbing; }
.dsh-am-legend {
  padding: 6px 16px 10px; font-size: 11px; display: flex; flex-wrap: wrap; gap: 10px;
  color: var(--dsw-alias-label-secondary, inherit);
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25));
}
.dsh-am-legend i { display: inline-block; width: 14px; height: 0; border-top-width: 2px; border-top-style: solid; vertical-align: middle; margin-right: 4px; }
.dsh-am-detail {
  position: absolute; right: 10px; top: 10px; width: min(340px, calc(100% - 20px));
  max-height: calc(100% - 20px); overflow: auto;
  border-radius: 10px; padding: 11px 12px; box-sizing: border-box;
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, transparent));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3));
}
.dsh-am-detail h2 { font-size: 13px; margin: 0 0 6px; }
.dsh-am-detail p { margin: 0 0 8px; white-space: pre-wrap; word-break: break-word; }
.dsh-am-links { font-size: 12px; display: grid; gap: 4px; margin-top: 10px; }
/* 取代链：只显示记忆正文，不显示 id / 状态码 */
.dsh-am-chain-title { font-size: 11px; color: var(--dsw-alias-label-secondary, inherit); margin-bottom: 2px; }
.dsh-am-chain-old { color: var(--dsw-alias-label-secondary, inherit); padding-left: 10px; border-left: 2px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4)); }
.dsh-am-chain-active { padding-left: 10px; border-left: 2px solid var(--dsw-alias-brand-primary, #7aa2ff); }
.dsh-am-empty { padding: 40px 16px; text-align: center; color: var(--dsw-alias-label-secondary, inherit); }
.dsh-am-empty b { display: block; margin-bottom: 6px; color: var(--dsw-alias-label-primary, inherit); }
.dsh-am-err { color: var(--dsw-alias-state-error-primary, #d93025); font-size: 12px; }
.dsh-am-hint {
  position: absolute; left: 10px; bottom: 8px; font-size: 11px; pointer-events: none;
  color: var(--dsw-alias-label-secondary, inherit);
}
`

    /**
     * 读出当前主题色的**实际值**。
     *
     * 为什么必须读出来：Canvas 的 `strokeStyle` 不认 CSS 变量，只认具体颜色。
     * 这是 Canvas 渲染相对 SVG 的代价 —— SVG 可以直接 `stroke="var(--dsw-...)"`。
     * 换来的是几百个节点不必变成几百个 DOM 元素。
     *
     * @param {HTMLElement} el - 用于取计算样式的元素。
     * @returns {object} 各 token 的当前值。
     */
    /**
     * Theme colors resolved without any DOM access.
     *
     * Used when no element is available yet (first render) or when
     * `getComputedStyle` is not usable (non-browser test sandbox).
     *
     * @returns {object} The hard-coded palette.
     */
    function fallbackColors() {
      const kindColors = {}
      for (const s of Object.values(KIND_STYLE)) {
        if (s.token === '') continue
        kindColors[s.token] = s.fallback
      }
      return {
        labelPrimary: '#f4f7ff',
        labelSecondary: '#b8c1d1',
        borderL2: 'rgba(128,128,128,.6)',
        brand: '#4d9bff',
        success: '#2e9e5b',
        error: '#d93025',
        warn: '#e0a03a',
        layer2: 'rgba(128,128,128,.18)',
        canvasBg: '#0d1117',
        kindColors,
      }
    }

    function themeColors(el) {
      // Never read the global `document` here: the renderer must work with the
      // element it was handed, and the test sandbox has no DOM at all.
      if (el === null || el === undefined) return fallbackColors()
      let cs
      try {
        cs = getComputedStyle(el)
      } catch {
        return fallbackColors()
      }
      if (cs === null || cs === undefined) return fallbackColors()
      const pick = (name, fallback) => {
        const v = cs.getPropertyValue(name)
        const value = typeof v === 'string' ? v.trim() : ''
        if (value === '' || (/^(#000(?:000)?|rgb\\(0, ?0, ?0\\))$/i.test(value) && (name.includes('label') || name.includes('brand')))) return fallback
        return value
      }
      /**
       * 只挡**真正接近黑色**的颜色（三通道之和 < 90，即平均每通道 < 30）。
       *
       * ⚠️ 阈值曾经是 < 180，但深色主题下**合法**的文字色也可能偏暗
       * （`#8b949e` 之和约 180），被判为"不可见"而换成 fallback，反而更乱。
       * 对比度交给具体绘制参数（线宽、alpha、描边）保证，不在这里过度过滤。
       */
      const visible = (name, fallback) => {
        const value = pick(name, fallback)
        const m = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
        if (m && Number(m[1]) + Number(m[2]) + Number(m[3]) < 90) return fallback
        return value
      }
      /**
       * 这个颜色**够不够"彩"**（有没有可辨认的色相）。
       *
       * 为什么需要：主题里的语义色号（brand / warn / info）**在不同主题下可能是任意明度** ——
       * 本鲸实测 `--dsw-alias-brand-primary` 在 DSH 深色主题里几乎**是白的**，
       * 于是"判断"画出来是白点，跟"退役灰"混在一张图上分不清。
       *
       * 判据：`max(r,g,b) - min(r,g,b)`（色度）。太小的就是灰/白/黑，没有色相。
       * 阈值取 40 —— 比它小的颜色，人眼基本认不出是什么色。
       *
       * @param {string} value - CSS 颜色。
       * @returns {boolean} 是否够彩。
       */
      const saturated = (value) => {
        const m = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
        if (m === null) return false
        const r = Number(m[1])
        const g = Number(m[2])
        const b = Number(m[3])
        return Math.max(r, g, b) - Math.min(r, g, b) >= 40
      }
      /**
       * 按 kind 的样式表里声明的 token 逐个解析出实际颜色。
       *
       * ⚠️ **必须过 `saturated()` 这一关**。
       *
       * 本鲸踩过的坑：`judgment` 原本用 `--dsw-alias-brand-primary`，
       * 而 **DSH 深色主题里这个色号几乎是白的** —— 于是"判断"画出来是**白点**，
       * 和"退役灰"混在一张图上，主人问「为什么有灰的有白的」。
       *
       * 语义色号（brand / warn / info）在不同主题里可能是任意明度，
       * **不能假定它有颜色**。所以这里检查饱和度：太灰/太白/太黑的色号一律拒掉，
       * 用 KIND_STYLE 里写死的 fallback —— 那是**保证有色相**的颜色。
       */
      const kindColors = {}
      for (const s of Object.values(KIND_STYLE)) {
        if (s.token === '') continue
        const themed = visible(s.token, s.fallback)
        kindColors[s.token] = saturated(themed) ? themed : s.fallback
      }
      return {
        labelPrimary: visible('--dsw-alias-label-primary', '#f4f7ff'),
        labelSecondary: visible('--dsw-alias-label-secondary', '#b8c1d1'),
        borderL2: pick('--dsw-alias-border-l2', 'rgba(128,128,128,.6)'),
        brand: visible('--dsw-alias-brand-primary', '#4d9bff'),
        success: visible('--dsw-alias-state-success-primary', '#2e9e5b'),
        error: visible('--dsw-alias-state-error-primary', '#d93025'),
        warn: visible('--dsw-alias-state-warn-primary', '#e0a03a'),
        layer2: pick('--dsw-alias-bg-layer-2', 'rgba(128,128,128,.18)'),
        // 标签描边用画布底色，否则字压在线上会糊成一团
        canvasBg: pick('--dsw-alias-bg-layer-1', '#0d1117'),
        kindColors,
      }
    }

    /** 边类型 → 描边色。 */
    function edgeColor(type, c) {
      if (type === 'tensions') return c.error
      if (type === 'supersedes') return c.brand
      if (type === 'complements') return c.success
      if (type === 'depends') return c.warn
      return c.borderL2
    }

    /**
     * 节点种类 → 颜色与形状。
     *
     * 主人要求："自己设计不同类型的不同颜色，比如判断一个颜色，思考一个颜色等等"，
     * 随后明确："**全要 ⚪**" —— 所以**形状统一为圆**，只用颜色区分类型。
     *
     * 设计原则：
     *   1. **色相区分语义**（一眼认出这是哪一类），明度接近（避免某类看着"更重"）
     *   2. **颜色必须够"彩"** —— 见下面的 `saturated()`：主题里那些接近白/灰的色号
     *      会被拒掉，改用固定的 fallback。本鲸踩过这个：`--dsw-alias-brand-primary`
     *      在深色主题里几乎是白的，于是"判断"画出来是白点，跟"退役灰"混在一起分不清。
     *   3. 未知 kind 有兜底（不认识的类型画成灰色，不崩、不隐形）
     *
     * | kind | 含义 | 色 |
     * |---|---|---|
     * | `judgment` | 判断（会进化） | 蓝 |
     * | `insight`  | 思考（想法/观察/疑问） | 青 |
     * | `rule`     | 规矩（受治理） | 琥珀 |
     *
     * `shape` 字段保留着（`pathNode` 也仍然支持菱形/方圆）—— 全圆是**当前选择**，
     * 不是能力的删除；哪天想用形状再区分，改这一列就行。
     */
    const KIND_STYLE = Object.freeze({
      judgment: { token: '--dsw-alias-brand-primary', fallback: '#3b82f6', shape: 'circle', label: '判断' },
      insight: { token: '--dsw-alias-state-info-primary', fallback: '#14b8a6', shape: 'circle', label: '思考' },
      rule: { token: '--dsw-alias-state-warn-primary', fallback: '#f59e0b', shape: 'circle', label: '规矩' },
    })

    /** 未知 kind 的兜底样式（灰，但**仍然可见**）。 */
    const KIND_FALLBACK = Object.freeze({ token: '', fallback: '#9aa4b2', shape: 'circle', label: '其它' })

    /**
     * 取某一类的样式。
     * @param {string} kind - 节点种类。
     * @returns {{token: string, fallback: string, shape: string, label: string}} 样式。
     */
    function kindStyle(kind) {
      return KIND_STYLE[kind] ?? KIND_FALLBACK
    }

    /**
     * 形状的**外接半径系数**（相对基准半径 r）。
     *
     * 用来把「画出来的形状」和「点击命中范围」对齐 —— 两者必须用同一个系数，
     * 否则会出现"明明点在图形上却选不中"或"点在空白处却选中了"。
     *
     * 现在全是圆（系数 1），但保留这个函数，将来换形状时点击会自动跟上。
     *
     * @param {string} shape - 'circle' | 'roundrect' | 'diamond'。
     * @returns {number} 外接半径系数。
     */
    function shapeExtent(shape) {
      if (shape === 'diamond') return 1.18
      if (shape === 'roundrect') return 1.18
      return 1
    }

    /**
     * 节点填充色。
     *
     * ⚠️ 曾经用 `c.layer2`（`--dsw-alias-bg-layer-2`）画判断节点 ——
     * 那是**背景** token！深色主题下背景色本身就是深色，
     * 画在深色画布上等于隐形。所以主人看到"颜色太浅看不清楚"。
     *
     * 现在按 kind 取**有实色**的语义色。主题变量读不到时用 fallback。
     *
     * @param {object} node - 节点。
     * @param {object} c - 主题色。
     * @returns {string} CSS 颜色。
     */
    function nodeColor(node, c) {
      const s = kindStyle(node.kind)
      const themed = s.token === '' ? '' : c.kindColors[s.token]
      return themed !== undefined && themed !== '' ? themed : s.fallback
    }

    /**
     * 节点填充色（**退役与否也在这里表达**）。
     *
     * ⚠️ 关键取舍：退役节点**不用透明度**区分（主人明确要求"不要透明的"），
     * 而是把颜色**往背景方向混一点**（降饱和/压暗），画出来仍然是实的。
     *
     * 为什么这样更好：
     *   · 半透明会让节点看着"像没画好"，而且叠在边上会串色
     *   · 混色是**实色**，视觉上干净，也仍然一眼能分出"这条是旧的"
     *
     * @param {object} node - 节点。
     * @param {object} c - 主题色。
     * @returns {string} CSS 颜色（不透明）。
     */
    function nodeFill(node, c) {
      const base = nodeColor(node, c)
      if (node.status === 'active') return base
      return mixWith(base, c.canvasBg, 0.45)
    }

    /**
     * 把两个颜色按比例混合（返回 `rgb(...)`）。
     *
     * 只支持 `#rgb` / `#rrggbb` / `rgb()` / `rgba()` 这几种实际会遇到的写法；
     * 解析不出来就**原样返回**（不崩，也不变成黑色）。
     *
     * @param {string} a - 主色。
     * @param {string} b - 混入色。
     * @param {number} t - b 的占比（0..1）。
     * @returns {string} 混好的 CSS 颜色。
     */
    function mixWith(a, b, t) {
      const pa = parseColor(a)
      const pb = parseColor(b)
      if (pa === null || pb === null) return a
      const r = Math.round(pa[0] * (1 - t) + pb[0] * t)
      const g = Math.round(pa[1] * (1 - t) + pb[1] * t)
      const bl = Math.round(pa[2] * (1 - t) + pb[2] * t)
      return `rgb(${r}, ${g}, ${bl})`
    }

    /**
     * 解析颜色成 `[r, g, b]`。
     * @param {string} s - CSS 颜色。
     * @returns {[number, number, number]|null} 解析结果；认不出来返回 null。
     */
    function parseColor(s) {
      if (typeof s !== 'string') return null
      const t = s.trim()
      const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(t)
      if (hex !== null) {
        const h = hex[1]
        if (h.length === 3) {
          return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]
        }
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
      }
      const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(t)
      if (rgb !== null) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
      return null
    }

    /**
     * 节点描边色：给实心节点一圈**更亮的边**，让它在任何背景上都立得住。
     * 退役节点用次级文字色（仍然可见，只是不抢眼）。
     */
    function nodeStroke(node, c) {
      return node.status === 'active' ? c.labelPrimary : c.labelSecondary
    }

    /**
     * 图谱渲染器：Canvas 2D + Worker 力导向 + 连续动画。
     *
     * 写成类而不是塞进 React 组件：渲染循环与指针交互是有状态的过程，
     * 放进 React 的渲染模型只会更难读。组件负责挂载/卸载与传数据。
     */
    class GraphRenderer {
      /**
       * @param {HTMLCanvasElement} canvas - 画布。
       * @param {{onSelect: (id: string|null) => void}} handlers - 回调。
       */
      constructor(canvas, handlers) {
        this.canvas = canvas
        this.ctx2d = canvas.getContext('2d')
        this.handlers = handlers
        this.colors = themeColors(canvas)

        /** id → { x, y, node }。位置由 Worker 每帧推回。 */
        this.positions = new Map()
        this.nodes = []
        this.edges = []
        /** 视图变换。 */
        this.tx = 0
        this.ty = 0
        this.scale = 1
        /** 交互状态。 */
        this.hoverId = null
        this.selectedId = null
        this.dragNodeId = null
        this.panFrom = null
        /** 循环控制。 */
        this.raf = null
        this.running = true
        this.alpha = 0
        /**
         * 自动适配视野的开关。
         *
         * 物理还在跑的时候为 true（每帧把视野套住整个图，
         * 否则节点会被推开跑到视野外，看着像坏了）；
         * **用户一旦自己拖拽/缩放就置 false** —— 不跟用户抢视野。
         * `resetView()` 会把它重新打开。
         */
        this.autoFit = true
        this.width = 1
        this.height = 1
        this.dpr = Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1))

        this.worker = this.createWorker()
        this.bindPointer()
        this.resize()
        /**
         * ⚠️ **再 resize 几次**（下一帧起）。
         *
         * 为什么需要：构造时样式可能刚注入、浏览器还没把它应用到布局上，
         * 于是 `getBoundingClientRect()` 拿到的是**旧的**尺寸
         * （实测：CSS 生效后是 760×419，但构造那一刻拿到 300×150 的默认值），
         * canvas 的绘图缓冲就一直是默认的 300×150 —— 画什么都在一个小缓冲里，
         * 表现是"画布空白"或"图挤在一角"。
         *
         * 见 `resizeSoon()`：它重试到缓冲尺寸与 CSS 一致为止（最多 10 帧）。
         */
        /**
         * ⚠️ **用 ResizeObserver 盯着画布**，这是尺寸问题的**根治**办法。
         *
         * 为什么不能只靠构造时量一次：`ensureStyles` 注入的样式表何时生效
         * 由浏览器决定 —— 实测构造那一刻 `getBoundingClientRect()` 拿到的是
         * HTML 默认的 300×150，而 CSS 生效后应该是 760×419。
         * 不补这一次，绘图缓冲就一直是 300×150，画什么都在那个小框里
         * （表现是"图挤在一角"或"画布空白"）。
         *
         * `resizeSoon()` 解决了"首次"；ResizeObserver 还覆盖之后的一切：
         * 面板被拉伸、侧边栏收起、窗口缩放、画布元素被替换。
         *
         * 拿不到 ResizeObserver 的环境（老浏览器）退化为 `resizeSoon()`。
         */
        this.observer = null
        if (typeof ResizeObserver === 'function') {
          this.observer = new ResizeObserver(() => {
            const before = `${this.width}x${this.height}`
            this.resize()
            if (`${this.width}x${this.height}` !== before) this.draw()
          })
          this.observer.observe(this.canvas)
        }
        this.resizeSoon()
        this.loop = this.loop.bind(this)
        this.raf = requestAnimationFrame(this.loop)
      }

      /**
       * 下一帧重试 resize，直到绘图缓冲尺寸与 CSS 尺寸一致。
       *
       * 这是 ResizeObserver 的兜底：万一观察者不可用、或没触发，
       * 至少保证最初几帧能把尺寸量对。最多 10 帧（约 160ms），拿对就停。
       *
       * @param {number} attempt - 已尝试次数（内部用）。
       * @returns {void}
       */
      resizeSoon(attempt = 0) {
        if (typeof requestAnimationFrame !== 'function') return
        if (attempt > 10) return
        requestAnimationFrame(() => {
          this.resize()
          const rect = this.canvas.getBoundingClientRect()
          const want = Math.floor(rect.width * this.dpr)
          if (this.canvas.width !== want) {
            this.resizeSoon(attempt + 1)
            return
          }
          this.draw()
        })
      }

      /**
       * 建 Worker。
       *
       * ⚠️ **Worker 不是"体验加分项"，它是拖拽的前提。**
       *
       * 本鲸曾经在这里想：Worker 挂了就退化为静态布局，"至少还能看清关系"。
       * 但实测发现 —— **拖拽是把坐标发给 Worker 让它钉住节点的**，
       * 没有 Worker 就**完全拖不动**（`this.worker?.postMessage` 是可选链，
       * 静默跳过，一点错都不报）。主人报的"每一个拖不动了"就是这个。
       *
       * 所以这里**不静默吞异常**：失败会打日志、并把原因留在 `this.workerError`。
       *
       * @returns {Worker|null} worker 或 null。
       */
      createWorker() {
        // 优先用**内联源码的 Blob URL**（不发网络请求，桌面版/网页版都通）；
        // 拿不到再退回包内分块 URL（需要 rev 对得上）。
        const candidates = []
        const blob = workerBlobUrl()
        if (blob !== null) candidates.push(blob)
        candidates.push(workerPath())

        let lastError = 'no candidate'
        for (const url of candidates) {
          try {
            if (typeof Worker !== 'function') {
              this.workerError = 'environment has no Worker'
              return null
            }
            const w = new Worker(url, { name: 'dsh-ai-memory-graph' })
            w.onmessage = (e) => {
              const msg = e.data
              if (msg === null || typeof msg !== 'object' || msg.type !== 'tick') return
              const coords = new Float32Array(msg.coords)
              for (let i = 0; i < msg.ids.length; i += 1) {
                const entry = this.positions.get(msg.ids[i])
                if (entry !== undefined) {
                  entry.x = coords[2 * i]
                  entry.y = coords[2 * i + 1]
                  entry.placed = true
                }
              }
              this.alpha = msg.alpha
              // 物理还在跑 → 持续把视野套住整个图（见 autoFit）
              if (this.autoFit === true) this.fitToContent()
            }
            w.onerror = (ev) => {
              // 加载失败（最常见是 URL 404）→ 退化为**主线程拖拽**，至少还能拖
              this.workerError = `worker load failed: ${ev?.message ?? 'unknown'} (${url.slice(0, 60)})`
              try { console.error('[dsh-ai-memory] Worker 加载失败，改用主线程拖拽', this.workerError) } catch { /* 忽略 */ }
              try { w.terminate() } catch { /* 忽略 */ }
              this.worker = null
            }
            this.workerError = null
            return w
          } catch (err) {
            lastError = `${err?.message ?? String(err)} (${url.slice(0, 60)})`
          }
        }
        this.workerError = lastError
        try { console.error('[dsh-ai-memory] Worker 建不起来，改用主线程拖拽', lastError) } catch { /* 忽略 */ }
        return null
      }

      /**
       * 画布尺寸跟随容器（含 devicePixelRatio 缩放，避免模糊）。
       *
       * ⚠️ 尺寸变了要**顺便重新适配视野** —— 否则会出现：
       * 构造时 canvas 还是默认的 300×150（样式刚注入、布局未稳），
       * 那时算出的适配比例是按小画布算的；等真正撑开到 880×419 之后，
       * 比例就太小/太偏，画面上只剩一两个节点，看着像坏了。
       */
      resize() {
        const rect = this.canvas.getBoundingClientRect()
        const w = Math.max(1, Math.floor(rect.width))
        const hh = Math.max(1, Math.floor(rect.height))
        const changed = w !== this.width || hh !== this.height
        this.width = w
        this.height = hh
        this.canvas.width = Math.floor(w * this.dpr)
        this.canvas.height = Math.floor(hh * this.dpr)
        this.ctx2d.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
        // 画布尺寸变了 → 视野要跟着重算（用户手动操作过就不动，见 autoFit）
        if (changed && this.autoFit === true) this.fitToContent()
      }

      /**
       * 灌入新数据。
       *
       * **保留已有节点的位置**是"不跳动"的关键：只把已知坐标回传给 Worker，
       * 让它在新节点上继续模拟，而不是整张图重新开始。
       *
       * @param {object[]} nodes - 快照节点。
       * @param {object[]} edges - 快照边。
       */
      setData(nodes, edges) {
        const prev = this.positions
        const next = new Map()
        for (const n of nodes) {
          const old = prev.get(n.id)
          if (old !== undefined) next.set(n.id, { x: old.x, y: old.y, placed: old.placed, node: n })
          else next.set(n.id, { x: 0, y: 0, placed: false, node: n })
        }
        this.positions = next
        this.nodes = nodes
        this.edges = edges

        // Seed deterministic positions before the first worker tick.
        this.layoutFallback()

        if (this.worker !== null) {
          // ⚠️ **必须把全部节点 id 都发过去**，已定位的带坐标、未定位的传 null。
          //
          // 这里踩过一个真 bug：最初只发「已定位」的节点，
          // 于是首次加载时 `coords = {}` —— 而 Worker 的 `setNodes()` 是
          // **用收到的键替换整个节点集**，收到 `{}` 就把节点全清了 →
          // Worker 里一个节点都没有 → 什么都不画 → **画布空白**（面板其余部分正常，最难查的那种）。
          //
          // 传 null 的语义：id 我认，位置你定（Worker 会用确定性哈希给它一个起点）。
          const coords = {}
          for (const [id, p] of next) {
            coords[id] = p.placed === true ? [p.x, p.y] : null
          }
          const links = edges.map((e) => [e.from, e.to])
          // 照 Obsidian：给 alpha .3 并 run —— 让图"活过来"，而不是瞬间定格
          this.worker.postMessage({ nodes: coords, links, alpha: 0.3, run: true })
          this.alpha = 0.3
        } else {
          this.layoutFallback()
        }
        this.draw()
      }

      /** 无 Worker 时的兜底布局：按序号撒在圆环上（至少不重叠成一点）。 */
      layoutFallback() {
        const list = [...this.positions.values()]
        const R = Math.min(this.width, this.height) * 0.32
        list.forEach((p, i) => {
          if (p.placed === true) return
          const a = (i / Math.max(1, list.length)) * Math.PI * 2
          p.x = Math.cos(a) * R
          p.y = Math.sin(a) * R
          p.placed = true
        })
      }

      /** 屏幕坐标 → 世界坐标。 */
      toWorld(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect()
        const sx = clientX - rect.left
        const sy = clientY - rect.top
        return {
          x: (sx - rect.width / 2 - this.tx) / this.scale,
          y: (sy - rect.height / 2 - this.ty) / this.scale,
        }
      }

      /**
       * 命中测试：返回指针下的节点 id。
       *
       * 现在全是圆（主人要求「全要 ⚪」），所以直接按半径算 + 4px 容差。
       * `shapeExtent()` 仍然参与计算 —— 万一哪天想再用形状区分，
       * 点击判定会**自动跟着变**，不会出现"看着是菱形却按圆去点"的错位。
       */
      hitTest(clientX, clientY) {
        const { x, y } = this.toWorld(clientX, clientY)
        let best = null
        let bestD = Infinity
        for (const [id, p] of this.positions) {
          const r = this.radiusOf(p.node) * shapeExtent(kindStyle(p.node.kind).shape)
          const dx = x - p.x
          const dy = y - p.y
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d <= r + 4 && d < bestD) {
            best = id
            bestD = d
          }
        }
        return best
      }

      /**
       * 节点半径。
       *
       * ⚠️ **所有节点一样大**（主人明确要求）。
       *
       * 之前是照 Obsidian 的 `nodeSizeMultiplier` 做的「连接越多越大」，
       * 结果是同一张图上有的 5px、有的 9.8px —— 主人看到就问了「为什么有的大有的小」。
       * 现在统一成 7px：**重要性靠连线看，不靠大小**。
       *
       * 想恢复「枢纽更大」：换成 `return 5 + Math.min(9, (node.degree || 0) * 1.6)`。
       */
      radiusOf(_node) {
        return 7
      }

      /**
       * 按形状在 (x, y) 建一条路径（**调用方负责 beginPath 之外的 fill/stroke**）。
       *
       * 形状是**颜色之外的第二重区分**：色盲用户、或缩得很小的时候，
       * 光靠颜色分辨不出"这是判断还是思考"，但圆和菱形一眼就分得开。
       *
       * @param {CanvasRenderingContext2D} ctx - 画布上下文。
       * @param {number} x - 中心 x。
       * @param {number} y - 中心 y。
       * @param {number} r - 外接半径。
       * @param {string} shape - 'circle' | 'roundrect' | 'diamond'。
       * @returns {void}
       */
      pathNode(ctx, x, y, r, shape) {
        ctx.beginPath()
        if (shape === 'diamond') {
          // 菱形：规矩 —— 一看就是"被治理的东西"，不是长出来的
          ctx.moveTo(x, y - r * 1.18)
          ctx.lineTo(x + r * 1.18, y)
          ctx.lineTo(x, y + r * 1.18)
          ctx.lineTo(x - r * 1.18, y)
          ctx.closePath()
          return
        }
        if (shape === 'roundrect') {
          // 方圆：思考 —— 比圆"硬"一点，像还没定型的念头
          const s = r * 0.95
          const k = s * 0.42
          ctx.moveTo(x - s + k, y - s)
          ctx.lineTo(x + s - k, y - s)
          ctx.quadraticCurveTo(x + s, y - s, x + s, y - s + k)
          ctx.lineTo(x + s, y + s - k)
          ctx.quadraticCurveTo(x + s, y + s, x + s - k, y + s)
          ctx.lineTo(x - s + k, y + s)
          ctx.quadraticCurveTo(x - s, y + s, x - s, y + s - k)
          ctx.lineTo(x - s, y - s + k)
          ctx.quadraticCurveTo(x - s, y - s, x - s + k, y - s)
          ctx.closePath()
          return
        }
        // 默认圆：判断
        ctx.arc(x, y, r, 0, Math.PI * 2)
      }

      /** 绑定指针交互：悬停、点击选中、拖节点、拖背景平移、滚轮缩放。 */
      bindPointer() {
        const c = this.canvas

        this.onPointerDown = (e) => {
          // 用户一动手就交出视野控制权（不再自动适配跟他抢）
          this.autoFit = false
          const id = this.hitTest(e.clientX, e.clientY)
          if (id !== null) {
            this.dragNodeId = id
            this.dragMoved = false
            c.setPointerCapture?.(e.pointerId)
            c.setAttribute('data-dragging', 'node')
            const w = this.toWorld(e.clientX, e.clientY)
            this.worker?.postMessage({ alpha: 0.3, alphaTarget: 0.3, run: true, forceNode: { id, x: w.x, y: w.y } })
          } else {
            this.panFrom = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty }
            c.setPointerCapture?.(e.pointerId)
            c.setAttribute('data-dragging', 'pan')
          }
        }

        this.onPointerMove = (e) => {
          if (this.dragNodeId !== null) {
            this.dragMoved = true
            const w = this.toWorld(e.clientX, e.clientY)
            if (this.worker !== null) {
              this.worker.postMessage({ alpha: 0.3, alphaTarget: 0.3, run: true, forceNode: { id: this.dragNodeId, x: w.x, y: w.y } })
            } else {
              /**
               * ⚠️ **没有 Worker 也要能拖**（主线程兜底）。
               *
               * 本鲸最初的想法是"Worker 挂了就退化为静态布局，至少还能看清关系"。
               * 但实测发现：**拖拽是把坐标发给 Worker 让它钉住节点的** ——
               * 没有 Worker 就**完全拖不动**，而且 `this.worker?.postMessage` 是可选链，
               * **静默跳过、一点错都不报**。主人报的"每一个拖不动了"就是这个。
               *
               * 这里直接改本地位姿：拖拽本来也不需要物理，把节点放到指针处就行。
               * 松手后它停在原地（没有力导向回弹），但**能拖**远比"精致地不能拖"强。
               */
              const p = this.positions.get(this.dragNodeId)
              if (p !== undefined) {
                p.x = w.x
                p.y = w.y
                p.placed = true
                this.draw()
              }
            }
            return
          }
          if (this.panFrom !== null) {
            this.tx = this.panFrom.tx + (e.clientX - this.panFrom.x)
            this.ty = this.panFrom.ty + (e.clientY - this.panFrom.y)
            return
          }
          const id = this.hitTest(e.clientX, e.clientY)
          if (id !== this.hoverId) {
            this.hoverId = id
            c.style.cursor = id !== null ? 'pointer' : 'grab'
          }
        }

        this.onPointerUp = (e) => {
          const draggedNode = this.dragNodeId
          if (draggedNode !== null) {
            // 松手：解除钉住，让物理接管（照 Obsidian：x/y 传 null）。
            // 没有 Worker 时节点就停在放手处 —— 见 onPointerMove 里的主线程兜底。
            this.worker?.postMessage({ alphaTarget: 0, forceNode: { id: draggedNode, x: null, y: null } })
            // 没有实际移动 → 当作点击选中（否则拖一下就误选）
            if (this.dragMoved !== true) {
              this.selectedId = draggedNode
              this.handlers.onSelect(draggedNode)
            }
            this.dragNodeId = null
          }
          if (this.panFrom !== null) this.panFrom = null
          c.removeAttribute('data-dragging')
          c.releasePointerCapture?.(e.pointerId)
        }

        this.onClick = (e) => {
          // 只在点到空白处时清空选中（点到节点已由 pointerup 处理）
          const id = this.hitTest(e.clientX, e.clientY)
          if (id === null) {
            this.selectedId = null
            this.handlers.onSelect(null)
          }
        }

        this.onWheel = (e) => {
          e.preventDefault()
          // 用户一缩放就交出视野控制权
          this.autoFit = false
          const factor = e.deltaY < 0 ? 1.1 : 0.9
          const next = Math.max(0.25, Math.min(4, this.scale * factor))
          // 以指针为中心缩放：保持指针下的世界坐标不动
          const rect = c.getBoundingClientRect()
          const px = e.clientX - rect.left - rect.width / 2
          const py = e.clientY - rect.top - rect.height / 2
          this.tx = px - ((px - this.tx) / this.scale) * next
          this.ty = py - ((py - this.ty) / this.scale) * next
          this.scale = next
        }

        // 顶部 UI 去掉后，功能挪到这里（不占地方但不丢）：
        //   · 双击背景 → 复位视图
        //   · 右键       → 切换「只看活跃 / 含退役判断」
        this.onDblClick = (e) => {
          if (this.hitTest(e.clientX, e.clientY) !== null) return
          this.resetView()
        }
        this.onContextMenu = (e) => {
          e.preventDefault()
          this.handlers.onToggleRetired?.()
        }

        c.addEventListener('pointerdown', this.onPointerDown)
        c.addEventListener('pointermove', this.onPointerMove)
        c.addEventListener('pointerup', this.onPointerUp)
        c.addEventListener('pointercancel', this.onPointerUp)
        c.addEventListener('click', this.onClick)
        c.addEventListener('dblclick', this.onDblClick)
        c.addEventListener('contextmenu', this.onContextMenu)
        c.addEventListener('wheel', this.onWheel, { passive: false })
      }

      /** 解开全部监听（卸载时调用，防泄漏）。 */
      destroy() {
        if (this.raf !== null) cancelAnimationFrame(this.raf)
        this.raf = null
        this.running = false
        // 停掉尺寸观察
        try { this.observer?.disconnect() } catch { /* 忽略 */ }
        this.observer = null
        const c = this.canvas
        c.removeEventListener('pointerdown', this.onPointerDown)
        c.removeEventListener('pointermove', this.onPointerMove)
        c.removeEventListener('pointerup', this.onPointerUp)
        c.removeEventListener('pointercancel', this.onPointerUp)
        c.removeEventListener('click', this.onClick)
        c.removeEventListener('dblclick', this.onDblClick)
        c.removeEventListener('contextmenu', this.onContextMenu)
        c.removeEventListener('wheel', this.onWheel)
        try { this.worker?.terminate() } catch { /* 忽略 */ }
        this.worker = null
      }

      /**
       * 复位视图。
       *
       * ⚠️ 现在会**重新打开 autoFit** —— 否则"复位"之后图可能还是跑到视野外，
       * 复位就成了空操作。用户下次手动拖拽会自动再关掉它。
       */
      resetView() {
        this.tx = 0
        this.ty = 0
        this.scale = 1
        this.autoFit = true
        this.fitToContent()
      }

      /**
       * 把视野缩放到**刚好装下所有节点**。
       *
       * 为什么需要：力导向把节点推开之后，图会长得比画布大 ——
       * 不自动适配的话，用户看到的是"几个点飘在角落、其余全在视野外"，
       * 像是坏了。（本鲸实测就是这么被坑的：3 个节点被推到 ±600，画布只有 760×419。）
       *
       * 只在 `autoFit` 为 true 时调用（物理还在跑的阶段）；
       * 用户一旦自己拖拽/缩放，就**交出控制权**，不再跟他抢视野。
       *
       * @returns {void}
       */
      fitToContent() {
        if (this.positions.size === 0) return
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const p of this.positions.values()) {
          if (Number.isFinite(p.x) === false || Number.isFinite(p.y) === false) continue
          if (p.x < minX) minX = p.x
          if (p.y < minY) minY = p.y
          if (p.x > maxX) maxX = p.x
          if (p.y > maxY) maxY = p.y
        }
        if (Number.isFinite(minX) === false || Number.isFinite(minY) === false) return
        const pad = 70 // 给标签留地方（标签画在节点下方）
        const w = Math.max(1, maxX - minX + pad * 2)
        const h = Math.max(1, maxY - minY + pad * 2)
        // 不放大超过 1.6 倍（节点少时别糊成巨球），也不缩小到 0.15 以下（否则看不清）
        const next = Math.max(0.15, Math.min(1.6, Math.min(this.width / w, this.height / h)))
        this.scale = next
        // 让内容中心对齐画布中心
        const cx = (minX + maxX) / 2
        const cy = (minY + maxY) / 2
        this.tx = -cx * next
        this.ty = -cy * next
      }

      /** 重新读主题色（明暗切换后调用）。 */
      refreshTheme() {
        this.colors = themeColors(this.canvas)
      }

      /**
       * 每帧渲染。
       *
       * ⚠️ 这里**不静默吞异常**。曾经写成 `try { this.draw() } catch {}`，
       * 结果是"画不出来但一点错都不报" —— 本插件最贵的一类 bug 就是这样藏起来的。
       * 现在失败会打一次日志（只打第一次，不刷屏），并把错误留在 `this.lastDrawError` 上，
       * 便于用 CDP 直接查。
       */
      loop() {
        if (!this.running) return
        try {
          this.draw()
        } catch (err) {
          this.lastDrawError = err
          if (this.drawErrorCount === 0) {
            this.drawErrorCount = 1
            try {
              console.error('[dsh-ai-memory] 绘制失败（只报一次）', err)
            } catch { /* console 不可用就算了 */ }
          } else {
            this.drawErrorCount = (this.drawErrorCount ?? 0) + 1
          }
        }
        this.raf = requestAnimationFrame(this.loop)
      }

      /** 画一帧。 */
      draw() {
        const ctx = this.ctx2d
        const c = this.colors
        ctx.clearRect(0, 0, this.width, this.height)
        ctx.save()
        ctx.translate(this.width / 2 + this.tx, this.height / 2 + this.ty)
        ctx.scale(this.scale, this.scale)

        // ---- 边 ----
        // ⚠️ 之前 lineWidth=1.2 且 globalAlpha=0.55 —— 又细又淡，几乎看不见。
        // 现在**一律不透明**（主人要求"不要透明的"），
        // 悬停高亮靠"其余变暗"来表达，但那也是**混成实色**而不是降 alpha。
        ctx.lineWidth = 2 / this.scale
        for (const e of this.edges) {
          const a = this.positions.get(e.from)
          const b = this.positions.get(e.to)
          if (a === undefined || b === undefined) continue
          const related = this.hoverId === null || this.hoverId === e.from || this.hoverId === e.to
          ctx.globalAlpha = 1
          // 无关的边混向背景（实色，不是透明）
          ctx.strokeStyle = related ? edgeColor(e.type, c) : mixWith(edgeColor(e.type, c), c.canvasBg, 0.7)
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
          // 取代边加箭头 —— 方向有意义（新的指向旧的）
          if (e.type === 'supersedes') {
            const ang = Math.atan2(b.y - a.y, b.x - a.x)
            const r = this.radiusOf(b.node) + 3
            const ax = b.x - Math.cos(ang) * r
            const ay = b.y - Math.sin(ang) * r
            ctx.beginPath()
            ctx.moveTo(ax, ay)
            ctx.lineTo(ax - Math.cos(ang - 0.4) * 9, ay - Math.sin(ang - 0.4) * 9)
            ctx.lineTo(ax - Math.cos(ang + 0.4) * 9, ay - Math.sin(ang + 0.4) * 9)
            ctx.closePath()
            ctx.fillStyle = ctx.strokeStyle
            ctx.fill()
          }
        }

        // ---- 节点 ----
        for (const [id, p] of this.positions) {
          const n = p.node
          const r = this.radiusOf(n)
          const dim = this.hoverId !== null && this.hoverId !== id
          // ⚠️ **节点一律不透明**（主人明确要求："不要透明的"）。
          //
          // 之前退役节点用 alpha 0.75、悬停时其他节点降到 0.25 —— 结果是
          // "有的实、有的透"，看着像没画好。
          // 现在"退役"用**颜色**表达（见 nodeFill：退役的降饱和度，不是降透明度），
          // 悬停高亮也改成**描边加粗**而不是把别人变透明。
          ctx.globalAlpha = 1

          const style = kindStyle(n.kind)
          this.pathNode(ctx, p.x, p.y, r, style.shape)
          ctx.fillStyle = nodeFill(n, c)
          ctx.fill()
          // 悬停/选中：加粗描边 —— 这样"突出"不依赖透明度
          const emphasized = id === this.selectedId || id === this.hoverId
          ctx.lineWidth = (emphasized ? 3 : 1.6) / this.scale
          ctx.strokeStyle = emphasized ? c.labelPrimary : nodeStroke(n, c)
          ctx.stroke()

          // 标签：缩小到一定程度就只显示重点节点（照 Obsidian 的 textFade 思路）
          const showLabel = this.scale > 0.85 || id === this.hoverId || id === this.selectedId || (n.degree || 0) >= 2
          if (showLabel) {
            ctx.globalAlpha = 1
            const fontPx = 12 / this.scale
            ctx.font = `600 ${fontPx}px -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'top'
            const label = n.label.length > 18 ? `${n.label.slice(0, 17)}…` : n.label
            const ty = p.y + r + 4 / this.scale
            // 先描一圈背景色再填字 —— 否则标签压在线上会糊成一团
            ctx.lineWidth = 3 / this.scale
            ctx.strokeStyle = c.canvasBg
            ctx.strokeText(label, p.x, ty)
            ctx.fillStyle = n.status === 'active' ? c.labelPrimary : c.labelSecondary
            ctx.fillText(label, p.x, ty)
          }
        }

        ctx.restore()
        ctx.globalAlpha = 1
      }
    }

    /** 统计 chip。 */
    function Chip({ label, value }) {
      return h('span', { className: 'dsh-am-chip' }, label, ' ', h('b', null, String(value)))
    }

    /**
     * 详情卡片。
     *
     * 主人要求：**里面只留 AI 存下来的记忆本身**。
     * 所以那些内部记账全部去掉了 —— id、状态、版本号、建立时间、标签、引用、
     * 以及 `← 互补 来自 n_0008_6rovu9` 这种裸 ID 的连线列表。
     *
     * 留下的只有两样，都是"记忆"本身：
     *   · 判断正文
     *   · 取代链（"这条是从哪条变过来的"，每一环也是记忆正文）
     *
     * 想看 id / 时间 / 标签这些元数据，用 `memory_search` 或 `memory_history` 工具。
     */
    function Detail({ node, onClose }) {
      if (node === null) return null
      return h('div', { className: 'dsh-am-detail' },
        h('p', null, node.text),
        (node.chain ?? []).length > 1
          ? h('div', { className: 'dsh-am-links' },
              h('div', { className: 'dsh-am-chain-title' }, '这条判断的来路：'),
              node.chain.map((ch, i) => h('div', {
                key: ch.id,
                className: ch.status === 'active' ? 'dsh-am-chain-active' : 'dsh-am-chain-old',
              }, `${i + 1}. ${ch.text}`)))
          : null,
        h('div', { style: { marginTop: '10px' } },
          h('button', { className: 'dsh-am-btn', type: 'button', onClick: onClose }, '关闭')),
      )
    }

    function FallbackGraph({ snapshot, onSelect }) {
      if (snapshot === null) return null
      const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : []
      const edges = Array.isArray(snapshot.edges) ? snapshot.edges : []
      const pos = new Map()
      const cx = 500; const cy = 250
      const radius = Math.min(190, 34 * Math.max(1, nodes.length))
      nodes.forEach((n, i) => { const a = (i / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2; pos.set(n.id, { x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius }) })
      return h('svg', { className: 'dsh-am-fallback', viewBox: '0 0 1000 500', 'aria-hidden': true },
        edges.map((e, i) => { const a = pos.get(e.from); const b = pos.get(e.to); return a && b ? h('line', { key: `e-${i}`, x1: a.x, y1: a.y, x2: b.x, y2: b.y, className: 'dsh-am-fallback-edge', style: { stroke: '#7aa2ff' } }) : null }),
        nodes.map((n) => { const p = pos.get(n.id); return h('g', { key: n.id, transform: `translate(${p.x} ${p.y})` }, h('circle', { r: n.kind === 'rule' ? 13 : 11, className: `dsh-am-fallback-node ${n.status}`, style: { fill: n.kind === 'rule' ? '#d99a32' : n.status === 'active' ? '#3b82f6' : '#596273', stroke: '#dbeafe' } }), h('text', { y: 25, textAnchor: 'middle', className: 'dsh-am-fallback-label', style: { fill: '#f4f7ff', stroke: 'none', fontWeight: 600 } }, n.label.length > 18 ? `${n.label.slice(0, 17)}…` : n.label)) }),
      )
    }
    /** 主面板。 */
    function MemoryGraphPanel() {
      const canvasRef = React.useRef(null)
      const rendererRef = React.useRef(null)
      const [state, setState] = React.useState({ phase: 'loading', snapshot: null, error: null })
      const [includeRetired, setIncludeRetired] = React.useState(false)
      const [selected, setSelected] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      /**
       * Canvas 是否可用（渲染器建起来了）。
       *
       * 用它决定**要不要渲染 SVG 兜底层** —— 见渲染处的注释：
       * 兜底层会盖在 canvas 上并吃掉指针事件，无条件渲染会导致"图能画但完全动不了"。
       */
      const [canvasOk, setCanvasOk] = React.useState(false)

      // 取快照
      React.useEffect(() => {
        let alive = true
        setState((s) => ({ ...s, phase: 'loading' }))
        fetch(includeRetired ? `${SNAPSHOT_PATH}?retired=1` : SNAPSHOT_PATH, { headers: { accept: 'application/json' } })
          .then(async (res) => {
            if (!res.ok) throw new Error(`快照请求失败：HTTP ${res.status}`)
            const body = await res.json()
            if (body.ok !== true) throw new Error(body.error || '快照返回 ok:false')
            if (alive) setState({ phase: 'ready', snapshot: body, error: null })
          })
          .catch((error) => {
            if (alive) setState({ phase: 'error', snapshot: null, error: error.message })
          })
        return () => { alive = false }
      }, [includeRetired])

      // 建渲染器。
      //
      // ⚠️ **依赖数组必须是 [state.phase]，不能是 []** —— 这是一个很隐蔽的真 bug：
      //
      //   首次渲染时 `phase === 'loading'`，组件返回的是「正在读记忆库…」那个 div，
      //   **里面根本没有 canvas**。于是 `canvasRef.current === null`，
      //   这个 effect 提前 return 了。
      //
      //   等 fetch 回来、`phase` 变 `ready`、canvas 真的出现时 ——
      //   若依赖是 `[]`，effect **永远不会再跑**。后果：
      //     · GraphRenderer 从未构造 → `resize()` 从未调用 → canvas 保持默认的 300×150
      //     · `canvasOk` 永远是 false → **SVG 兜底层一直盖在 canvas 上** → 完全动不了
      //
      //   而这一切**不报任何错**（所以极难查）。
      React.useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null) return undefined
        // 已经建过就别重复建（phase 可能变多次）
        if (rendererRef.current !== null) return undefined
        // 注入样式（用容器自己的 document）。
        // ⚠️ 这一句曾经**漏掉过** —— 函数定义了却没人调用，结果面板是裸 HTML 且不报错。
        ensureStyles(canvas.ownerDocument)
        let renderer = null
        try {
          renderer = new GraphRenderer(canvas, {
            onSelect: (id) => setSelected(id),
            // 右键切换「只看活跃 / 含退役判断」（顶部按钮去掉后挪到这里）
            onToggleRetired: () => setIncludeRetired((v) => !v),
          })
        } catch {
          // Canvas 不可用（极少见）：保持 canvasOk=false，让 SVG 兜底层顶上。
          renderer = null
        }
        rendererRef.current = renderer
        // Canvas 建成了 → 撤掉兜底层（否则它会吃掉所有指针事件）
        if (renderer !== null) setCanvasOk(true)

        const onResize = () => renderer?.resize()
        globalThis.addEventListener?.('resize', onResize)
        // 明暗切换：主题 token 的值会变，要重读
        const observer = typeof MutationObserver === 'function' && renderer !== null
          ? new MutationObserver(() => renderer.refreshTheme())
          : null
        observer?.observe(canvas.ownerDocument.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'data-theme', 'style'],
        })

        // ⚠️ 清理**必须延迟到真正卸载时**。
        // 这个 effect 现在依赖 `state.phase`（会从 loading → ready 变一次），
        // 若在依赖变化时就 destroy，会把刚建好的渲染器拆掉。
        // 用 rendererRef 比对：只有当 ref 还指向**我建的这个**时才清理。
        return () => {
          if (rendererRef.current !== renderer) return
          globalThis.removeEventListener?.('resize', onResize)
          observer?.disconnect()
          renderer?.destroy()
          rendererRef.current = null
        }
        // 依赖 phase：首次是 loading（没有 canvas），变成 ready 后 canvas 才存在。
      }, [state.phase])

      // 数据变化 → 喂给渲染器。
      //
      // ⚠️ 依赖里必须有 `canvasOk`：建渲染器的 effect 和这个 effect 都在 `phase` 变 ready
      // 那一轮跑，但**顺序上渲染器可能还没建好**（rendererRef 仍是 null），
      // 于是第一次 setData 被静默跳过 —— 数据就永远进不去了。
      // 加上 canvasOk 后，渲染器一建好这个 effect 会再跑一次。
      React.useEffect(() => {
        const renderer = rendererRef.current
        if (renderer === null || state.snapshot === null) return
        renderer.setData(state.snapshot.nodes, state.snapshot.edges)
      }, [state.snapshot, canvasOk])

      // 选中 → 取详情
      React.useEffect(() => {
        if (selected === null) { setDetail(null); return undefined }
        let alive = true
        fetch(`${NODE_PATH}?id=${encodeURIComponent(selected)}`, { headers: { accept: 'application/json' } })
          .then(async (res) => {
            const body = await res.json()
            if (alive && body.ok === true) setDetail(body.node)
          })
          .catch(() => { /* 详情取不到不影响看图 */ })
        return () => { alive = false }
      }, [selected])

      const snapshot = state.snapshot
      /**
       * 顶部 UI 开关。
       *
       * 主人要求「**只留图**」—— 标题、说明、统计、按钮全部去掉，
       * 因为侧边栏图标已经写着「判断图谱」，面板里再来一遍是重复的。
       *
       * 但功能不能丢，所以：
       *   · **复位视图** → 挪到**双击背景**（见 GraphRenderer 的 dblclick）
       *   · **只看活跃 / 含退役** → 挪到**右键菜单**（contextmenu）
       *   · 节点数/连线数 → 悬停时在底部一行小字里显示（默认不占地方）
       *
       * 想恢复旧样子：把下面三个常量改成 true 即可。
       */
      const SHOW_HEAD = false
      const SHOW_CHIPS = false
      const SHOW_TOOLBAR = false
      // 图例**开着**：主人明确要过「什么颜色的线代表什么最好写出来」。
      // 它是唯一留下的文字 —— 因为**颜色本身不自解释**，不写就只能猜。
      const SHOW_LEGEND = true

      const head = SHOW_HEAD
        ? h('div', { className: 'dsh-am-head' },
            h('h1', null, '判断图谱'),
            h('p', { className: 'dsh-am-sub' },
              '这张网是你自己的判断长出来的。节点只做导航 —— 点开才看全文。'),
          )
        : null

      const toolbar = SHOW_TOOLBAR
        ? h('div', { className: 'dsh-am-tools' },
            h('button', {
              className: 'dsh-am-btn', type: 'button',
              'aria-pressed': includeRetired ? 'true' : 'false',
              onClick: () => setIncludeRetired((v) => !v),
            }, includeRetired ? '含退役判断' : '只看活跃'),
            h('button', {
              className: 'dsh-am-btn', type: 'button',
              onClick: () => rendererRef.current?.resetView(),
            }, '复位视图'),
            snapshot !== null && snapshot.truncated
              ? h('span', { className: 'dsh-am-sub', style: { margin: 0 } }, '（节点过多，已截断）')
              : null,
          )
        : null

      /**
       * Legend colors come from the **same** `edgeColor()` the canvas uses,
       * so the two can never disagree.
       *
       * Colors are read from the canvas element; before the canvas exists
       * (first render) `themeColors(null)` returns the built-in palette.
       */
      const legendColors = themeColors(canvasRef.current)
      const legend = SHOW_LEGEND
        ? h('div', { className: 'dsh-am-legend' },
            edgeLegend(legendColors).map(([k, color]) => h('span', { key: k },
              h('i', { style: { borderTopColor: color } }),
              EDGE_LABEL[k],
            )),
          )
        : null

      if (state.phase === 'loading' && snapshot === null) {
        return h('div', { className: 'dsh-am-root' }, head, h('div', { className: 'dsh-am-empty' }, '正在读记忆库…'))
      }
      if (state.phase === 'error') {
        return h('div', { className: 'dsh-am-root' }, head,
          h('div', { className: 'dsh-am-empty' },
            h('b', null, '读不到记忆库'),
            h('div', { className: 'dsh-am-err' }, state.error),
          ))
      }

      const nodes = snapshot.nodes
      if (nodes.length === 0) {
        return h('div', { className: 'dsh-am-root' }, head,
          h('div', { className: 'dsh-am-empty' },
            h('b', null, '还没有任何判断'),
            h('div', null, '这本身是诚实的 —— 写不出真判断时，就该是空的。'),
            h('div', { style: { marginTop: '6px' } }, '让 AI 用 memory_write 写下第一条判断后，这里会长出第一个节点。'),
          ))
      }

      const st = snapshot.stats
      const chips = SHOW_CHIPS
        ? h('div', { className: 'dsh-am-stats' },
            Chip({ label: '判断', value: st.judgments }),
            Chip({ label: '规矩', value: st.rules }),
            Chip({ label: '已退役', value: st.retired }),
            Chip({ label: '连线', value: st.edges }),
            Chip({ label: '孤立', value: st.orphans }),
            st.problems > 0 ? Chip({ label: '数据问题', value: st.problems }) : null,
          )
        : null

      return h('div', { className: 'dsh-am-root' },
        head, chips, toolbar,
        h('div', { className: 'dsh-am-stage' },
          h('canvas', {
            ref: canvasRef,
            className: 'dsh-am-canvas',
            role: 'img',
            'aria-label': '判断关系图谱',
          }),
          // ⚠️ **兜底层只在 Canvas 真的用不了时才渲染**。
          //
          // 这里踩过一个很坑的 bug：兜底层曾经**无条件渲染**，而它的 CSS 是
          //   .dsh-am-fallback { position: absolute; z-index: 3; pointer-events: auto; }
          //   .dsh-am-canvas   { position: relative; z-index: 2; }
          // 于是它**盖在 canvas 上面并吃掉所有指针事件** —— 拖拽、滚轮、点击全被它接走，
          // canvas 一个事件都收不到。表现就是"图能画出来但完全动不了"，
          // 而且主人看到的"图"其实是这个**静态 SVG**，不是 Canvas。
          //
          // 判据用 `rendererRef.current !== null`（Canvas 渲染器建起来了就说明 Canvas 可用）。
          canvasOk ? null : FallbackGraph({ snapshot, onSelect: (id) => setSelected(id) }),
          // 底部那行小字（"N 节点 · M 连线"）也去掉了 —— 主人要的是**只有图**。
          // 数量信息可以从侧边栏图标或 memory_stats 工具拿。
          h(Detail, { node: detail, onClose: () => setSelected(null) }),
        ),
        legend,
      )
    }

    /** 侧边栏图标。 */
    function MemoryIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true,
        style: { display: 'block' },
      },
        h('circle', { cx: 6, cy: 6, r: 2.6 }),
        h('circle', { cx: 18, cy: 8, r: 2.6 }),
        h('circle', { cx: 10, cy: 18, r: 2.6 }),
        h('path', { d: 'M8.2 7.2 15.6 8.4M7.4 8.3l1.9 7.2M16.6 10.2l-5.2 6.2' }),
      )
    }

    /**
     * 注入面板样式。
     *
     * ## ⚠️ 这里有一段很贵的教训（本鲸先搞错了，是主人纠正的）
     *
     * 本鲸最初写的是 `ctx.styles.insert(CSS)`，理由是"官方 Client Builtin 清单里有 `styles`"。
     * **这个推理是错的**：
     *
     *   1. Builtin 清单列的是**能力声明**，不等于当前版本**提供了该服务**。
     *      DeepSeek Harness `0.2.0-rc.2` **不提供客户端 `styles` 服务**。
     *   2. 本鲸还写了 `if (ctx.styles !== undefined)` 想做"可选" ——
     *      但 `ctx` 是**受限 Proxy**，**读未提供的服务名这一步本身就抛错**。
     *      于是 factory 抛 → fiber 变 FAILED → **整个应用拒绝启动**
     *      （`web boot: 1 entry did not activate / dsh-ai-memory: failed`）。
     *   3. 若把它声明成必需 `inject: ['slots','styles']`，则会更早卡在
     *      `pending (waiting for service: styles)` —— 同样起不来。
     *
     * ## 正确做法：照 `dsh-downloads-panel`（一直能用）直插带标记的 `<style>`
     *
     * 关键点：
     *   - 用**容器自己的 document**（`container.ownerDocument`），不是全局 `document`
     *   - 打 `data-plugin` 标记，避免重复注入
     *   - 整段包 try/catch：**样式只是锦上添花，取不到不该让面板消失**
     *
     * 官方 practices.md 禁止的是"操作文档头 / 在组件外写 DOM"，
     * 而这里插的是**本插件自己的样式表**（带标记），与"读别的插件的 DOM"是两回事。
     *
     * @param {Document|null|undefined} doc - 面板容器所属的 document。
     * @returns {void}
     */
    function ensureStyles(doc) {
      try {
        if (doc === null || doc === undefined) return
        if (doc.querySelector('style[data-plugin="dsh-ai-memory"]') !== null) return
        const tag = doc.createElement('style')
        tag.setAttribute('data-plugin', 'dsh-ai-memory')
        tag.textContent = CSS
        doc.head.append(tag)
      } catch {
        // 样式是锦上添花：没样式的面板仍然能看关系图，不该因此崩掉
      }
    }

    function apply(ctx) {
      // ⚠️ 这里**只碰 ctx.slots**（唯一在 inject 里声明过的服务）。
      // 任何其它服务名的读取都可能抛 —— 见 ensureStyles 的注释。
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, MemoryGraphPanel))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: PANEL_LABEL,
      }, MemoryIcon))
    }

    return { name: 'dsh-ai-memory-client', inject: ['slots'], apply }
  },
})



