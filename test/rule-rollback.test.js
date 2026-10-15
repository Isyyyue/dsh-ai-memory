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

import { openLibrary, createOperations } from '../src/index.js'
import { buildTools } from '../src/tools.js'

/** Build a temporary store and its operation set. */
function fresh() {
  const work = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-rule-'))
  let t = 1_700_000_000_000
  const ops = createOperations(openLibrary(join(work, 'lib')), { now: () => (t += 60_000) })
  return { ops, work, done: () => { try { rmSync(work, { recursive: true, force: true }) } catch { /* ignore */ } } }
}

describe('rule · rollback', () => {
  test('a rollback must carry a reason (a rollback is a change too)', () => {
    const { ops, done } = fresh()
    try {
      const made = ops.rule({ action: 'amend', id: 'r1', text: '\u7b2c\u4e00\u7248', reason: '\u5efa\u7acb' })
      const id = made.rules[0].id
      ops.rule({ action: 'amend', id, text: '\u7b2c\u4e8c\u7248', reason: '\u6539' })
      const r = ops.rule({ action: 'rollback', id, to_revision: 1, reason: '' })
      assert.equal(r.ok, false)
      assert.match(r.note, /reason/)
    } finally { done() }
  })

  test('a rollback must carry a valid to_revision', () => {
    const { ops, done } = fresh()
    try {
      const made = ops.rule({ action: 'amend', id: 'r1', text: '\u7b2c\u4e00\u7248', reason: '\u5efa\u7acb' })
      const id = made.rules[0].id
      for (const bad of [undefined, 0, -1, 1.5, 'abc']) {
        const r = ops.rule({ action: 'rollback', id, to_revision: bad, reason: '\u8bd5' })
        assert.equal(r.ok, false, `to_revision=${String(bad)} must be refused`)
      }
    } finally { done() }
  })

  test('rolling back to a nonexistent revision → refused explicitly, with the actual revision count', () => {
    const { ops, done } = fresh()
    try {
      const made = ops.rule({ action: 'amend', id: 'r1', text: '\u7b2c\u4e00\u7248', reason: '\u5efa\u7acb' })
      const id = made.rules[0].id
      const r = ops.rule({ action: 'rollback', id, to_revision: 5, reason: '\u8bd5' })
      assert.equal(r.ok, false)
      assert.match(r.note, /only 1 revision/)
    } finally { done() }
  })

  test('rolling back to the current revision → says plainly that there is nothing to roll back (no empty change)', () => {
    const { ops, done } = fresh()
    try {
      const made = ops.rule({ action: 'amend', id: 'r1', text: '\u7b2c\u4e00\u7248', reason: '\u5efa\u7acb' })
      const id = made.rules[0].id
      const r = ops.rule({ action: 'rollback', id, to_revision: 1, reason: '\u8bd5' })
      assert.equal(r.ok, false)
      assert.match(r.note, /nothing to roll back/)
    } finally { done() }
  })

  test('**core**: a rollback really restores the older content', () => {
    const { ops, done } = fresh()
    try {
      const made = ops.rule({ action: 'amend', id: 'r1', text: '\u7b2c\u4e00\u7248\u5185\u5bb9', reason: '\u5efa\u7acb' })
      const id = made.rules[0].id
      ops.rule({ action: 'amend', id, text: '\u7b2c\u4e8c\u7248\u5185\u5bb9', reason: '\u6539\u574f\u4e86' })
      const r = ops.rule({ action: 'rollback', id, to_revision: 1, reason: '\u7b2c\u4e8c\u7248\u592a\u5bbd' })
      assert.equal(r.ok, true)
      assert.equal(r.rules[0].text, '\u7b2c\u4e00\u7248\u5185\u5bb9', 'the content is back to revision one')
      assert.equal(r.rules[0].revision, 3, 'a rollback is a new change, so the revision number advances to 3')
    } finally { done() }
  })

  test('**core**: a rollback leaves no gap — history is preserved in full (auditable)', () => {
    const { ops, done } = fresh()
    try {
      const made = ops.rule({ action: 'amend', id: 'r1', text: 'A', reason: '\u5efa\u7acb' })
      const id = made.rules[0].id
      ops.rule({ action: 'amend', id, text: 'B', reason: '\u6539\u6210 B' })
      ops.rule({ action: 'amend', id, text: 'C', reason: '\u6539\u6210 C' })
      ops.rule({ action: 'rollback', id, to_revision: 1, reason: '\u56de\u5230 A' })
      const read = ops.rule({ action: 'read' })
      const h = read.rules[0].history
      assert.ok(h.length >= 4, `history must retain every change; actual ${h.length} entries`)
      // The intermediate revisions are still in history — the rollback did not wipe them.
      assert.ok(h.some((line) => line.includes('\u6539\u6210 B')), "B's change reason is still there")
      assert.ok(h.some((line) => line.includes('\u6539\u6210 C')), "C's change reason is still there")
      assert.ok(h.some((line) => line.includes('\u56de\u5230 A')), 'the rollback itself is on record too')
    } finally { done() }
  })

  test('rollback after rollback (switching back and forth both hold)', () => {
    const { ops, done } = fresh()
    try {
      const made = ops.rule({ action: 'amend', id: 'r1', text: 'v1', reason: '\u5efa\u7acb' })
      const id = made.rules[0].id
      ops.rule({ action: 'amend', id, text: 'v2', reason: '\u6539' })
      ops.rule({ action: 'rollback', id, to_revision: 1, reason: '\u56de v1' })
      assert.equal(ops.rule({ action: 'read' }).rules[0].text, 'v1')
      // Revision 2 is v2 now, so rolling back to it must land on v2.
      ops.rule({ action: 'rollback', id, to_revision: 2, reason: '\u518d\u56de v2' })
      assert.equal(ops.rule({ action: 'read' }).rules[0].text, 'v2', 'an intermediate revision is reachable')
    } finally { done() }
  })

  test('rolling back a nonexistent rule → refused explicitly', () => {
    const { ops, done } = fresh()
    try {
      const r = ops.rule({ action: 'rollback', id: 'ghost', to_revision: 1, reason: '\u8bd5' })
      assert.equal(r.ok, false)
      assert.match(r.note, /No rule/)
    } finally { done() }
  })

  test('rolling back a **judgment** (not a rule) → refused, and it says only kind=rule is covered', () => {
    const { ops, done } = fresh()
    try {
      const j = ops.write({ text: '\u4e00\u6761\u5224\u65ad' })
      const r = ops.rule({ action: 'rollback', id: j.node_id, to_revision: 1, reason: '\u8bd5' })
      assert.equal(r.ok, false)
      assert.match(r.note, /is not a rule/)
    } finally { done() }
  })

  test('an unrecognized action → refused, listing the three supported ones', () => {
    const { ops, done } = fresh()
    try {
      const r = ops.rule({ action: 'destroy' })
      assert.equal(r.ok, false)
      assert.match(r.note, /read.*amend.*rollback/)
    } finally { done() }
  })
})

