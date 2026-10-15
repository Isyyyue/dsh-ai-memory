/**
 * Assert that the client.js installed in the profile is the **fixed** version.
 *
 * Why this is separate: the incident was "the client half prevents the whole application from
 * opening", and both failure shapes are easy to miss (`failed` and `pending (waiting for
 * service: styles)`). After installing, it must be possible to **confirm quickly** that the copy
 * on disk contains no `ctx.styles` access.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const profileClient = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-ai-memory', 'lib', 'client.js')
const workspaceClient = join(import.meta.dirname, '..', 'lib', 'client.js')

let fails = 0
/** Assert and print. */
function check(label, cond, extra = '') {
  if (cond) console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`)
  else {
    fails += 1
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

for (const [label, path] of [['工作区', workspaceClient], ['profile（宿主实际加载的）', profileClient]]) {
  console.log(`\n【${label}】${path}`)
  let src
  try {
    src = readFileSync(path, 'utf8')
  } catch (err) {
    check('文件可读', false, err.message)
    continue
  }
  // Strip comments: they deliberately document these pitfalls and must not count as code.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  check('不读 ctx.styles（0.2.0-rc.2 不提供该服务，读它会抛）', !/ctx\.styles/.test(code))
  check('不调用 styles.insert', !/styles\.insert/.test(code))
  check('inject 只声明 slots', /inject: \['slots'\]/.test(code))
  check('apply 里只碰 ctx.slots', (() => {
    const body = code.slice(code.indexOf('function apply(ctx)'))
    const used = [...body.matchAll(/ctx\.(\w+)/g)].map((m) => m[1])
    return [...new Set(used)].join(',') === 'slots'
  })())
  check('样式用带 data-plugin 标记的 <style> 直插', /data-plugin="dsh-ai-memory"/.test(src))
  check('ensureStyles 有定义且有调用', (src.match(/ensureStyles\(/g) ?? []).length >= 2)
  check('样式注入用容器自己的 document', /ensureStyles\(canvas\.ownerDocument\)/.test(src))
  check('worker URL 是懒求值（不在模块作用域读 DOM）', /let cachedWorkerPath = null/.test(src) && !/^\s*const WORKER_PATH = /m.test(src))
  check('字节数', true, String(src.length))
}

console.log(`\n${'='.repeat(56)}`)
if (fails > 0) {
  console.log(`失败 ${fails} 项 —— **先别重启**，先把上面红的修掉`)
  process.exit(1)
}
console.log('客户端半边是修复后的版本 ✓（可以重启验证）')
