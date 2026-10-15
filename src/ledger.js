/**
 * 追加式账本（append-only ledger）—— 记忆的唯一真相（source of truth）。
 *
 * 为什么是账本，而不是"一堆可变的卡片文件"：
 * - 判断会被推翻（supersede），而**推翻的过程本身是信息**。可变文件只看得到结果；
 *   账本看得到"3 月我这么想 → 6 月被那条证据推翻 → 9 月我又改回来"。
 * - 账本是纯文本 JSONL：人类可读、可 git diff、可 rm、可手工修。
 * - 图谱、反链、当前活跃判断**全部由 fold 派生**，可随时重建、删掉不丢信息。
 *   这正合 DSH 官方立场：session log 是唯一真相，插件记忆是派生缓存。
 *
 * 本模块是**纯函数**（不碰文件系统），所以测试可以直接喂事件数组。
 *
 * 事件类型（全部只追加，永不修改历史行）：
 *   node.created     新判断 / 新规则落地
 *   node.revised     改文字（保留历史版本，不算推翻）
 *   node.superseded  被新判断取代（双时态：关掉旧的 valid_to，**不删**）
 *   node.withdrawn   撤回（自己发现错了，但没被谁取代）
 *   edge.linked      建立双链
 *   edge.unlinked    解除双链
 *   rule.amended     规则变更（治理：带理由、可回滚）
 */

/** 账本里被承认的事件类型。不认识的类型会被记为 problem，绝不静默吞掉。 */
export const EVENT_TYPES = Object.freeze([
  'node.created',
  'node.revised',
  'node.superseded',
  'node.withdrawn',
  'edge.linked',
  'edge.unlinked',
  'rule.amended',
])

/** 节点状态。只有 active 参与检索与注入。 */
export const STATUS = Object.freeze({
  ACTIVE: 'active',
  SUPERSEDED: 'superseded',
  WITHDRAWN: 'withdrawn',
})

/**
 * 节点种类。
 *
 * - `judgment` 判断：被证据推翻后会被取代（会进化）
 * - `rule`     规矩：给自己定的约束，变更要走治理（可审计、可回滚）
 * - `insight`  思考：没有主语/宾语三角的**灵感与观察** ——
 *              它们的价值在"被记住"，而不是"被较真"，
 *              所以**不参与取代判定**（没有 key 就存不成判断，
 *              强行三元组化反而会逼 AI 编造结构）。
 *
 * 旧账本里只有前两种；新类型只增不改，老数据照常读取。
 */
export const KIND = Object.freeze({
  JUDGMENT: 'judgment',
  RULE: 'rule',
  INSIGHT: 'insight',
})

/**
 * 建一个空状态。
 * @returns {object} 可被 applyEvent 就地更新的状态对象。
 */
export function createState() {
  return {
    seq: 0,
    nodes: new Map(),
    edges: [],
    problems: [],
  }
}

/**
 * 把一条事件就地应用到状态上。
 *
 * 刻意保持**纯同步、无 IO、无异常**：坏事件被记进 problems 而不是抛出，
 * 因为一条坏行不该让整个记忆库读不出来（那等于记忆全丢）。
 *
 * @param {object} state - createState() 的产物。
 * @param {object} ev - 账本事件 `{ seq, at, type, data }`。
 * @returns {object} 同一个 state（便于 reduce）。
 */
