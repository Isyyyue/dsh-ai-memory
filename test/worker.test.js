/**
 * 力导向 Worker 的测试。
 *
 * 为什么值得专门测：Worker 是"丝滑"的核心（照 Obsidian 的做法把物理计算搬出主线程），
 * 但它跑在独立上下文里、**主线程看不到它的异常** —— 一旦物理算错（NaN、不收敛、
 * 节点飞出天际），面板只会表现为"图不动"或"图消失"，**不报错**。
 *
 * 测试手法：造一个假的 `self`，把 worker 脚本跑起来，手动喂消息、手动推进帧，
 * 检查节点是否真的移动、是否收敛、是否稳定。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const WORKER_PATH = join(here, '..', 'lib', 'client.graph-worker.js')

/**
 * 在隔离 vm 里跑 worker 脚本，返回可控的句柄。
 *
 * 关键：**不用真的 setTimeout 等待** —— 把定时器换成手动队列，
 * 这样"推进一帧"是确定性的、瞬间的，测试不必 sleep。
 *
 * @returns {{post: Function, ticks: object[], runFrame: Function, pendingFrames: Function, lastFrame: Function}}
 */
function loadWorker() {
  const ticks = []
  const timers = []
  let idSeq = 0

  const sandbox = {
    self: {
      onmessage: null,
      postMessage(msg) {
        if (msg !== null && typeof msg === 'object' && msg.type === 'tick') {
          ticks.push({ ids: msg.ids, coords: Array.from(new Float32Array(msg.coords)), alpha: msg.alpha })
        }
      },
    },
    setTimeout(fn, ms) {
      idSeq += 1
      timers.push({ id: idSeq, fn, ms })
      return idSeq
    },
    clearTimeout() { /* 测试里不需要真取消 */ },
    Math,
    Float32Array,
    Object,
    Array,
    Number,
    Map,
    Infinity,
    console,
  }
  sandbox.globalThis = sandbox

  const code = readFileSync(WORKER_PATH, 'utf8')
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'client.graph-worker.js' })

  return {
    /** 喂一条消息。 */
    post: (msg) => sandbox.self.onmessage({ data: msg }),
    /** 收到的全部 tick。 */
    ticks,
    /** 执行排队的下一帧（如果有）。 */
    runFrame() {
      const t = timers.shift()
      if (t === undefined) return false
      t.fn()
      return true
    },
    /** 还有几帧在排队。 */
    pendingFrames: () => timers.length,
    /** 最后一条 tick。 */
    lastFrame: () => ticks[ticks.length - 1],
    /** 取某节点最新坐标。 */
    positionOf(id) {
      const f = ticks[ticks.length - 1]
      if (f === undefined) return undefined
      const i = f.ids.indexOf(id)
      if (i < 0) return undefined
      return { x: f.coords[2 * i], y: f.coords[2 * i + 1] }
    },
  }
}

/** 跑 n 帧。 */
function runFrames(w, n) {
  for (let i = 0; i < n; i += 1) {
    if (!w.runFrame()) break
  }
}

describe('worker · 基本运转', () => {
  test('收到节点后开始推进并回报坐标', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [10, 0] }, links: [['a', 'b']], alpha: 0.3, run: true })
    runFrames(w, 3)
    assert.ok(w.ticks.length >= 1, '应当有 tick 回报')
    const f = w.lastFrame()
    assert.deepEqual([...f.ids].sort(), ['a', 'b'])
    assert.equal(f.coords.length, 4, '两个节点 → 4 个浮点数')
  })

  test('回报的坐标全是有限数（NaN 会让画布整块消失）', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [0, 0], c: [1, 1] }, links: [['a', 'b'], ['b', 'c'], ['c', 'a']], alpha: 0.5, run: true })
    runFrames(w, 30)
    const f = w.lastFrame()
    for (let i = 0; i < f.coords.length; i += 1) {
      assert.ok(Number.isFinite(f.coords[i]), `第 ${i} 个坐标必须是有限数，实际 ${f.coords[i]}`)
    }
  })

  test('重合节点不会产生 NaN（除零保护）', () => {
    const w = loadWorker()
    // 三个节点全在原点 —— 最坏情况
    w.post({ nodes: { a: [0, 0], b: [0, 0], c: [0, 0] }, links: [['a', 'b']], alpha: 1, run: true })
    runFrames(w, 20)
    const f = w.lastFrame()
    assert.ok(f.coords.every(Number.isFinite), '重合也必须安全')
    // 而且应当被推开（不再全重合）
    const [ax, ay, bx, by] = f.coords
    assert.ok(Math.hypot(ax - bx, ay - by) > 0.5, '斥力应当把它们分开')
  })

  test('空节点集不崩、不无限推进', () => {
    const w = loadWorker()
    w.post({ nodes: {}, links: [], alpha: 0.3, run: true })
    runFrames(w, 5)
    // 没有节点就不该有坐标回报
    assert.equal(w.ticks.length, 0)
  })
})

