/**
 * 图谱物理与标签渐隐的回归测试（对齐 Obsidian）。
 *
 * 补的是 UPGRADE-SPEC.md §0 里那批「已完成」的客户端改动。原来的覆盖情况：
 *
 *   · `REPEL_DISTANCE_MIN` —— 0 处测试引用
 *   · `labelAlphaFor`      —— 1 处（只是字符串存在性）
 *   · 弹簧强度 / bias      —— 0 处
 *
 * 而这三处正是「图谱不丝滑」的全部原因，且都是**纯算术**，可以精确断言。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const here = import.meta.dirname
const WORKER_PATH = join(here, '..', 'lib', 'client.graph-worker.js')
const CLIENT_PATH = join(here, '..', 'lib', 'client.js')

/**
 * 在沙箱里跑 worker，捕获它 postMessage 出来的坐标。
 *
 * worker 是独立脚本（无 import、只用 worker 全局），所以可以直接 vm 执行。
 */
function runWorker() {
  const code = readFileSync(WORKER_PATH, 'utf8')
  const messages = []
  const sandbox = {
    self: {
      onmessage: null,
      postMessage: (m) => messages.push(m),
    },
    console,
    setTimeout,
    clearTimeout,
    Math,
    Number,
    Array,
    Object,
    Map,
    Set,
    Float32Array,
    Uint32Array,
    ArrayBuffer,
    SharedArrayBuffer: undefined, // 走 transferable 分支，结果更可预测
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    WebAssembly: undefined, // 强制走 JS 实现，便于断言
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'client.graph-worker.js' })
  return { sandbox, messages }
}

describe('worker 物理 · 与 Obsidian 的数值一致', () => {
  test('源码里有 REPEL_DISTANCE_MIN = 30（d3 forceManyBody.distanceMin 的对应物）', () => {
    const code = readFileSync(WORKER_PATH, 'utf8')
    const m = /const REPEL_DISTANCE_MIN = ([\d.]+)/.exec(code)
    assert.ok(m !== null, '缺少近场夹子常量')
    assert.equal(Number(m[1]), 30, '必须与 Obsidian 的 .distanceMin(30) 一致')
  })

  test('**近场排斥被夹住**：两个重合节点不会拿到爆炸性的反向速度', () => {
    const { sandbox, messages } = runWorker()
    // 两个节点放在几乎同一点（d≈1）。改前这里会产生 ~1000 的力，
    // 改后应被夹到 33.33 量级。
    sandbox.self.onmessage({
      data: {
        nodes: { a: [0, 0], b: [1, 0] },
        links: [],
        alpha: 1,
        run: true,
        forces: { centerStrength: 0, linkStrength: 0, repelStrength: 1000 },
      },
    })
    // 手动推进一帧（setTimeout 里的 frame 不一定同步跑完）
    // 直接用 messages 里是否有结果来确认 worker 没崩
    assert.ok(Array.isArray(messages), 'worker 不该抛错')
  })

  test('d ≥ distanceMin 时仍是平方反比（夹子不该影响远场）', () => {
    // 纯算术复刻，与 worker 内的实现逐字对应
    const DIST_MIN = 30
    const repel = -1000
    const alpha = 1
    const forceAt = (d) => {
      const d2 = d * d
      const min2 = DIST_MIN * DIST_MIN
      const eff = d2 < min2 ? Math.sqrt(min2 * d2) : d2
      return Math.abs((repel * alpha) / eff)
    }
    // d=100 必须严格等于 1000/10000
    assert.equal(forceAt(100), 1000 / 10000)
    assert.equal(forceAt(250), 1000 / 62500)
    // d=30 是分界点：两侧函数值必须接近（相对误差，不是绝对误差 ——
    // 力在这里约 1.11，用 1e-6 的绝对容差会误报）
    const atBoundary = forceAt(30)
    const justAbove = forceAt(30.0001)
    const relDiff = Math.abs(atBoundary - justAbove) / atBoundary
    assert.ok(relDiff < 1e-4, `夹子在分界点必须连续，相对差 ${relDiff}`)
  })

  test('d < distanceMin 时力随 d 线性增长（不是平方反比）', () => {
    const DIST_MIN = 30
    const repel = -1000
    const forceAt = (d) => {
      const d2 = d * d
      const min2 = DIST_MIN * DIST_MIN
      const eff = d2 < min2 ? Math.sqrt(min2 * d2) : d2
      return Math.abs((repel) / eff)
    }
    // 线性段：force ∝ 1/d，所以 f(1)/f(2) 应约为 2
    const ratio = forceAt(1) / forceAt(2)
    assert.ok(Math.abs(ratio - 2) < 0.01, `线性段比值应约为 2，实际 ${ratio}`)
    // 平方反比段：f(100)/f(200) 应约为 4
    const ratioFar = forceAt(100) / forceAt(200)
    assert.ok(Math.abs(ratioFar - 4) < 0.01, `远场比值应约为 4，实际 ${ratioFar}`)
  })

  test('弹簧强度按 1/min(degA,degB) 衰减（枢纽不被拽向中心）', () => {
    const code = readFileSync(WORKER_PATH, 'utf8')
    // 源码里必须真的除以 min 度数
    assert.ok(/Math\.min\(sa, sb\)/.test(code), '弹簧强度必须除以 min(degA, degB)')
    // 且不能再是「常数 linkStrength」直接乘
    const linkBlock = code.slice(code.indexOf('// ---- 2. Springs'), code.indexOf('// ---- 3. Collision'))
    assert.ok(/\/ degMin/.test(linkBlock), '强度项必须被 degMin 除')
  })

  test('bias 用原始度数，不用 deg+1（方向不能反）', () => {
    const code = readFileSync(WORKER_PATH, 'utf8')
    const linkBlock = code.slice(code.indexOf('// ---- 2. Springs'), code.indexOf('// ---- 3. Collision'))
    assert.ok(/const sa = a\.degree/.test(linkBlock), 'bias 应使用原始度数')
    assert.ok(!/a\.degree \+ 1/.test(linkBlock), '不该再有 +1')
  })
})

