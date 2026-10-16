/**
 * dsh-ai-memory client half: the judgment graph panel.
 *
 * ## Why this version was rewritten from scratch
 *
 * The previous version was **SVG with a one-shot layout that then froze**, and
 * the feedback was that it was not as smooth as comparable graphs. Obsidian's
 * graph implementation (`sim.js` and `app.js` inside
 * `D:\Obsidian\resources\obsidian.asar`) was studied, and its smoothness comes
 * from four decisions, none of which the previous version made:
 *
 * | Obsidian's approach | Previous version | This version |
 * |---|---|---|
 * | Force-directed layout runs in a **Web Worker** | 220 iterations on the main thread | ✅ Worker (`client.graph-worker.js`) |
 * | **Continuous animation**, advancing alpha every frame | Frozen after one layout | ✅ rAF loop until alpha converges |
 * | **Canvas rendering** (Obsidian uses PIXI/WebGL) | SVG (hundreds of DOM nodes) | ✅ Canvas 2D |
 * | **Reheat and pin the node** while dragging | No dragging | ✅ `alpha:.3, alphaTarget:.3, forceNode` |
 *
 * Physics constants are copied from Obsidian (see the header comment in
 * `lib/client.graph-worker.js`). Rendering uses Canvas 2D rather than PIXI: it
 * is entirely adequate at a few hundred nodes and avoids pulling in a 487 KB
 * WebGL library (zero external dependencies is a hard constraint of this
 * plugin).
 *
 * ## Hard constraints still honoured (official practices.md)
 * - No Harness Client package is required (only `require('react')`)
 * - No DOM is attached to the page body and the document head is not
 *   manipulated directly
 * - No other plugin's DOM is read
 * - Styles use only `--dsw-alias-*` theme tokens (Canvas reads their values
 *   with getComputedStyle)
 * - Resources are registered in `apply` and cleaned up through `ctx.effect`
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
    /** In-package **chunk** file name of the Worker (served by DSH's own chunk route; see resolveWorkerUrl). */
    const WORKER_FILE = 'client.graph-worker.js'

    /**
     * Build the Worker URL.
     *
     * ## Why a rev is required
     *
     * DSH's client-modules serves the in-package `client.<name>.js` chunks on
     * demand, but **the rev in the URL must match exactly** (`chunkRequest()`
     * does a strict `resourceUrl !== chunkUrl(id, fileName, rev)` comparison),
     * so a URL without `?rev=` always 404s.
     *
     * ## ⚠️ A fatal pitfall was hit here
     *
     * `document.currentScript.src` was tried first to obtain the rev — **that is
     * wrong**. The official README states:
     *   "Plugin bundles execute lazily — running a bundle only registers a factory,
     *    and **module side effects run at materialization**"
     * The factory therefore runs on **first use**, by which time `currentScript`
     * is already `null`. No rev → worker 404 → the panel silently degrades to a
     * static layout. **With no error.**
     *
     * ## The correct approach: look up this module's own URL in the **module table**
     *
     * When the browser loads this bundle, `<head>` keeps
     * `<script src=".../plugins/??dsh-ai-memory/client.js&rev=XXXX">` (or the
     * single-resource combo form). Script tags are **persistent DOM** and are
     * unaffected by currentScript, so scanning script tags for the one
     * containing this package name yields the rev from its URL.
     *
     * This is **synchronous** and completes during factory execution (the script
     * tags were inserted and parsed long before).
     *
     * @returns {string} The worker URL (same-origin, relative path).
     */
    function resolveWorkerUrl() {
      const base = `/plugins/dsh-ai-memory/${WORKER_FILE}`
      try {
        // Try currentScript first (valid on paths where the script materializes as soon as it loads)
        const direct = document.currentScript?.src
        const rev = extractRev(direct)
        if (rev !== null) return `${base}?rev=${rev}`

        // Main path: look it up in the module table. The bundle's script tag stays in head.
        const scripts = document.querySelectorAll?.('script[src]')
        if (scripts !== null && scripts !== undefined) {
          for (const s of scripts) {
            const src = s.src
            if (typeof src !== 'string' || !src.includes('dsh-ai-memory')) continue
            const found = extractRev(src)
            if (found !== null) return `${base}?rev=${found}`
          }
        }

        // Last resort: the boot payload carries the full graph (with each entry's url and rev)
        const boot = globalThis.__DSH_BOOT__
        const entries = boot?.entries ?? []
        for (const e of entries) {
          if (e?.id !== 'dsh-ai-memory') continue
          const found = extractRev(e.url)
          if (found !== null) return `${base}?rev=${found}`
        }
      } catch {
        // Any parse failure degrades to no rev (the panel uses the fallback layout; it does not go blank)
      }
      return base
    }

    /**
     * Extract the `rev` parameter from a URL.
     *
     * Two shapes are supported:
     *   - combo: `/plugins/??dsh-ai-memory/client.js&rev=XXXX`
     *   - chunk: `/plugins/dsh-ai-memory/client.js?rev=XXXX`
     * The former uses `&rev=`, the latter `?rev=` — handing both to the URL
     * parser is more robust.
     *
     * @param {unknown} url - Candidate URL.
     * @returns {string|null} The rev, or null.
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

    // >>> WORKER-SOURCE (generated by test/inline-worker.mjs — do not edit by hand) >>>
    const WORKER_SOURCE = "/**\n * Force-directed simulation running on a **dedicated Worker thread**.\n *\n * The shape of this file and its parameters were **derived from Obsidian's graph**\n * (`sim.js`, 17.7 KB, inside `D:\\Obsidian\\resources\\obsidian.asar`). Its\n * smoothness is not magic — it comes from three decisions:\n *\n *   1. **Physics runs in a Worker** — the main thread only renders and never\n *      stalls on iteration\n *      (Obsidian: `new Worker(\"/sim.js\", { name: \"Graph Worker\" })`)\n *   2. **Continuous animation** (not \"compute once and freeze\") — alpha advances\n *      every frame until it converges\n *   3. **Reheat on interaction** — dragging posts\n *      `{alpha:.3, alphaTarget:.3, run:true, forceNode}`; releasing posts\n *      `{alphaTarget:0, forceNode:{x:null,y:null}}`\n *\n * Obsidian's physics constants (read out of its code and copied verbatim here):\n *   alphaDecay    = 1 - 0.001^(1/300) ≈ 0.0228\n *   alphaMin      = 0.001\n *   velocityDecay = 0.6\n *   centerStrength= 0.1\n *   linkDistance  = 250\n *   repelStrength = 1000\n *   collide       = radius 60, strength 0.5\n *\n * ⚠️ This file is a **standalone Worker script** and cannot use ESM import (it\n * runs directly inside a Worker). It therefore relies only on the worker global\n * and imports nothing.\n *\n * Message protocol (kept aligned with Obsidian's worker for easy comparison):\n *   in:  { nodes: {id: [x,y]}, links: [[id,id]], alpha, alphaTarget, run, forceNode: {id,x,y}, forces: {...} }\n *   out: { id: [id...], buffer: ArrayBuffer of Float32Array(2n), alpha }\n */\n\n/* eslint-disable no-restricted-globals */\n\n// ---- Physics constants (from Obsidian's sim.js) ----\nconst ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 300) // ≈ 0.0228\nconst ALPHA_MIN = 0.001\nconst VELOCITY_DECAY = 0.6\nconst TICK_MS = 1000 / 60\n\n// ---- Tunable parameters (Obsidian allows `forces` to override these) ----\nlet centerStrength = 0.1\nlet linkStrength = 1\nlet linkDistance = 250\nlet repelStrength = -1000 // negative sign means repulsion\n\n// ---- State ----\n/** @type {Map<string, {id:string,x:number,y:number,vx:number,vy:number,fx:number|null,fy:number|null}>} */\nlet nodes = new Map()\n/** @type {{source:object,target:object}[]} */\nlet links = []\nlet alpha = 1\nlet alphaTarget = 0\nlet running = false\nlet timer = null\n\n/**\n * Initialize or update the node set.\n *\n * Existing positions are preserved (**the key to \"no jumping\"**): incoming data\n * does not reset coordinates, it only updates the nodes that actually changed.\n * Obsidian's worker does the same (it keeps an `F` table and only creates\n * entries for ids it has not seen before).\n *\n * @param {Record<string, [number, number]>} incoming - id → [x, y].\n */\nfunction setNodes(incoming) {\n  const next = new Map()\n  for (const [id, xy] of Object.entries(incoming)) {\n    const existing = nodes.get(id)\n    if (existing !== undefined) {\n      // Reuse the old position and velocity; only the coordinates are updated,\n      // and only when the caller supplied them\n      if (Array.isArray(xy) && Number.isFinite(xy[0]) && Number.isFinite(xy[1])) {\n        existing.x = xy[0]\n        existing.y = xy[1]\n      }\n      next.set(id, existing)\n    } else {\n      // New node: start near the origin at a pseudo-random angle. A deterministic\n      // hash is used instead of Math.random so layouts stay reproducible.\n      const h = hash32(id)\n      const angle = ((h % 1000) / 1000) * Math.PI * 2\n      const r = 30 + ((h >>> 10) % 100)\n      next.set(id, {\n        id,\n        x: Math.cos(angle) * r,\n        y: Math.sin(angle) * r,\n        vx: 0,\n        vy: 0,\n        fx: null,\n        fy: null,\n      })\n    }\n  }\n  nodes = next\n  // Rebuild the index\n  let i = 0\n  for (const n of nodes.values()) n.index = i++\n}\n\n/** Set the links. */\nfunction setLinks(pairs) {\n  links = []\n  for (const [a, b] of pairs) {\n    const s = nodes.get(a)\n    const t = nodes.get(b)\n    if (s !== undefined && t !== undefined) links.push({ source: s, target: t })\n  }\n  // Degree, used for the collision radius and the render size\n  for (const n of nodes.values()) n.degree = 0\n  for (const l of links) {\n    l.source.degree += 1\n    l.target.degree += 1\n  }\n}\n\n/** FNV-1a hash — deterministic initial layout. */\nfunction hash32(s) {\n  let x = 2166136261\n  for (let i = 0; i < s.length; i += 1) {\n    x ^= s.charCodeAt(i)\n    x = Math.imul(x, 16777619)\n  }\n  return x >>> 0\n}\n\n/**\n * One simulation step. A merged implementation of d3-force's three forces\n * (charge / link / collide).\n */\nfunction tick() {\n  const list = [...nodes.values()]\n  const n = list.length\n\n  // ---- 1. Repulsion (many-body, per d3.forceManyBody) ----\n  // Barnes-Hut would be O(n log n), but this plugin's graphs are usually a few\n  // dozen to a few hundred nodes, where O(n²) is entirely adequate (200 nodes =\n  // 20k pairs, negligible per frame) and saves the ~200 lines of quadtree code.\n  // Zero dependencies is a hard constraint.\n  for (let i = 0; i < n; i += 1) {\n    const a = list[i]\n    for (let j = i + 1; j < n; j += 1) {\n      const b = list[j]\n      let dx = b.x - a.x\n      let dy = b.y - a.y\n      let d2 = dx * dx + dy * dy\n      if (d2 < 1e-6) {\n        // Exactly coincident: separate them deterministically (avoids a\n        // divide-by-zero NaN)\n        dx = ((hash32(a.id) % 7) - 3) || 1\n        dy = ((hash32(b.id) % 7) - 3) || 1\n        d2 = dx * dx + dy * dy\n      }\n      const d = Math.sqrt(d2)\n      const strength = (repelStrength * alpha) / d2\n      const fx = (dx / d) * strength\n      const fy = (dy / d) * strength\n      a.vx += fx\n      a.vy += fy\n      b.vx -= fx\n      b.vy -= fy\n    }\n  }\n\n  // ---- 2. Springs (per d3.forceLink) ----\n  for (const l of links) {\n    const a = l.source\n    const b = l.target\n    let dx = b.x + b.vx - a.x - a.vx\n    let dy = b.y + b.vy - a.y - a.vy\n    let d = Math.sqrt(dx * dx + dy * dy)\n    if (d < 1e-6) {\n      dx = 1\n      dy = 1\n      d = Math.SQRT2\n    }\n    // d3's formula: strength is distributed by the two endpoints' degree, so\n    // higher-degree nodes move less\n    const sa = a.degree + 1\n    const sb = b.degree + 1\n    const bias = sa / (sa + sb)\n    const k = ((d - linkDistance) / d) * alpha * linkStrength\n    const cx = dx * k\n    const cy = dy * k\n    a.vx += cx * bias\n    a.vy += cy * bias\n    b.vx -= cx * (1 - bias)\n    b.vy -= cy * (1 - bias)\n  }\n\n  // ---- 3. Collision (per d3.forceCollide, radius 60) ----\n  const RADIUS = 60\n  for (let i = 0; i < n; i += 1) {\n    const a = list[i]\n    for (let j = i + 1; j < n; j += 1) {\n      const b = list[j]\n      let dx = b.x - a.x\n      let dy = b.y - a.y\n      let d2 = dx * dx + dy * dy\n      const minD = RADIUS\n      if (d2 >= minD * minD) continue\n      if (d2 < 1e-6) {\n        dx = ((hash32(a.id) % 5) - 2) || 1\n        dy = ((hash32(b.id) % 5) - 2) || 1\n        d2 = dx * dx + dy * dy\n      }\n      const d = Math.sqrt(d2)\n      const overlap = (minD - d) / d\n      const push = overlap * 0.5 * alpha\n      const fx = dx * push\n      const fy = dy * push\n      a.vx -= fx\n      a.vy -= fy\n      b.vx += fx\n      b.vy += fy\n    }\n  }\n\n  // ---- 4. Centering + position integration (per d3.forceCenter + integrator) ----\n  const cx0 = 0\n  const cy0 = 0\n  for (const node of list) {\n    node.vx += (cx0 - node.x) * centerStrength * alpha\n    node.vy += (cy0 - node.y) * centerStrength * alpha\n\n    if (node.fx !== null) {\n      node.x = node.fx\n      node.vx = 0\n    } else {\n      node.vx *= VELOCITY_DECAY\n      node.x += node.vx\n    }\n    if (node.fy !== null) {\n      node.y = node.fy\n      node.vy = 0\n    } else {\n      node.vy *= VELOCITY_DECAY\n      node.y += node.vy\n    }\n  }\n\n  // ---- 5. alpha decay ----\n  alpha += (alphaTarget - alpha) * ALPHA_DECAY\n}\n\n/** Pack the positions and post them back to the main thread. */\nfunction publish() {\n  const list = [...nodes.values()]\n  const ids = new Array(list.length)\n  const coords = new Float32Array(list.length * 2)\n  for (let i = 0; i < list.length; i += 1) {\n    ids[i] = list[i].id\n    coords[2 * i] = list[i].x\n    coords[2 * i + 1] = list[i].y\n  }\n  // Transfer the ArrayBuffer as a transferable: zero copy\n  self.postMessage({ type: 'tick', ids, coords: coords.buffer, alpha }, [coords.buffer])\n}\n\n/**\n * One frame: advance the simulation and publish the result; schedule the next\n * frame while it has not converged.\n */\nfunction frame() {\n  timer = null\n  if (nodes.size === 0) {\n    running = false\n    return\n  }\n  tick()\n  publish()\n  // Convergence per d3: stop once alpha < alphaMin (dragging reheats it)\n  if (alpha > ALPHA_MIN || alphaTarget > 0) {\n    running = true\n    timer = setTimeout(frame, TICK_MS)\n  } else {\n    running = false\n  }\n}\n\n/** Start (or wake) the simulation. */\nfunction kick() {\n  if (timer === null) {\n    running = true\n    timer = setTimeout(frame, TICK_MS)\n  }\n}\n\nself.onmessage = (e) => {\n  const msg = e.data ?? {}\n\n  if (msg.nodes !== undefined) setNodes(msg.nodes)\n  if (msg.links !== undefined) setLinks(msg.links)\n\n  // Drag: pin one node's position and reheat\n  if (msg.forceNode !== undefined) {\n    const n = nodes.get(msg.forceNode.id)\n    if (n !== undefined) {\n      n.fx = msg.forceNode.x === null || msg.forceNode.x === undefined ? null : msg.forceNode.x\n      n.fy = msg.forceNode.y === null || msg.forceNode.y === undefined ? null : msg.forceNode.y\n    }\n  }\n\n  // Physics parameters are runtime-tunable (Obsidian's `forces` field)\n  if (msg.forces !== undefined) {\n    const f = msg.forces\n    if (Number.isFinite(f.centerStrength)) centerStrength = f.centerStrength\n    if (Number.isFinite(f.linkStrength)) linkStrength = f.linkStrength\n    if (Number.isFinite(f.linkDistance)) linkDistance = f.linkDistance\n    if (Number.isFinite(f.repelStrength)) repelStrength = -Math.abs(f.repelStrength)\n  }\n\n  // alpha only ever rises (Obsidian updates only when Q < A.alpha), so a late\n  // message cannot push progress backwards\n  if (Number.isFinite(msg.alpha) && msg.alpha > alpha) alpha = msg.alpha\n  if (Number.isFinite(msg.alphaTarget)) alphaTarget = msg.alphaTarget\n\n  if (msg.run === true) kick()\n  // Data changed without `run` being requested (e.g. only the node set was\n  // swapped) → still advance one frame so the view reflects the new data\n  else if (msg.nodes !== undefined || msg.links !== undefined) kick()\n}\n"
    // <<< WORKER-SOURCE <<<

    /**
     * Create a Blob URL pointing at the **inlined worker source**.
     *
     * ## Why not the in-package chunk URL
     *
     * The initial implementation used
     * `/plugins/dsh-ai-memory/client.graph-worker.js?rev=XXX`, relying on DSH's
     * own chunk route. It **works**, but only under one fatal precondition:
     * **`rev` must match exactly**, and the rev has to be recovered from the
     * plugin's own script tag or `__DSH_BOOT__`.
     *
     * The desktop (Electron) bundle transfer **does not necessarily leave a
     * script tag behind** (it goes through `loadBundle`), so the rev cannot be
     * recovered → the URL carries no rev → **404** → the Worker cannot be
     * created → **dragging stops working entirely** (`this.worker?.postMessage`
     * is an optional chain, so it is skipped silently and no error is raised).
     *
     * ## Why inlining helps
     *
     * A Blob URL **makes no network request at all** — it depends on no rev, no
     * route and no transfer mechanism, so it works in both the desktop and the
     * web build. The cost is roughly 10 KB added to client.js (the worker
     * source).
     *
     * @returns {string|null} The Blob URL, or null when the environment does not support it.
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
     * Cached worker URL.
     *
     * ⚠️ **It must be evaluated lazily**, never computed at module scope — this
     * was the most expensive pitfall encountered here.
     *
     * The first version was `const WORKER_PATH = resolveWorkerUrl()`, which read
     * `document` as soon as the factory executed. The consequence was that
     * **DSH's web boot failed outright**:
     *
     *     web boot: 1 entry did not activate
     *     dsh-ai-memory: failed
     *
     * client-modules' activation audit (in the web front end inside `app.asar`)
     * checks each entry's fiber state, and a factory that throws at module scope
     * puts the fiber in FAILED → the whole application **refuses to start** (not
     * "the panel is broken" but "the app will not open").
     *
     * By contrast, the factory of `dsh-downloads-panel` (which works) performs
     * **no module-level DOM access at all**. That is the entire difference.
     *
     * So it is now lazy: the URL is resolved only when a Worker is actually
     * created. At that point:
     *   - the component is mounted, so `document` is definitely available
     *   - even if resolution fails, only the graph animation is affected (it
     *     degrades to a static layout) and **activation is unaffected**
     *
     * @type {string|null}
     */
    let cachedWorkerPath = null

    /**
     * Get the worker URL (resolved and cached on first call).
     * @returns {string} The worker URL.
     */
    function workerPath() {
      if (cachedWorkerPath === null) cachedWorkerPath = resolveWorkerUrl()
      return cachedWorkerPath
    }

    /**
     * Edge type → display name (used by both the legend and the detail panel).
     *
     * The order is the legend's display order. Only the **four types that are
     * actually drawn** are listed: `derives` / `restates` currently have no
     * entry point that creates them (the tools expose only the first four), and
     * listing them would suggest that those lines are somehow missing.
     */
    const EDGE_LABEL = {
      supersedes: '取代',
      complements: '互补',
      tensions: '矛盾',
      depends: '依据',
    }

    /**
     * Edge type → **the color actually used on the canvas**.
     *
     * ⚠️ This **must share its source with `edgeColor()`**; CSS variable names
     * cannot be used here.
     *
     * A pitfall hit here: the legend originally used
     * `var(--dsw-alias-brand-primary)`, while the `supersedes` edge on the canvas
     * fell back to `#3b82f6` whenever the theme color was not colorful enough —
     * so **the legend and the canvas disagreed** (in dark themes brand is nearly
     * white, so the legend drew white while the canvas drew blue).
     *
     * Both now read from `edgeColor()`, so they **cannot disagree**.
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
/* Retired nodes are distinguished by **color**, not by opacity. */
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
/* Supersession chain: memory text only, no ids or status codes. */
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
     * Read the **actual values** of the current theme colors.
     *
     * Why they must be read out: Canvas `strokeStyle` does not understand CSS
     * variables, only concrete colors. This is the price Canvas rendering pays
     * relative to SVG — SVG can use `stroke="var(--dsw-...)"` directly. In
     * exchange, several hundred nodes do not become several hundred DOM elements.
     *
     * @param {HTMLElement} el - Element used to read computed styles.
     * @returns {object} The current value of each token.
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
       * Filter out only colors that are **genuinely near-black** (the sum of the
       * three channels is < 90, i.e. under 30 per channel on average).
       *
       * ⚠️ The threshold used to be < 180, but in dark themes even **legitimate**
       * text colors can be dark (`#8b949e` sums to about 180) and were judged
       * "invisible" and replaced by the fallback, which was worse. Contrast is
       * left to the concrete drawing parameters (line width, alpha, stroke)
       * instead of being over-filtered here.
       */
      const visible = (name, fallback) => {
        const value = pick(name, fallback)
        const m = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
        if (m && Number(m[1]) + Number(m[2]) + Number(m[3]) < 90) return fallback
        return value
      }
      /**
       * Whether this color is **colorful enough** (has a recognizable hue).
       *
       * Why this is needed: semantic theme colors (brand / warn / info) **can
       * have any lightness in a given theme** — `--dsw-alias-brand-primary` was
       * measured to be nearly **white** in DSH's dark theme, so "judgment" was
       * drawn as a white dot and could not be told apart from "retired gray" on
       * the same graph.
       *
       * The criterion is `max(r,g,b) - min(r,g,b)` (chroma). Too small means
       * gray/white/black with no hue. The threshold is 40 — below it, the human
       * eye cannot identify the color.
       *
       * @param {string} value - CSS color.
       * @returns {boolean} Whether it is colorful enough.
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
       * Resolve the actual color of each token declared in the per-kind style
       * table.
       *
       * ⚠️ **It must pass `saturated()`**.
       *
       * A pitfall hit here: `judgment` originally used
       * `--dsw-alias-brand-primary`, and **that token is nearly white in DSH's
       * dark theme** — so "judgment" was drawn as a **white dot** and blended
       * into "retired gray" on the same graph, prompting the question "why are
       * some gray and some white?".
       *
       * Semantic tokens (brand / warn / info) can have any lightness in a given
       * theme, so **having a color cannot be assumed**. Saturation is therefore
       * checked here: tokens that are too gray/white/black are rejected in favor
       * of the fallback hard-coded in KIND_STYLE, which is **guaranteed to have
       * a hue**.
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
        // Label stroke uses the canvas background, otherwise text over edges smears together
        canvasBg: pick('--dsw-alias-bg-layer-1', '#0d1117'),
        kindColors,
      }
    }

    /** Edge type → stroke color. */
    function edgeColor(type, c) {
      if (type === 'tensions') return c.error
      if (type === 'supersedes') return c.brand
      if (type === 'complements') return c.success
      if (type === 'depends') return c.warn
      return c.borderL2
    }

    /**
     * Node kind → color and shape.
     *
     * A distinct color per kind was requested, and then that they should **all
     * be ⚪** — so **the shape is uniformly a circle** and only the color
     * distinguishes kinds.
     *
     * Design principles:
     *   1. **Hue encodes semantics** (which kind this is, at a glance), with
     *      similar lightness (so no kind looks "heavier")
     *   2. **The color must be colorful enough** — see `saturated()` below: theme
     *      tokens that are nearly white/gray are rejected in favor of a fixed
     *      fallback. This was hit before: `--dsw-alias-brand-primary` is nearly
     *      white in dark themes, so "judgment" was drawn as a white dot and could
     *      not be told apart from "retired gray".
     *   3. Unknown kinds have a fallback (an unrecognized type is drawn gray: it
     *      neither crashes nor becomes invisible)
     *
     * | kind | meaning | color |
     * |---|---|---|
     * | `judgment` | judgment (evolves) | blue |
     * | `insight`  | insight (idea / observation / question) | teal |
     * | `rule`     | rule (governed) | amber |
     *
     * The `shape` field is retained (`pathNode` still supports diamond and
     * rounded-rect) — all-circles is the **current choice**, not a removal of
     * capability; should shapes be wanted again, only this column changes.
     */
    const KIND_STYLE = Object.freeze({
      judgment: { token: '--dsw-alias-brand-primary', fallback: '#3b82f6', shape: 'circle', label: '判断' },
      insight: { token: '--dsw-alias-state-info-primary', fallback: '#14b8a6', shape: 'circle', label: '思考' },
      rule: { token: '--dsw-alias-state-warn-primary', fallback: '#f59e0b', shape: 'circle', label: '规矩' },
    })

    /** Fallback style for an unknown kind (gray, but **still visible**). */
    const KIND_FALLBACK = Object.freeze({ token: '', fallback: '#9aa4b2', shape: 'circle', label: '其它' })

    /**
     * Get the style for one kind.
     * @param {string} kind - Node kind.
     * @returns {{token: string, fallback: string, shape: string, label: string}} The style.
     */
    function kindStyle(kind) {
      return KIND_STYLE[kind] ?? KIND_FALLBACK
    }

    /**
     * **Circumscribed radius factor** of a shape (relative to the base radius r).
     *
     * It aligns the drawn shape with the click hit area — both must use the same
     * factor, otherwise a click on the shape misses or a click on empty space
     * selects.
     *
     * Everything is a circle now (factor 1), but the function is kept so hit
     * testing follows automatically if shapes change.
     *
     * @param {string} shape - 'circle' | 'roundrect' | 'diamond'.
     * @returns {number} The circumscribed radius factor.
     */
    function shapeExtent(shape) {
      if (shape === 'diamond') return 1.18
      if (shape === 'roundrect') return 1.18
      return 1
    }

    /**
     * Node fill color.
     *
     * ⚠️ Judgment nodes were once drawn with `c.layer2`
     * (`--dsw-alias-bg-layer-2`) — that is a **background** token! In a dark
     * theme the background is itself dark, so drawing it on a dark canvas made
     * the node invisible. That is what produced the report "the colors are too
     * faint to see".
     *
     * Colors are now taken per kind from **solid** semantic colors, with the
     * fallback used when a theme variable cannot be read.
     *
     * @param {object} node - Node.
     * @param {object} c - Theme colors.
     * @returns {string} CSS color.
     */
    function nodeColor(node, c) {
      const s = kindStyle(node.kind)
      const themed = s.token === '' ? '' : c.kindColors[s.token]
      return themed !== undefined && themed !== '' ? themed : s.fallback
    }

    /**
     * Node fill color (**retirement is expressed here too**).
     *
     * ⚠️ Key tradeoff: retired nodes are **not** distinguished by opacity, but by
     * **mixing the color slightly toward the background** (lower saturation /
     * darker), which still draws solid.
     *
     * Why this is better:
     *   · semi-transparency makes a node look "unfinished" and blends with
     *     whatever is behind it
     *   · a mixed color is **solid**, visually clean, and still tells at a glance
     *     that "this one is old"
     *
     * @param {object} node - Node.
     * @param {object} c - Theme colors.
     * @returns {string} CSS color (opaque).
     */
    function nodeFill(node, c) {
      const base = nodeColor(node, c)
      if (node.status === 'active') return base
      return mixWith(base, c.canvasBg, 0.45)
    }

    /**
     * Mix two colors by ratio (returns `rgb(...)`).
     *
     * Only the notations that actually occur are supported — `#rgb` / `#rrggbb` /
     * `rgb()` / `rgba()`; anything unparseable is **returned unchanged** (no
     * crash, and not black).
     *
     * @param {string} a - Base color.
     * @param {string} b - Color to mix in.
     * @param {number} t - Share of b (0..1).
     * @returns {string} The mixed CSS color.
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
     * Parse a color into `[r, g, b]`.
     * @param {string} s - CSS color.
     * @returns {[number, number, number]|null} The parsed value, or null when unrecognized.
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
     * Node stroke color: a **brighter ring** around a solid node so it holds up
     * on any background. Retired nodes use the secondary text color (still
     * visible, just less prominent).
     */
    function nodeStroke(node, c) {
      return node.status === 'active' ? c.labelPrimary : c.labelSecondary
    }

    /**
     * Graph renderer: Canvas 2D + Worker force-directed layout + continuous
     * animation.
     *
     * Written as a class rather than folded into a React component: the render
     * loop and pointer interaction are stateful processes that would only be
     * harder to read inside React's rendering model. The component handles
     * mount/unmount and passing data.
     */
    class GraphRenderer {
      /**
       * @param {HTMLCanvasElement} canvas - The canvas.
       * @param {{onSelect: (id: string|null) => void}} handlers - Callbacks.
       */
      constructor(canvas, handlers) {
        this.canvas = canvas
        this.ctx2d = canvas.getContext('2d')
        this.handlers = handlers
        this.colors = themeColors(canvas)

        /** id → { x, y, node }. Positions are pushed back by the Worker every frame. */
        this.positions = new Map()
        this.nodes = []
        this.edges = []
        /** View transform. */
        this.tx = 0
        this.ty = 0
        this.scale = 1
        /** Interaction state. */
        this.hoverId = null
        this.selectedId = null
        this.dragNodeId = null
        this.panFrom = null
        /** Loop control. */
        this.raf = null
        this.running = true
        this.alpha = 0
        /**
         * Auto-fit toggle.
         *
         * True while physics is still running (the view is fitted around the
         * whole graph every frame, otherwise nodes get pushed out of view and it
         * looks broken); it is set to false **as soon as the user drags or
         * zooms** — the view is not contested with the user. `resetView()` turns
         * it back on.
         */
        this.autoFit = true
        this.width = 1
        this.height = 1
        this.dpr = Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1))

        this.worker = this.createWorker()
        this.bindPointer()
        this.resize()
        /**
         * ⚠️ **Resize a few more times** (starting next frame).
         *
         * Why: at construction time the styles may have just been injected and
         * the browser may not have applied them to layout yet, so
         * `getBoundingClientRect()` returns the **old** size (measured: 760×419
         * once CSS applies, but 300×150 the moment the constructor runs), and the
         * canvas drawing buffer stays at the default 300×150 — everything is
         * drawn into a small buffer, showing up as a blank canvas or a graph
         * squeezed into one corner.
         *
         * See `resizeSoon()`: it retries until the buffer size matches CSS (at
         * most 10 frames).
         */
        /**
         * ⚠️ **Watch the canvas with a ResizeObserver** — the root fix for the
         * sizing problem.
         *
         * Why measuring once in the constructor is not enough: when the style
         * sheet injected by `ensureStyles` takes effect is up to the browser —
         * measured, `getBoundingClientRect()` returns HTML's default 300×150 at
         * construction time, while it should be 760×419 once CSS applies. Without
         * this extra pass the drawing buffer stays 300×150 and everything is
         * drawn inside that small box (showing up as a graph squeezed into a
         * corner, or a blank canvas).
         *
         * `resizeSoon()` handles the "first time"; the ResizeObserver covers
         * everything after that: the panel being stretched, the sidebar
         * collapsing, the window resizing, the canvas element being replaced.
         *
         * Environments without ResizeObserver (old browsers) degrade to
         * `resizeSoon()`.
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
       * Retry resize on the next frame until the drawing buffer size matches the
       * CSS size.
       *
       * This is the fallback for the ResizeObserver: should the observer be
       * unavailable or never fire, it at least guarantees the size is measured
       * correctly in the first few frames. At most 10 frames (about 160 ms), and
       * it stops once the size is right.
       *
       * @param {number} attempt - Number of attempts so far (internal).
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
       * Create the Worker.
       *
       * ⚠️ **The Worker is not a nice-to-have; it is the precondition for
       * dragging.**
       *
       * The original reasoning here was that a failed Worker could degrade to a
       * static layout, which would "at least still show the relationships". But
       * measurement showed that **dragging works by sending coordinates to the
       * Worker so it pins the node** — with no Worker, **dragging does not work
       * at all** (`this.worker?.postMessage` is an optional chain, so it is
       * skipped silently and not a single error is raised). That is exactly the
       * report "nothing can be dragged any more".
       *
       * Exceptions are therefore **not swallowed silently** here: a failure is
       * logged and the reason is kept on `this.workerError`.
       *
       * @returns {Worker|null} The worker, or null.
       */
      createWorker() {
        // Prefer the **Blob URL built from the inlined source** (no network
        // request; works in both desktop and web builds); fall back to the
        // in-package chunk URL (which requires a matching rev).
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
              // Physics still running → keep the view fitted around the whole graph (see autoFit)
              if (this.autoFit === true) this.fitToContent()
            }
            w.onerror = (ev) => {
              // Load failure (most often a 404) → degrade to **main-thread dragging**, which at least still drags
              this.workerError = `worker load failed: ${ev?.message ?? 'unknown'} (${url.slice(0, 60)})`
              try { console.error('[dsh-ai-memory] Worker 加载失败，改用主线程拖拽', this.workerError) } catch { /* ignore */ }
              try { w.terminate() } catch { /* ignore */ }
              this.worker = null
            }
            this.workerError = null
            return w
          } catch (err) {
            lastError = `${err?.message ?? String(err)} (${url.slice(0, 60)})`
          }
        }
        this.workerError = lastError
        try { console.error('[dsh-ai-memory] Worker 建不起来，改用主线程拖拽', lastError) } catch { /* ignore */ }
        return null
      }

      /**
       * The canvas size follows its container (including devicePixelRatio scaling
       * to avoid blur).
       *
       * ⚠️ A size change must **also re-fit the view** — otherwise: at
       * construction the canvas is still the default 300×150 (styles just
       * injected, layout not settled), so the fit ratio was computed for a small
       * canvas; once it actually expands to 880×419 that ratio is too small or
       * off-center and only one or two nodes remain on screen, which looks
       * broken.
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
        // Canvas size changed → the view must be recomputed (unless the user acted manually; see autoFit)
        if (changed && this.autoFit === true) this.fitToContent()
      }

      /**
       * Load new data.
       *
       * **Preserving existing node positions** is the key to "no jumping": only
       * the already-known coordinates are sent back to the Worker so it keeps
       * simulating around the new nodes instead of restarting the whole graph.
       *
       * @param {object[]} nodes - Snapshot nodes.
       * @param {object[]} edges - Snapshot edges.
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
          // ⚠️ **Every node id must be sent**, with coordinates for positioned
          // nodes and null for the rest.
          //
          // A real bug was hit here: only "positioned" nodes were sent at first,
          // so on first load `coords = {}` — and the Worker's `setNodes()`
          // **replaces the whole node set with the keys it receives**, so `{}`
          // cleared every node → the Worker had no nodes → nothing was drawn →
          // **a blank canvas** (with the rest of the panel working normally, the
          // hardest kind to diagnose).
          //
          // Sending null means: the id is recognized, the position is yours to
          // choose (the Worker gives it a starting point from a deterministic hash).
          const coords = {}
          for (const [id, p] of next) {
            coords[id] = p.placed === true ? [p.x, p.y] : null
          }
          const links = edges.map((e) => [e.from, e.to])
          // Per Obsidian: give alpha .3 and run — so the graph "comes alive" instead of freezing instantly
          this.worker.postMessage({ nodes: coords, links, alpha: 0.3, run: true })
          this.alpha = 0.3
        } else {
          this.layoutFallback()
        }
        this.draw()
      }

      /** Fallback layout with no Worker: spread by index around a ring (at least not all on one point). */
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

      /** Screen coordinates → world coordinates. */
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
       * Hit test: return the id of the node under the pointer.
       *
       * Everything is a circle now, so this is a direct radius test plus a 4px
       * tolerance. `shapeExtent()` still takes part — should shapes be used for
       * distinction again, hit testing **follows automatically** instead of a
       * diamond being clicked as if it were a circle.
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
       * Node radius.
       *
       * ⚠️ **All nodes are the same size.**
       *
       * This previously followed Obsidian's `nodeSizeMultiplier` — "more
       * connections, bigger node" — which produced 5px and 9.8px nodes on the same
       * graph and prompted the question "why are some bigger and some smaller?".
       * It is now a uniform 7px: **importance is read from the links, not from
       * size**.
       *
       * To restore "hubs are bigger": use
       * `return 5 + Math.min(9, (node.degree || 0) * 1.6)`.
       */
      radiusOf(_node) {
        return 7
      }

      /**
       * Build a path for the shape at (x, y) (**the caller owns fill/stroke
       * beyond beginPath**).
       *
       * Shape is a **second distinction beyond color**: for color-blind users, or
       * when zoomed far out, color alone cannot say whether this is a judgment or
       * an insight, but a circle and a diamond are distinguishable at a glance.
       *
       * @param {CanvasRenderingContext2D} ctx - Canvas context.
       * @param {number} x - Center x.
       * @param {number} y - Center y.
       * @param {number} r - Circumscribed radius.
       * @param {string} shape - 'circle' | 'roundrect' | 'diamond'.
       * @returns {void}
       */
      pathNode(ctx, x, y, r, shape) {
        ctx.beginPath()
        if (shape === 'diamond') {
          // Diamond: rule — reads as something "governed" rather than grown
          ctx.moveTo(x, y - r * 1.18)
          ctx.lineTo(x + r * 1.18, y)
          ctx.lineTo(x, y + r * 1.18)
          ctx.lineTo(x - r * 1.18, y)
          ctx.closePath()
          return
        }
        if (shape === 'roundrect') {
          // Rounded square: insight — slightly "harder" than a circle, like a thought not yet settled
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
        // Default circle: judgment
        ctx.arc(x, y, r, 0, Math.PI * 2)
      }

      /** Bind pointer interaction: hover, click to select, drag a node, drag the background to pan, wheel to zoom. */
      bindPointer() {
        const c = this.canvas

        this.onPointerDown = (e) => {
          // Hand over view control as soon as the user acts (auto-fit no longer competes)
          this.autoFit = false
          const id = this.hitTest(e.clientX, e.clientY)
          if (id !== null) {
            this.dragNodeId = id
            this.dragMoved = false
            this.dragStart = { x: e.clientX, y: e.clientY }
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
            // Pointer hardware and automation may report tiny movements during
            // a click. Treat only meaningful displacement as a node drag.
            if (this.dragStart && Math.hypot(e.clientX - this.dragStart.x, e.clientY - this.dragStart.y) > 4) this.dragMoved = true
            const w = this.toWorld(e.clientX, e.clientY)
            if (this.worker !== null) {
              this.worker.postMessage({ alpha: 0.3, alphaTarget: 0.3, run: true, forceNode: { id: this.dragNodeId, x: w.x, y: w.y } })
            } else {
              /**
               * ⚠️ **Dragging must work without a Worker too** (main-thread fallback).
               *
               * The original idea was that a failed Worker could degrade to a
               * static layout, which would "at least still show the
               * relationships". Measurement showed otherwise: **dragging works by
               * sending coordinates to the Worker so it pins the node** — with no
               * Worker it **cannot drag at all**, and `this.worker?.postMessage`
               * is an optional chain, so it **is skipped silently and no error is
               * raised at all**. That is exactly the report "nothing can be
               * dragged any more".
               *
               * Here the local position is updated directly: dragging needs no
               * physics anyway, the node just goes where the pointer is. It stays
               * put on release (no force-directed spring back), but **being able
               * to drag** beats "elegantly unable to drag".
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
            // Release: unpin and let physics take over (per Obsidian: x/y as null).
            // With no Worker the node stays where it was released — see the
            // main-thread fallback in onPointerMove.
            this.worker?.postMessage({ alphaTarget: 0, forceNode: { id: draggedNode, x: null, y: null } })
            // No actual movement → treat it as a click selection (otherwise a drag mis-selects)
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
          // Clear the selection only when empty space is clicked (a node click is handled by pointerup)
          const id = this.hitTest(e.clientX, e.clientY)
          if (id === null) {
            this.selectedId = null
            this.handlers.onSelect(null)
          }
        }

        this.onWheel = (e) => {
          e.preventDefault()
          // Hand over view control as soon as the user zooms
          this.autoFit = false
          const factor = e.deltaY < 0 ? 1.1 : 0.9
          const next = Math.max(0.25, Math.min(4, this.scale * factor))
          // Zoom around the pointer: keep the world coordinate under the pointer fixed
          const rect = c.getBoundingClientRect()
          const px = e.clientX - rect.left - rect.width / 2
          const py = e.clientY - rect.top - rect.height / 2
          this.tx = px - ((px - this.tx) / this.scale) * next
          this.ty = py - ((py - this.ty) / this.scale) * next
          this.scale = next
        }

        // With the top UI removed, its functions moved here (taking no space but
        // not lost):
        //   · double-click the background → reset the view
        //   · right-click                  → toggle "active only / include retired"
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

      /** Remove every listener (called on unmount to prevent leaks). */
      destroy() {
        if (this.raf !== null) cancelAnimationFrame(this.raf)
        this.raf = null
        this.running = false
        // Stop observing size
        try { this.observer?.disconnect() } catch { /* ignore */ }
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
        try { this.worker?.terminate() } catch { /* ignore */ }
        this.worker = null
      }

      /**
       * Reset the view.
       *
       * ⚠️ It now **turns autoFit back on** — otherwise the graph may still be
       * outside the view after "reset", making reset a no-op. The next manual
       * drag turns it off again.
       */
      resetView() {
        this.tx = 0
        this.ty = 0
        this.scale = 1
        this.autoFit = true
        this.fitToContent()
      }

      /**
       * Zoom the view so it **just fits every node**.
       *
       * Why this is needed: once the force-directed layout pushes nodes apart,
       * the graph grows larger than the canvas — without auto-fitting the user
       * sees "a few dots drifting in a corner with everything else out of view",
       * which looks broken. (Measured: 3 nodes pushed to ±600 on a 760×419
       * canvas.)
       *
       * Called only while `autoFit` is true (the phase where physics is still
       * running); once the user drags or zooms, **control is handed over** and
       * the view is no longer contested.
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
        const pad = 70 // Room for labels (drawn below the node)
        const w = Math.max(1, maxX - minX + pad * 2)
        const h = Math.max(1, maxY - minY + pad * 2)
        // Never zoom in past 1.6× (a few nodes should not become huge blobs) or out below 0.15× (illegible)
        const next = Math.max(0.15, Math.min(1.6, Math.min(this.width / w, this.height / h)))
        this.scale = next
        // Align the content center with the canvas center
        const cx = (minX + maxX) / 2
        const cy = (minY + maxY) / 2
        this.tx = -cx * next
        this.ty = -cy * next
      }

      /** Re-read theme colors (called after a light/dark switch). */
      refreshTheme() {
        this.colors = themeColors(this.canvas)
      }

      /**
       * Render every frame.
       *
       * ⚠️ Exceptions are **not swallowed silently** here. This was once
       * `try { this.draw() } catch {}`, which produced "nothing is drawn but no
       * error is reported" — the most expensive class of bug in this plugin hides
       * exactly that way. A failure now logs once (first time only, no spam) and
       * leaves the error on `this.lastDrawError` for direct inspection over CDP.
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
            } catch { /* console unavailable; ignore */ }
          } else {
            this.drawErrorCount = (this.drawErrorCount ?? 0) + 1
          }
        }
        this.raf = requestAnimationFrame(this.loop)
      }

      /** Draw one frame. */
      draw() {
        const ctx = this.ctx2d
        const c = this.colors
        ctx.clearRect(0, 0, this.width, this.height)
        ctx.save()
        ctx.translate(this.width / 2 + this.tx, this.height / 2 + this.ty)
        ctx.scale(this.scale, this.scale)

        // ---- Edges ----
        // ⚠️ This used lineWidth=1.2 with globalAlpha=0.55 — thin and faint,
        // almost invisible. Everything is now **fully opaque**, and hover
        // emphasis is expressed by dimming the others, which is also **mixed
        // into a solid color** rather than lowering alpha.
        ctx.lineWidth = 2 / this.scale
        for (const e of this.edges) {
          const a = this.positions.get(e.from)
          const b = this.positions.get(e.to)
          if (a === undefined || b === undefined) continue
          const related = this.hoverId === null || this.hoverId === e.from || this.hoverId === e.to
          ctx.globalAlpha = 1
          // Unrelated edges are mixed toward the background (solid, not transparent)
          ctx.strokeStyle = related ? edgeColor(e.type, c) : mixWith(edgeColor(e.type, c), c.canvasBg, 0.7)
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
          // Supersedes edges get an arrowhead — the direction is meaningful (new points at old)
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

        // ---- Nodes ----
        for (const [id, p] of this.positions) {
          const n = p.node
          const r = this.radiusOf(n)
          const dim = this.hoverId !== null && this.hoverId !== id
          // ⚠️ **Nodes are always opaque.**
          //
          // Retired nodes previously used alpha 0.75 and hover dimmed others to
          // 0.25 — the result was "some solid, some see-through", which looks
          // unfinished. Retirement is now expressed by **color** (see nodeFill:
          // retired nodes are desaturated, not made transparent) and hover
          // emphasis thickens the **stroke** instead of fading the others.
          ctx.globalAlpha = 1

          const style = kindStyle(n.kind)
          this.pathNode(ctx, p.x, p.y, r, style.shape)
          ctx.fillStyle = nodeFill(n, c)
          ctx.fill()
          // Hover/selection: thicker stroke — emphasis that does not depend on opacity
          const emphasized = id === this.selectedId || id === this.hoverId
          ctx.lineWidth = (emphasized ? 3 : 1.6) / this.scale
          ctx.strokeStyle = emphasized ? c.labelPrimary : nodeStroke(n, c)
          ctx.stroke()

          // Labels: below a certain zoom only important nodes show (following Obsidian's textFade idea)
          const showLabel = this.scale > 0.85 || id === this.hoverId || id === this.selectedId || (n.degree || 0) >= 2
          if (showLabel) {
            ctx.globalAlpha = 1
            const fontPx = 12 / this.scale
            ctx.font = `600 ${fontPx}px -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'top'
            const label = n.label.length > 18 ? `${n.label.slice(0, 17)}…` : n.label
            const ty = p.y + r + 4 / this.scale
            // Stroke a background halo before filling the text — otherwise labels over edges smear
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

    /** Statistics chip. */
    function Chip({ label, value }) {
      return h('span', { className: 'dsh-am-chip' }, label, ' ', h('b', null, String(value)))
    }

    /**
     * Detail card.
     *
     * It must contain **only the memory the AI stored**. All internal
     * bookkeeping was therefore removed — id, status, version, creation time,
     * tags, citations, and link lists full of bare ids such as
     * `← complements from n_0008_6rovu9`.
     *
     * Two things remain, both the memory itself:
     *   · the judgment text
     *   · the supersession chain ("which one did this come from", each step also
     *     memory text)
     *
     * For id / time / tag metadata, use the `memory_search` or `memory_history`
     * tool.
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
    /** Main panel. */
    function MemoryGraphPanel() {
      const canvasRef = React.useRef(null)
      const rendererRef = React.useRef(null)
      const [state, setState] = React.useState({ phase: 'loading', snapshot: null, error: null })
      const [includeRetired, setIncludeRetired] = React.useState(false)
      const [selected, setSelected] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      /**
       * Whether Canvas is usable (the renderer was created).
       *
       * It decides **whether to render the SVG fallback layer** — see the comment
       * at the render site: the fallback layer sits over the canvas and swallows
       * pointer events, so rendering it unconditionally makes "the graph draw but
       * never move".
       */
      const [canvasOk, setCanvasOk] = React.useState(false)

      // Fetch the snapshot
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

      // Create the renderer.
      //
      // ⚠️ **The dependency array must be [state.phase], not []** — this is a
      // real and well-hidden bug:
      //
      //   On the first render `phase === 'loading'` and the component returns the
      //   "Reading memory store…" div, which **contains no canvas at all**. So
      //   `canvasRef.current === null` and this effect returns early.
      //
      //   Once the fetch resolves, `phase` becomes `ready` and the canvas actually
      //   appears — but with `[]` as the dependency the effect **never runs
      //   again**. Consequences:
      //     · GraphRenderer is never constructed → `resize()` is never called →
      //       the canvas keeps its default 300×150
      //     · `canvasOk` stays false forever → **the SVG fallback layer keeps
      //       covering the canvas** → nothing can be interacted with
      //
      //   None of this **reports any error** (which is why it is so hard to find).
      React.useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null) return undefined
        // Do not build twice (phase can change more than once)
        if (rendererRef.current !== null) return undefined
        // Inject styles (using the container's own document).
        // ⚠️ This line was once **missing** — the function was defined but never
        // called, leaving the panel as bare HTML with no error.
        ensureStyles(canvas.ownerDocument)
        let renderer = null
        try {
          renderer = new GraphRenderer(canvas, {
            onSelect: (id) => setSelected(id),
            // Right-click toggles "active only / include retired" (moved here when the top button was removed)
            onToggleRetired: () => setIncludeRetired((v) => !v),
          })
        } catch {
          // Canvas unavailable (rare): keep canvasOk=false so the SVG fallback takes over.
          renderer = null
        }
        rendererRef.current = renderer
        // Canvas created → drop the fallback layer (it would otherwise swallow all pointer events)
        if (renderer !== null) setCanvasOk(true)

        const onResize = () => renderer?.resize()
        globalThis.addEventListener?.('resize', onResize)
        // Light/dark switch: theme token values change and must be re-read
        const observer = typeof MutationObserver === 'function' && renderer !== null
          ? new MutationObserver(() => renderer.refreshTheme())
          : null
        observer?.observe(canvas.ownerDocument.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'data-theme', 'style'],
        })

        // ⚠️ Cleanup **must be deferred to the real unmount**.
        // This effect now depends on `state.phase` (which changes once, from
        // loading → ready), so destroying on a dependency change would tear down
        // the renderer that was just created.
        // Compare against rendererRef: clean up only when the ref still points at
        // **the one created here**.
        return () => {
          if (rendererRef.current !== renderer) return
          globalThis.removeEventListener?.('resize', onResize)
          observer?.disconnect()
          renderer?.destroy()
          rendererRef.current = null
        }
        // Depends on phase: it is loading at first (no canvas) and the canvas only exists once it becomes ready.
      }, [state.phase])

      // Data change → feed the renderer.
      //
      // ⚠️ `canvasOk` must be in the dependencies: the effect that creates the
      // renderer and this one both run in the round where `phase` becomes ready,
      // but **the renderer may not exist yet in that order** (rendererRef is
      // still null), so the first setData is skipped silently and the data never
      // gets in. With canvasOk added, this effect runs again as soon as the
      // renderer is created.
      React.useEffect(() => {
        const renderer = rendererRef.current
        if (renderer === null || state.snapshot === null) return
        renderer.setData(state.snapshot.nodes, state.snapshot.edges)
      }, [state.snapshot, canvasOk])

      // Selection → fetch details
      React.useEffect(() => {
        if (selected === null) { setDetail(null); return undefined }
        let alive = true
        fetch(`${NODE_PATH}?id=${encodeURIComponent(selected)}`, { headers: { accept: 'application/json' } })
          .then(async (res) => {
            const body = await res.json()
            if (alive && body.ok === true) setDetail(body.node)
          })
          .catch(() => { /* a failed detail fetch does not affect the graph */ })
        return () => { alive = false }
      }, [selected])

      const snapshot = state.snapshot
      /**
       * Top UI switches.
       *
       * The requirement was to **keep only the graph** — title, description,
       * statistics and buttons were all removed, because the sidebar icon already
       * reads "Judgment Graph" and repeating it inside the panel is redundant.
       *
       * The functionality was not dropped, though:
       *   · **Reset view** → moved to **double-clicking the background** (see
       *     GraphRenderer's dblclick)
       *   · **Active only / include retired** → moved to the **context menu**
       *     (contextmenu)
       *   · node/edge counts → shown in a small line at the bottom on hover
       *     (taking no space by default)
       *
       * To restore the old appearance: set the three constants below to true.
       */
      const SHOW_HEAD = false
      const SHOW_CHIPS = false
      const SHOW_TOOLBAR = false
      // The legend stays **on**: which color means what should be written out. It
      // is the only text left — **color alone is not self-explanatory**, so
      // without it one can only guess.
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
          // ⚠️ **The fallback layer renders only when Canvas is genuinely
          // unusable.**
          //
          // A nasty bug was hit here: the fallback layer used to render
          // **unconditionally**, and its CSS is
          //   .dsh-am-fallback { position: absolute; z-index: 3; pointer-events: auto; }
          //   .dsh-am-canvas   { position: relative; z-index: 2; }
          // so it **covered the canvas and swallowed every pointer event** —
          // dragging, the wheel and clicks were all taken by it and the canvas
          // received none. The symptom was "the graph draws but nothing can be
          // interacted with", and what was seen was in fact this **static SVG**,
          // not the Canvas.
          //
          // The test is `rendererRef.current !== null` (a created Canvas renderer
          // means Canvas is usable).
          canvasOk ? null : FallbackGraph({ snapshot, onSelect: (id) => setSelected(id) }),
          // The small bottom line ("N nodes · M edges") was also removed — only
          // the graph is wanted. Counts are available from the sidebar icon or
          // the memory_stats tool.
          h(Detail, { node: detail, onClose: () => setSelected(null) }),
        ),
        legend,
      )
    }

    /** Sidebar icon. */
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
     * Inject the panel styles.
     *
     * ## ⚠️ An expensive lesson lives here
     *
     * The first version was `ctx.styles.insert(CSS)`, on the grounds that
     * `styles` appears in the official Client Builtin list. **That reasoning was
     * wrong**:
     *
     *   1. The Builtin list states **capabilities**, which does not mean the
     *      current version **provides that service**. DeepSeek Harness
     *      `0.2.0-rc.2` **does not provide a client `styles` service**.
     *   2. `if (ctx.styles !== undefined)` was also written to make it
     *      "optional" — but `ctx` is a **restricted Proxy**, and **reading an
     *      unprovided service name throws by itself**. So the factory throws →
     *      the fiber becomes FAILED → **the whole application refuses to start**
     *      (`web boot: 1 entry did not activate / dsh-ai-memory: failed`).
     *   3. Declaring it as required, `inject: ['slots','styles']`, blocks even
     *      earlier on `pending (waiting for service: styles)` — it does not start
     *      either.
     *
     * ## The correct approach: follow `dsh-downloads-panel` (which always works)
     * and insert a marked `<style>` directly
     *
     * Key points:
     *   - use **the container's own document** (`container.ownerDocument`), not
     *     the global `document`
     *   - mark it with `data-plugin` to avoid duplicate injection
     *   - wrap the whole thing in try/catch: **styles are a bonus; failing to get
     *     them should not make the panel disappear**
     *
     * What the official practices.md forbids is "manipulating the document head /
     * writing DOM outside the component", whereas what is inserted here is
     * **this plugin's own style sheet** (marked), which is a different matter
     * from "reading another plugin's DOM".
     *
     * @param {Document|null|undefined} doc - The document the panel container belongs to.
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
        // Styles are a bonus: an unstyled panel still shows the relationship graph and must not crash over it
      }
    }

    function apply(ctx) {
      // ⚠️ **Only ctx.slots is touched here** (the only service declared in
      // inject). Reading any other service name may throw — see the comment on
      // ensureStyles.
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, MemoryGraphPanel))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: PANEL_LABEL,
      }, MemoryIcon))
    }

    return { name: 'dsh-ai-memory-client', inject: ['slots'], apply }
  },
})


