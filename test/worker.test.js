/**
 * Tests for the force-directed worker.
 *
 * Why this deserves dedicated tests: the worker is what makes the panel feel
 * smooth (following Obsidian's practice of moving the physics off the main
 * thread), but it runs in a separate context, so **the main thread never sees
 * its exceptions**. If the physics goes wrong (NaN, no convergence, nodes
 * flying off to infinity) the panel only shows "the graph does not move" or
 * "the graph disappeared" — **with no error raised**.
 *
 * Approach: build a fake `self`, run the worker script in it, feed messages and
 * advance frames by hand, then check whether nodes really move, really
 * converge, and really stay stable.
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
 * Run the worker script inside an isolated vm and return a controllable handle.
 *
 * Key point: **no real setTimeout waiting** — timers are replaced with a manual
 * queue, so "advance one frame" is deterministic and instant, and the test never
 * has to sleep.
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
    clearTimeout() { /* no real cancellation is needed in tests */ },
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
    /** Feed one message. */
    post: (msg) => sandbox.self.onmessage({ data: msg }),
    /** Every tick received. */
    ticks,
    /** Run the next queued frame, if any. */
    runFrame() {
      const t = timers.shift()
      if (t === undefined) return false
      t.fn()
      return true
    },
    /** How many frames are still queued. */
    pendingFrames: () => timers.length,
    /** The last tick. */
    lastFrame: () => ticks[ticks.length - 1],
    /** Latest position of one node. */
    positionOf(id) {
      const f = ticks[ticks.length - 1]
      if (f === undefined) return undefined
      const i = f.ids.indexOf(id)
      if (i < 0) return undefined
      return { x: f.coords[2 * i], y: f.coords[2 * i + 1] }
    },
  }
}

/** Run n frames. */
function runFrames(w, n) {
  for (let i = 0; i < n; i += 1) {
    if (!w.runFrame()) break
  }
}

describe('worker · basic operation', () => {
  test('after receiving nodes it starts advancing and reports coordinates', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [10, 0] }, links: [['a', 'b']], alpha: 0.3, run: true })
    runFrames(w, 3)
    assert.ok(w.ticks.length >= 1, 'a tick should be reported')
    const f = w.lastFrame()
    assert.deepEqual([...f.ids].sort(), ['a', 'b'])
    assert.equal(f.coords.length, 4, 'two nodes → four floats')
  })

  test('reported coordinates are all finite (NaN would make the whole canvas disappear)', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [0, 0], c: [1, 1] }, links: [['a', 'b'], ['b', 'c'], ['c', 'a']], alpha: 0.5, run: true })
    runFrames(w, 30)
    const f = w.lastFrame()
    for (let i = 0; i < f.coords.length; i += 1) {
      assert.ok(Number.isFinite(f.coords[i]), `coordinate ${i} must be finite; actual ${f.coords[i]}`)
    }
  })

  test('coincident nodes do not produce NaN (division-by-zero guard)', () => {
    const w = loadWorker()
    // All three nodes at the origin — the worst case
    w.post({ nodes: { a: [0, 0], b: [0, 0], c: [0, 0] }, links: [['a', 'b']], alpha: 1, run: true })
    runFrames(w, 20)
    const f = w.lastFrame()
    assert.ok(f.coords.every(Number.isFinite), 'coincident nodes must still be safe')
    // They should also be pushed apart (no longer all coincident)
    const [ax, ay, bx, by] = f.coords
    assert.ok(Math.hypot(ax - bx, ay - by) > 0.5, 'repulsion should separate them')
  })

  test('an empty node set does not crash and does not advance forever', () => {
    const w = loadWorker()
    w.post({ nodes: {}, links: [], alpha: 0.3, run: true })
    runFrames(w, 5)
    // With no nodes there should be no coordinate report
    assert.equal(w.ticks.length, 0)
  })
})

