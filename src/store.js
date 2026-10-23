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

import { readFileSync, writeFileSync, existsSync, statSync, renameSync, unlinkSync, mkdirSync, appendFileSync, openSync, readSync, closeSync, fstatSync, linkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

/**
 * How long a lock file may sit before it is considered abandoned.
 *
 * ⚠️ This exists because of a concrete failure mode, not for tidiness: a lock
 * created with O_EXCL and never removed — because the holder crashed, was
 * killed, or the machine lost power — would block **every subsequent write
 * forever**. A lock without recovery turns "two writers may collide" into
 * "after one crash, nothing can ever be written again", which is strictly
 * worse than the race it was meant to fix.
 *
 * 5 s is generous for a write that normally completes in single-digit
 * milliseconds, so it will not steal a lock from a live writer.
 */
export const LOCK_STALE_MS = 5000

/**
 * How long a caller waits for a held lock before giving up.
 *
 * Deliberately much shorter than LOCK_STALE_MS: waiting is synchronous, so it
 * blocks whatever asked to write. Two seconds of contention is already a sign
 * something is wrong; failing loudly beats stalling a tool call.
 */
export const LOCK_WAIT_MS = 2000

/**
 * Whether a process id is still running.
 *
 * `process.kill(pid, 0)` performs the existence check without delivering a
 * signal. EPERM means the process exists but belongs to another user, which
 * still counts as alive — treating it as dead would let us steal a live lock.
 *
 * @param {number} pid - Process id from a lock file.
 * @returns {boolean} Whether that process is still running.
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/**
 * Block the current thread for a few milliseconds.
 *
 * The write path is synchronous throughout (appendFileSync, renameSync), so
 * waiting for a lock has to be synchronous too. `Atomics.wait` on a throwaway
 * SharedArrayBuffer is the standard way to sleep without a busy loop burning a
 * core.
 *
 * @param {number} ms - Milliseconds to sleep.
 * @returns {void}
 */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

/**
 * Take the ledger's write lock, or report that it could not be taken.
 *
 * ## Why a lock is needed at all, given ids are already unique
 *
 * Unique ids stop two writers from producing the same node id, which stops
 * nodes from being silently dropped. They do **not** stop two writers from
 * computing the same `seq`. Sequence numbers are what give the ledger its
 * order, and order is load-bearing: `foldEvents` sorts by `seq`, and
 * `supersedeChain` walks supersession links in that order. Two concurrent
 * supersessions of the same assertion can therefore fold into a chain that
 * reflects neither writer's intent.
 *
 * So the invariant the lock protects is not "unique ids" but **"seq order
 * equals commit order"**.
 *
 * ## The creation race, and why the owner is written *before* the file appears
 *
 * The obvious implementation — `openSync(path, 'wx')` then `writeFileSync(fd,
 * owner)` — has a real window: between the atomic create and the owner write,
 * the lock file exists but is **empty**. A second process that hits that
 * window reads `''`, `JSON.parse` throws, the holder is unknown, and the lock
 * is classified as abandoned and deleted. Both processes then believe they hold
 * it.
 *
 * Measured: 6 processes × 1 write showed a maximum concurrent depth of **2**,
 * and in the full 4-process × 3-write run two processes were handed the same
 * `seq`. The lock was there and silently not working — the worst kind of
 * failure.
 *
 * The fix is to make the owner readable at the instant the path becomes
 * visible: write the owner to a private temp file first, then hard-link it into
 * place. `link()` fails atomically if the target exists, and the link is only
 * created once the content is already on disk. No empty-file window exists.
 *
 * ## Recovery
 *
 * A held lock is inspected before waiting: if its owner is gone, or it is
 * older than LOCK_STALE_MS, it is removed and the lock is retried. An
 * **unreadable** lock is only stolen once it is older than the stale window,
 * never immediately — see the comment at that branch.
 *
 * @param {string} lockPath - Path of the lock file.
 * @param {{waitMs?: number, staleMs?: number, now?: () => number}} [opts] - Tunables (tests inject these).
 * @returns {{ok: boolean, reason?: string}} Whether the lock is now held.
 */
export function acquireLock(lockPath, opts = {}) {
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : LOCK_WAIT_MS
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : LOCK_STALE_MS
  const now = opts.now ?? (() => Date.now())
  const deadline = now() + waitMs
  const owner = JSON.stringify({ pid: process.pid, at: now() })

  try {
    mkdirSync(dirname(lockPath), { recursive: true })
  } catch (err) {
    return { ok: false, reason: `无法建目录：${err.message}` }
  }

  // A per-attempt temp name so two processes never share a staging file.
  const tmpPath = `${lockPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`

  const stage = () => {
    writeFileSync(tmpPath, owner)
  }
  const cleanupTmp = () => {
    try { unlinkSync(tmpPath) } catch { /* already moved or never created */ }
  }

  for (;;) {
    // Stage the owner first: by the time the lock path exists, its content is
    // already complete. See the header note about the empty-file window.
    try {
      stage()
    } catch (err) {
      cleanupTmp()
      return { ok: false, reason: `无法写锁文件：${err.message}` }
    }

    try {
      // link() is atomic and fails with EEXIST when the target exists, exactly
      // like O_EXCL — but the content is guaranteed present.
      linkSync(tmpPath, lockPath)
      cleanupTmp()
      return { ok: true }
    } catch (err) {
      cleanupTmp()
      if (err.code !== 'EEXIST') return { ok: false, reason: `抢锁失败：${err.message}` }
    }

    // Someone holds it. Decide: steal, wait, or give up.
    let holder = null
    let readable = false
    try {
      holder = JSON.parse(readFileSync(lockPath, 'utf8'))
      readable = true
    } catch {
      holder = null
    }

    /**
     * Age of the lock.
     *
     * When the content is readable its own `at` is authoritative — it is the
     * moment the owner claimed it. When it is not readable (empty, truncated,
     * or held open by something else) fall back to the file's mtime, which is
     * still a real timestamp.
     *
     * ⚠️ Never default to `Infinity` here. That was a bug: an unreadable lock
     * got `age = Infinity`, which satisfied `age > staleMs` and was stolen
     * immediately — exactly the behaviour this branch is supposed to prevent.
     */
    const holderAt = Number(holder?.at)
    let age
    if (Number.isFinite(holderAt)) {
      age = now() - holderAt
    } else {
      try {
        age = now() - statSync(lockPath).mtimeMs
      } catch {
        // Vanished between the read and the stat: retry from the top.
        continue
      }
    }
    const holderAlive = readable && isPidAlive(Number(holder?.pid))

    /**
     * Steal only when we can prove the holder is gone, or when the lock is
     * older than the stale window.
     *
     * ⚠️ An unreadable lock must **not** be stolen immediately. Doing so was
     * the second half of the race: with the link-based creation above the
     * window is gone, but a lock can still be briefly unreadable if a reader
     * loses the race against an antivirus or indexing service holding the file.
     * Waiting out the stale window costs at most one slow write; stealing it
     * wrongly hands out two concurrent writers.
     */
    if ((readable && !holderAlive) || age > staleMs) {
      try {
        unlinkSync(lockPath)
      } catch { /* someone else may have removed it first; retry anyway */ }
      continue
    }

    if (now() >= deadline) {
      return {
        ok: false,
        reason: `账本被占用超过 ${waitMs}ms（持有者 pid ${String(holder?.pid)}，已 ${Math.round(age)}ms）`,
      }
    }
    sleepSync(2)
  }
}

/**
 * Release a lock this process holds.
 *
 * Only removes the file when the recorded owner is this process: a lock stolen
 * after a stale timeout may legitimately belong to someone else by now, and
 * deleting it would hand out a second concurrent writer.
 *
 * @param {string} lockPath - Path of the lock file.
 * @returns {void}
 */
export function releaseLock(lockPath) {
  try {
    const holder = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (Number(holder?.pid) !== process.pid) return
  } catch {
    // Unreadable: fall through and remove, since we cannot prove it is not ours.
  }
  try {
    unlinkSync(lockPath)
  } catch { /* already gone */ }
}

/**
 * Run a function while holding the ledger's write lock.
 *
 * The function runs in a `finally`, so an exception inside it still releases
 * the lock — a thrown planner must not leave the ledger permanently locked.
 *
 * @template T
 * @param {string} ledgerPath - Ledger path; the lock sits beside it.
 * @param {() => T} fn - Work to perform under the lock.
 * @param {object} [opts] - Forwarded to acquireLock.
 * @returns {{ok: true, value: T} | {ok: false, reason: string}} Result.
 */
export function withLedgerLock(ledgerPath, fn, opts = {}) {
  const lockPath = `${ledgerPath}.lock`
  const got = acquireLock(lockPath, opts)
  if (!got.ok) return { ok: false, reason: got.reason }
  try {
    return { ok: true, value: fn() }
  } finally {
    releaseLock(lockPath)
  }
}

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
