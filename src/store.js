/**
 * 存储层：账本落盘与读回。
 *
 * 三条来自社区实测的设计约束：
 *
 * 1. **文件持真相，索引可重建**。账本是 JSONL 纯文本 —— 人类可读、可 git diff、可 rm。
 *    任何派生数据（图谱、反链、活跃集）都能从账本重算，删掉不丢信息。
 *
 * 2. **防外部手改被覆盖**（viya-memory 的 atomicWrite 模式）。账本可能被人手工编辑
 *    （这是纯文本的代价与好处），所以写入前比对 mtime，别人改过就**报错而不是覆盖**。
 *    比对做两次：写临时文件前、rename 前 —— 覆盖"写临时文件耗时窗口"内的外部改动。
 *
 * 3. **只追加，不重写历史**。除了压缩（compact）之外，绝不重写已有行。
 *    这让"推翻的过程"本身成为可审计的事实。
 */

import { readFileSync, writeFileSync, existsSync, statSync, renameSync, unlinkSync, mkdirSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 账本文件名。 */
export const LEDGER_FILE = 'ledger.jsonl'

/**
 * 解析 JSONL 文本成事件数组。
 *
 * 坏行**不抛异常**，而是收集成 problems —— 一条坏行不该让整个记忆库读不出来。
 * 这与 foldEvents 的容错策略一致。
 *
 * @param {string} text - 文件全文。
 * @returns {{events: object[], problems: object[]}} 事件与解析问题。
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
  // 按 seq 稳定排序：手工编辑可能插错位置，排序让 fold 结果与书写顺序无关。
  events.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
  return { events, problems }
}

/**
 * 序列化事件数组成 JSONL 文本。
 * @param {object[]} events - 事件数组。
 * @returns {string} 以换行结尾的文本。
 */
export function serializeLedger(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '')
}

/**
 * 读账本。文件不存在时返回空账本（首次运行是正常状态，不是错误）。
 *
 * @param {string} filePath - 账本绝对路径。
 * @returns {{events: object[], problems: object[], exists: boolean, mtimeMs: number|undefined}}
 */
export function readLedger(filePath) {
  if (!existsSync(filePath)) return { events: [], problems: [], exists: false, mtimeMs: undefined }
  const text = readFileSync(filePath, 'utf8')
  const { events, problems } = parseLedger(text)
  return { events, problems, exists: true, mtimeMs: statSync(filePath).mtimeMs }
}

/**
 * 原子追加事件（推荐路径：只追加，永不重写历史）。
 *
 * 追加比全量重写安全得多：即使写到一半崩了，最坏情况是最后一行不完整，
 * 前面的历史完好。而重写失败会丢整个文件。
 *
 * @param {string} filePath - 账本绝对路径。
 * @param {object[]} events - 要追加的事件。
 * @returns {{ok: boolean, reason?: string, appended: number}} 结果。
 */
export function appendEvents(filePath, events) {
  if (events.length === 0) return { ok: true, appended: 0 }
  try {
    mkdirSync(dirname(filePath), { recursive: true })
  } catch (err) {
    return { ok: false, reason: `无法建目录：${err.message}`, appended: 0 }
  }
  try {
    appendFileSync(filePath, serializeLedger(events), 'utf8')
    return { ok: true, appended: events.length }
  } catch (err) {
    return { ok: false, reason: `追加失败：${err.message}`, appended: 0 }
  }
}

/**
 * 原子全量写入（仅用于压缩 / 手工修复），带**两次** mtime 检查。
 *
 * 照搬 viya-memory 验证过的模式：临时文件 → 二次检查 → rename。
 * 失败一律报错而不写 —— 宁可拒绝，也不覆盖别人的改动。
 *
 * @param {string} filePath - 目标路径。
 * @param {string} content - 完整内容。
 * @param {number|undefined} expectedMtimeMs - 期望的当前 mtime；undefined 表示不做检查（首次创建）。
 * @returns {{ok: boolean, reason?: string}} 结果。
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

  // 第二次检查：覆盖"写临时文件"这段耗时窗口内的外部改动。
  if (!check()) {
    try { unlinkSync(tmp) } catch { /* 清理失败不掩盖主因 */ }
    return { ok: false, reason: 'stale' }
  }

  try {
    renameSync(tmp, filePath)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* 同上 */ }
    return { ok: false, reason: `rename 失败：${err.message}` }
  }
  return { ok: true }
}
