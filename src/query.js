/**
 * Search layer: find relevant items among active judgments.
 *
 * Why Chinese needs dedicated handling — a hard conclusion from community field
 * testing:
 *   dsh-hybrid-memory found that **FTS5's unicode61 tokenizer does not segment
 *   Chinese**, so a **two-character sliding window** must pre-tokenize text
 *   before it is written to the index.
 *   dsh-memory-guide likewise notes that general-purpose embeddings and
 *   tokenizers handle CJK poorly.
 *
 * This module uses **no FTS5, no vectors and no external dependencies**, because
 * a plugin installed into a profile via `link:` gets no own node_modules (both
 * viya-memory and dsh-balance-pill hit this). So it implements a lexical scorer
 * that is sufficient, deterministic and testable:
 *
 *   Latin/digits → split on whitespace and punctuation, prefix match
 *   Chinese      → two-character sliding window (bigram), single characters as fallback
 *
 * Scoring weights follow viya-memory's measured preference: title/body > tags >
 * link note. Here "title" means the first sentence of the judgment body — the
 * judgment is that sentence.
 */

/**
 * Test whether a character is in a CJK (Chinese/Japanese/Korean) range.
 * @param {string} ch - Single character.
 * @returns {boolean} Whether the character is CJK.
 */
function isCjk(ch) {
  const c = ch.codePointAt(0)
  return (
    (c >= 0x4e00 && c <= 0x9fff) || // CJK Unified Ideographs
    (c >= 0x3400 && c <= 0x4dbf) || // Extension A
    (c >= 0xf900 && c <= 0xfaff) || // CJK Compatibility Ideographs
    (c >= 0x3040 && c <= 0x30ff) || // Japanese kana
    (c >= 0xac00 && c <= 0xd7af)    // Hangul
  )
}

/**
 * Split text into search terms.
 *
 * ⚠️ A field-tested pitfall: the two-character sliding window **must stay inside
 * one contiguous CJK run**. Sliding indiscriminately over every CJK character
 * builds bigrams that span whitespace or punctuation boundaries and exist in no
 * input term. Those bigrams can never match, so AND search silently degrades to
 * OR: the symptom is "results are a bit off", with no error raised.
 *
 * @param {string} text - Source text.
 * @returns {string[]} Term array (lowercased; Chinese yields bigrams plus single characters).
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text === '') return []
  const lower = text.toLowerCase()

  // Pass 1: split into Latin words and contiguous CJK runs, preserving boundaries.
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

  // Pass 2: two-character sliding window within each CJK run, keeping single characters as a recall fallback.
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
 * Test whether a token is distinctive enough to gate AND matching.
 *
 * This is a key trade-off in this module: **a single CJK character is too common
 * to decide whether AND holds**. A field-tested pitfall: a query that matches
 * nothing on its Latin part still matched an unrelated judgment that happened to
 * contain one of its single CJK characters, because that character fallback was
 * treated as required. The symptom is irrelevant results mixed in, again with no
 * error raised.
 *
 * So Latin words and CJK bigrams are distinctive (they may be required), while
 * single CJK characters contribute score only and gate nothing. Only when a
 * query consists **solely** of single characters (a one-character query) do
 * those characters become required — otherwise nothing would ever match.
 *
 * @param {string} token - Term.
 * @returns {boolean} Whether the token is distinctive.
 */
function isDistinctive(token) {
  if (token.length > 1) return true
  return !isCjk(token)
}

/**
 * Score one query term's match strength against a node.
 *
 * @param {object} node - Node.
 * @param {string} term - Query term (already lowercased).
 * @returns {number} Weight contribution (0 = no match).
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
  // Single-character hits score half: they are noisy and must not weigh the same as a bigram.
  if (term.length === 1 && isCjk(term)) score *= 0.5
  return score
}

/**
 * Search a node set.
 *
 * Two recall rounds (viya-memory's verified approach, avoiding "adding a term
 * kills the query"):
 *   round one AND — every **distinctive** term must hit; this is the main path;
 *   only when round one yields 0 results and the query has more than one term
 *   does round two run as an OR fallback, flagged relaxed.
 *
 * @param {object[]} nodes - Candidate nodes (normally active only).
 * @param {string} query - Query string.
 * @param {{limit?: number}} [opts] - Options.
 * @returns {{results: object[], relaxed: boolean, total: number}} Search results.
 */
export function search(nodes, query, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 10
  const terms = [...new Set(tokenize(query))]
  if (terms.length === 0) return { results: [], relaxed: false, total: 0 }

  const distinctive = terms.filter(isDistinctive)
  // Single characters gate matching only when they are all the query has, otherwise a single-character query could never match anything.
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
  // Flag relaxed only when relaxing actually found something. Reporting relaxed:true on 0 results would suggest the fallback found matches, which misleads.
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
 * Build a one-line summary (for injection and list display).
 *
 * @param {string} text - Full text.
 * @param {number} [max] - Maximum character count.
 * @returns {string} Single-line summary.
 */
export function summarize(text, max = 120) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return flat.slice(0, max - 1) + '…'
}
