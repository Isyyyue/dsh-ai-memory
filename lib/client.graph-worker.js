/**
 * Force-directed simulation running on a **dedicated Worker thread**.
 *
 * The shape of this file and its parameters were **derived from Obsidian's graph**
 * (`sim.js`, 17.7 KB, inside `D:\Obsidian\resources\obsidian.asar`). Its
 * smoothness is not magic — it comes from three decisions:
 *
 *   1. **Physics runs in a Worker** — the main thread only renders and never
 *      stalls on iteration
 *      (Obsidian: `new Worker("/sim.js", { name: "Graph Worker" })`)
 *   2. **Continuous animation** (not "compute once and freeze") — alpha advances
 *      every frame until it converges
 *   3. **Reheat on interaction** — dragging posts
 *      `{alpha:.3, alphaTarget:.3, run:true, forceNode}`; releasing posts
 *      `{alphaTarget:0, forceNode:{x:null,y:null}}`
 *
 * Obsidian's physics constants (read out of its code and copied verbatim here):
 *   alphaDecay    = 1 - 0.001^(1/300) ≈ 0.0228
 *   alphaMin      = 0.001
 *   velocityDecay = 0.6
 *   centerStrength= 0.1
 *   linkDistance  = 250
 *   repelStrength = 1000
 *   collide       = radius 60, strength 0.5
 *
 * ⚠️ This file is a **standalone Worker script** and cannot use ESM import (it
 * runs directly inside a Worker). It therefore relies only on the worker global
 * and imports nothing.
 *
 * Message protocol (kept aligned with Obsidian's worker for easy comparison):
 *   in:  { nodes: {id: [x,y]}, links: [[id,id]], alpha, alphaTarget, run, forceNode: {id,x,y}, forces: {...} }
 *   out: { id: [id...], buffer: ArrayBuffer of Float32Array(2n), alpha }
 */

/* eslint-disable no-restricted-globals */

// ---- Physics constants (from Obsidian's sim.js) ----
const ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 300) // ≈ 0.0228
const ALPHA_MIN = 0.001
const VELOCITY_DECAY = 0.6
const TICK_MS = 1000 / 60

// ---- Tunable parameters (Obsidian allows `forces` to override these) ----
let centerStrength = 0.1
let linkStrength = 1
let linkDistance = 250
let repelStrength = -1000 // negative sign means repulsion

/**
 * Minimum distance for the repulsion force, per d3's `forceManyBody.distanceMin`
 * and Obsidian's `.distanceMin(30)`.
 *
 * ⚠️ Without this the layout jitters, and the cause is arithmetic, not taste:
 * the force is `strength / d²`, so at d=1 it is 1000 while at d=30 it is 1.11.
 * d3 clamps by replacing `d²` with `sqrt(distanceMin² · d²)` — a linear ramp —
 * which caps the near-field force at `strength / (distanceMin · d)`.
 *
 * Measured against Obsidian's sim.js (alpha = 1, repelStrength = -1000):
 *
 *     d=1    ours 1000.00  vs obsidian 33.33   →  30× too strong
 *     d=2    ours  250.00  vs obsidian 16.67   →  15× too strong
 *     d=5    ours   40.00  vs obsidian  6.67   →   6× too strong
 *     d=20   ours    2.50  vs obsidian  1.67   →  1.5× too strong
 *     d=30+  identical
 *
 * Two nodes that drift close are therefore blasted apart by hundreds of times
 * the intended force, which reads as shimmer. The clamp removes it.
 */
const REPEL_DISTANCE_MIN = 30

// ---- State ----
/** @type {Map<string, {id:string,x:number,y:number,vx:number,vy:number,fx:number|null,fy:number|null}>} */
let nodes = new Map()
/** @type {{source:object,target:object}[]} */
let links = []
let alpha = 1
let alphaTarget = 0
let running = false
let timer = null

/**
 * Initialize or update the node set.
 *
 * Existing positions are preserved (**the key to "no jumping"**): incoming data
 * does not reset coordinates, it only updates the nodes that actually changed.
 * Obsidian's worker does the same (it keeps an `F` table and only creates
 * entries for ids it has not seen before).
 *
 * @param {Record<string, [number, number]>} incoming - id → [x, y].
 */