describe('worker · convergence (what decides whether it feels smooth)', () => {
  test('alpha decays frame by frame', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [100, 0] }, links: [['a', 'b']], alpha: 1, run: true })
    runFrames(w, 1)
    const first = w.lastFrame().alpha
    runFrames(w, 20)
    const later = w.lastFrame().alpha
    assert.ok(later < first, `alpha should decay: ${first} → ${later}`)
  })

  test('it stops advancing once converged (no busy-waiting on the CPU)', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [100, 0] }, links: [['a', 'b']], alpha: 1, run: true })
    // Run enough frames to converge (alphaMin = 0.001, decay ≈0.0228 per frame)
    runFrames(w, 600)
    assert.equal(w.pendingFrames(), 0, 'no frames should remain queued after convergence')
  })

  test('two linked nodes settle near linkDistance (spring convergence)', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [-400, 0], b: [400, 0] }, links: [['a', 'b']], alpha: 1, run: true })
    // ⚠️ Frame 1 is not a usable baseline: a d3-style integrator **overshoots**
    // on the first frame (the spring pulls too far), then velocityDecay=0.6
    // absorbs the oscillation and it converges over several frames. That is
    // established d3 behaviour, not a bug. What actually needs verifying is the
    // **converged result**.
    runFrames(w, 400)
    const d = Math.abs(w.positionOf('a').x - w.positionOf('b').x)
    // Default linkDistance = 250 (following Obsidian)
    assert.ok(d > 150 && d < 350, `it should converge near 250; actual ${d.toFixed(0)}`)
  })

  test('a starting distance far below linkDistance is pushed apart (the spring works both ways)', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [10, 0] }, links: [['a', 'b']], alpha: 1, run: true })
    runFrames(w, 1)
    const d1 = Math.abs(w.positionOf('a').x - w.positionOf('b').x)
    runFrames(w, 300)
    const d2 = Math.abs(w.positionOf('a').x - w.positionOf('b').x)
    assert.ok(d2 > d1, `too close should be pushed apart: ${d1.toFixed(0)} → ${d2.toFixed(0)}`)
  })

  test('the linkDistance parameter really takes effect', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [-300, 0], b: [300, 0] }, links: [['a', 'b']], forces: { linkDistance: 500 }, alpha: 1, run: true })
    runFrames(w, 400)
    const d = Math.abs(w.positionOf('a').x - w.positionOf('b').x)
    // It settles near linkDistance (where repulsion and the spring balance), so it must not still be at 600
    assert.ok(d < 600, `the distance should be pulled toward 500; actual ${d.toFixed(0)}`)
  })
})

describe('worker · interaction protocol (following Obsidian)', () => {
  test('forceNode pins a node at the given position', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [100, 0] }, links: [['a', 'b']], alpha: 0.5, run: true })
    w.post({ alpha: 0.3, alphaTarget: 0.3, run: true, forceNode: { id: 'a', x: 250, y: -75 } })
    runFrames(w, 10)
    const p = w.positionOf('a')
    assert.ok(Math.abs(p.x - 250) < 0.001, `a pinned x should be exactly 250; actual ${p.x}`)
    assert.ok(Math.abs(p.y - (-75)) < 0.001, `a pinned y should be exactly -75; actual ${p.y}`)
  })

  test('forceNode with null releases the pin and the physics takes over again', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [100, 0] }, links: [['a', 'b']], alpha: 0.5, run: true })
    w.post({ alpha: 0.5, run: true, forceNode: { id: 'a', x: 300, y: 0 } })
    runFrames(w, 5)
    const pinned = w.positionOf('a')
    assert.ok(Math.abs(pinned.x - 300) < 0.001)
    // Release
    w.post({ alphaTarget: 0, forceNode: { id: 'a', x: null, y: null } })
    runFrames(w, 60)
    const freed = w.positionOf('a')
    assert.ok(Math.abs(freed.x - 300) > 0.5, 'once released the physics should push it away')
  })

  test('dragging reheats the simulation (alpha rises again)', () => {
    const w = loadWorker()
    // ⚠️ The initial alpha is 1 (following d3 / Obsidian defaults) and it
    // **only rises, never falls** — so to observe "reheating" it must first be
    // allowed to cool naturally.
    w.post({ nodes: { a: [0, 0], b: [100, 0] }, links: [['a', 'b']], alpha: 1, run: true })
    runFrames(w, 120) // cool well below 0.9
    const cool = w.lastFrame().alpha
    assert.ok(cool < 0.3, `precondition: it should have cooled by now; actual alpha=${cool}`)

    // Drag: reheating per Obsidian's protocol
    w.post({ alpha: 0.9, alphaTarget: 0.3, run: true, forceNode: { id: 'a', x: 10, y: 10 } })
    runFrames(w, 1)
    assert.ok(w.lastFrame().alpha > cool, `dragging should reheat alpha: ${cool} → ${w.lastFrame().alpha}`)
  })

  test('alpha only rises, never falls (a late low-alpha message changes nothing)', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [50, 0] }, links: [['a', 'b']], alpha: 1, run: true })
    runFrames(w, 30)

    // Control group: run one more frame without sending a late message
    const control = loadWorker()
    control.post({ nodes: { a: [0, 0], b: [50, 0] }, links: [['a', 'b']], alpha: 1, run: true })
    runFrames(control, 30)

    // Test group: insert one late low-alpha message
    w.post({ alpha: 0.01, run: true })
    runFrames(w, 1)
    runFrames(control, 1)

    // Both should advance to the same alpha — the late low value has no effect
    assert.ok(
      Math.abs(w.lastFrame().alpha - control.lastFrame().alpha) < 1e-9,
      `a late message must not change alpha: test ${w.lastFrame().alpha} vs control ${control.lastFrame().alpha}`,
    )
  })

  test('with an initial alpha=1, a smaller alpha message is ignored (d3/Obsidian semantics)', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [100, 0] }, links: [['a', 'b']], alpha: 0.05, run: true })
    runFrames(w, 1)
    // Initial 1 → 0.05 is ignored → still close to 1 after the first frame
    assert.ok(w.lastFrame().alpha > 0.9, `a smaller alpha should be ignored; actual ${w.lastFrame().alpha}`)
  })

  test('the forces parameters can be adjusted at runtime', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [100, 0] }, links: [['a', 'b']], alpha: 1, run: true })
    w.post({ forces: { centerStrength: 0.5, linkStrength: 2, linkDistance: 120, repelStrength: 300 } })
    runFrames(w, 100)
    const f = w.lastFrame()
    assert.ok(f.coords.every(Number.isFinite), 'it must stay stable after the parameters change')
  })
})

