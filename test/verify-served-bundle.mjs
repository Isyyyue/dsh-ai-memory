/**
 * Assert that the client bundle **the host is actually serving** contains every critical fix.
 *
 * Why this is separate: nearly every pitfall in this plugin is **silent** — the code changed but
 * the host serves an old bundle, or a fix never made it into the served copy, and nothing reports
 * an error. This script fetches the served content over HTTP and asserts on it, which is the
 * closest available check to "what the user actually receives".
 *
 * Usage: node test/verify-served-bundle.mjs
 */

const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:19387'
const ID = 'dsh-ai-memory'

const list = await (await fetch(`${BASE}/plugins/${ID}/snapshot`)).json().catch(() => null)
if (list === null) {
  console.log('✗ 宿主不可达或插件未启用')
  process.exit(1)
}

// The snapshot route does not expose rev, so derive it the way the bundle probe script does.
const probe = await (await fetch(`${BASE}/plugins/${ID}/snapshot`)).text()
void probe

/** Try the usual rev source: compute it from the plugin directory's mtime. */
import { createHash } from 'node:crypto'
import { statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const profileClient = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', ID, 'lib', 'client.js')
const st = statSync(profileClient)
const h = createHash('sha1').update('plugin-artifact').update('\0')
for (const x of [String(st.mtimeMs), String(st.ctimeMs), String(st.size)]) {
  h.update(String(Buffer.byteLength(x)) + ':').update(x)
}
const rev = h.digest('hex').slice(0, 12)

const res = await fetch(`${BASE}/plugins/??${ID}/client.js&rev=${rev}`)
if (!res.ok) {
  console.log(`✗ bundle 取不到（HTTP ${res.status}，rev=${rev}）`)
  process.exit(1)
}
const body = await res.text()
/** Strip comments — they **deliberately document** these pitfalls and must not count as code. */
const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

console.log(`\n【宿主正在服务的 bundle】rev=${rev}  ${body.length} 字节\n`)

let fails = 0
/** Assert and print. */
function check(label, cond) {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    fails += 1
    console.log(`  ✗ ${label}`)
  }
}

console.log('— 应用稳定性（违反会让整个应用打不开）—')
check('不读 ctx.styles', !/ctx\.styles/.test(code))
check('inject 只声明 slots', /inject: \['slots'\]/.test(code))

console.log('\n— 画布能不能画 —')
check('渲染器 effect 依赖 state.phase（否则永远不建渲染器）', /\}, \[state\.phase\]\)/.test(code))
check('数据 effect 依赖含 canvasOk', /\[state\.snapshot, canvasOk\]/.test(code))
check('有 resizeSoon 重试（否则绘图缓冲停在 300×150）', /resizeSoon\(attempt = 0\)/.test(code))
check('有 ResizeObserver（尺寸变化的根治手段）', /new ResizeObserver\(/.test(code))
check('resize 后重算视野', /changed && this\.autoFit === true/.test(code))
check('全部节点 id 都发给 Worker（否则节点集被清空）', /coords\[id\] = p\.placed === true \? \[p\.x, p\.y\] : null/.test(code))

console.log('\n— 能不能交互 —')
check('兜底层是有条件渲染（否则盖住 canvas 吃掉指针事件）', /canvasOk \? null : FallbackGraph/.test(code))
check('有 dblclick 复位', /addEventListener\('dblclick'/.test(code))
check('有 contextmenu 切换含退役', /addEventListener\('contextmenu'/.test(code))

console.log('\n— UI 精简（只留图，见 client.js 的 SHOW_* 常量）—')
check('SHOW_HEAD = false', /const SHOW_HEAD = false/.test(code))
check('SHOW_CHIPS = false', /const SHOW_CHIPS = false/.test(code))
check('SHOW_TOOLBAR = false', /const SHOW_TOOLBAR = false/.test(code))
// The legend is deliberately ON: colour alone does not explain itself, so the
// edge-type key stays visible even though every other chrome element is hidden.
check('SHOW_LEGEND = true', /const SHOW_LEGEND = true/.test(code))
const detail = code.slice(code.indexOf('function Detail('), code.indexOf('function FallbackGraph'))
check('详情不显示裸 id', detail.length > 100 && !/node\.id/.test(detail))
check('详情不显示版本/时间', !/node\.revision|node\.createdAt/.test(detail))
check('详情保留正文', /node\.text/.test(detail))
check('详情保留取代链', /node\.chain/.test(detail))

console.log('\n— 样式注入 —')
check('用带 data-plugin 标记的 <style>', /data-plugin="dsh-ai-memory"/.test(body))
check('ensureStyles 有定义且有调用', (body.match(/ensureStyles\(/g) ?? []).length >= 2)

console.log(`\n${'='.repeat(56)}`)
if (fails > 0) {
  console.log(`失败 ${fails} 项`)
  process.exit(1)
}
console.log('宿主服务的 bundle 含全部关键修复 ✓')
