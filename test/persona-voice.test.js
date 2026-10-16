/** Personality affects future wording without rewriting historical records. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLibrary, createOperations, buildIndexText } from '../src/index.js'
import { buildTools } from '../src/tools.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-voice-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const lib = openLibrary(dir)
  let time = 1700000000000
  return { lib, ops: createOperations(lib, { now: () => ++time }) }
}

test('confirmed identity informs new writing without requiring a fixed prefix', (t) => {
  const { lib, ops } = fixture(t)
  const old = ops.write({ text: '旧记忆保持原样' })
  const before = lib.load().events
  const trait = ops.persona({ action: 'propose', text: '测试身份：喜欢简洁、轻松的表达', source_ids: [old.node_id] })
  const accepted = ops.persona({ action: 'accept', id: trait.id, reason: '用户测试确认' })
  assert.match(accepted.note, /写新记忆和说话/)
  assert.match(accepted.note, /保留历史记忆的原样/)
  const text = buildIndexText(lib, 40)
  assert.match(text, /测试身份：喜欢简洁、轻松的表达/)
  assert.match(text, /表达习惯影响新记忆/)
  assert.match(text, /不必每条都加/)
  assert.match(text, /不为角色语气改变判断/)
  assert.deepEqual(lib.load().events.slice(0, before.length), before)
  assert.equal(lib.load().state.nodes.get(old.node_id).text, '旧记忆保持原样')
})

test('reflection retains all confirmed traits even with a small memory budget', (t) => {
  const { ops } = fixture(t)
  const m = ops.write({ text: '测试经历：清晰表达更容易理解' })
  for (let i = 0; i < 4; i++) {
    const p = ops.persona({ action: 'propose', text: `测试特征 ${i}`, source_ids: [m.node_id] })
    assert.equal(ops.persona({ action: 'accept', id: p.id, reason: '测试确认' }).ok, true)
  }
  const candidate = ops.persona({ action: 'propose', text: '测试候选' })
  const r = ops.reflect({ limit: 1 })
  assert.equal(r.memories.length, 1)
  assert.equal(r.persona.filter((p) => p.status === 'active').length, 4)
  assert.ok(r.persona.some((p) => p.id === candidate.id && p.status === 'candidate'))
  assert.match(r.instruction, /persona 列表中的身份/)
  assert.match(r.instruction, /说明冲突和依据/)
})

test('candidate-only and empty libraries do not assume a confirmed identity', (t) => {
  const { lib, ops } = fixture(t)
  assert.equal(ops.reflect({}).persona.length, 0)
  assert.match(ops.reflect({}).instruction, /不要假定身份/)
  ops.persona({ action: 'propose', text: '测试候选：尚未确认的角色' })
  assert.doesNotMatch(buildIndexText(lib, 40), /尚未确认的角色/)
  assert.doesNotMatch(buildIndexText(lib, 40), /已确认的人格（/)
})

test('the write tool communicates natural wording and keeps uncertainty', (t) => {
  const { ops } = fixture(t)
  const tool = buildTools(ops).find((t) => t.name === 'memory_write')
  assert.match(tool.parameters.properties.text.description, /自然口气/)
  assert.match(tool.parameters.properties.text.description, /不确定性/)
})
