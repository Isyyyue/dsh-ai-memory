import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLibrary, createOperations } from '../../src/index.js'

function withOps(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-am-question-'))
  try { return fn(createOperations(openLibrary(dir))) } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('question · 未完成问题生命周期', () => {
  test('open → touch → close 会正确折叠', () => withOps((ops) => {
    const source = ops.write({ text: '依据', subject: 's', relation: 'r', object: '1' })
    const opened = ops.question({ action: 'open', text: '还要验证什么？', source_ids: [source.node_id], urgency: 0.8 })
    assert.equal(opened.ok, true)
    assert.equal(ops.question({ action: 'touch', id: opened.id, note: '做了一次检查' }).ok, true)
    assert.equal(ops.question({ action: 'close', id: opened.id, resolved_by: source.node_id, note: '依据已经足够' }).ok, true)
    const q = ops.question({ action: 'read', status: 'closed' }).questions[0]
    assert.equal(q.status, 'closed'); assert.equal(q.attempts, 1); assert.equal(q.resolvedBy, source.node_id)
  }))

  test('source_ids 指向不存在或已退役节点时拒绝', () => withOps((ops) => {
    assert.equal(ops.question({ action: 'open', text: 'x', source_ids: ['missing'] }).ok, false)
    const first = ops.write({ text: 'old', subject: 's', relation: 'r', object: '1' })
    ops.write({ text: 'new', subject: 's', relation: 'r', object: '2' })
    assert.equal(ops.question({ action: 'open', text: 'x', source_ids: [first.node_id] }).ok, false)
  }))

  test('close / abandon 没有 note 时拒绝', () => withOps((ops) => {
    const q = ops.question({ action: 'open', text: 'x' })
    assert.equal(ops.question({ action: 'close', id: q.id }).ok, false)
    assert.equal(ops.question({ action: 'abandon', id: q.id }).ok, false)
  }))
})
