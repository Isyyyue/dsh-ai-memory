import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLibrary, createOperations } from '../src/index.js'

function withOps(fn) { const dir=mkdtempSync(join(tmpdir(),'dsh-am-self-')); try{return fn(createOperations(openLibrary(dir)))}finally{rmSync(dir,{recursive:true,force:true})} }

describe('selfModel · 从账本计算行为模式', () => {
  test('同 subject 被推翻 3/4 会进入 fragile', () => withOps((ops) => {
    for (let i=0;i<4;i+=1) ops.write({ text: '判断 '+i, subject: 'svc', relation: 'port', object: String(i) })
    const model=ops.selfModel(); const item=model.fragile.find((x)=>x.subject==='svc')
    assert.equal(item.n,4); assert.equal(item.overturned,3); assert.equal(item.rate,0.75)
  }))
  test('未连接 tensions 的活跃判断进入 blind', () => withOps((ops) => {
    const r=ops.write({text:'孤立判断'}); const model=ops.selfModel(); assert.ok(model.blind.some((x)=>x.id===r.node_id))
  }))
  test('selfRatio / selfSurvival 和空账本都不会 NaN', () => withOps((ops) => {
    const self=ops.write({text:'自发想法',kind:'insight',trigger:'self',citations:[process.execPath]})
    ops.write({text:'普通判断'})
    const model=ops.selfModel(); assert.equal(model.selfRatio,0.5); assert.equal(model.selfSurvival,1)
    assert.equal(Number.isNaN(model.selfRatio),false)
  }))
})
