/**
 * Tests for rule rollback.
 *
 * Why it is tested on its own: the tool description promised "rollback-able", but
 * rollback was originally **not implemented** — a declaration that did not match
 * behaviour, the exact class of problem this project objects to most. Once it was
 * added, a test had to hold it in place; otherwise the next change turns the
 * declaration back into an empty promise.
 *
 * Core design: **a rollback is itself a new change** — it also records a reason and
 * also enters history. History is never deleted, consistent with the ledger's
 * append-only principle.
 *
 * Note: the Chinese fixture strings below are kept byte-identical and written as
 * `\u` escapes, which keeps this source ASCII-only. They stand in for arbitrary
 * rule bodies and change reasons, and the assertions that read them back are
 * matched to the same escapes.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openLibrary, createOperations } from '../../src/index.js'
import { buildTools } from '../../src/tools.js'

/** Build a temporary store and its operation set. */
function fresh() {
  const work = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-rule-'))
  let t = 1_700_000_000_000
  const ops = createOperations(openLibrary(join(work, 'lib')), { now: () => (t += 60_000) })
  return { ops, work, done: () => { try { rmSync(work, { recursive: true, force: true }) } catch { /* ignore */ } } }
}

describe('规矩 · 回滚', () => {
  test('回滚必须给 reason（回滚也是一次变更）', () => {
    const { ops, done } = fresh()
    try {
      const made = ops.rule({ action: 'amend', id: 'r1', text: '第一版', reason: '建立' })
      const id = made.rules[0].id
      ops.rule({ action: 'amend', id, text: '第二版', reason: '改' })
      const r = ops.rule({ action: 'rollback', id, to_revision: 1, reason: '' })
      assert.equal(r.ok, false)
      assert.match(r.note, /reason/)
    } finally { done() }
  })

  test('回滚必须给合法的 to_revision', () => {
    const { ops, done } = fresh()
    try {
      const made = ops.rule({ action: 'amend', id: 'r1', text: '第一版', reason: '建立' })
      const id = made.rules[0].id
      for (const bad of [undefined, 0, -1, 1.5, 'abc']) {
        const r = ops.rule({ action: 'rollback', id, to_revision: bad, reason: '试' })
        assert.equal(r.ok, false, `to_revision=${String(bad)} 应当被拒`)
      }
    } finally { done() }
  })

  test('回滚到不存在的版本 → 明确拒绝并告知实际版本数', () => {
    const { ops, done } = fresh()
    try {
      const made = ops.rule({ action: 'amend', id: 'r1', text: '第一版', reason: '建立' })
      const id = made.rules[0].id
      const r = ops.rule({ action: 'rollback', id, to_revision: 5, reason: '试' })
      assert.equal(r.ok, false)
      assert.match(r.note, /只有 1 版/)
    } finally { done() }
  })

  test('回滚到当前版本 → 明确说无需回滚（不制造空变更）', () => {
    const { ops, done } = fresh()
    try {
      const made = ops.rule({ action: 'amend', id: 'r1', text: '第一版', reason: '建立' })
      const id = made.rules[0].id
      const r = ops.rule({ action: 'rollback', id, to_revision: 1, reason: '试' })
      assert.equal(r.ok, false)
      assert.match(r.note, /无需回滚/)
    } finally { done() }
  })

  test('**核心**：回滚真的把内容恢复成旧版本', () => {
    const { ops, done } = fresh()
    try {
      const made = ops.rule({ action: 'amend', id: 'r1', text: '第一版内容', reason: '建立' })
      const id = made.rules[0].id
      ops.rule({ action: 'amend', id, text: '第二版内容', reason: '改坏了' })
      const r = ops.rule({ action: 'rollback', id, to_revision: 1, reason: '第二版太宽' })
      assert.equal(r.ok, true)
      assert.equal(r.rules[0].text, '第一版内容', '内容回到第一版')
      assert.equal(r.rules[0].revision, 3, '回滚是一次新变更，所以版本号前进到 3')
    } finally { done() }
  })

  test('**核心**：回滚不留白 —— 历史完整保留（可审计）', () => {
    const { ops, done } = fresh()
    try {
      const made = ops.rule({ action: 'amend', id: 'r1', text: 'A', reason: '建立' })
      const id = made.rules[0].id
      ops.rule({ action: 'amend', id, text: 'B', reason: '改成 B' })
      ops.rule({ action: 'amend', id, text: 'C', reason: '改成 C' })
      ops.rule({ action: 'rollback', id, to_revision: 1, reason: '回到 A' })
      const read = ops.rule({ action: 'read' })
      const h = read.rules[0].history
      assert.ok(h.length >= 4, `历史应当保留全部变更，实际 ${h.length} 条`)
      // The intermediate revisions are still in history — the rollback did not wipe them.
      assert.ok(h.some((line) => line.includes('改成 B')), 'B 的变更理由还在')
      assert.ok(h.some((line) => line.includes('改成 C')), 'C 的变更理由还在')
      assert.ok(h.some((line) => line.includes('回到 A')), '回滚本身也留痕')
    } finally { done() }
  })

  test('回滚后再回滚（来回切换都成立）', () => {
    const { ops, done } = fresh()
    try {
      const made = ops.rule({ action: 'amend', id: 'r1', text: 'v1', reason: '建立' })
      const id = made.rules[0].id
      ops.rule({ action: 'amend', id, text: 'v2', reason: '改' })
      ops.rule({ action: 'rollback', id, to_revision: 1, reason: '回 v1' })
      assert.equal(ops.rule({ action: 'read' }).rules[0].text, 'v1')
      // Revision 2 is v2 now, so rolling back to it must land on v2.
      ops.rule({ action: 'rollback', id, to_revision: 2, reason: '再回 v2' })
      assert.equal(ops.rule({ action: 'read' }).rules[0].text, 'v2', '能回到中间版本')
    } finally { done() }
  })

  test('回滚不存在的规矩 → 明确拒绝', () => {
    const { ops, done } = fresh()
    try {
      const r = ops.rule({ action: 'rollback', id: 'ghost', to_revision: 1, reason: '试' })
      assert.equal(r.ok, false)
      assert.match(r.note, /找不到/)
    } finally { done() }
  })

  test('回滚一条**判断**（非规矩）→ 拒绝，并说明只管 kind=rule', () => {
    const { ops, done } = fresh()
    try {
      const j = ops.write({ text: '一条判断' })
      const r = ops.rule({ action: 'rollback', id: j.node_id, to_revision: 1, reason: '试' })
      assert.equal(r.ok, false)
      assert.match(r.note, /不是规矩/)
    } finally { done() }
  })

  test('不认识的 action → 拒绝并列出支持的三个', () => {
    const { ops, done } = fresh()
    try {
      const r = ops.rule({ action: 'destroy' })
      assert.equal(r.ok, false)
      assert.match(r.note, /read.*amend.*rollback/)
    } finally { done() }
  })
})

