/**
 * 用 CDP 深入检查一个页面：stage 内容、未捕获异常、console 输出。
 * 用法：node _cdp-deep.mjs <cdpBase> <pageUrl> [等待毫秒]
 */

const cdpBase = process.argv[2] ?? 'http://127.0.0.1:19555'
const pageUrl = process.argv[3]
const waitMs = Number(process.argv[4] ?? 7000)

const list = await (await fetch(`${cdpBase}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (page === undefined) throw new Error('找不到 page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const events = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id !== undefined && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  } else if (m.method !== undefined) {
    events.push(m)
  }
})
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
const send = (method, params = {}) =>
  new Promise((res) => {
    id += 1
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })

await send('Runtime.enable')
await send('Page.enable')
await send('Log.enable')
await send('Page.navigate', { url: pageUrl })
await new Promise((r) => setTimeout(r, waitMs))

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  if (r.result?.exceptionDetails) return `«求值抛错: ${r.result.exceptionDetails.text}»`
  return r.result?.result?.value
}

console.log('URL        :', await ev('location.href'))
console.log('标题       :', await ev('document.title'))
console.log('结果       :', await ev("document.getElementById('result') ? document.getElementById('result').textContent : null"))
console.log('stage 长度 :', await ev("document.getElementById('stage') ? document.getElementById('stage').innerHTML.length : null"))
console.log('stage 内容 :', await ev("document.getElementById('stage') ? document.getElementById('stage').innerHTML.slice(0, 500) : null"))
console.log('canvas 数  :', await ev("document.querySelectorAll('canvas').length"))

const errs = events
  .filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text)
if (errs.length > 0) {
  console.log('\n--- 未捕获异常 ---')
  for (const e of errs) console.log(e)
}

const cons = events
  .filter((e) => e.method === 'Runtime.consoleAPICalled')
  .map((e) => `[${e.params.type}] ${e.params.args.map((a) => a.value ?? a.description).join(' ')}`)
if (cons.length > 0) {
  console.log('\n--- console ---')
  for (const e of cons.slice(0, 12)) console.log(e)
}

console.log('\n--- 页面内日志 ---')
console.log(await ev("document.getElementById('log') ? document.getElementById('log').textContent : '(无)'"))

ws.close()
