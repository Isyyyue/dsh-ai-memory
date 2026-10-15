/**
 * 确定性取代引擎（deterministic supersession）。
 *
 * 为什么不能用"相似度"来判定矛盾 —— 这是本插件最重要的设计依据，有学术实证：
 *
 *   MemStrata（arXiv 2606.26511）在 98 个标注对上实测：
 *     余弦相似度区分「矛盾」与「复述」的 AUROC = 0.59（接近随机）；
 *     而且**矛盾平均比复述更像原事实**（0.812 vs 0.800）——
 *     因为「值翻转」（8000 → 8080）比真正的同义改写是**更小的编辑**。
 *   结论：陈旧性检测**必须是结构性的**，不能靠阈值、也不能靠 LLM 裁判。
 *     "新事实与已存事实共享 (subject, relation) 键但断言不同 object，则新的取代旧的
 *      —— 与它们 embedding 多相似无关。"
 *
 * 本模块因此**不含任何相似度计算**。判定完全靠字符串规范化 + 三元组比对。
 * 这样做的另一个好处：可测试、可复现、零依赖、零 LLM 调用（读取路径无 LLM）。
 *
 * 两条对称的消融结论（同一论文）决定了本引擎的姿态：
 *   - 激进合并 → 回归到低于 RAG（丢掉回答后续问题所需的细节）；
 *   - 完全不取代 → 虚构率涨 6 倍，**比不准确更不安全**（模型同时看到新旧值，开始编造）。
 *   → 「保留优先，然后取代」：只在矛盾这一个轴上压缩，绝不合并不同事实。
 */

import { KIND } from './ledger.js'

/**
 * 合法的 kind 白名单。
 *
 * ⚠️ 之前这里是写死的 `input.kind === 'rule' ? 'rule' : 'judgment'` ——
 * 新增 `insight` 时就被**静默降级**成 judgment（不报错，只是类型丢了，
 * 而且取代逻辑会拿它当判断去比三元组）。
 * 改成白名单后，**新增一种 kind 只需在这里加一项**（其实连这里也不用改 ——
 * 直接从 KIND 枚举派生，永远不会再漏）。
 */
const VALID_KINDS = new Set(Object.values(KIND))

/**
 * 规范化一个三元组分量，用于确定性比对。
 *
 * 规范化是**有损且刻意保守**的：只做那些"不会把不同事实变相同"的处理。
 * 不做词干化、不做同义词、不做向量 —— 那些都会引入不确定性。
 *
 * @param {unknown} v - 原始分量。
 * @returns {string} 规范化后的键分量（空字符串表示"没有这一项"）。
 */
export function normalizeComponent(v) {
  if (typeof v !== 'string') return ''
  return v
    .normalize('NFKC')          // 全角/半角、兼容字符归一（中文场景很重要）
    .trim()
    .replace(/\s+/g, ' ')       // 压平空白
    .toLowerCase()              // 大小写不敏感
}

/**
 * 生成 (subject, relation) 键。取代判定只看这个键 + object。
 *
 * @param {{subject?: unknown, relation?: unknown}} node - 含三元组的节点。
 * @returns {string|null} 键；任一分量缺失时返回 null（= 不参与取代）。
 */
export function assertionKey(node) {
  const s = normalizeComponent(node?.subject)
  const r = normalizeComponent(node?.relation)
  if (s === '' || r === '') return null
  return `${s}\u0000${r}`
}

/**
 * 判定一条新判断与已有判断的关系。
 *
 * 返回四种之一，与论文的标注类别一致：
 *   'duplicate'   —— 同键同 object：复述（不新建，只强化引用）
 *   'supersede'   —— 同键不同 object：矛盾（新取代旧）
 *   'novel'       —— 没有同键：新事实
 *   'unkeyed'     —— 缺三元组：无法参与取代，只按普通节点存
 *
 * @param {object} incoming - 新判断（需 subject/relation/object）。
 * @param {object[]} active - 当前活跃节点数组。
 * @returns {{relation: string, target?: object}} 判定结果与命中的既有节点。
 */
export function classify(incoming, active) {
  const key = assertionKey(incoming)
  if (key === null) return { relation: 'unkeyed' }

  const obj = normalizeComponent(incoming.object)
  let sameKey = null
  for (const n of active) {
    if (assertionKey(n) !== key) continue
    // 同键同 object → 复述。object 为空时视为"没有可断言的差异"，也算复述。
    if (normalizeComponent(n.object) === obj) return { relation: 'duplicate', target: n }
    sameKey = n
  }
  if (sameKey !== null) return { relation: 'supersede', target: sameKey }
  return { relation: 'novel' }
}

