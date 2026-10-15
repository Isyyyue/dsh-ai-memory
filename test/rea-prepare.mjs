/**
 * 把「用 REA 在真实浏览器里验证面板」这件事**一键化**。
 *
 * ## 为什么需要这个脚本
 *
 * 本鲸在这上面绕了非常多轮，踩的坑都固化在这里了：
 *
 *   1. **REA 跑在 WSL Linux 里**，不是 Windows。所以：
 *      · `executable_path` 必须是 Linux 路径
 *      · 测试页必须**在 WSL 里能访问**
 *   2. **WSL 里 `cp` 会静默失败成 0 字节**（尤其跟在 `pkill` 之后的组合命令里）。
 *      → 这个脚本用 `cat >` 并且**每次同步后回报字节数验证**。
 *   3. **截图会缩放到看不清小字**，但 `capture.at_end: ["accessibility"]`
 *      会把页面文字**原样返回** → 用它读结果，一枪命中。
 *
 * ## 这个脚本做三件事
 *
 *   1. 把 `lib/client.js`、`lib/client.graph-worker.js`、测试页同步进 WSL（并验证）
 *   2. 在 WSL 里起静态服务器（支持 POST）
 *   3. 打印"接下来该在 REA 里调什么"（参数直接可抄）
 *
 * 它**不**自己调 REA —— 因为 REA 是 MCP 工具，只有 agent 能调。
 *
 * 用法：node test/rea-prepare.mjs
 */

import { readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

/**
 * ⚠️ **这些是可配置的，不要写死自己机器的路径。**
 *
 * REA 的浏览器工具跑在 **WSL Linux** 里（本鲸踩了很久才搞清），
 * 所以这里用 WSL 侧的路径与端口。换机器就改这几个环境变量：
 *
 *   REA_WSL_DISTRO  默认 Ubuntu
 *   REA_WSL_DIR     默认 ~/am-test（WSL 里的家目录）
 *   REA_WSL_PORT    默认 18888
 *   REA_CHROME      打印给 REA 用的 Chromium 路径
 *
 * 没有 WSL、或不用 REA 的话**完全可以跳过这个脚本** ——
 * 它只是"在真实浏览器里看面板"的辅助工具，
 * **插件本身的运行与测试不依赖它**（跑 `node --test` 就够了）。
 */
const WSL = process.env.REA_WSL_DISTRO ?? 'Ubuntu'
const REMOTE_DIR = process.env.REA_WSL_DIR ?? '~/am-test'
const PORT = Number(process.env.REA_WSL_PORT ?? 18888)
const CHROME = process.env.REA_CHROME ?? '~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome'

/** WSL 可写目录的 Linux 侧路径（`/mnt/c/...`）。 */
function toWslPath(winPath) {
  const p = winPath.replace(/\\/g, '/')
  const m = /^([A-Za-z]):\/(.*)$/.exec(p)
  if (m === null) throw new Error(`不能转成 WSL 路径：${winPath}`)
  return `/mnt/${m[1].toLowerCase()}/${m[2]}`
}

/**
 * 在 WSL 里跑一条命令，返回 stdout（去掉 stderr 噪音）。
 * @param {string} script - bash 脚本。
 * @returns {string} 输出。
 */
function wsl(script) {
  try {
    return execFileSync('wsl.exe', ['-d', WSL, '-e', 'bash', '-lc', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch (err) {
    return `«失败: ${err.message}»`
  }
}

/**
 * 用 `cat >` 同步一个文件，并**回报字节数验证**。
 *
 * ⚠️ 为什么不用 `cp`：本鲸实测 `cp` 会静默失败成 0 字节。
 *
 * @param {string} localPath - Windows 侧绝对路径。
 * @returns {{name: string, local: number, remote: number, ok: boolean}} 同步结果。
 */
function syncFile(localPath) {
  const name = localPath.split(/[\\/]/).pop()
  const localSize = statSync(localPath).size
  wsl(`cat '${toWslPath(localPath)}' > ${REMOTE_DIR}/${name}`)
  const remoteSize = Number(wsl(`wc -c < ${REMOTE_DIR}/${name}`)) || 0
  return { name, local: localSize, remote: remoteSize, ok: localSize === remoteSize && localSize > 0 }
}

/** 主流程。 */
function main() {
  console.log('=== 准备 WSL 侧的面板验证环境 ===\n')

  console.log('① 建目录')
  console.log('  ' + wsl(`mkdir -p ${REMOTE_DIR} && echo ok`))

  console.log('\n② 同步文件（用 cat >，并验字节数）')
  // ⚠️ worker 要**同时**放在两个位置：
  //   1. `~/am-test/client.graph-worker.js`  —— 直接引用时用
  //   2. `~/am-test/plugins/dsh-ai-memory/client.graph-worker.js`
  //      —— 插件的 `resolveWorkerUrl()` 算出来就是这个路径（与真实 DSH 一致），
  //         不放这里的话 Worker 会 404、拖拽静默失效，测的就不是拖拽了。
  wsl(`mkdir -p ${REMOTE_DIR}/plugins/dsh-ai-memory && echo ok`)
  const files = [
    // ⚠️ 用 **test/client.js**（打了插桩的那份），不是 lib/client.js。
    // 插桩把 `GraphRenderer` 暴露到 window，`_browser-renderer.html` 才能绕开 React 直接测它。
    // 先跑 `node test/_instrument.mjs` 生成它。
    join(here, 'client.js'),
    join(pluginRoot, 'lib', 'client.graph-worker.js'),
    join(here, '_browser-renderer.html'),
    join(here, '_browser-drag.html'),
    join(here, '_browser-kinds.html'),
    join(here, '_browser-probe.html'),
    join(here, '_wsl-serve.cjs'),
  ]
  let allOk = true
  for (const f of files) {
    const r = syncFile(f)
    if (!r.ok) allOk = false
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}  ${r.local} → ${r.remote} 字节`)
  }
  if (!allOk) {
    console.log('\n⚠️ 有文件没同步成功（WSL 的 cp/cat 会静默失败）。先解决再继续。')
    process.exit(1)
  }

  // worker 也复制一份到插件路径下（让 resolveWorkerUrl 算出的路径真的通）
  const workerSrc = join(pluginRoot, 'lib', 'client.graph-worker.js')
  wsl(`cat '${toWslPath(workerSrc)}' > ${REMOTE_DIR}/plugins/dsh-ai-memory/client.graph-worker.js`)
  const workerRemote = Number(wsl(`wc -c < ${REMOTE_DIR}/plugins/dsh-ai-memory/client.graph-worker.js`)) || 0
  const workerLocal = statSync(workerSrc).size
  console.log(`  ${workerLocal === workerRemote ? '✓' : '✗'} plugins/dsh-ai-memory/client.graph-worker.js  ${workerLocal} → ${workerRemote} 字节`)

  console.log('\n③ 起静态服务器（支持 POST /_result）')
  // 先看端口是不是已经有服务了（上一次跑留下的）—— 那就直接复用
  const before = wsl(`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${PORT}/_browser-kinds.html || true`)
  if (before === '200') {
    console.log('  端口已被占用且能服务测试页 → 直接复用')
  } else {
    wsl(`cd ${REMOTE_DIR} && setsid nohup node _wsl-serve.cjs ${REMOTE_DIR} ${PORT} > /tmp/am-serve.log 2>&1 < /dev/null & sleep 3; echo started`)
    const after = wsl(`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${PORT}/_browser-kinds.html || true`)
    console.log(`  HTTP ${after}`)
    if (after !== '200') {
      console.log('  ✗ 服务器没起来，看 WSL 里的 /tmp/am-serve.log')
      process.exit(1)
    }
  }

  console.log('\n④ 环境就绪。现在在 REA 里调 capture_browser_scenario：\n')
  console.log('   browser        : { "mode": "launch", "headless": true,')
  console.log(`                      "executable_path": "${CHROME}" }`)
  console.log('   start_url      : { "url": "http://127.0.0.1:' + PORT + '/_browser-renderer.html" }')
  console.log('   actions        : [ { "step_id": "w", "action": "wait_for",')
  console.log('                        "locator": { "kind": "css", "selector": "#verdict" }, "state": "attached" },')
  console.log('                      { "step_id": "s", "action": "wait_for_timeout", "duration_ms": 2500 } ]')
  console.log('   capture.at_end : ["accessibility"]   ← 用它读结果，不要用截图（小字会糊）')
  console.log('')
  console.log('   ⚠️ executable_path 必须是 **Linux 路径** —— REA 跑在 WSL 里。')
  console.log('   测试页里的 VERDICT 行会原样出现在 accessibility 文本里。')
}

main()
