/**
 * 零依赖断言。
 *
 * 这个插件靠 `link:` 装进 profile，拿不到自己的 `node_modules`。
 * 加任何一个依赖都会让整条插件静默失活（不报错、不注册工具）。
 * 所以这条保证必须由 CI 守住，而不是靠记性。
 *
 * 用法：node test/checks/deps-check.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')
let bad = 0

// 1. package.json 里不能有任何依赖字段
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'bundleDependencies']) {
  const deps = pkg[field]
  if (deps !== undefined && Object.keys(deps).length > 0) {
    console.error(`  ✗ package.json has ${field}: ${Object.keys(deps).join(', ')}`)
    bad += 1
  }
}

// 2. 不能有 node_modules 目录
if (existsSync(join(ROOT, 'node_modules'))) {
  console.error('  ✗ node_modules exists — a link: install would break')
  bad += 1
}

// 3. peerDependencies 是允许的（声明宿主版本，不会被安装），但要有
if (pkg.peerDependencies === undefined) {
  console.error('  ✗ peerDependencies is missing — the host compatibility check becomes a no-op')
  bad += 1
}

console.log('')
console.log(`  依赖字段        ${bad === 0 ? '无' : '有问题'}`)
console.log(`  node_modules    ${existsSync(join(ROOT, 'node_modules')) ? '存在' : '不存在'}`)
console.log(`  peerDependencies ${pkg.peerDependencies ? JSON.stringify(pkg.peerDependencies) : '缺失'}`)
console.log(bad === 0 ? '✓ 零依赖保证成立' : `✗ ${bad} 个问题`)
process.exit(bad === 0 ? 0 : 1)
