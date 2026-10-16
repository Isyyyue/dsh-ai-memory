/** Exercise the shipped pointer handlers, including real click jitter. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function renderer() {
  let api
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    .replace("return { name: 'dsh-ai-memory-client', inject: ['slots'], apply }", 'return { GraphRenderer }')
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: ({ factory }) => { api = factory(() => ({})) } } } })
  const selected = []
  const instance = Object.create(api.GraphRenderer.prototype)
  Object.assign(instance, {
    canvas: { addEventListener() {}, setAttribute() {}, removeAttribute() {}, setPointerCapture() {}, releasePointerCapture() {} },
    worker: null, dragNodeId: null, panFrom: null,
    positions: new Map([['test-node', { x: 0, y: 0 }]]),
    handlers: { onSelect: (id) => selected.push(id) },
    hitTest: () => 'test-node', toWorld: (x, y) => ({ x, y }), draw() {},
  })
  instance.bindPointer()
  return { instance, selected }
}

test('a one-pixel pointer movement still selects a node', () => {
  const { instance, selected } = renderer()
  instance.onPointerDown({ clientX: 100, clientY: 100, pointerId: 1 })
  instance.onPointerMove({ clientX: 101, clientY: 100 })
  instance.onPointerUp({ pointerId: 1 })
  assert.deepEqual(selected, ['test-node'])
})

test('a real drag moves the node without opening details', () => {
  const { instance, selected } = renderer()
  instance.onPointerDown({ clientX: 100, clientY: 100, pointerId: 1 })
  instance.onPointerMove({ clientX: 140, clientY: 160 })
  instance.onPointerUp({ pointerId: 1 })
  assert.deepEqual(selected, [])
  assert.equal(instance.positions.get('test-node').x, 140)
  assert.equal(instance.positions.get('test-node').y, 160)
})
