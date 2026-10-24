/** Regression tests for destructive edge cases found during deep validation. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLibrary, createOperations } from '../../src/index.js'
import { appendEvents, readLedger } from '../../src/store.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-boundary-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const lib = openLibrary(dir)
  let time = 1700000000000
  return { lib, ops: createOperations(lib, { now: () => ++time }) }
}

test('an incomplete triple cannot retire a complete judgment', (t) => {
  const { lib, ops } = fixture(t)
  const old = ops.write({ text: '端口判断', subject: 'svc', relation: 'port', object: '8000' })
  const next = ops.write({ text: '端口尚待调查', subject: 'svc', relation: 'port' })
  assert.equal(next.action, 'created')
  assert.equal(lib.load().state.nodes.get(old.node_id).status, 'active')
})

test('an insight cannot supersede a judgment even with an accidental triple', (t) => {
  const { lib, ops } = fixture(t)
  const old = ops.write({ text: '端口判断', subject: 'svc', relation: 'port', object: '8000' })
  const next = ops.write({ text: '端口也许不同', kind: 'insight', subject: 'svc', relation: 'port', object: '8080' })
  assert.equal(next.action, 'created')
  assert.equal(lib.load().state.nodes.get(old.node_id).status, 'active')
})

test('a judgment cannot supersede a governed rule sharing its triple', (t) => {
  const { lib, ops } = fixture(t)
  const old = ops.write({ text: '规则', kind: 'rule', subject: 'self', relation: 'style', object: 'concise' })
  ops.write({ text: '判断', subject: 'self', relation: 'style', object: 'verbose' })
  assert.equal(lib.load().state.nodes.get(old.node_id).status, 'active')
})

test('a link hint never recommends the judgment just retired by the write', (t) => {
  const { ops } = fixture(t)
  const old = ops.write({ text: '共享端口判断', subject: 'svc', relation: 'port', object: '8000' })
  const next = ops.write({ text: '共享端口判断更新', subject: 'svc', relation: 'port', object: '8080' })
  assert.equal(next.action, 'supersede')
  assert.ok(!next.link_hint?.includes(old.node_id))
})

test('rule amendment refuses a judgment id without changing the ledger', (t) => {
  const { lib, ops } = fixture(t)
  const old = ops.write({ text: '原始判断' })
  const seq = lib.load().state.seq
  assert.equal(ops.rule({ action: 'amend', id: old.node_id, text: '假规则', reason: '测试' }).ok, false)
  assert.equal(lib.load().state.seq, seq)
})

test('a final line without a newline does not swallow the next append', (t) => {
  const { lib } = fixture(t)
  writeFileSync(lib.ledgerPath, JSON.stringify({ seq: 1, at: 1, type: 'node.created', data: { id: 'first' } }))
  assert.equal(appendEvents(lib.ledgerPath, [{ seq: 2, at: 2, type: 'node.created', data: { id: 'second' } }]).ok, true)
  assert.equal(readLedger(lib.ledgerPath).events.length, 2)
})

test('a truncated final record stays visible as a problem without losing new writes', (t) => {
  const { lib } = fixture(t)
  writeFileSync(lib.ledgerPath, '{"seq":1,')
  assert.equal(appendEvents(lib.ledgerPath, [{ seq: 2, at: 2, type: 'node.created', data: { id: 'second' } }]).ok, true)
  const parsed = readLedger(lib.ledgerPath)
  assert.equal(parsed.events.length, 1)
  assert.equal(parsed.problems.length, 1)
})