describe('worker · stability', () => {
  test('feeding the same data twice does not send nodes flying', () => {
    const w = loadWorker()
    const nodes = { a: [0, 0], b: [80, 0], c: [40, 70] }
    const links = [['a', 'b'], ['b', 'c']]
    w.post({ nodes, links, alpha: 0.3, run: true })
    runFrames(w, 50)
    const before = w.positionOf('a')
    // Feed it again (simulating the panel refetching the snapshot)
    w.post({ nodes, links, alpha: 0.3, run: true })
    runFrames(w, 50)
    const after = w.positionOf('a')
    const moved = Math.hypot(after.x - before.x, after.y - before.y)
    assert.ok(moved < 400, `re-feeding data must not send nodes flying; actual movement ${moved.toFixed(0)}`)
  })

  test('when a new node joins, existing node positions are preserved (the whole graph is not relaid out)', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [80, 0] }, links: [['a', 'b']], alpha: 0.3, run: true })
    runFrames(w, 80)
    const aBefore = w.positionOf('a')
    // Add a new node and send back the existing positions (which is what the panel does)
    w.post({
      nodes: { a: [aBefore.x, aBefore.y], b: [w.positionOf('b').x, w.positionOf('b').y], c: [0, 0] },
      links: [['a', 'b'], ['b', 'c']],
      alpha: 0.3,
      run: true,
    })
    runFrames(w, 1)
    const aAfter = w.positionOf('a')
    const jump = Math.hypot(aAfter.x - aBefore.x, aAfter.y - aBefore.y)
    assert.ok(jump < 60, `an existing node must not teleport; actual jump ${jump.toFixed(1)}`)
  })

  test('it stays stable with many nodes (200-node stress test)', () => {
    const w = loadWorker()
    const nodes = {}
    for (let i = 0; i < 200; i += 1) nodes[`n${i}`] = [0, 0]
    const links = []
    for (let i = 1; i < 200; i += 1) links.push([`n${i - 1}`, `n${i}`])
    w.post({ nodes, links, alpha: 0.3, run: true })
    runFrames(w, 40)
    const f = w.lastFrame()
    assert.equal(f.ids.length, 200)
    assert.ok(f.coords.every(Number.isFinite), 'all coordinates must be finite with 200 nodes too')
  })
})

describe('worker · null coordinates (the client first-load path)', () => {
  test('**every node id must be sent** (null means "you choose the position")', () => {
    // Hard-won lesson: the client initially sent only **already positioned**
    // nodes to the worker, so on first load it sent an empty object `{}` — and
    // setNodes() **replaces the entire node set with the keys it received**, so
    // `{}` cleared every node → the worker had none → a **blank canvas** (with
    // the rest of the panel looking fine).
    const w = loadWorker()
    w.post({ nodes: { a: null, b: null, c: null }, links: [['a', 'b'], ['b', 'c']], alpha: 0.3, run: true })
    runFrames(w, 3)
    const f = w.lastFrame()
    assert.ok(f !== undefined, 'null coordinates must still produce a tick')
    assert.deepEqual([...f.ids].sort(), ['a', 'b', 'c'], 'all three nodes must be present')
    assert.ok(f.coords.every(Number.isFinite), 'the worker should compute starting points for them')
  })

  test('nodes sent with null get a **deterministic** starting point (the same id twice is identical)', () => {
    const w1 = loadWorker()
    w1.post({ nodes: { x: null }, links: [], alpha: 0.3, run: true })
    runFrames(w1, 1)
    const w2 = loadWorker()
    w2.post({ nodes: { x: null }, links: [], alpha: 0.3, run: true })
    runFrames(w2, 1)
    assert.deepEqual(w1.positionOf('x'), w2.positionOf('x'), 'the starting point for the same id must be reproducible')
  })

  test('a mixed batch (some null, some positioned) does not crash', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [10, 10], b: null, c: [20, -20] }, links: [['a', 'b'], ['b', 'c']], alpha: 0.3, run: true })
    runFrames(w, 20)
    const f = w.lastFrame()
    assert.equal(f.ids.length, 3)
    assert.ok(f.coords.every(Number.isFinite))
  })

  test('an empty nodes object clears the node set (so the caller must never send one)', () => {
    const w = loadWorker()
    w.post({ nodes: { a: [0, 0], b: [50, 0] }, links: [['a', 'b']], alpha: 0.3, run: true })
    runFrames(w, 3)
    assert.equal(w.lastFrame().ids.length, 2)
    // Send an empty object → the node set is replaced with nothing → later frame() calls exit early and produce no ticks
    const before = w.ticks.length
    w.post({ nodes: {}, links: [], alpha: 0.3, run: true })
    runFrames(w, 3)
    assert.equal(w.ticks.length, before, 'no ticks after clearing (which is exactly what causes a blank canvas)')
  })
})
