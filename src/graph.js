/**
 * 图谱快照：把 fold 出来的状态转成客户端画图需要的最小结构。
 *
 * 设计依据（社区与官方的一致结论）：
 *   graph-memory 的文档写明 —— **图谱节点只做导航，不做事实载荷**：
 *     "Summary, SPO, and communities only navigate; original question and final
 *      answer remain the evidence."
 *   官方 practices.md 也要求：派生的视图应由 Host 算好再交给 Client，
 *     "The value reaches the Client already computed; the Client does not fold
 *      session events itself."
 *
 * 所以本模块**只输出节点与边**（含状态、度数、少量摘要），不输出正文全文 ——
 * 正文按需由 memory_search / memory_history 取。这样图谱再大也不会撑爆上下文或传输。
 *
 * 同时它也是"可解释性界面"的数据源：每个节点带 status / supersededBy / 度数，
 * 于是能看出"这条想法被谁取代了、它连着什么"。
 */

import { activeNodes, supersedeChain, backlinksOf, outlinksOf, STATUS, KIND } from './ledger.js'
import { summarize } from './query.js'

/**
 * 构建图谱快照。
 *
 * @param {object} state - fold 后的状态。
 * @param {{includeRetired?: boolean, maxNodes?: number}} [opts] - 选项。
 * @returns {object} `{ nodes, edges, stats, truncated }`。
 */
export function buildSnapshot(state, opts = {}) {
  const includeRetired = opts.includeRetired === true
  const maxNodes = Number.isInteger(opts.maxNodes) && opts.maxNodes > 0 ? opts.maxNodes : 500

  const active = activeNodes(state)

  /**
   * 选点策略。
   *
   * ## 默认：**只画活跃的**（主人明确要求"退役的就直接消失"）
   *
   * 图是"我现在相信什么"，不是"我历史上想过什么"。
   * 退役的（被取代 / 自己撤回）默认**完全不画** —— 干净、不干扰。
   *
   * ## `?retired=1` 时才把退役的也带出来（含取代链）
   *
   * 那时候要的是"进化史"：一条判断被推翻过几次、怎么变的。
   * 沿 `supersedes` 边（`from` = 新的 → `to` = 被取代的旧的）逐代回追，
   * 把整条来路都带上。
   *
   * ## ⚠️ 本鲸在这上面反复过两次，记下来免得再来
   *
   * 1. **曾经只取活跃** → 因为每条 `supersedes` 边都指向退役节点，
   *    把退役滤掉就等于**把所有边都滤掉**，得到「3 节点 · 0 连线」的空白图。
   * 2. 于是本鲸改成**默认就带上取代链** → 图能看了，但满屏灰点，
   *    主人问「为什么有灰的有白的」。
   * 3. **最终（主人定的）**：默认**只画活跃**，退役的想看得主动要（右键切换）。
   *    灰点不再混在默认视图里。
   */
  const byId = state.nodes
  const chainIds = new Set()
  if (includeRetired) {
    for (const n of active) {
      const seen = new Set([n.id])
      let frontier = [n.id]
      while (frontier.length > 0) {
        const next = []
        for (const fromId of frontier) {
          for (const e of state.edges) {
            // 方向：from 是新的，to 是它取代掉的旧的 → 顺着 from 往下追
            if (e.type !== 'supersedes' || e.from !== fromId) continue
            if (seen.has(e.to)) continue
            seen.add(e.to)
            chainIds.add(e.to)
            next.push(e.to)
          }
        }
        frontier = next
      }
    }
  }

  const pool = includeRetired
    ? [...state.nodes.values()]
    : [...active, ...[...chainIds].map((id) => byId.get(id)).filter((n) => n !== undefined)]

  // 稳定排序：新建的靠前，这样面板上先看到最近的想法。
  pool.sort((a, b) => b.createdAt - a.createdAt || String(a.id).localeCompare(String(b.id)))

  const truncated = pool.length > maxNodes
  const chosen = pool.slice(0, maxNodes)
  const chosenIds = new Set(chosen.map((n) => n.id))

  // 度数：一眼看出哪条判断是枢纽、哪条是孤岛。
  const degree = new Map()
  for (const e of state.edges) {
    if (!chosenIds.has(e.from) || !chosenIds.has(e.to)) continue
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1)
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1)
  }

  const nodes = chosen.map((n) => ({
    id: n.id,
    // 摘要而非全文：图谱是导航层，正文按需取。
    label: summarize(n.text, 60),
    kind: n.kind,
    status: n.status,
    degree: degree.get(n.id) ?? 0,
    createdAt: n.createdAt,
    revision: n.revision,
    ...(n.supersededBy !== null ? { supersededBy: n.supersededBy } : {}),
    ...(n.subject !== null ? { subject: n.subject } : {}),
    ...(n.relation !== null ? { relation: n.relation } : {}),
    ...(n.object !== null ? { object: n.object } : {}),
  }))

  const edges = state.edges
    .filter((e) => chosenIds.has(e.from) && chosenIds.has(e.to))
    .map((e) => ({ from: e.from, to: e.to, type: e.type }))

  return {
    nodes,
    edges,
    stats: countStats(state, nodes, edges),
    truncated,
  }
}

/**
 * 统计。面板顶部与 /stats 路由共用。
 *
 * @param {object} state - 状态。
 * @param {object[]} [nodes] - 已裁剪的节点（省略则重算）。
 * @param {object[]} [edges] - 已裁剪的边（省略则重算）。
 * @returns {object} 统计对象。
 */
export function countStats(state, nodes, edges) {
  const all = [...state.nodes.values()]
  const active = activeNodes(state)
  const connected = new Set()
  for (const e of state.edges) {
    connected.add(e.from)
    connected.add(e.to)
  }
  return {
    nodes: nodes === undefined ? all.length : nodes.length,
    edges: edges === undefined ? state.edges.length : edges.length,
    active: active.length,
    retired: all.filter((n) => n.status !== STATUS.ACTIVE).length,
    judgments: active.filter((n) => n.kind === KIND.JUDGMENT).length,
    rules: active.filter((n) => n.kind === KIND.RULE).length,
    insights: active.filter((n) => n.kind === KIND.INSIGHT).length,
    orphans: active.filter((n) => !connected.has(n.id)).length,
    problems: state.problems.length,
  }
}

/**
 * 单条判断的详情（供面板点击时展示）。
 *
 * @param {object} state - 状态。
 * @param {string} id - 节点 id。
 * @returns {object|null} 详情；找不到返回 null。
 */
export function nodeDetail(state, id) {
  const n = state.nodes.get(id)
  if (n === undefined) return null
  const { chain } = supersedeChain(state, id)
  return {
    id: n.id,
    text: n.text,
    kind: n.kind,
    status: n.status,
    revision: n.revision,
    createdAt: n.createdAt,
    validFrom: n.validFrom,
    validTo: n.validTo,
    supersededBy: n.supersededBy,
    tags: n.tags,
    citations: n.citations,
    // 反链是"可解释性"的核心：谁引用了我。
    backlinks: backlinksOf(state, id).map((e) => ({ from: e.from, type: e.type, note: e.note })),
    outlinks: outlinksOf(state, id).map((e) => ({ to: e.to, type: e.type, note: e.note })),
    history: n.history.map((h) => ({ at: h.at, text: summarize(h.text, 300), reason: h.reason })),
    chain: chain.map((c) => ({ id: c.id, text: summarize(c.text, 200), status: c.status })),
  }
}
