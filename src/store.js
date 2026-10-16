/**
 * Storage layer: writing the ledger to disk and reading it back.
 *
 * Three design constraints from community field experience:
 *
 * 1. The file holds the truth; indexes are rebuildable. The ledger is plain-text
 *    JSONL: human-readable, git-diffable, deletable. Any derived data (graph,
 *    backlinks, active set) can be recomputed from the ledger, so deleting it
 *    loses nothing.
 *
 * 2. External hand edits must not be overwritten (viya-memory's atomicWrite
 *    pattern). The ledger can be edited by hand, which is both the cost and the
 *    benefit of plain text, so writes compare mtime first and report an error
 *    rather than overwrite when someone else changed it. The comparison runs
 *    twice — before writing the temporary file and before rename — to cover
 *    external changes inside the temp-write window.
 *
 * 3. Append only; never rewrite history. Except for compaction, existing lines
 *    are never rewritten, which keeps the supersession process itself an
 *    auditable fact.
 */

import { readFileSync, writeFileSync, existsSync, statSync, renameSync, unlinkSync, mkdirSync, appendFileSync, openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Ledger file name. */
export const LEDGER_FILE = 'ledger.jsonl'

/**
 * Parse JSONL text into an event array.
 *
 * Bad lines are collected as problems rather than thrown: one bad line must not
 * make the whole memory store unreadable. This matches foldEvents' fault
 * tolerance.
 *
 * @param {string} text - Full file contents.
 * @returns {{events: object[], problems: object[]}} Events and parse problems.
 */
export function parseLedger(text) {
  const events = []
  const problems = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line === '') continue
    try {
      const ev = JSON.parse(line)
      if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
        problems.push({ line: i + 1, reason: '不是对象' })
        continue
      }
      events.push(ev)
    } catch (err) {
      problems.push({ line: i + 1, reason: `JSON 解析失败：${err.message}` })
    }
  }
  // Stable sort by seq: hand edits can insert lines in the wrong place, and sorting makes the fold result independent of write order.
  events.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
  return { events, problems }
}

/**
 * Serialize an event array to JSONL text.
 * @param {object[]} events - Event array.
 * @returns {string} Text ending with a newline.
 */
export function serializeLedger(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '')
}

/**
 * Read the ledger. A missing file yields an empty ledger: first run is a normal
 * state, not an error.
 *
 * @param {string} filePath - Absolute ledger path.
 * @returns {{events: object[], problems: object[], exists: boolean, mtimeMs: number|undefined}}
 */
export function readLedger(filePath) {
  if (!existsSync(filePath)) return { events: [], problems: [], exists: false, mtimeMs: undefined }
  const text = readFileSync(filePath, 'utf8')
  const { events, problems } = parseLedger(text)
  return { events, problems, exists: true, mtimeMs: statSync(filePath).mtimeMs }
}

/**
 * Atomically append events (the preferred path: append only, never rewrite
 * history).
 *
 * Appending is far safer than a full rewrite: a crash mid-write leaves at worst
 * an incomplete last line with earlier history intact, whereas a failed rewrite
 * loses the entire file.
 *
 * @param {string} filePath - Absolute ledger path.
 * @param {object[]} events - Events to append.
 * @returns {{ok: boolean, reason?: string, appended: number}} Result.
 */
export function appendEvents(filePath, events) {
  if (events.length === 0) return { ok: true, appended: 0 }
  try {
    mkdirSync(dirname(filePath), { recursive: true })
  } catch (err) {
    return { ok: false, reason: `无法建目录：${err.message}`, appended: 0 }
  }
  try {
    // A hand-edited or crash-truncated tail may lack its line separator.
    // Preserve it verbatim, but keep new records on separate parseable lines.
    let separator = ''
    if (existsSync(filePath)) {
      const fd = openSync(filePath, 'r')
      try {
        const size = fstatSync(fd).size
        if (size > 0) {
          const last = Buffer.alloc(1)
          readSync(fd, last, 0, 1, size - 1)
          if (last[0] !== 10) separator = '\n'
        }
      } finally { closeSync(fd) }
    }
    appendFileSync(filePath, separator + serializeLedger(events), 'utf8')
    return { ok: true, appended: events.length }
  } catch (err) {
    return { ok: false, reason: `追加失败：${err.message}`, appended: 0 }
  }
}

/**
 * Atomic full write (for compaction and manual repair only), with two mtime
 * checks.
 *
 * Follows viya-memory's verified pattern: temp file → second check → rename.
 * Any failure reports an error instead of writing: refusing beats overwriting
 * someone else's change.
 *
 * @param {string} filePath - Target path.
 * @param {string} content - Complete contents.
 * @param {number|undefined} expectedMtimeMs - Expected current mtime; undefined skips the check (first creation).
 * @returns {{ok: boolean, reason?: string}} Result.
 */
export function atomicWrite(filePath, content, expectedMtimeMs) {
  const check = () => {
    if (expectedMtimeMs === undefined) return true
    if (!existsSync(filePath)) return false
    return statSync(filePath).mtimeMs === expectedMtimeMs
  }
  if (!check()) return { ok: false, reason: 'stale' }

  try {
    mkdirSync(dirname(filePath), { recursive: true })
  } catch (err) {
    return { ok: false, reason: `无法建目录：${err.message}` }
  }

  const tmp = join(dirname(filePath), `.${LEDGER_FILE}.${process.pid}.${Date.now().toString(36)}.tmp`)
  try {
    writeFileSync(tmp, content, 'utf8')
  } catch (err) {
    return { ok: false, reason: `写临时文件失败：${err.message}` }
  }

  // Second check: covers external changes made during the temp-write window.
  if (!check()) {
    try { unlinkSync(tmp) } catch { /* a cleanup failure must not mask the primary cause */ }
    return { ok: false, reason: 'stale' }
  }

  try {
    renameSync(tmp, filePath)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* as above */ }
    return { ok: false, reason: `rename 失败：${err.message}` }
  }
  return { ok: true }
}