export function applyEvent(state, ev) {
  if (ev === null || typeof ev !== 'object') {
    state.problems.push({ at: 'fold', reason: '事件不是对象', raw: ev })
    return state
  }
  if (!EVENT_TYPES.includes(ev.type)) {
    state.problems.push({ at: 'fold', reason: `未知事件类型 ${String(ev.type)}`, seq: ev.seq })
    return state
  }
  const d = ev.data ?? {}
  const at = typeof ev.at === 'number' ? ev.at : 0

  switch (ev.type) {
    case 'node.created': {
      const id = typeof d.id === 'string' && d.id !== '' ? d.id : `n_${String(ev.seq ?? 0).padStart(4, '0')}`
      if (state.nodes.has(id)) {
        state.problems.push({ at: 'fold', reason: `节点 id 重复：${id}`, seq: ev.seq })
        break
      }
      state.nodes.set(id, {
        id,
        kind: d.kind === KIND.RULE || d.kind === KIND.INSIGHT ? d.kind : KIND.JUDGMENT,
        text: typeof d.text === 'string' ? d.text : '',
        // 确定性取代用的三元组。缺任一项则该节点只参与检索、不参与取代。
        subject: typeof d.subject === 'string' && d.subject !== '' ? d.subject : null,
        relation: typeof d.relation === 'string' && d.relation !== '' ? d.relation : null,
        object: typeof d.object === 'string' && d.object !== '' ? d.object : null,
        tags: Array.isArray(d.tags) ? d.tags.filter((t) => typeof t === 'string') : [],
        citations: Array.isArray(d.citations) ? d.citations.filter((c) => typeof c === 'string') : [],
        createdAt: at,
        // 双时态账本：validFrom/validTo 是「事实何时为真」，createdAt 是「系统何时知道」。
        validFrom: at,
        validTo: null,
        supersededBy: null,
        status: STATUS.ACTIVE,
        revision: 1,
        history: [{ at, text: typeof d.text === 'string' ? d.text : '', reason: '建立' }],
      })
      break
    }

    case 'node.revised': {
      const n = state.nodes.get(d.id)
      if (n === undefined) {
        state.problems.push({ at: 'fold', reason: `改文字指向不存在的节点：${String(d.id)}`, seq: ev.seq })
        break
      }
      const before = n.text
      n.text = typeof d.text === 'string' ? d.text : n.text
      if (typeof d.subject === 'string' && d.subject !== '') n.subject = d.subject
      if (typeof d.relation === 'string' && d.relation !== '') n.relation = d.relation
      if (typeof d.object === 'string' && d.object !== '') n.object = d.object
      n.revision += 1
      n.history.push({ at, text: n.text, before, reason: typeof d.reason === 'string' ? d.reason : '修订' })
      break
    }

    case 'node.superseded': {
      const old = state.nodes.get(d.id)
      const by = state.nodes.get(d.byId)
      if (old === undefined || by === undefined) {
        state.problems.push({
          at: 'fold',
          reason: `取代指向不存在的节点：${String(d.id)} → ${String(d.byId)}`,
          seq: ev.seq,
        })
        break
      }
      // 关键：**退役而不删除**。旧节点留在账本里，供 as-of-time 查询与"进化轨迹"。
      old.status = STATUS.SUPERSEDED
      old.validTo = at
      old.supersededBy = by.id
      old.history.push({ at, text: old.text, reason: `被 ${by.id} 取代：${String(d.reason ?? '')}` })
      break
    }

    case 'node.withdrawn': {
      const n = state.nodes.get(d.id)
      if (n === undefined) {
        state.problems.push({ at: 'fold', reason: `撤回指向不存在的节点：${String(d.id)}`, seq: ev.seq })
        break
      }
      n.status = STATUS.WITHDRAWN
      n.validTo = at
      n.history.push({ at, text: n.text, reason: `撤回：${String(d.reason ?? '')}` })
      break
    }

    case 'edge.linked': {
      const from = state.nodes.get(d.from)
      const to = state.nodes.get(d.to)
      if (from === undefined || to === undefined) {
        state.problems.push({
          at: 'fold',
          reason: `双链指向不存在的节点：${String(d.from)} → ${String(d.to)}`,
          seq: ev.seq,
        })
        break
      }
      if (from.id === to.id) {
        state.problems.push({ at: 'fold', reason: '不允许自连', seq: ev.seq })
        break
      }
      // 去重键 = 起点 + 终点 + 类型。同一对节点可以有多种关系（互补 + 矛盾并存）。
      const key = `${from.id}\u0000${to.id}\u0000${String(d.type ?? 'related')}`
      if (state.edges.some((e) => `${e.from}\u0000${e.to}\u0000${e.type}` === key)) break
      state.edges.push({
        from: from.id,
        to: to.id,
        type: typeof d.type === 'string' && d.type !== '' ? d.type : 'related',
        note: typeof d.note === 'string' ? d.note : '',
        at,
      })
      break
    }

    case 'edge.unlinked': {
      const type = typeof d.type === 'string' && d.type !== '' ? d.type : null
      state.edges = state.edges.filter((e) => {
        if (e.from !== d.from || e.to !== d.to) return true
        if (type !== null && e.type !== type) return true
        return false
      })
      break
    }

    case 'rule.amended': {
      // 规则以节点承载（kind: 'rule'），变更理由与前后文留在事件里 → 可审计、可回滚。
      const n = state.nodes.get(d.id)
      if (n === undefined) {
        state.problems.push({ at: 'fold', reason: `规则变更指向不存在的节点：${String(d.id)}`, seq: ev.seq })
        break
      }
      const before = n.text
      n.text = typeof d.after === 'string' ? d.after : n.text
      n.revision += 1
      n.history.push({
        at,
        text: n.text,
        before,
        reason: typeof d.reason === 'string' ? d.reason : '规则变更',
        amendment: true,
      })
      break
    }

    default:
      break
  }

  if (typeof ev.seq === 'number' && ev.seq > state.seq) state.seq = ev.seq
  return state
}

