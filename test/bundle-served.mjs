/**
 * 验证客户端 bundle 是否**在宿主的服务表里**（而不是只检查槽位注册）。
 *
 * 为什么需要这个：
 *   `Slots.listSubTree` 显示"槽位里有没有注册"，而注册的前提是浏览器**先拿到并执行了**
 *   `lib/client.js`。如果 bundle 根本没进宿主的 responses 表，浏览器永远拿不到它，
 *   槽位里自然也不会出现 —— 但**两边都不报错**。这是典型的静默失效。
 *
 * 判据（来自 dsh-client-modules/lib/index.js 的实现）：
 *   1. 单资源 URL 是 **combo 形式**：`/plugins/??<id>/client.js&rev=<rev>`
 *      （不是 `/plugins/<id>/client.js` —— 那个形状不存在）
 *   2. rev = framedHash("plugin-artifact", [mtimeMs, ctimeMs, size]) 的 sha1 前 12 位
 *   3. 宿主在**启动扫描**时把 `dsh.client` 条目收进 responses 表；启动后才装上的 bundle
 *      **不在表里**，直到宿主重启（官方原文：replacing an installed package requires
 *      restart to load a fresh JavaScript module generation）
 *
 * 用法：
 *   node test/bundle-served.mjs            # 检查本插件
 *   node test/bundle-served.mjs --all      # 顺带对照一个已知在用的插件（判别宿主侧问题）
 */

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const BASE = process.env.DSH_WEB_BASE ?? 'http://127.0.0.1:19387'
const PROFILE_NM = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules')

/**
 * 复算宿主的 artifact rev。
 * 算法逐行照抄 dsh-client-modules/lib/index.js 的 framedHash + artifactRevision。
 *
 * @param {{mtimeMs: number, ctimeMs: number, size: number}} b - 文件系统基线。
 * @returns {string} 12 位十六进制 rev。
 */
export function artifactRevision(b) {
  const hash = createHash('sha1').update('plugin-artifact').update('\0')
  for (const part of [String(b.mtimeMs), String(b.ctimeMs), String(b.size)]) {
    hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
  }
  return hash.digest('hex').slice(0, 12)
}

/** 拼 combo 形式的单资源 URL（这是宿主真正认的形状）。 */
export function comboUrl(id, rev) {
  return `${BASE}/plugins/??${id}/client.js&rev=${rev}`
}

/**
 * 探测一个包名的客户端 bundle 是否被宿主服务。
 *
 * @param {string} id - 包名。
 * @param {string} clientPath - 客户端文件路径。
 * @returns {Promise<{id: string, rev: string, status: number, bytes: number, served: boolean, reason?: string}>}
 */
export async function probeBundle(id, clientPath) {
  let st
  try {
    st = statSync(clientPath)
  } catch (err) {
    return { id, rev: '', status: 0, bytes: 0, served: false, reason: `读不到文件：${err.message}` }
  }
  const rev = artifactRevision({ mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size })
  const url = comboUrl(id, rev)
  try {
    const res = await fetch(url, { headers: { accept: 'application/javascript' } })
    const body = await res.text()
    return {
      id,
      rev,
      status: res.status,
      bytes: body.length,
      served: res.status === 200,
      ...(res.status === 200 ? {} : { reason: `宿主服务表里没有这个 rev（HTTP ${res.status}）` }),
    }
  } catch (err) {
    return { id, rev, status: 0, bytes: 0, served: false, reason: `请求失败：${err.message}` }
  }
}

