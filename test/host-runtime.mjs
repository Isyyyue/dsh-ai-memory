/** Exercise the plugin through real DSH services against a disposable ledger.
 * Usage: node test/host-runtime.mjs <DSH source/runtime root>
 * No credentials, model calls or production profile changes are required.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import * as memory from '../src/index.js'

const root = resolve(process.argv[2] ?? process.env.DSH_RUNTIME_ROOT ?? '.')
const load = (path) => import(pathToFileURL(join(root, path)).href)
const source = existsSync(join(root, 'vendor/cordis/lib/index.js'))
const { Context } = await load(source ? 'vendor/cordis/lib/index.js' : 'node_modules/@deepseek-ai/cordis/lib/index.js')
const { default: Tools } = await load(source ? 'packages/core/tools/lib/index.js' : 'node_modules/@deepseek-ai/dsh-tools/lib/index.js')
const { default: Prompt } = await load(source ? 'packages/core/system-prompt/lib/index.js' : 'node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js')
const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-runtime-'))
const ctx = new Context()
let server
let calls = 0
try {
  await ctx.plugin(Prompt)
  await ctx.plugin(Tools)
  await ctx.plugin(memory, { dir })
  assert.equal(ctx.tools.schemas().length, 8)
  const call = async (name, args) => {
    const result = await ctx.tools.execute({ name, arguments: args, callId: `qa-${++calls}`, signal: new AbortController().signal })
    assert.ok(!result.isError, JSON.stringify(result.content))
    return result.value
  }
  const a = await call('memory_write', { text: '测试：鱼的表达应自然', subject: 'fish', relation: 'style', object: 'natural' })
  assert.equal(a.action, 'created')
  const b = await call('memory_write', { text: '测试：鱼的表达应简洁', subject: 'fish', relation: 'style', object: 'concise' })
  assert.equal(b.action, 'supersede')
  assert.equal((await call('memory_history', { id: a.node_id })).chain.length, 2)
  const c = await call('memory_write', { text: '测试：鱼的表达可以使用拟声词' })
  assert.equal((await call('memory_connect', { from: b.node_id, to: c.node_id, type: 'complements' })).ok, true)
  const p = await call('memory_persona', { action: 'propose', text: '测试人格：自然使用鱼类拟声词', source_ids: [c.node_id] })
  assert.ok(p.ok)
  assert.equal((await call('memory_persona', { action: 'accept', id: p.id, reason: '仅测试确认' })).ok, true)
  assert.equal((await call('memory_persona', { action: 'read' })).active.length, 1)
  const reflection = await call('memory_reflect', {})
  assert.ok(reflection.memories.length > 0)
  assert.ok(reflection.persona.some((trait) => trait.id === p.id && trait.status === 'active'))
  assert.match(reflection.instruction, /persona 列表中的身份/)
  assert.equal((await call('memory_search', { query: '拟声词' })).total, 2)
  assert.equal((await call('memory_rule', { action: 'amend', text: '测试规则：核验后再下结论', reason: '测试' })).ok, true)
  assert.equal((await call('memory_stats', {})).persona, 1)
  const assembly = await ctx.systemPrompt.assemble()
  assert.match(JSON.stringify(assembly), /测试人格/)

  // Real HTTP transport exercises the same route handlers as the desktop host.
  const { createRoutes } = await import('../src/routes.js')
  const routes = createRoutes(memory.openLibrary(dir), { maxNodes: 2 })
  server = createServer((req, res) => {
    const route = routes.find((r) => r.path === new URL(req.url, 'http://localhost').pathname)
    if (route) route.handler(req, res)
    else { res.statusCode = 404; res.end() }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}/plugins/dsh-ai-memory`
  assert.equal((await (await fetch(`${base}/stats`)).json()).stats.persona, 1)
  const snap = await (await fetch(`${base}/snapshot`)).json()
  assert.equal(snap.truncated, true)
  assert.equal(snap.nodes.length, 2)
  assert.equal((await (await fetch(`${base}/node?id=${p.id}`)).json()).node.text, '测试人格：自然使用鱼类拟声词')
  assert.equal((await fetch(`${base}/stats`, { headers: { Origin: 'https://example.invalid' } })).status, 403)
  assert.equal((await fetch(`${base}/stats`, { headers: { Origin: new URL(base).origin } })).status, 200)
  assert.equal((await (await fetch(`${base}/node?id=missing`)).json()).ok, false)
  const registry = ctx.tools
  await ctx.fiber.dispose()
  assert.equal(registry.schemas().length, 0)
  console.log(JSON.stringify({ ok: true, toolCalls: calls, tools: 8, httpChecks: 7, lifecycle: 'registered, assembled, disposed', isolated: true }))
} finally {
  if (server) await new Promise((done) => server.close(done))
  await ctx.fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
}
