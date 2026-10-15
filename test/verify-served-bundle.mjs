/**
 * 断言**宿主正在服务的**那份客户端 bundle 含全部关键修复。
 *
 * 为什么需要单独做：本插件踩过的坑几乎都是**静默的** ——
 * 代码改了但宿主服务的是旧 bundle、或修复没进到服务的那份，都不报错。
 * 这个脚本直接从 HTTP 取回宿主服务的内容做断言，是最接近"用户实际拿到什么"的检查。
 *
 * 用法：node test/verify-served-bundle.mjs
 */

const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:19387'
const ID = 'dsh-ai-memory'

const list = await (await fetch(`${BASE}/plugins/${ID}/snapshot`)).json().catch(() => null)
if (list === null) {
  console.log('✗ 宿主不可达或插件未启用')
  process.exit(1)
}

// 从 snapshot 路由拿不到 rev，改从 bundle 探测脚本拿
const probe = await (await fetch(`${BASE}/plugins/${ID}/snapshot`)).text()
void probe

/** 尝试几个常见 rev 来源：直接读插件目录的 mtime 算。 */
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
/** 去掉注释 —— 注释里会**专门记录**这些坑，不能当成代码。 */
const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

console.log(`\n【宿主正在服务的 bundle】rev=${rev}  ${body.length} 字节\n`)

let fails = 0
/** 断言并打印。 */
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

console.log('\n— UI 精简（主人要求只留图）—')
check('SHOW_HEAD = false', /const SHOW_HEAD = false/.test(code))
check('SHOW_CHIPS = false', /const SHOW_CHIPS = false/.test(code))
check('SHOW_TOOLBAR = false', /const SHOW_TOOLBAR = false/.test(code))
check('SHOW_LEGEND = false', /const SHOW_LEGEND = false/.test(code))
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
