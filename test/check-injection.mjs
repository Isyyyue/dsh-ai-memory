/**
 * 用**真实记忆库**检查注入文本：三种 kind 是否都在、想法有没有被列出来。
 * 用法：node test/check-injection.mjs
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { openLibrary, buildIndexText } from '../src/index.js'

const lib = openLibrary(join(homedir(), '.dsh', 'ai-memory'))
const text = buildIndexText(lib, 40)

console.log('注入文本长度:', text.length, '字符\n')

const hasRules = text.includes('Rules you set for yourself')
const hasJudgments = text.includes('Active judgments (')
const hasInsights = text.includes('Ideas not yet settled into judgments')

console.log('含「规矩」一节   :', hasRules)
console.log('含「判断」一节   :', hasJudgments)
console.log('含「想法」一节   :', hasInsights)
console.log('含那条新想法     :', text.includes('节点大小=连接数'))
console.log('')

const i = text.indexOf('Ideas not yet settled')
if (i >= 0) {
  console.log('--- 想法那一节 ---')
  console.log(text.slice(i, i + 200))
}