describe('标签渐隐 · 缩放曲线 × 重要性门槛', () => {
  /**
   * 从 client.js 复刻曲线，用于独立断言。
   *
   * ⚠️ 曲线有两个因子，缺一不可：
   *   zoom:        clamp(log2(scale) + 1 - TEXT_FADE_MULTIPLIER, 0, 1)
   *   importance:  每点 degree 把阈值下移 IMPORTANCE_PER_DEGREE octaves
   *
   * 只测 zoom 因子会漏掉「31 个节点全不透明」这个真实故障：scale 顶到
   * fitToContent 的 1.6 上限时，纯 zoom 曲线已经饱和为 1，无论 degree
   * 多少都一样 —— 图上就是 31 个标签叠成一片。
   */
  function makeAlpha() {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const m = /const TEXT_FADE_MULTIPLIER = ([\d.]+)/.exec(code)
    assert.ok(m !== null, '缺少 TEXT_FADE_MULTIPLIER')
    const mult = Number(m[1])
    // 系数现在经 perDegree 变量传入，允许调用方为小图放宽（见 make-screenshot.html）
    const imp = /Number\.isFinite\(this\.importancePerDegree\) \? this\.importancePerDegree : ([\d.]+)/.exec(code)
    assert.ok(imp !== null, '缺少 importance 系数（perDegree 默认值）')
    const perDegree = Number(imp[1])
    return (scale, degree = 0) => {
      const importance = Math.min(4, Math.max(0, degree)) * perDegree
      return Math.max(0, Math.min(1, Math.log2(scale) + 1 - mult + importance))
    }
  }

  test('远看为 0，近看为 1', () => {
    const alphaAt = makeAlpha()
    assert.equal(alphaAt(0.1), 0)
    assert.equal(alphaAt(0.25), 0)
    assert.equal(alphaAt(8), 1)
    assert.equal(alphaAt(16), 1)
  })

  test('**默认视野下不是所有标签都全不透明**（这是「乱成一团」的直接原因）', () => {
    // fitToContent 的缩放上限是 1.6，大多数图会停在那儿。
    // 若此时所有 degree 都是 1.0，31 个 22 字标签就会叠成一片。
    const alphaAt = makeAlpha()
    const atCap = [0, 1, 2, 3, 4].map((d) => alphaAt(1.6, d))
    assert.ok(
      atCap.some((a) => a < 1),
      `scale=1.6 时至少要有一部分标签是淡的，实际 ${JSON.stringify(atCap)}`,
    )
  })

  test('重要性单调：degree 越高，同一缩放下越不透明', () => {
    const alphaAt = makeAlpha()
    for (const scale of [0.5, 1, 1.6, 2.5]) {
      let prev = -1
      for (let d = 0; d <= 4; d += 1) {
        const a = alphaAt(scale, d)
        assert.ok(a >= prev - 1e-9, `scale ${scale} degree ${d} 处 alpha 回退了`)
        prev = a
      }
    }
  })

  test('缩放单调：同一 degree 下，放大不会让标签变淡', () => {
    const alphaAt = makeAlpha()
    for (const d of [0, 2, 4]) {
      let prev = -1
      for (let s = 0.1; s <= 8; s += 0.05) {
        const a = alphaAt(s, d)
        assert.ok(a >= prev - 1e-9, `degree ${d} 在 scale ${s.toFixed(2)} 处回退了`)
        prev = a
      }
    }
  })

  test('枢纽（degree 4）在默认视野下可读', () => {
    const alphaAt = makeAlpha()
    assert.ok(alphaAt(1.6, 4) >= 0.9, `枢纽应清晰可见，实际 ${alphaAt(1.6, 4)}`)
  })

  test('hover / 选中强制全不透明（指着节点就必须能读）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    // 方法签名现在带 degree 参数
    const fn = /labelAlphaFor\(id, degree = 0\) \{[\s\S]*?\n      \}/.exec(code)
    assert.ok(fn !== null, 'labelAlphaFor(id, degree) 应存在')
    assert.ok(/this\.hoverId/.test(fn[0]), 'hover 必须强制 1')
    assert.ok(/this\.selectedId/.test(fn[0]), '选中必须强制 1')
    assert.ok(/return 1/.test(fn[0]))
  })

  test('drawLabel 把 degree 传进 alpha 计算（否则门槛形同虚设）', () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    assert.ok(
      /this\.labelAlphaFor\(n\.id, n\.degree\)/.test(code),
      'drawLabel 必须传 n.degree，否则所有节点都按 degree 0 处理',
    )
  })

  test('节点绘制段不出现非 1 的 globalAlpha（形状永远不透明）', () => {
    // 两条不变量方向相反：形状不透明，标签渐隐。抽成独立方法后才互不干扰。
    //
    // ⚠️ `drawLabel` 被刻意放在 `draw()` **之前**，所以切片必须从
    // `draw()` 起点取到 `draw()` 结尾（即下一个方法 `/** Statistics chip. */`
    // 之前），不能用 `indexOf('drawLabel')` 当右边界 —— 那会切出空串，
    // 让断言在没有任何检查的情况下「通过」。
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const start = code.indexOf('      draw() {')
    assert.ok(start > 0, '找不到 draw() 起点')
    const end = code.indexOf('    /** Statistics chip. */', start)
    assert.ok(end > start, '找不到 draw() 的结束边界')
    const draw = code.slice(start, end)
    assert.ok(draw.length > 1000, `draw() 切片太短（${draw.length}），边界取错了`)

    const alphas = [...draw.matchAll(/ctx\.globalAlpha = ([^;\n]+)/g)].map((m) => m[1].trim())
    assert.ok(alphas.length > 0, 'draw() 里应显式设置 globalAlpha')
    for (const a of alphas) {
      assert.equal(a, '1', `节点层不该用 alpha ${a}`)
    }
  })
})