function setNodes(incoming) {
  const next = new Map()
  for (const [id, xy] of Object.entries(incoming)) {
    const existing = nodes.get(id)
    if (existing !== undefined) {
      // Reuse the old position and velocity; only the coordinates are updated,
      // and only when the caller supplied them
      if (Array.isArray(xy) && Number.isFinite(xy[0]) && Number.isFinite(xy[1])) {
        existing.x = xy[0]
        existing.y = xy[1]
      }
      next.set(id, existing)
    } else {
      // New node: start near the origin at a pseudo-random angle. A deterministic
      // hash is used instead of Math.random so layouts stay reproducible.
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
  // Rebuild the index
  let i = 0
  for (const n of nodes.values()) n.index = i++
}

/** Set the links. */
function setLinks(pairs) {
  links = []
  for (const [a, b] of pairs) {
    const s = nodes.get(a)
    const t = nodes.get(b)
    if (s !== undefined && t !== undefined) links.push({ source: s, target: t })
  }
  // Degree, used for the collision radius and the render size
  for (const n of nodes.values()) n.degree = 0
  for (const l of links) {
    l.source.degree += 1
    l.target.degree += 1
  }
}

/** FNV-1a hash — deterministic initial layout. */
function hash32(s) {
  let x = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    x ^= s.charCodeAt(i)
    x = Math.imul(x, 16777619)
  }
  return x >>> 0
}

/**
 * One simulation step. A merged implementation of d3-force's three forces
 * (charge / link / collide).
 */
function tick() {
  const list = [...nodes.values()]
  const n = list.length

  // ---- 1. Repulsion (many-body, per d3.forceManyBody) ----
  // Barnes-Hut would be O(n log n), but this plugin's graphs are usually a few
  // dozen to a few hundred nodes, where O(n²) is entirely adequate (200 nodes =
  // 20k pairs, negligible per frame) and saves the ~200 lines of quadtree code.
  // Zero dependencies is a hard constraint.
  for (let i = 0; i < n; i += 1) {
    const a = list[i]
    for (let j = i + 1; j < n; j += 1) {
      const b = list[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let d2 = dx * dx + dy * dy
      if (d2 < 1e-6) {
        // Exactly coincident: separate them deterministically (avoids a
        // divide-by-zero NaN)
        dx = ((hash32(a.id) % 7) - 3) || 1
        dy = ((hash32(b.id) % 7) - 3) || 1
        d2 = dx * dx + dy * dy
      }
      const d = Math.sqrt(d2)
      // d3's near-field clamp: below distanceMin, use a linear ramp instead of
      // inverse-square. See REPEL_DISTANCE_MIN for the measured reason.
      const min2 = REPEL_DISTANCE_MIN * REPEL_DISTANCE_MIN
      const eff = d2 < min2 ? Math.sqrt(min2 * d2) : d2
      const strength = (repelStrength * alpha) / eff
      const fx = (dx / d) * strength
      const fy = (dy / d) * strength
      a.vx += fx
      a.vy += fy
      b.vx -= fx
      b.vy -= fy
    }
  }

  // ---- 2. Springs (per d3.forceLink) ----
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
    // d3's formula, and the strength matters as much as the bias.
    //
    // ⚠️ Two corrections against Obsidian's `forceLink()`:
    //
    //   1. **Strength is `1 / min(degA, degB)`, not a constant 1.** d3's default
    //      is `count => 1 / Math.min(count[source], count[target])`. With a
    //      constant, a hub joined to 20 links is pulled 20× harder than
    //      Obsidian would pull it (measured: deg 20/20 at d=100 gives 1.5 here
    //      versus 0.075 there), so hubs collapse toward the centre and drag
    //      their neighbours into a clump.
    //   2. **Bias uses raw degrees, not `deg + 1`.** d3 computes
    //      `count[source] / (count[source] + count[target])`, which moves the
    //      *lower*-degree end more. The `+1` version inverted that direction.
    const sa = a.degree
    const sb = b.degree
    // Both endpoints isolated (a self-standing edge): fall back to 1 so the
    // spring still has some effect rather than dividing by zero.
    const degMin = Math.min(sa, sb) || 1
    const bias = sa + sb === 0 ? 0.5 : sa / (sa + sb)
    const k = ((d - linkDistance) / d) * alpha * linkStrength / degMin
    const cx = dx * k
    const cy = dy * k
    a.vx += cx * bias
    a.vy += cy * bias
    b.vx -= cx * (1 - bias)
    b.vy -= cy * (1 - bias)
  }

  // ---- 3. Collision (per d3.forceCollide, with an anisotropic radius) ----
  /**
   * Collision radii.
   *
   * ⚠️ A single isotropic radius is the wrong shape for this graph. Nodes are
   * 7px circles but their labels are horizontal strips roughly 22 characters
   * (≈220px) wide and one line tall. Reserving a circle big enough for the
   * label width would push nodes ~220px apart in *both* axes, wasting the
   * vertical space where nothing is drawn; reserving a circle sized for the
   * node alone lets labels overlap, which is what "the graph is a mess" looked
   * like.
   *
   * So the separation is elliptical: wide horizontally (label width) and short
   * vertically (label height). d3 has no built-in for this, but the collide
   * step only needs a distance test, so scaling one axis before the test is
   * enough.
   *
   * Values are in world units and are deliberately conservative — a label that
   * slightly overlaps its neighbour's *empty* half is fine, a label covering
   * another label is not.
   */
  const COL_NODE = 26 // node-to-node minimum, keeps circles from touching
  /**
   * Half-width reserved for a label, horizontally.
   *
   * ⚠️ Measured, not guessed. With labels averaging 21 characters at
   * 12px/scale, the world-space width is ≈158 units, so half is ≈79. The
   * earlier value of 118 was already wider than needed, yet the graph still
   * looked crowded — because at scale 1.6 (the fitToContent cap) a 158-unit
   * label occupies ≈250 screen pixels, and 31 of those cannot fit side by side
   * in a 1400px canvas no matter how the forces are tuned.
   *
   * So the radius is set slightly *above* the measured half-width: the point is
   * not to eliminate overlap at every zoom, it is to make the layout expand
   * until the labels have room, and let zoom handle the rest. 92 gives a small
   * margin over the measured 79 without inflating the vertical spread.
   */
  const COL_LABEL_W = 92
  const COL_LABEL_H = 30 // node radius plus one line of text, vertically
  for (let i = 0; i < n; i += 1) {
    const a = list[i]
    for (let j = i + 1; j < n; j += 1) {
      const b = list[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      if (dx * dx + dy * dy < 1e-6) {
        dx = ((hash32(a.id) % 5) - 2) || 1
        dy = ((hash32(b.id) % 5) - 2) || 1
      }
      // Normalise into a space where the ellipse becomes a unit circle, test
      // there, then push back out along the original direction.
      const nx = dx / COL_LABEL_W
      const ny = dy / COL_LABEL_H
      const dist = Math.sqrt(nx * nx + ny * ny)
      if (dist >= 1) continue
      const overlap = (1 - dist) / (dist || 1)
      const push = overlap * 0.5 * alpha
      const fx = dx * push * 0.5
      const fy = dy * push
      a.vx -= fx
      a.vy -= fy
      b.vx += fx
      b.vy += fy
    }
  }

  // Node-to-node minimum on top, so small circles never sit on top of each other
  // even when their labels point in opposite directions.
  for (let i = 0; i < n; i += 1) {
    const a = list[i]
    for (let j = i + 1; j < n; j += 1) {
      const b = list[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let d2 = dx * dx + dy * dy
      if (d2 >= COL_NODE * COL_NODE) continue
      if (d2 < 1e-6) {
        dx = ((hash32(a.id) % 5) - 2) || 1
        dy = ((hash32(b.id) % 5) - 2) || 1
        d2 = dx * dx + dy * dy
      }
      const d = Math.sqrt(d2)
      const overlap = (COL_NODE - d) / d
      const push = overlap * 0.5 * alpha
      const fx = dx * push
      const fy = dy * push
      a.vx -= fx
      a.vy -= fy
      b.vx += fx
      b.vy += fy
    }
  }

  // ---- 4. Centering + position integration (per d3.forceCenter + integrator) ----
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

  // ---- 5. alpha decay ----
  alpha += (alphaTarget - alpha) * ALPHA_DECAY
}

/** Pack the positions and post them back to the main thread. */
function publish() {
  const list = [...nodes.values()]
  const ids = new Array(list.length)
  const coords = new Float32Array(list.length * 2)
  for (let i = 0; i < list.length; i += 1) {
    ids[i] = list[i].id
    coords[2 * i] = list[i].x
    coords[2 * i + 1] = list[i].y
  }
  // Transfer the ArrayBuffer as a transferable: zero copy
  self.postMessage({ type: 'tick', ids, coords: coords.buffer, alpha }, [coords.buffer])
}

/**
 * One frame: advance the simulation and publish the result; schedule the next
 * frame while it has not converged.
 */
function frame() {
  timer = null
  if (nodes.size === 0) {
    running = false
    return
  }
  tick()
  publish()
  // Convergence per d3: stop once alpha < alphaMin (dragging reheats it)
  if (alpha > ALPHA_MIN || alphaTarget > 0) {
    running = true
    timer = setTimeout(frame, TICK_MS)
  } else {
    running = false
  }
}

/** Start (or wake) the simulation. */
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

  // Drag: pin one node's position and reheat
  if (msg.forceNode !== undefined) {
    const n = nodes.get(msg.forceNode.id)
    if (n !== undefined) {
      n.fx = msg.forceNode.x === null || msg.forceNode.x === undefined ? null : msg.forceNode.x
      n.fy = msg.forceNode.y === null || msg.forceNode.y === undefined ? null : msg.forceNode.y
    }
  }

  // Physics parameters are runtime-tunable (Obsidian's `forces` field)
  if (msg.forces !== undefined) {
    const f = msg.forces
    if (Number.isFinite(f.centerStrength)) centerStrength = f.centerStrength
    if (Number.isFinite(f.linkStrength)) linkStrength = f.linkStrength
    if (Number.isFinite(f.linkDistance)) linkDistance = f.linkDistance
    if (Number.isFinite(f.repelStrength)) repelStrength = -Math.abs(f.repelStrength)
  }

  // alpha only ever rises (Obsidian updates only when Q < A.alpha), so a late
  // message cannot push progress backwards
  if (Number.isFinite(msg.alpha) && msg.alpha > alpha) alpha = msg.alpha
  if (Number.isFinite(msg.alphaTarget)) alphaTarget = msg.alphaTarget

  if (msg.run === true) kick()
  // Data changed without `run` being requested (e.g. only the node set was
  // swapped) → still advance one frame so the view reflects the new data
  else if (msg.nodes !== undefined || msg.links !== undefined) kick()
}