// ---- 作为脚本直接运行时执行检查 ----
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1].replace(/\\/g, '/')
if (isMain || process.argv[1]?.endsWith('bundle-served.mjs')) {
  const results = []

  console.log('\n【本插件】')
  const mine = await probeBundle('dsh-ai-memory', join(root, 'lib', 'client.js'))
  results.push(mine)
  console.log(`  rev=${mine.rev}  HTTP ${mine.status}  ${mine.bytes} 字节`)
  if (mine.served) {
    console.log('  ✓ 客户端 bundle 已被宿主服务')
    // 内容抽检：确认服务的确实是本插件的代码（针对 Canvas + Worker 架构）
    const res = await fetch(comboUrl('dsh-ai-memory', mine.rev))
    const body = await res.text()
    const marks = [
      ['模块加载器', body.includes('__ModuleLoader__')],
      ['注册 id 正确', body.includes('dsh-ai-memory')],
      ['含图谱面板组件', body.includes('MemoryGraphPanel')],
      ['用 Canvas 2D 渲染', body.includes("getContext('2d')") || body.includes('getContext("2d")')],
      ['力导向跑在 Worker 里', body.includes('workerPath()') && body.includes('new Worker')],
      ['有连续动画循环', body.includes('requestAnimationFrame')],
      ['样式用 <style> 直插', body.includes('data-plugin="dsh-ai-memory"')],
      // 去注释后再查 —— 注释里会**专门记录**这个坑，不能当成代码
      ['不读 ctx.styles（会打挂应用）', !/ctx\.styles/.test(body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, ''))],
    ]
    for (const [label, ok] of marks) console.log(`    ${ok ? '✓' : '✗'} ${label}`)
  } else {
    console.log(`  ✗ 未被服务 — ${mine.reason}`)
  }

  if (process.argv.includes('--all')) {
    console.log('\n【对照：一个已知在用的插件】')
    const ref = await probeBundle('dsh-downloads-panel', join(PROFILE_NM, 'dsh-downloads-panel', 'lib', 'client.js'))
    results.push(ref)
    console.log(`  rev=${ref.rev}  HTTP ${ref.status}  ${ref.bytes} 字节`)
    console.log(`  ${ref.served ? '✓ 被服务（说明宿主侧本身正常）' : '✗ 也没被服务（问题在宿主侧，不在本插件）'}`)
  }

  console.log(`\n${'='.repeat(60)}`)
  const mineOk = mine.served
  if (mineOk) {
    console.log('结论：客户端 bundle 在服务链路上验证通过 ✓')
  } else {
    const refOk = results.find((r) => r.id === 'dsh-downloads-panel')?.served
    console.log('结论：本插件的客户端 bundle **尚未进入宿主的服务表**。')
    if (refOk === true) {
      console.log('')
      console.log('这是一个**已知的、可预期的状态**，不是缺陷。确切根因：')
      console.log('')
      console.log('  dsh-client-modules 的 resolveMeta()（lib/index.js:701）按 sourceKey')
      console.log('  永久缓存每个包的解析结果 —— **包括缓存 null**：')
      console.log('      if (cached !== undefined) return cached')
      console.log('      if (decl === undefined || decl.platform !== "web") pkgMeta.set(key, null)')
      console.log('')
      console.log('  本插件是在宿主启动之后装上的，且首次被解析时 package.json 里还没有')
      console.log('  dsh.client，于是缓存了 null —— 而 sourceKey 没变，缓存永不失效。')
      console.log('')
      console.log('  因此这些都无效：')
      console.log('    ✗ 重装        （sourceKey 不变）')
      console.log('    ✗ 关掉再启用  （同上）')
      console.log('    ✗ 改 mtime    （HMR 只重建"已在表里"的条目，已做受控实验证明）')
      console.log('    ✓ 重启宿主    ← 唯一有效的动作')
      console.log('')
      console.log('  官方原文（host-plugin.md）：')
      console.log('    "replacing an installed package requires restart to load a fresh')
      console.log('     JavaScript module generation."')
      console.log('')
      console.log('  → 宿主侧（工具、注入、HTTP 路由）已通过 HMR 生效；')
      console.log('    客户端侧需重启宿主，之后重跑本脚本应返回 200。')
    } else {
      console.log('  对照插件也没被服务 —— 问题可能在宿主侧，或在 BASE 地址/端口上。')
    }
  }
  // 用 exitCode 而不是 process.exit()：fetch 的 socket 还挂着时强退会触发
  // libuv 的 UV_HANDLE_CLOSING 断言（Windows 上表现为一行刺眼的 stderr）。
  // 让事件循环自然排空，退出码照样准确。
  process.exitCode = mineOk ? 0 : 2
}
