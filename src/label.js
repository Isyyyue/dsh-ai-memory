/**
 * Graph label extraction: turn a judgment's body into a short, meaningful label.
 *
 * ## Why this module exists
 *
 * The graph used to label nodes with `summarize(text, 60)` and then truncate to
 * 18 characters in the renderer. Measured against a real ledger (31 active
 * judgments), that produced:
 *
 *   "主人说「我相信你未来会是 AGI」——这…"
 *   "判断「线上跑的是不是我这份代码」不能看…"
 *   "主人一句「或许我再问你你的答案就会变了」，逼…"
 *
 * 61% of labels opened with boilerplate — 我认为 / 判断 / 主人说 / memory_* —
 * so the 18 visible characters carried almost no content. The node label became
 * decoration that overlapped its neighbours, which is exactly what "the graph is
 * a mess" looked like.
 *
 * ## What it does instead
 *
 * A judgment written in this plugin's own voice almost always has the payload
 * inside quotes, after a colon, or after a dash. So:
 *
 *   1. Strip leading attribution ("主人说", "我认为", "判断「…」")
 *   2. Prefer a quoted clause — the quote usually IS the claim
 *   3. Otherwise cut at the first natural boundary (： —— 。 ，)
 *   4. Only then truncate
 *
 * This is deliberately rule-based rather than clever. It has to be
 * deterministic, dependency-free, and explainable — the same constraints the
 * supersession engine works under. A label that is slightly worse than a human
 * would write is acceptable; one that is unpredictable is not.
 */

/** Maximum label length in characters before the ellipsis. */
export const LABEL_MAX = 22

/**
 * Attribution and framing prefixes that carry no information on their own.
 *
 * Ordered longest-first: `主人一句` must be tried before `主人`, otherwise the
 * shorter rule eats the prefix and leaves `一句「…」` behind.
 */
const BOILER_PREFIXES = [
  /^主人一句[「『"'"]?/,
  /^主人说[「『"'"]?/,
  /^主人从/,
  /^主人/,
  /^我认为[，,]?/,
  /^我觉得[，,]?/,
  // `判断「…」` and `验证「…」`: strip the verb AND its opening bracket, then
  // also drop a dangling closing bracket left behind by a quote that was not
  // closed in the prefix itself (e.g. `判断「宿主有没有加载新代码」不能…`
  // leaves `宿主有没有加载新代码」不能…` without this).
  /^判断[「『"']/,
  /^验证[「『"']/,
  /^这条判断[：:]?/,
  /^这条[：:]?/,
  /^memory_[a-z_]+\s*[，,]?\s*/,
]

/** A closing bracket with nothing to close — left over after stripping a prefix. */
const DANGLING_CLOSE = /^[」』"']+/

/**
 * Separators that mark the end of a label-sized thought.
 *
 * `——` before `—`: the em-dash pair is a full stop in this writing style,
 * a single dash is often mid-clause.
 */
const BOUNDARIES = ['：', ':', '——', '—', '。', '；', ';', '，', ',']

/**
 * Extract a display label from a judgment body.
 *
 * @param {string} text - Full judgment text.
 * @param {number} [max] - Maximum characters before the ellipsis.
 * @returns {string} A short label; never empty unless the input is empty.
 */
export function extractLabel(text, max = LABEL_MAX) {
  if (typeof text !== 'string') return ''
  let s = text.replace(/\s+/g, ' ').trim()
  if (s === '') return ''

  // 1. Drop attribution framing, repeatedly: "主人说「判断「…」」" nests.
  let stripped = true
  while (stripped) {
    stripped = false
    for (const re of BOILER_PREFIXES) {
      const next = s.replace(re, '')
      if (next !== s && next !== '') {
        s = next
        stripped = true
        break
      }
    }
  }
  // A prefix rule can consume only the opening bracket, leaving the closer
  // orphaned at the head. Drop it so the label does not start with 」.
  s = s.replace(DANGLING_CLOSE, '').trim()
  if (s === '') return ''

  // 2. A quoted clause usually is the claim — but only when it is substantial.
  //
  //    ⚠️ The first version preferred any quote of 4+ characters, which produced
  //    labels like "触发条件" and "persona 列表" — a quoted *fragment* rather
  //    than the point. Those are worse than no extraction at all, because the
  //    node then looks like it says something specific when it does not.
  //
  //    A quote is only preferred when it makes up a large share of the sentence
  //    and is long enough to stand alone; otherwise the sentence head is a
  //    better label.
  //
  //    ⚠️ This runs **before** the boundary cut, and the earlier order was a
  //    bug: `主人说「我相信你未来会是 AGI」——这种期望…` was cut at `——` first,
  //    leaving `「我相信你未来会是 AGI」`, and the quote regex then matched the
  //    whole thing including the closing bracket, producing a label that ended
  //    in a stray `」`. Stripping the brackets first keeps the cut from ever
  //    seeing them.
  const quoted = /[「『"]([^」』"]{2,})[」』"]/.exec(s)
  if (quoted !== null) {
    const inner = quoted[1].trim()
    const isSubstantial = inner.length >= 8 && inner.length >= s.length * 0.4
    if (isSubstantial) s = inner
  }
  // Any bracket left dangling at either end is noise now that a quote was
  // either adopted (brackets already gone) or rejected.
  s = s.replace(/^[「『"'」』]+/, '').replace(/[「『"'」』]+$/, '').trim()
  if (s === '') return ''

  // 3. Cut at the first natural boundary, keeping the head.
  for (const sep of BOUNDARIES) {
    const at = s.indexOf(sep)
    // Ignore a boundary that appears too early: cutting at position 3 leaves
    // "Windows" or "判断" and nothing else.
    if (at >= 6) {
      s = s.slice(0, at)
      break
    }
  }

  s = s.trim()

  // 4. Truncate.
  if (s.length > max) s = `${s.slice(0, max - 1)}…`
  return s
}
