/**
 * Checks the injected text against the **real memory store**: are all three kinds
 * present, and are insights listed?
 * Usage: node test/check-injection.mjs
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { openLibrary, buildIndexText } from '../../src/index.js'

const lib = openLibrary(join(homedir(), '.dsh', 'ai-memory'))
const text = buildIndexText(lib, 40)

console.log('injected text length:', text.length, 'chars\n')

const hasRules = text.includes('规矩（你给自己定的')
const hasJudgments = text.includes('活跃判断（共')
const hasInsights = text.includes('还没成形到能当判断的想法')

console.log('has the "rules" section      :', hasRules)
console.log('has the "judgments" section  :', hasJudgments)
console.log('has the "insights" section   :', hasInsights)
// Real user data: this is the literal insight text in the live store, so it is kept verbatim.
console.log('has that new insight         :', text.includes('\u8282\u70b9\u5927\u5c0f=\u8fde\u63a5\u6570'))
console.log('')

const i = text.indexOf('还没成形')
if (i >= 0) {
  console.log('--- the insights section ---')
  console.log(text.slice(i, i + 200))
}
