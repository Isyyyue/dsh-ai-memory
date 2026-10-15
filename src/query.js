/**
 * 检索层：在活跃判断里找相关项。
 *
 * 为什么中文要专门处理 —— 这是社区实测的硬结论：
 *   dsh-hybrid-memory 发现 **FTS5 的 unicode61 分词器不切中文**，
 *   必须在写入索引前做 **2 字滑窗预分词**。
 *   dsh-memory-guide 也指出：通用 embedding 和分词层处理 CJK 都很拉胯。
 *
 * 本模块**不用 FTS5、不用向量、不用外部依赖** —— 因为插件以 `link:` 方式装进 profile 时
 * 拿不到自己的 node_modules（viya-memory 与 dsh-balance-pill 都踩过这个坑）。
 * 所以自己实现一个够用的、确定性可测的词法打分：
 *
 *   英文/数字 → 按空白与标点切词，前缀匹配
 *   中文      → 2 字滑窗（bigram）+ 单字兜底
 *
 * 打分权重参照 viya-memory 的实测取向：标题/正文 > 标签 > 关联说明。
 * 这里的"标题"对应判断的正文首句 —— 判断本身就是那句话。
 */

/**
 * 判断字符是否属于 CJK（中日韩）范围。
 * @param {string} ch - 单字符。
 * @returns {boolean} 是否 CJK。
 */
function isCjk(ch) {
  const c = ch.codePointAt(0)
  return (
    (c >= 0x4e00 && c <= 0x9fff) || // CJK 统一表意
    (c >= 0x3400 && c <= 0x4dbf) || // 扩展 A
    (c >= 0xf900 && c <= 0xfaff) || // 兼容表意
    (c >= 0x3040 && c <= 0x30ff) || // 日文假名
    (c >= 0xac00 && c <= 0xd7af)    // 韩文
  )
}

/**
 * 把一段文本切成检索词。
 *
 * ⚠️ 一个实测踩过的坑：2 字滑窗**必须限制在连续的 CJK 段内**。
 * 如果对所有 CJK 单字无差别滑窗，跨过空格/标点边界就会造出不存在的词
 * （例如「图谱 导航」会产出「谱导」），于是 AND 检索永远命中不了，
 * 检索静默退化成 OR —— 表现是"结果不太准"，但**不报错**。
 *
 * @param {string} text - 原文。
 * @returns {string[]} 词数组（已小写化；中文产出 bigram + 单字）。
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text === '') return []
  const lower = text.toLowerCase()

  // 第一遍：切出「拉丁词」与「CJK 连续段」两类 token，保留边界信息。
  const segments = []
  let latin = ''
  let cjkRun = ''

  const flushLatin = () => {
    if (latin !== '') {
      segments.push({ kind: 'latin', value: latin })
      latin = ''
    }
  }
  const flushCjk = () => {
    if (cjkRun !== '') {
      segments.push({ kind: 'cjk', value: cjkRun })
      cjkRun = ''
    }
  }

  for (const ch of lower) {
    if (isCjk(ch)) {
      flushLatin()
      cjkRun += ch
    } else if (/[\p{L}\p{N}]/u.test(ch)) {
      flushCjk()
      latin += ch
    } else {
      flushLatin()
      flushCjk()
    }
  }
  flushLatin()
  flushCjk()

  // 第二遍：CJK 段内做 2 字滑窗，并保留单字兜底（保召回）。
  const out = []
  for (const seg of segments) {
    if (seg.kind === 'latin') {
      out.push(seg.value)
      continue
    }
    const chars = [...seg.value]
    for (let i = 0; i < chars.length; i += 1) {
      out.push(chars[i])
      if (i + 1 < chars.length) out.push(chars[i] + chars[i + 1])
    }
  }
  return out
}

/**
 * 判断一个 token 是否"有区分度"。
 *
 * 这是本模块一个重要的设计取舍：**单个汉字太常见，不能决定 AND 是否成立**。
 * 实测踩过的坑：查询 `zzzz不存在` 会命中一条含「不」的无关判断，
 * 因为兜底单字「不」被当成了必需项。表现是"结果里混进不相干的东西"，且**不报错**。
 *
 * 所以：拉丁词与 CJK bigram 有区分度（可作必需项），单个汉字只贡献分数、不把关。
 * 若查询**只**由单字组成（例如就查一个字），才退回用单字当必需项 —— 否则什么都搜不到。
 *
 * @param {string} token - 词。
 * @returns {boolean} 是否有区分度。
 */
