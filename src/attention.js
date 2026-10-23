/**
 * Rank unfinished questions by the pressure they exert on the next thinking cycle.
 * Pure functions only; callers supply the current time for deterministic tests.
 */

export const STALENESS_HORIZON_MS = 7 * 24 * 60 * 60 * 1000

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value))

/**
 * Score one open question. Higher pressure means it deserves attention sooner.
 *
 * @param {object} q - Folded question.
 * @param {number} now - Current time in milliseconds.
 * @returns {number} Pressure in the inclusive range 0..1.
 */
export function pressure(q, now) {
  const urgency = clamp(Number.isFinite(Number(q?.urgency)) ? Number(q.urgency) : 0.5)
  const confidence = clamp(Number.isFinite(Number(q?.confidence)) ? Number(q.confidence) : 0.2)
  const attempts = Math.max(0, Number.isFinite(Number(q?.attempts)) ? Number(q.attempts) : 0)
  const touched = Number.isFinite(Number(q?.lastTouchedAt))
    ? Number(q.lastTouchedAt)
    : Number.isFinite(Number(q?.openedAt)) ? Number(q.openedAt) : Number(now)
  const age = Math.max(0, Number(now) - touched)
  const staleness = 0.3 + 0.7 * clamp(age / STALENESS_HORIZON_MS)
  const fatigue = 1 / (1 + attempts * 0.5)
  return clamp(urgency * (1 - confidence) * staleness * fatigue)
}

/**
 * Rank open questions by pressure, excluding closed and abandoned records.
 *
 * @param {object} state - Folded ledger state.
 * @param {number} now - Current time in milliseconds.
 * @param {{limit?: number, minPressure?: number}} [opts] - Ranking limits.
 * @returns {Array<{question: object, pressure: number}>} Ranked questions.
 */
export function rankQuestions(state, now, opts = {}) {
  const rawLimit = Number(opts.limit)
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 10
  const minPressure = Number.isFinite(Number(opts.minPressure)) ? clamp(Number(opts.minPressure)) : 0
  const questions = state?.questions instanceof Map ? [...state.questions.values()] : []
  return questions
    .filter((q) => q?.status === 'open')
    .map((question) => ({ question, pressure: pressure(question, now) }))
    .filter((entry) => entry.pressure >= minPressure)
    .sort((a, b) => b.pressure - a.pressure || String(a.question.id).localeCompare(String(b.question.id)))
    .slice(0, limit)
}

/**
 * Pick the questions for one thinking cycle.
 *
 * @param {object} state - Folded ledger state.
 * @param {number} now - Current time in milliseconds.
 * @param {{max?: number, minPressure?: number}} [opts] - Focus limits.
 * @returns {object[]} Questions, highest pressure first.
 */
export function focusFor(state, now, opts = {}) {
  const rawMax = Number(opts.max)
  const max = Number.isInteger(rawMax) && rawMax > 0 ? rawMax : 3
  const minPressure = Number.isFinite(Number(opts.minPressure)) ? clamp(Number(opts.minPressure)) : 0.2
  return rankQuestions(state, now, { limit: max, minPressure }).map((entry) => entry.question)
}
