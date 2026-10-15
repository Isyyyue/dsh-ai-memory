/**
 * WSL 侧的测试服务器：既服务静态文件，也接收测试页 POST 回来的结果。
 *
 * 为什么不用 `python3 -m http.server`：那个不支持 POST。
 * 有了它，就不必每次让 REA 返回一大坨 base64 截图 —— 直接读结果文件即可。
 *
 * 用法：node _wsl-serve.cjs <root> <port>
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const root = process.argv[2] || process.cwd()
const port = Number(process.argv[3] || 18888)
const RESULT = '/tmp/am-result.json'

http.createServer((req, res) => {
  // 测试页把结果 POST 到这里
  if (req.method === 'POST' && req.url === '/_result') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      try {
        fs.writeFileSync(RESULT, body)
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
      } catch (e) {
        res.writeHead(500)
        res.end(String(e))
      }
    })
    return
  }

  const rel = decodeURIComponent((req.url || '/').split('?')[0])
  const p = path.join(root, rel)
  fs.readFile(p, (e, b) => {
    if (e) {
      res.writeHead(404)
      res.end('404')
      return
    }
    const x = path.extname(p)
    res.writeHead(200, {
      'content-type': x === '.html' ? 'text/html; charset=utf-8'
        : x === '.js' ? 'text/javascript; charset=utf-8' : 'text/plain',
    })
    res.end(b)
  })
}).listen(port, '127.0.0.1', () => console.log('ready on ' + port))