function isDistinctive(token) {
  if (token.length > 1) return true
  return !isCjk(token)
}

/**
 * 给一个节点算某个查询词的命中强度。
 *
 * @param {object} node - 节点。
 * @param {string} term - 查询词（已小写）。
 * @returns {number} 权重贡献（0 = 未命中）。
 */
function termScore(node, term) {
  let score = 0
  const text = String(node.text ?? '').toLowerCase()
  if (text.includes(term)) score += 3
  if (String(node.subject ?? '').toLowerCase().includes(term)) score += 2
  if (String(node.object ?? '').toLowerCase().includes(term)) score += 2
  if (String(node.relation ?? '').toLowerCase().includes(term)) score += 2
  for (const tag of node.tags ?? []) {
    if (String(tag).toLowerCase().includes(term)) score += 1.5
  }
  // 单字命中打对折：它噪音大，不该和 bigram 同权。
  if (term.length === 1 && isCjk(term)) score *= 0.5
  return score
}

/**
 * 在节点集合里检索。
 *
 * 两轮召回（照搬 viya-memory 验证过的做法，避免"加词即自杀"）：
 *   第一轮 AND —— 每个**有区分度**的词都要命中，这是主路径；
 *   只有第一轮 0 条、且查询词 > 1 时，才跑第二轮 OR 兜底，并标记 relaxed。
 *
 * @param {object[]} nodes - 候选节点（通常只传 active 的）。
 * @param {string} query - 查询串。
 * @param {{limit?: number}} [opts] - 选项。
 * @returns {{results: object[], relaxed: boolean, total: number}} 检索结果。
 */
export function search(nodes, query, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 10
  const terms = [...new Set(tokenize(query))]
  if (terms.length === 0) return { results: [], relaxed: false, total: 0 }

  const distinctive = terms.filter(isDistinctive)
  // 只由单字组成时才用单字把关，否则纯单字查询会永远搜不到东西。
  const required = distinctive.length > 0 ? distinctive : terms

  const scored = []
  for (const node of nodes) {
    let total = 0
    let requiredHits = 0
    for (const term of terms) {
      const s = termScore(node, term)
      if (s > 0) total += s
    }
    for (const term of required) {
      if (termScore(node, term) > 0) requiredHits += 1
    }
    if (requiredHits > 0) scored.push({ node, score: total, hits: requiredHits })
  }

  const andHits = scored.filter((r) => r.hits === required.length)
  let relaxed = false
  let pool = andHits
  // 只在"放宽确实捞到了东西"时才标记 relaxed。
  // 否则 0 条结果却报 relaxed:true，会让人以为"放宽后找到了"—— 那是误导。
  if (pool.length === 0 && required.length > 1 && scored.length > 0) {
    pool = scored
    relaxed = true
  }

  pool.sort((a, b) => b.hits - a.hits || b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)))

  return {
    results: pool.slice(0, limit).map((r) => ({ ...r.node, score: Number(r.score.toFixed(3)) })),
    relaxed,
    total: pool.length,
  }
}

/**
 * 生成一句话摘要（用于注入与列表展示）。
 *
 * @param {string} text - 全文。
 * @param {number} [max] - 最大字符数。
 * @returns {string} 单行摘要。
 */
export function summarize(text, max = 120) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return flat.slice(0, max - 1) + '…'
}