describe('规矩 · 声明与行为一致（防"声明了没实现"）', () => {
  test('description 里承诺的三种 action 都真的实现了', () => {
    const { ops, done } = fresh()
    try {
      const tools = buildTools(ops)
      const ruleTool = tools.find((t) => t.name === 'memory_rule')
      // Extract the promised action names from the description.
      const promised = ['read', 'amend', 'rollback'].filter((a) => ruleTool.description.includes(a))
      assert.equal(promised.length, 3, 'description 应当承诺三种 action')

      const made = ops.rule({ action: 'amend', id: 'r1', text: 'X', reason: '建立' })
      const id = made.rules[0].id
      ops.rule({ action: 'amend', id, text: 'Y', reason: '改' })

      // All three really work (none returns "Unknown action").
      for (const action of promised) {
        const args = action === 'rollback' ? { action, id, to_revision: 1, reason: '试' } : { action, id, text: 'Z', reason: '试' }
        const r = ops.rule(args)
        assert.ok(!/不认识的 action/.test(r.note), `${action} 应当被实现，实际：${r.note}`)
      }
    } finally { done() }
  })

  test('to_revision 参数真的在工具 schema 里声明', () => {
    const { ops, done } = fresh()
    try {
      const ruleTool = buildTools(ops).find((t) => t.name === 'memory_rule')
      assert.ok(ruleTool.parameters.properties.to_revision, 'schema 里必须有 to_revision')
      assert.equal(ruleTool.parameters.properties.to_revision.type, 'integer')
    } finally { done() }
  })

  test('description 里的 "rollback" 不是空话 —— 走完整条链路验证', () => {
    const { ops, done } = fresh()
    try {
      const ruleTool = buildTools(ops).find((t) => t.name === 'memory_rule')
      const made = ruleTool.execute({ action: 'amend', id: 'r1', text: '原始', reason: '建立' })
      const id = made.rules[0].id
      ruleTool.execute({ action: 'amend', id, text: '被改坏了', reason: '手滑' })
      const rolled = ruleTool.execute({ action: 'rollback', id, to_revision: 1, reason: '恢复' })
      assert.equal(rolled.ok, true)
      assert.equal(rolled.rules[0].text, '原始', '经过工具层也能真正回滚')
    } finally { done() }
  })
})
