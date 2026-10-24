/**
 * 验证注入内容与 HTTP 路由。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const P = join(import.meta.dirname, '..', '..').replace(/\\\\/g, '/')
const { openLibrary, createOperations, buildIndexText } = await import(`file://${P}/src/index.js`)
const { createRoutes } = await import(`file://${P}/src/routes.js`)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  ← ${detail}`}`)
  if (ok) pass += 1
  else fail += 1
}

const dir = mkdtempSync(join(tmpdir(), 'aimem-inject-'))
let clock = 1730000000000
const lib = openLibrary(dir)
const ops = createOperations(lib, { now: () => (clock += 60000) })

console.log('=== 注入：空账本 ===')
const empty = buildIndexText(lib, 40)
check('空账本不崩', typeof empty === 'string' && empty.length > 0)
check('空账本有写入指引', empty.includes('memory_write'), '缺写入指引')

console.log('')
console.log('=== 注入：有未完成问题时出现对应段落 ===')
ops.question({ action: 'open', text: '为什么静默失效更危险？', urgency: 0.9, confidence: 0.2 })
const withQ = buildIndexText(lib, 40)
check('出现【你上次没想完的事】', withQ.includes('没想完'), withQ.slice(0, 200))
check('问题正文进入注入', withQ.includes('静默失效'))

console.log('')
console.log('=== 注入：没有问题时不出现该段落（不写"暂无"这类噪音）===')
const dir2 = mkdtempSync(join(tmpdir(), 'aimem-noq-'))
const lib2 = openLibrary(dir2)
const ops2 = createOperations(lib2, { now: () => (clock += 60000) })
ops2.write({ text: '一条判断', subject: 'a', relation: 'b', object: '1' })
const noQ = buildIndexText(lib2, 40)
check('没有问题时不出现该段落', !noQ.includes('没想完'), '空段落不该出现')

console.log('')
console.log('=== 注入：规矩受 maxEntries 限制 ===')
for (let i = 0; i < 30; i += 1) {
  ops2.rule({ action: 'amend', id: 'nope', text: `第 ${i} 条规矩 ` + '内容'.repeat(20), reason: '压测' })
}
const capped = buildIndexText(lib2, 5)
const ruleLines = capped.split('\n').filter((l) => l.startsWith('- [')).length
check(`规矩行数受 maxEntries=5 约束（实际 ${ruleLines} 行）`, ruleLines <= 6, `共 ${ruleLines} 行`)

console.log('')
console.log('=== 注入：账本问题必须显示（不能静默）===')
const dir3 = mkdtempSync(join(tmpdir(), 'aimem-prob-'))
const { appendFileSync } = await import('node:fs')
const lib3 = openLibrary(dir3)
appendFileSync(join(dir3, 'ledger.jsonl'),
  JSON.stringify({ seq: 1, at: 1, type: 'node.created', data: { id: 'x', kind: 'bogus_kind', text: 't' } }) + '\n')
const probText = buildIndexText(lib3, 40)
check('账本问题出现在注入里', probText.includes('bogus_kind') || /问题|problem/i.test(probText), probText.slice(0, 300))

console.log('')
console.log('=== 路由：questions 端点 ===')
const routes = createRoutes(lib)
const qRoute = routes.find((r) => r.path.includes('/questions'))
check('存在 /questions 路由', qRoute !== undefined, routes.map((r) => r.path).join(', '))

if (qRoute) {
  // 假 req/res
  const mk = (remoteAddress, origin) => {
    const res = {
      statusCode: 0, headers: {}, body: '',
      setHeader(k, v) { this.headers[k] = v },
      end(b) { this.body = b },
    }
    const req = {
      socket: { remoteAddress },
      headers: { host: '127.0.0.1:1234', ...(origin ? { origin } : {}) },
      url: '/plugins/dsh-ai-memory/questions',
    }
    return { req, res }
  }

  const ok = mk('127.0.0.1')
  qRoute.handler(ok.req, ok.res)
  check('回环请求返回 200', ok.res.statusCode === 200, `实际 ${ok.res.statusCode}`)
  let body = null
  try { body = JSON.parse(ok.res.body) } catch { /* ignore */ }
  check('返回 JSON 且 ok=true', body !== null && body.ok === true, ok.res.body.slice(0, 150))
  check('返回 questions 数组', body !== null && Array.isArray(body.questions), Object.keys(body ?? {}).join(','))

  const remote = mk('10.0.0.5')
  qRoute.handler(remote.req, remote.res)
  check('非回环请求被拒（403）', remote.res.statusCode === 403, `实际 ${remote.res.statusCode}`)

  const cross = mk('127.0.0.1', 'http://evil.example')
  qRoute.handler(cross.req, cross.res)
  check('跨源请求被拒（403）', cross.res.statusCode === 403, `实际 ${cross.res.statusCode}`)
}

console.log('')
console.log('=== 结果 ===')
console.log(`${pass} 通过, ${fail} 失败`)
for (const d of [dir, dir2, dir3]) rmSync(d, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