/**
 * 为一条新判断算出它应该产生的事件序列。
 *
 * 纯函数：输入状态 + 新判断，输出事件数组。**不写盘、不改状态**。
 * 这样调用方可以先把事件拿去看、去测、去审，再决定要不要提交。
 *
 * @param {object} state - fold 后的当前状态。
 * @param {object} input - `{ text, subject, relation, object, kind, tags, citations, reason }`。
 * @param {{at: number, nextSeq: number, newId: string}} ctx - 时间、序号、新 id。
 * @returns {{events: object[], outcome: object}} 事件与结果摘要。
 */
export function planWrite(state, input, ctx) {
  const active = activeNodesOf(state)
  const verdict = classify(input, active)
  const at = ctx.at
  let seq = ctx.nextSeq
  const events = []
  const take = () => (seq += 1)

  if (verdict.relation === 'duplicate') {
    // 复述：**不新建节点，也不产生任何事件**。
    // 理由：同一断言不需要两份卡（那正是"攒"而不是"长"）。
    // 刻意不推一条从 ctx.newId 出发的边 —— 那个节点并不存在，推了会让 fold 报 problem。
    // 复述这件事本身是"确认"，但它的价值在于让调用方知道"已经有了"，不必落盘。
    return {
      events: [],
      outcome: {
        action: 'duplicate',
        nodeId: verdict.target.id,
        text: verdict.target.text,
        note: '这条判断与既有判断是同一断言（同 subject/relation/object），未新建节点。',
      },
    }
  }

  const nodeEvent = {
    seq: take(),
    at,
    type: 'node.created',
    data: {
      id: ctx.newId,
      // ⚠️ 这里曾经写死成 `input.kind === 'rule' ? 'rule' : 'judgment'` ——
      // 于是新加的 `insight` 被**静默降级**成 judgment（不报错，只是类型丢了）。
      // 现在按 KIND 白名单校验，不认识的才退成 judgment。
      kind: VALID_KINDS.has(input.kind) ? input.kind : 'judgment',
      text: input.text,
      subject: input.subject ?? null,
      relation: input.relation ?? null,
      object: input.object ?? null,
      tags: input.tags ?? [],
      citations: input.citations ?? [],
    },
  }
  events.push(nodeEvent)

  if (verdict.relation === 'supersede') {
    const old = verdict.target
    // 双时态：关掉旧节点的 valid_to，**不删除**。旧判断仍可被 as-of-time 查询与轨迹查看。
    events.push({
      seq: take(),
      at,
      type: 'node.superseded',
      data: { id: old.id, byId: ctx.newId, reason: input.reason ?? '同一断言的更新值' },
    })
    // 取代同时留一条边，让图谱上看得见"谁取代了谁"。
    events.push({
      seq: take(),
      at,
      type: 'edge.linked',
      data: { from: ctx.newId, to: old.id, type: 'supersedes', note: input.reason ?? '' },
    })
    return {
      events,
      outcome: {
        action: 'supersede',
        nodeId: ctx.newId,
        supersededId: old.id,
        supersededText: old.text,
        note: `确定性取代：同 (subject, relation) 键、不同 object。旧判断退役但保留在账本里。`,
      },
    }
  }

  return {
    events,
    outcome: { action: 'created', nodeId: ctx.newId, note: '新判断已记录。' },
  }
}

/**
 * 轻量取活跃节点（避免本模块依赖 ledger.js 的具体形状，只要求 state.nodes 是 Map）。
 * @param {object} state - 折叠后的状态。
 * @returns {object[]} 活跃节点数组。
 */
function activeNodesOf(state) {
  const out = []
  for (const n of state.nodes.values()) {
    if (n.status === 'active') out.push(n)
  }
  return out
}

/**
 * 生成一个稳定的节点 id。
 *
 * 刻意**不含时间戳以外的随机性**：同样的内容在不同时间会得到不同 id（因为是两条不同的判断），
 * 但同一时刻生成的 id 可复现，便于测试。
 *
 * @param {number} at - 毫秒时间戳。
 * @param {number} seq - 序号。
 * @returns {string} 形如 `n_0007_1a2b3c` 的 id。
 */
export function makeNodeId(at, seq) {
  const t = at.toString(36).slice(-6)
  const s = String(seq).padStart(4, '0')
  return `n_${s}_${t}`
}
