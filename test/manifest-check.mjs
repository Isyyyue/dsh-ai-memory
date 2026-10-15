/**
 * 清单与语法的自查（官方 verification.md 在无浏览器控制时要求的验证范围）。
 *
 * 只做三件允许的事：JavaScript 语法、清单校验、以及调用方另行查询的活 Client 槽位。
 * **不做**：模拟 React/DOM、找渲染器、抽 SVG 预览、截图 —— 官方明确禁止用这些替代真实验证。
 */

import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let fails = 0
/** 断言并打印。 */
function check(label, cond, extra = '') {
  if (cond) console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`)
  else {
    fails += 1
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

console.log('\n【语法】')
for (const rel of ['src/index.js', 'src/ledger.js', 'src/supersede.js', 'src/store.js', 'src/query.js', 'src/graph.js', 'src/tools.js', 'src/routes.js', 'lib/client.js']) {
  const p = join(root, rel)
  let ok = true
  let msg = ''
  try {
    execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' })
  } catch (err) {
    ok = false
    msg = String(err.stderr ?? err.message).split('\n')[0]
  }
  check(rel, ok, msg)
}

console.log('\n【清单】')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check('name 是 dsh-ai-memory', pkg.name === 'dsh-ai-memory')
check('type = module', pkg.type === 'module')
check('dsh.bundle.patch 指向存在的文件', existsSync(join(root, pkg.dsh.bundle.patch)), pkg.dsh.bundle.patch)
check('dsh.client.platform = web', pkg.dsh.client.platform === 'web')
check('exports["./client"] 指向真文件', existsSync(join(root, pkg.exports['./client'])), pkg.exports['./client'])
check('exports["."] 指向真文件', existsSync(join(root, pkg.exports['.'])), pkg.exports['.'])
check('files 含 lib/（客户端半边要打包进去）', pkg.files.includes('lib/'))
check('files 含 src/', pkg.files.includes('src/'))
check('cordis.patch.yml 存在', existsSync(join(root, 'cordis.patch.yml')))
check('README.md 存在', existsSync(join(root, 'README.md')))
check('LICENSE 存在', existsSync(join(root, 'LICENSE')))
// MAINTAINING.md is intentionally NOT shipped (it is a maintainer-only log,
// see .gitignore). If it is present locally, it must still be parseable.
if (existsSync(join(root, 'MAINTAINING.md'))) {
  check('MAINTAINING.md 非空（本地维护日志）', readFileSync(join(root, 'MAINTAINING.md'), 'utf8').length > 1000)
}

console.log('\n【dsh.requires 声明（自检脚本读这个）】')
const req = pkg.dsh.requires
check('有 tested 版本', typeof req.tested === 'string' && req.tested !== '')
check('checks 是数组且非空', Array.isArray(req.checks) && req.checks.length > 0, `${req.checks.length} 条`)
const kinds = new Set(['profileDep', 'clientBundle', 'patchRow', 'http', 'httpFields', 'process', 'patchMarker'])
const unknown = req.checks.map((c) => c.kind).filter((k) => !kinds.has(k))
check('所有 check kind 都在脚本词汇表内', unknown.length === 0, unknown.join(', '))
const httpChecks = req.checks.filter((c) => c.kind === 'http' || c.kind === 'httpFields')
check('http 类检查都带 path', httpChecks.every((c) => typeof c.path === 'string' && c.path.startsWith('/plugins/dsh-ai-memory/')), httpChecks.map((c) => c.path).join(', '))

console.log('\n【客户端半边不含硬约束违规】')
const client = readFileSync(join(root, 'lib/client.js'), 'utf8')
/** 去掉注释后再做"代码里有没有用 X"的判断（文档注释里会专门记录这些坑）。 */
const clientCode = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
check('不 require Harness Client 包', !/require\(['"]@deepseek-ai/.test(client))
check('不碰页面主体（不往 document.body 挂 DOM）', !/document\.body/.test(client))
check('不嵌 iframe', !/createElement\(['"]iframe['"]/.test(client))
check('不读别的插件的 DOM（只允许查 script 标签或自己的 style 标记）', (() => {
  const queries = [...client.matchAll(/querySelector(?:All)?\(\s*([^)]*)\)/g)].map((m) => m[1])
  return queries.every((q) => /script|data-plugin="dsh-ai-memory"/i.test(q))
})())

// ⚠️ 这一段被**两次**纠正过，记下来免得再来一遍：
//
//   第一次（本鲸错）：以为要用 `<style>` 直插，写断言"不许读 ctx.styles"。
//   第二次（本鲸又错）：看到官方 Builtin 清单里有 `styles`，改成断言"必须用 styles.insert"。
//                      —— 但**清单列的是能力声明，不等于当前版本提供了该服务**。
//                      DeepSeek Harness 0.2.0-rc.2 **不提供**客户端 `styles` 服务。
//
// 真相（主人定位，且经真实 Chrome 复现验证）：
//   `ctx` 是**受限 Proxy**，读一个没 inject 的服务名会**抛错**（不是返回 undefined）。
//   所以 `if (ctx.styles !== undefined)` 这种"安全判断"**本身就是抛点** →
//   apply 抛 → fiber=FAILED → 宿主启动审计拒绝启动**整个应用**
//   （`web boot: 1 entry did not activate / dsh-ai-memory: failed`）。
//
// 正确做法：照 `dsh-downloads-panel`（一直能用）直插带 `data-plugin` 标记的 `<style>`，
// 用容器自己的 `ownerDocument`，并整段包 try/catch。
check('**不读 ctx.styles**（该服务在 0.2.0-rc.2 上不存在，读它会抛）', !/ctx\.styles/.test(clientCode))
check('不调用 styles.insert', !/styles\.insert/.test(clientCode))
check('样式用带 data-plugin 标记的 <style> 直插', /data-plugin="dsh-ai-memory"/.test(client))
check('ensureStyles 真的被调用了（定义了不调用 = 裸 HTML 且不报错）', (client.match(/ensureStyles\(/g) ?? []).length >= 2)
check('样式注入用容器自己的 document', /ensureStyles\(canvas\.ownerDocument\)/.test(client))
check('样式注入自己吞异常（取不到不该让面板消失）', (() => {
  const start = client.indexOf('function ensureStyles')
  const body = client.slice(start, start + 700)
  return /try\s*\{/.test(body) && /catch/.test(body)
})())
check('apply 里只碰 ctx.slots（唯一声明过的服务）', (() => {
  const applyBody = clientCode.slice(clientCode.indexOf('function apply(ctx)'))
  const used = [...applyBody.matchAll(/ctx\.(\w+)/g)].map((m) => m[1])
  return [...new Set(used)].join(',') === 'slots'
})())

console.log('\n【Canvas + Worker 架构】')
const worker = readFileSync(join(root, 'lib/client.graph-worker.js'), 'utf8')
/** 同样去掉注释再做判断（注释里会专门提到"不用 Math.random"这类话）。 */
const workerCode = worker.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
check('worker 文件名符合 client-modules 分块约定', /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test('client.graph-worker.js'))
check('worker 是独立脚本（不 import，Worker 里没有模块解析）', !/^\s*import\s/m.test(worker))
check('worker 有 onmessage 入口', /self\.onmessage\s*=/.test(worker))
check('worker 用 setTimeout 推进（不是 rAF —— Worker 里没有 rAF）', /setTimeout/.test(workerCode) && !/requestAnimationFrame/.test(workerCode))
check('worker 用确定性哈希做初始布局（不用 Math.random）', /hash32/.test(workerCode) && !/Math\.random/.test(workerCode))
check('客户端用 Canvas 2D 画图', /getContext\(['"]2d['"]\)/.test(client))
check('客户端有连续动画循环', /requestAnimationFrame/.test(client) && /cancelAnimationFrame/.test(client))
check('客户端卸载时终止 worker', /terminate\(\)/.test(client))

console.log(`\n${'='.repeat(56)}`)
if (fails > 0) {
  console.log(`清单自查失败 ${fails} 项`)
  process.exit(1)
}
console.log('清单自查全部通过 ✓')
console.log('\n注：视觉验证（面板实际渲染成什么样）在无浏览器控制时不可用，')
console.log('    按官方 verification.md 的要求，此项如实标注为未验证。')