describe('worker · 收敛（决定"是否丝滑"）', () => {
  test('alpha 随帧衰减', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [100, 0] }, links: [['a', 'b']], alpha: 1, run: true })
    runFrames(w, 1)
    const first = w.lastFrame().alpha
    runFrames(w, 20)
    const later = w.lastFrame().alpha
    assert.ok(later < first, `alpha 应当衰减：${first} → ${later}`)
  })

  test('收敛后停止推进（不空转烧 CPU）', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [100, 0] }, links: [['a', 'b']], alpha: 1, run: true })
    // 跑足够多帧让它收敛（alphaMin = 0.001，衰减 ≈0.0228/帧）
    runFrames(w, 600)
    assert.equal(w.pendingFrames(), 0, '收敛后不该再有排队的帧')
  })

  test('有边相连的两个节点最终停在 linkDistance 附近（弹簧收敛）', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [-400, 0], b: [400, 0] }, links: [['a', 'b']], alpha: 1, run: true })
    // ⚠️ 不能拿"第 1 帧"当基准：d3 式积分器第一帧会**过冲**（弹簧拉过头），
    // 之后靠 velocityDecay=0.6 吸收振荡、若干帧后收敛。这是 d3 的既定行为，不是 bug。
    // 真正该验的是**收敛结果**。
    runFrames(w, 400)
    const d = Math.abs(w.positionOf('a').x - w.positionOf('b').x)
    // 默认 linkDistance = 250（照 Obsidian）
    assert.ok(d > 150 && d < 350, `应当收敛到 250 附近，实际 ${d.toFixed(0)}`)
  })

  test('初始距离远小于 linkDistance 时会被推开（弹簧双向）', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [10, 0] }, links: [['a', 'b']], alpha: 1, run: true })
    runFrames(w, 1)
    const d1 = Math.abs(w.positionOf('a').x - w.positionOf('b').x)
    runFrames(w, 300)
    const d2 = Math.abs(w.positionOf('a').x - w.positionOf('b').x)
    assert.ok(d2 > d1, `太近时应当被推开：${d1.toFixed(0)} → ${d2.toFixed(0)}`)
  })

  test('linkDistance 参数真的生效', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [-300, 0], b: [300, 0] }, links: [['a', 'b']], forces: { linkDistance: 500 }, alpha: 1, run: true })
    runFrames(w, 400)
    const d = Math.abs(w.positionOf('a').x - w.positionOf('b').x)
    // 会停在 linkDistance 附近（斥力与弹簧平衡处），不该还停在 600
    assert.ok(d < 600, `距离应当被拉到 500 附近，实际 ${d.toFixed(0)}`)
  })
})

