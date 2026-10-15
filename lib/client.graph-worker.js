/**
 * 力导向模拟 —— 跑在**独立 Worker 线程**里。
 *
 * 这个文件的形状与参数是**照 Obsidian 的图谱扒出来的**（`D:\Obsidian\resources\obsidian.asar`
 * 里的 `sim.js`，17.7 KB）。它的丝滑不是玄学，是三个决定：
 *
 *   1. **物理计算在 Worker 里** —— 主线程只管渲染，不因迭代卡顿
 *      （Obsidian 原文：`new Worker("/sim.js", { name: "Graph Worker" })`）
 *   2. **连续动画**（不是"算完就画死"）—— 每帧推进 alpha，直到收敛
 *   3. **交互时重新加热** —— 拖拽发 `{alpha:.3, alphaTarget:.3, run:true, forceNode}`，
 *      松手发 `{alphaTarget:0, forceNode:{x:null,y:null}}`
 *
 * Obsidian 的物理参数（本鲸从其代码里读出的常量，这里照抄）：
 *   alphaDecay    = 1 - 0.001^(1/300) ≈ 0.0228
 *   alphaMin      = 0.001
 *   velocityDecay = 0.6
 *   centerStrength= 0.1
 *   linkDistance  = 250
 *   repelStrength = 1000
 *   collide       = 半径 60、强度 0.5
 *
 * ⚠️ 本文件是**独立 Worker 脚本**，不能用 ESM import（Worker 里直接跑）。
 * 所以它只依赖 worker 全局，不 import 任何东西。
 *
 * 通信协议（与 Obsidian 的 worker 保持一致，便于对照）：
 *   收：{ nodes: {id: [x,y]}, links: [[id,id]], alpha, alphaTarget, run, forceNode: {id,x,y}, forces: {...} }
 *   发：{ id: [id...], buffer: Float32Array(2n) 的 ArrayBuffer, alpha }
 */

/* eslint-disable no-restricted-globals */

// ---- 物理常量（照 Obsidian sim.js）----
const ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 300) // ≈ 0.0228
const ALPHA_MIN = 0.001
const VELOCITY_DECAY = 0.6
const TICK_MS = 1000 / 60

// ---- 可调参数（Obsidian 允许通过 forces 覆盖）----
let centerStrength = 0.1
let linkStrength = 1
let linkDistance = 250
let repelStrength = -1000 // 负号表示斥力

// ---- 状态 ----
/** @type {Map<string, {id:string,x:number,y:number,vx:number,vy:number,fx:number|null,fy:number|null}>} */
let nodes = new Map()
/** @type {{source:object,target:object}[]} */
let links = []
let alpha = 1
let alphaTarget = 0
let running = false
let timer = null

/**
 * 初始化/更新节点集合。
 *
 * 保留已有节点的位置（**这是"不跳动"的关键**）：新数据到达时不重置坐标，
 * 只更新那些确实变了的。Obsidian 的 worker 也是这么做的（它维护 `F` 表，
 * 只对不存在的 id 新建，存在的沿用）。
 *
 * @param {Record<string, [number, number]>} incoming - id → [x, y]。
 */
function setNodes(incoming) {
  const next = new Map()
  for (const [id, xy] of Object.entries(incoming)) {
    const existing = nodes.get(id)
    if (existing !== undefined) {
      // 沿用旧位置与速度 —— 只更新坐标（如果调用方给了）
      if (Array.isArray(xy) && Number.isFinite(xy[0]) && Number.isFinite(xy[1])) {
        existing.x = xy[0]
        existing.y = xy[1]
      }
      next.set(id, existing)
    } else {
      // 新节点：从原点附近随机起步（用确定性哈希，不用 Math.random —— 便于复现）
      const h = hash32(id)
      const angle = ((h % 1000) / 1000) * Math.PI * 2
      const r = 30 + ((h >>> 10) % 100)
      next.set(id, {
        id,
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
      })
    }
  }
  nodes = next
  // 重建索引
  let i = 0
  for (const n of nodes.values()) n.index = i++
}

/** 设置边。 */
function setLinks(pairs) {
  links = []
  for (const [a, b] of pairs) {
    const s = nodes.get(a)
    const t = nodes.get(b)
    if (s !== undefined && t !== undefined) links.push({ source: s, target: t })
  }
  // 度数：用于碰撞半径与渲染大小
  for (const n of nodes.values()) n.degree = 0
  for (const l of links) {
    l.source.degree += 1
    l.target.degree += 1
  }
}

/** FNV-1a 哈希 —— 确定性初始布局。 */
function hash32(s) {
  let x = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    x ^= s.charCodeAt(i)
    x = Math.imul(x, 16777619)
  }
  return x >>> 0
}