describe('rule · declaration matches behaviour (guarding against "declared but not implemented")', () => {
  test('all three actions promised in the description are really implemented', () => {
    const { ops, done } = fresh()
    try {
      const tools = buildTools(ops)
      const ruleTool = tools.find((t) => t.name === 'memory_rule')
      // Extract the promised action names from the description.
      const promised = ['read', 'amend', 'rollback'].filter((a) => ruleTool.description.includes(a))
      assert.equal(promised.length, 3, 'the description must promise three actions')

      const made = ops.rule({ action: 'amend', id: 'r1', text: 'X', reason: '\u5efa\u7acb' })
      const id = made.rules[0].id
      ops.rule({ action: 'amend', id, text: 'Y', reason: '\u6539' })

      // All three really work (none returns "Unknown action").
      for (const action of promised) {
        const args = action === 'rollback' ? { action, id, to_revision: 1, reason: '\u8bd5' } : { action, id, text: 'Z', reason: '\u8bd5' }
        const r = ops.rule(args)
        assert.ok(!/Unknown action/.test(r.note), `${action} must be implemented; actual: ${r.note}`)
      }
    } finally { done() }
  })

  test('the to_revision parameter really is declared in the tool schema', () => {
    const { ops, done } = fresh()
    try {
      const ruleTool = buildTools(ops).find((t) => t.name === 'memory_rule')
      assert.ok(ruleTool.parameters.properties.to_revision, 'the schema must carry to_revision')
      assert.equal(ruleTool.parameters.properties.to_revision.type, 'integer')
    } finally { done() }
  })

  test('"rollback" in the description is not an empty promise — verified through the whole chain', () => {
    const { ops, done } = fresh()
    try {
      const ruleTool = buildTools(ops).find((t) => t.name === 'memory_rule')
      const made = ruleTool.execute({ action: 'amend', id: 'r1', text: '\u539f\u59cb', reason: '\u5efa\u7acb' })
      const id = made.rules[0].id
      ruleTool.execute({ action: 'amend', id, text: '\u88ab\u6539\u574f\u4e86', reason: '\u624b\u6ed1' })
      const rolled = ruleTool.execute({ action: 'rollback', id, to_revision: 1, reason: '\u6062\u590d' })
      assert.equal(rolled.ok, true)
      assert.equal(rolled.rules[0].text, '\u539f\u59cb', 'the rollback really works through the tool layer too')
    } finally { done() }
  })
})