describe('worker · 交互协议（照 Obsidian）', () => {
  test('forceNode 把节点钉在指定位置', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [100, 0] }, links: [['a', 'b']], alpha: 0.5, run: true })
    w.post({ alpha: 0.3, alphaTarget: 0.3, run: true, forceNode: { id: 'a', x: 250, y: -75 } })
    runFrames(w, 10)
    const p = w.positionOf('a')
    assert.ok(Math.abs(p.x - 250) < 0.001, `钉住的 x 应当精确等于 250，实际 ${p.x}`)
    assert.ok(Math.abs(p.y - (-75)) < 0.001, `钉住的 y 应当精确等于 -75，实际 ${p.y}`)
  })

  test('forceNode 传 null 解除钉住，物理重新接管', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [100, 0] }, links: [['a', 'b']], alpha: 0.5, run: true })
    w.post({ alpha: 0.5, run: true, forceNode: { id: 'a', x: 300, y: 0 } })
    runFrames(w, 5)
    const pinned = w.positionOf('a')
    assert.ok(Math.abs(pinned.x - 300) < 0.001)
    // 松手
    w.post({ alphaTarget: 0, forceNode: { id: 'a', x: null, y: null } })
    runFrames(w, 60)
    const freed = w.positionOf('a')
    assert.ok(Math.abs(freed.x - 300) > 0.5, '解除钉住后应当被物理推走')
  })

  test('拖拽时重新加热（alpha 回升）', () => {
    const w = loadWorker()
    // ⚠️ alpha 初值是 1（照 d3 / Obsidian 的默认），而且**只升不降** ——
    // 所以想观察"加热"，必须先让它自然冷却下去。
    w.post({ nodes: { a: [0, 0], b: [100, 0] }, links: [['a', 'b']], alpha: 1, run: true })
    runFrames(w, 120) // 冷却到远低于 0.9
    const cool = w.lastFrame().alpha
    assert.ok(cool < 0.3, `前置条件：应当已经冷却，实际 alpha=${cool}`)

    // 拖拽：照 Obsidian 的协议重新加热
    w.post({ alpha: 0.9, alphaTarget: 0.3, run: true, forceNode: { id: 'a', x: 10, y: 10 } })
    runFrames(w, 1)
    assert.ok(w.lastFrame().alpha > cool, `拖拽应当把 alpha 加热回去：${cool} → ${w.lastFrame().alpha}`)
  })

  test('alpha 只升不降（迟到的低 alpha 消息不改变什么）', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [50, 0] }, links: [['a', 'b']], alpha: 1, run: true })
    runFrames(w, 30)

    // 对照组：同样再跑一帧，但不发迟到消息
    const control = loadWorker()
    control.post({ nodes: { a: [0, 0], b: [50, 0] }, links: [['a', 'b']], alpha: 1, run: true })
    runFrames(control, 30)

    // 实验组：插一条迟到的低 alpha
    w.post({ alpha: 0.01, run: true })
    runFrames(w, 1)
    runFrames(control, 1)

    // 两者应当推进到同样的 alpha —— 迟到的低值没有影响
    assert.ok(
      Math.abs(w.lastFrame().alpha - control.lastFrame().alpha) < 1e-9,
      `迟到消息不该改变 alpha：实验 ${w.lastFrame().alpha} vs 对照 ${control.lastFrame().alpha}`,
    )
  })

  test('初值 alpha=1 时，较小的 alpha 消息被忽略（d3/Obsidian 语义）', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [100, 0] }, links: [['a', 'b']], alpha: 0.05, run: true })
    runFrames(w, 1)
    // 初值 1 → 0.05 被忽略 → 第一帧后仍接近 1
    assert.ok(w.lastFrame().alpha > 0.9, `较小的 alpha 应当被忽略，实际 ${w.lastFrame().alpha}`)
  })

  test('forces 参数可在运行时调整', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [100, 0] }, links: [['a', 'b']], alpha: 1, run: true })
    w.post({ forces: { centerStrength: 0.5, linkStrength: 2, linkDistance: 120, repelStrength: 300 } })
    runFrames(w, 100)
    const f = w.lastFrame()
    assert.ok(f.coords.every(Number.isFinite), '改参数后仍要稳定')
  })
})

