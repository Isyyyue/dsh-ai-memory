import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLibrary, createOperations } from '../src/index.js'

function withOps(fn) { const dir=mkdtempSync(join(tmpdir(),'dsh-am-cycle-')); try{return fn(createOperations(openLibrary(dir)))}finally{rmSync(dir,{recursive:true,force:true})} }

describe('cycle · 思考周期', () => {
  test('begin 按压力返回 focus，end produced=0 成功', () => withOps((ops) => {
    ops.question({ action: 'open', text: '低优先级', urgency: 0.2, confidence: 0.2 })
    const important = ops.question({ action: 'open', text: '高优先级', urgency: 1, confidence: 0 })
    const began = ops.cycle({ action: 'begin', trigger: 'self' })
    assert.equal(began.ok, true); assert.equal(began.focus[0].id, important.id)
    const ended = ops.cycle({ action: 'end', id: began.id, produced: 0 })
    assert.equal(ended.ok, true); assert.equal(ended.produced, 0)
  }))

  test('没有 open 问题时 begin 仍成功但 focus 为空', () => withOps((ops) => {
    const began = ops.cycle({ action: 'begin', trigger: 'self' })
    assert.equal(began.ok, true); assert.deepEqual(began.focus, [])
  }))

  test('cycle.started 的 self trigger 会折叠保存', () => withOps((ops) => {
    const began = ops.cycle({ action: 'begin', trigger: 'self' })
    const cycle = ops.cycle({ action: 'read' }).cycles.find((x) => x.id === began.id)
    assert.equal(cycle.trigger, 'self')
  }))
})