/** 单步模拟。这是 d3-force 三个力（charge / link / collide）的合并实现。 */
function tick() {
  const list = [...nodes.values()]
  const n = list.length

  // ---- 1. 斥力（many-body，照 d3.forceManyBody）----
  // 用 Barnes-Hut 是 O(n log n)，但本插件的图通常几十到几百节点，
  // O(n²) 在这个量级完全够用（200 节点 = 2 万对，每帧微不足道），
  // 而且省掉四叉树那两百行代码 —— 零依赖是硬约束。
  for (let i = 0; i < n; i += 1) {
    const a = list[i]
    for (let j = i + 1; j < n; j += 1) {
      const b = list[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let d2 = dx * dx + dy * dy
      if (d2 < 1e-6) {
        // 完全重合：确定性拆开（避免除零产生 NaN）
        dx = ((hash32(a.id) % 7) - 3) || 1
        dy = ((hash32(b.id) % 7) - 3) || 1
        d2 = dx * dx + dy * dy
      }
      const d = Math.sqrt(d2)
      const strength = (repelStrength * alpha) / d2
      const fx = (dx / d) * strength
      const fy = (dy / d) * strength
      a.vx += fx
      a.vy += fy
      b.vx -= fx
      b.vy -= fy
    }
  }

  // ---- 2. 弹簧（照 d3.forceLink）----
  for (const l of links) {
    const a = l.source
    const b = l.target
    let dx = b.x + b.vx - a.x - a.vx
    let dy = b.y + b.vy - a.y - a.vy
    let d = Math.sqrt(dx * dx + dy * dy)
    if (d < 1e-6) {
      dx = 1
      dy = 1
      d = Math.SQRT2
    }
    // d3 的公式：strength 按两端度数分配（度数高的节点移动更少）
    const sa = a.degree + 1
    const sb = b.degree + 1
    const bias = sa / (sa + sb)
    const k = ((d - linkDistance) / d) * alpha * linkStrength
    const cx = dx * k
    const cy = dy * k
    a.vx += cx * bias
    a.vy += cy * bias
    b.vx -= cx * (1 - bias)
    b.vy -= cy * (1 - bias)
  }

  // ---- 3. 碰撞（照 d3.forceCollide，半径 60）----
  const RADIUS = 60
  for (let i = 0; i < n; i += 1) {
    const a = list[i]
    for (let j = i + 1; j < n; j += 1) {
      const b = list[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let d2 = dx * dx + dy * dy
      const minD = RADIUS
      if (d2 >= minD * minD) continue
      if (d2 < 1e-6) {
        dx = ((hash32(a.id) % 5) - 2) || 1
        dy = ((hash32(b.id) % 5) - 2) || 1
        d2 = dx * dx + dy * dy
      }
      const d = Math.sqrt(d2)
      const overlap = (minD - d) / d
      const push = overlap * 0.5 * alpha
      const fx = dx * push
      const fy = dy * push
      a.vx -= fx
      a.vy -= fy
      b.vx += fx
      b.vy += fy
    }
  }

  // ---- 4. 向心 + 位置积分（照 d3.forceCenter + 积分器）----
  const cx0 = 0
  const cy0 = 0
  for (const node of list) {
    node.vx += (cx0 - node.x) * centerStrength * alpha
    node.vy += (cy0 - node.y) * centerStrength * alpha

    if (node.fx !== null) {
      node.x = node.fx
      node.vx = 0
    } else {
      node.vx *= VELOCITY_DECAY
      node.x += node.vx
    }
    if (node.fy !== null) {
      node.y = node.fy
      node.vy = 0
    } else {
      node.vy *= VELOCITY_DECAY
      node.y += node.vy
    }
  }

  // ---- 5. alpha 衰减 ----
  alpha += (alphaTarget - alpha) * ALPHA_DECAY
}

/** 打包位置并发回主线程。 */
function publish() {
  const list = [...nodes.values()]
  const ids = new Array(list.length)
  const coords = new Float32Array(list.length * 2)
  for (let i = 0; i < list.length; i += 1) {
    ids[i] = list[i].id
    coords[2 * i] = list[i].x
    coords[2 * i + 1] = list[i].y
  }
  // 用 transferable 传 ArrayBuffer，零拷贝
  self.postMessage({ type: 'tick', ids, coords: coords.buffer, alpha }, [coords.buffer])
}

/** 一帧：推进模拟并发回结果；未收敛就继续排下一帧。 */
function frame() {
  timer = null
  if (nodes.size === 0) {
    running = false
    return
  }
  tick()
  publish()
  // 收敛条件照 d3：alpha < alphaMin 就停（但拖拽会把它重新加热）
  if (alpha > ALPHA_MIN || alphaTarget > 0) {
    running = true
    timer = setTimeout(frame, TICK_MS)
  } else {
    running = false
  }
}

/** 启动（或唤醒）模拟。 */
function kick() {
  if (timer === null) {
    running = true
    timer = setTimeout(frame, TICK_MS)
  }
}

self.onmessage = (e) => {
  const msg = e.data ?? {}

  if (msg.nodes !== undefined) setNodes(msg.nodes)
  if (msg.links !== undefined) setLinks(msg.links)

  // 拖拽：固定某节点的位置，并重新加热
  if (msg.forceNode !== undefined) {
    const n = nodes.get(msg.forceNode.id)
    if (n !== undefined) {
      n.fx = msg.forceNode.x === null || msg.forceNode.x === undefined ? null : msg.forceNode.x
      n.fy = msg.forceNode.y === null || msg.forceNode.y === undefined ? null : msg.forceNode.y
    }
  }

  // 物理参数可运行时调（照 Obsidian 的 forces 字段）
  if (msg.forces !== undefined) {
    const f = msg.forces
    if (Number.isFinite(f.centerStrength)) centerStrength = f.centerStrength
    if (Number.isFinite(f.linkStrength)) linkStrength = f.linkStrength
    if (Number.isFinite(f.linkDistance)) linkDistance = f.linkDistance
    if (Number.isFinite(f.repelStrength)) repelStrength = -Math.abs(f.repelStrength)
  }

  // alpha 只升不降（照 Obsidian：Q < A.alpha 才更新）—— 避免迟到的消息把进度打回去
  if (Number.isFinite(msg.alpha) && msg.alpha > alpha) alpha = msg.alpha
  if (Number.isFinite(msg.alphaTarget)) alphaTarget = msg.alphaTarget

  if (msg.run === true) kick()
  // 数据变了但没要求 run（例如只是换节点集）→ 也推进一帧，让画面反映新数据
  else if (msg.nodes !== undefined || msg.links !== undefined) kick()
}