describe('worker · 稳定性', () => {
  test('重复喂同一份数据不会让节点乱飞', () => {
    const w = loadWorker()
    const nodes = { a: [0, 0], b: [80, 0], c: [40, 70] }
    const links = [['a', 'b'], ['b', 'c']]
    w.post({ nodes, links, alpha: 0.3, run: true })
    runFrames(w, 50)
    const before = w.positionOf('a')
    // 再来一次（模拟面板重新取快照）
    w.post({ nodes, links, alpha: 0.3, run: true })
    runFrames(w, 50)
    const after = w.positionOf('a')
    const moved = Math.hypot(after.x - before.x, after.y - before.y)
    assert.ok(moved < 400, `重喂数据不该让节点飞走，实际移动 ${moved.toFixed(0)}`)
  })

  test('新节点加入时已有节点位置被保留（不整张图重排）', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [80, 0] }, links: [['a', 'b']], alpha: 0.3, run: true })
    runFrames(w, 80)
    const aBefore = w.positionOf('a')
    // 加一个新节点，并回传已有位置（面板就是这么做的）
    w.post({
      nodes: { a: [aBefore.x, aBefore.y], b: [w.positionOf('b').x, w.positionOf('b').y], c: [0, 0] },
      links: [['a', 'b'], ['b', 'c']],
      alpha: 0.3,
      run: true,
    })
    runFrames(w, 1)
    const aAfter = w.positionOf('a')
    const jump = Math.hypot(aAfter.x - aBefore.x, aAfter.y - aBefore.y)
    assert.ok(jump < 60, `已有节点不该瞬移，实际跳了 ${jump.toFixed(1)}`)
  })

  test('大量节点仍然稳定（200 节点压力）', () => {
    const w = loadWorker()
    const nodes = {}
    for (let i = 0; i < 200; i += 1) nodes[`n${i}`] = [0, 0]
    const links = []
    for (let i = 1; i < 200; i += 1) links.push([`n${i - 1}`, `n${i}`])
    w.post({ nodes, links, alpha: 0.3, run: true })
    runFrames(w, 40)
    const f = w.lastFrame()
    assert.equal(f.ids.length, 200)
    assert.ok(f.coords.every(Number.isFinite), '200 节点也必须全是有限数')
  })
})

describe('worker · 传 null 坐标（客户端首次加载的路径）', () => {
  test('**节点 id 必须全部发过去**（传 null 表示"位置你定"）', () => {
    // 血泪教训：客户端最初只把**已定位**的节点发给 Worker，
    // 于是首次加载时发的是空对象 `{}` —— 而 setNodes() 是**用收到的键替换整个节点集**，
    // 收到 {} 就把节点全清了 → Worker 里一个节点都没有 → **画布空白**（面板其余部分正常）。
    const w = loadWorker()
    w.post({ nodes: { a: null, b: null, c: null }, links: [['a', 'b'], ['b', 'c']], alpha: 0.3, run: true })
    runFrames(w, 3)
    const f = w.lastFrame()
    assert.ok(f !== undefined, '传 null 坐标也必须产生 tick')
    assert.deepEqual([...f.ids].sort(), ['a', 'b', 'c'], '三个节点都要在')
    assert.ok(f.coords.every(Number.isFinite), 'Worker 应当给它们算出起点')
  })

  test('传 null 的节点会被赋予**确定性**起点（同一 id 两次一致）', () => {
    const w1 = loadWorker()
    w1.post({ nodes: { x: null }, links: [], alpha: 0.3, run: true })
    runFrames(w1, 1)
    const w2 = loadWorker()
    w2.post({ nodes: { x: null }, links: [], alpha: 0.3, run: true })
    runFrames(w2, 1)
    assert.deepEqual(w1.positionOf('x'), w2.positionOf('x'), '同 id 的起点必须可复现')
  })

  test('混发（部分 null 部分有坐标）不崩', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [10, 10], b: null, c: [20, -20] }, links: [['a', 'b'], ['b', 'c']], alpha: 0.3, run: true })
    runFrames(w, 20)
    const f = w.lastFrame()
    assert.equal(f.ids.length, 3)
    assert.ok(f.coords.every(Number.isFinite))
  })

  test('收到空 nodes 对象会清空节点集（所以调用方绝不能发空）', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [50, 0] }, links: [['a', 'b']], alpha: 0.3, run: true })
    runFrames(w, 3)
    assert.equal(w.lastFrame().ids.length, 2)
    // 发空对象 → 节点集被替换为空 → 后续 frame() 早退，不再产生 tick
    const before = w.ticks.length
    w.post({ nodes: {}, links: [], alpha: 0.3, run: true })
    runFrames(w, 3)
    assert.equal(w.ticks.length, before, '清空后不该再有 tick（这正是"画布空白"的成因）')
  })
})