/**
 * 折叠整个事件序列成当前状态。这是唯一的"读"路径。
 * @param {object[]} events - 按 seq 升序的事件数组。
 * @returns {object} 状态（含 nodes / edges / seq / problems）。
 */
export function foldEvents(events) {
  const state = createState()
  for (const ev of events) applyEvent(state, ev)
  return state
}

/** 当前活跃节点。只有这些参与检索、注入与取代判定。 */
export function activeNodes(state) {
  return [...state.nodes.values()].filter((n) => n.status === STATUS.ACTIVE)
}

/** 按 id 取节点。 */
export function nodeOf(state, id) {
  return state.nodes.get(id) ?? undefined
}

/** 某节点的入边（谁引用了我）—— 反向链接。 */
export function backlinksOf(state, id) {
  return state.edges.filter((e) => e.to === id)
}

/** 某节点的出边（我引用了谁）。 */
export function outlinksOf(state, id) {
  return state.edges.filter((e) => e.from === id)
}

/**
 * 沿取代链走到底，看一个判断最终演化成了什么。
 * 这是"进化轨迹"的实现：往回能追来路，往前能追去向。
 *
 * @param {object} state - 折叠后的状态。
 * @param {string} id - 起始节点 id。
 * @returns {{chain: object[], terminal: object|undefined}} 取代链与链尾。
 */
export function supersedeChain(state, id) {
  const chain = []
  const seen = new Set()
  let cur = state.nodes.get(id)
  while (cur !== undefined && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.push(cur)
    if (cur.supersededBy === null) break
    cur = state.nodes.get(cur.supersededBy)
  }
  return { chain, terminal: chain[chain.length - 1] }
}

/**
 * **双时态查询**：把账本折叠到「T 时刻的样子」。
 *
 * 这是账本式存储换来的核心能力 —— 文件式记忆做不到：
 *   validFrom / validTo 记录「事实何时为真」（valid time），
 *   createdAt 记录「系统何时知道」（transaction time）。
 *   只要截取 `at <= T` 的事件前缀再折叠，就得到 T 时刻的确切状态。
 *
 * 为什么这样是对的（而不是"近似"）：账本是**只追加**的，
 * 所以任意时刻的状态都是它之前事件前缀的纯函数。这正是 DSH 官方
 * 「一切必须能从已提交事件重建」那条原则在插件侧的落地。
 *
 * @param {object[]} events - 全量事件（可按 seq 升序，内部会再过滤）。
 * @param {number} at - Unix 毫秒时间戳。
 * @returns {object} T 时刻的状态（结构与 foldEvents 相同）。
 */
export function foldAsOf(events, at) {
  const prefix = []
  for (const ev of events) {
    const t = typeof ev?.at === 'number' ? ev.at : 0
    if (t <= at) prefix.push(ev)
  }
  return foldEvents(prefix)
}

/**
 * 在某个时刻，某条断言键上「活跃的是哪一条」。
 *
 * 这是双时态查询最常用的问法：「3 月的时候，我认为端口是多少？」
 *
 * @param {object[]} events - 全量事件。
 * @param {number} at - 查询时刻。
 * @param {string} key - assertionKey() 产出的键。
 * @returns {object|undefined} 那一刻活跃的节点；没有则 undefined。
 */
export function activeAssertionAsOf(events, at, key) {
  const state = foldAsOf(events, at)
  for (const n of state.nodes.values()) {
    if (n.status !== STATUS.ACTIVE) continue
    const s = typeof n.subject === 'string' ? n.subject : ''
    const r = typeof n.relation === 'string' ? n.relation : ''
    if (s === '' || r === '') continue
    if (`${s}\u0000${r}` === key) return n
  }
  return undefined
}
