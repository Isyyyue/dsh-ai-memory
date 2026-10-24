/**
 * 文档体检：断链、未标语言的代码块、格式问题。
 *
 * ⚠️ 这是独立脚本而不是内嵌在 ci.yml 的 `node -e "..."` 里，因为那种写法
 * 要在 YAML、shell、JS 三层之间转义引号，实际跑起来是第一个失败的步骤
 * （CI 11 秒即失败）。独立文件没有转义层。
 *
 * 用法：node test/checks/docs-check.mjs
 * 退出码：0 = 通过，1 = 有问题
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')
const FENCE = String.fromCharCode(96, 96, 96)

/**
 * Local maintainer logs, excluded from the published repository.
 *
 * They are gitignored, they are written for one person on one machine, and
 * their code fences are deliberately bare (they quote shell sessions and
 * directory trees from memory). Checking them would report failures nobody can
 * act on.
 */
const LOCAL_ONLY = new Set(['MAINTAINING.md', 'HANDOVER.md'])

/** 收集所有 markdown 文件。 */
function collectMarkdown(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) collectMarkdown(p, out)
    else if (e.name.endsWith('.md') && !LOCAL_ONLY.has(e.name)) out.push(p)
  }
  return out
}

const files = collectMarkdown(ROOT)

let broken = 0
let fences = 0
let unlabeled = 0
let trailing = 0

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const rel = relative(ROOT, file)

  // 1. 相对链接
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1]
    if (/^(https?:|mailto:|#)/.test(target)) continue
    const clean = target.split('#')[0]
    if (clean === '') continue
    if (!existsSync(resolve(dirname(file), clean))) {
      console.error(`  ✗ ${rel} → ${target}`)
      broken += 1
    }
  }

  // 2. 代码块语言标注
  let inFence = false
  for (const line of text.split('\n')) {
    if (!line.startsWith(FENCE)) continue
    if (!inFence) {
      fences += 1
      if (line.slice(3).trim() === '') {
        console.error(`  ✗ ${rel} 有未标语言的代码块`)
        unlabeled += 1
      }
      inFence = true
    } else {
      inFence = false
    }
  }

  // 3. 行尾空格
  const t = text.split('\n').filter((l) => / $/.test(l)).length
  if (t > 0) {
    console.error(`  ✗ ${rel} 有 ${t} 行行尾空格`)
    trailing += t
  }
}

console.log('')
console.log(`${files.length} 个 markdown 文件，${fences} 个代码块`)
console.log(`  断链        ${broken}`)
console.log(`  未标语言    ${unlabeled}`)
console.log(`  行尾空格    ${trailing}`)

const bad = broken + unlabeled + trailing
console.log(bad === 0 ? '✓ 文档检查通过' : `✗ ${bad} 个问题`)
process.exit(bad === 0 ? 0 : 1)
