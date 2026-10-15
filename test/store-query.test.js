/**
 * Storage-layer and search-layer tests.
 *
 * Focuses on three things the community measured in the field:
 *   1. an atomic write really does refuse to clobber an outside edit (double mtime check);
 *   2. one bad line does not make the whole store unreadable;
 *   3. the two-character sliding window really does recall Chinese (FTS5 unicode61
 *      does not segment Chinese, so this had to be solved here).
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseLedger, serializeLedger, readLedger, appendEvents, atomicWrite, LEDGER_FILE } from '../src/store.js'
import { tokenize, search, summarize } from '../src/query.js'

let work

before(() => {
  work = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-test-'))
})

after(() => {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* a failed cleanup does not change the conclusion */ }
})

describe('store · JSONL 解析', () => {
  test('空文本 → 空账本', () => {
    const { events, problems } = parseLedger('')
    assert.deepEqual(events, [])
    assert.deepEqual(problems, [])
  })

  test('坏行被收集，好行照常解析（一条坏行不毁整库）', () => {
    const text = [
      JSON.stringify({ seq: 1, at: 1, type: 'node.created', data: { id: 'a', text: 'A' } }),
      '{ 这不是合法 JSON',
      JSON.stringify({ seq: 2, at: 2, type: 'node.created', data: { id: 'b', text: 'B' } }),
    ].join('\n')
    const { events, problems } = parseLedger(text)
    assert.equal(events.length, 2, '两个好行都要读出来')
    assert.equal(problems.length, 1)
    assert.equal(problems[0].line, 2, '报告出错行号')
  })

  test('按 seq 排序：手工编辑插错位置也能正确 fold', () => {
    const text = [
      JSON.stringify({ seq: 3, at: 3, type: 'node.created', data: { id: 'c' } }),
      JSON.stringify({ seq: 1, at: 1, type: 'node.created', data: { id: 'a' } }),
      JSON.stringify({ seq: 2, at: 2, type: 'node.created', data: { id: 'b' } }),
    ].join('\n')
    const { events } = parseLedger(text)
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3])
  })

  test('数组与 null 行被拒（不是合法事件）', () => {
    const { problems } = parseLedger('[1,2,3]\nnull\n')
    assert.equal(problems.length, 2)
  })

  test('serialize → parse 往返一致', () => {
    const evs = [
      { seq: 1, at: 10, type: 'node.created', data: { id: 'a', text: '含"引号"与\n换行' } },
      { seq: 2, at: 20, type: 'edge.linked', data: { from: 'a', to: 'b', type: 'related' } },
    ]
    const { events, problems } = parseLedger(serializeLedger(evs))
    assert.deepEqual(problems, [])
    assert.deepEqual(events, evs)
  })
})

describe('store · 读写与追加', () => {
  test('读不存在的文件 → 空账本，不抛（首次运行是正常态）', () => {
    const p = join(work, 'nope', LEDGER_FILE)
    const r = readLedger(p)
    assert.equal(r.exists, false)
    assert.deepEqual(r.events, [])
  })

  test('appendEvents 建目录并写入', () => {
    const p = join(work, 'sub', 'deep', LEDGER_FILE)
    const r = appendEvents(p, [{ seq: 1, at: 1, type: 'node.created', data: { id: 'a', text: 'A' } }])
    assert.equal(r.ok, true)
    assert.equal(r.appended, 1)
    assert.equal(readLedger(p).events.length, 1)
  })

  test('追加不重写历史（两次追加 = 两行都在）', () => {
    const p = join(work, 'append2', LEDGER_FILE)
    appendEvents(p, [{ seq: 1, at: 1, type: 'node.created', data: { id: 'a', text: 'A' } }])
    appendEvents(p, [{ seq: 2, at: 2, type: 'node.created', data: { id: 'b', text: 'B' } }])
    const { events } = readLedger(p)
    assert.equal(events.length, 2)
  })

  test('空数组追加是 no-op', () => {
    const p = join(work, 'empty', LEDGER_FILE)
    const r = appendEvents(p, [])
    assert.equal(r.ok, true)
    assert.equal(r.appended, 0)
    assert.equal(existsSync(p), false, '不建空文件')
  })
})

describe('store · 原子写与防覆盖（社区实测的关键防护）', () => {
  test('mtime 不匹配 → 拒绝写入（不覆盖别人手改的）', () => {
    const dir = join(work, 'guard')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, LEDGER_FILE)
    writeFileSync(p, 'original\n', 'utf8')
    const staleMtime = 12345 // a value that cannot possibly match
    const r = atomicWrite(p, 'should not land\n', staleMtime)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'stale')
    assert.equal(readFileSync(p, 'utf8'), 'original\n', '原文件一字未动')
  })

  test('mtime 匹配 → 写入成功', () => {
    const dir = join(work, 'guard2')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, LEDGER_FILE)
    writeFileSync(p, 'v1\n', 'utf8')
    const mt = readLedger(p).mtimeMs
    const r = atomicWrite(p, 'v2\n', mt)
    assert.equal(r.ok, true)
    assert.equal(readFileSync(p, 'utf8'), 'v2\n')
  })

  test('首次创建（expectedMtimeMs = undefined）不检查', () => {
    const p = join(work, 'create', LEDGER_FILE)
    const r = atomicWrite(p, 'fresh\n', undefined)
    assert.equal(r.ok, true)
    assert.equal(readFileSync(p, 'utf8'), 'fresh\n')
  })

  test('写入不留临时文件残渣', () => {
    const p = join(work, 'tmpcheck', LEDGER_FILE)
    atomicWrite(p, 'x\n', undefined)
    const leftovers = readdirSync(join(work, 'tmpcheck')).filter((f) => f.includes('.tmp'))
    assert.deepEqual(leftovers, [], '临时文件必须被 rename 掉或清理')
  })

  test('失败时也清理临时文件', () => {
    const dir = join(work, 'tmpfail')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, LEDGER_FILE)
    writeFileSync(p, 'orig\n', 'utf8')
    const r = atomicWrite(p, 'nope\n', 999999)
    assert.equal(r.ok, false)
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'))
    assert.deepEqual(leftovers, [], '失败路径不能留垃圾')
  })
})

describe('query · 中文分词（FTS5 不切中文，必须自己解决）', () => {
  test('中文产出 2 字滑窗 + 单字兜底', () => {
    const t = tokenize('判断进化')
    assert.ok(t.includes('判断'), 'bigram 要在')
    assert.ok(t.includes('断进'), '滑窗要滑动')
    assert.ok(t.includes('进化'), 'bigram 要在')
    assert.ok(t.includes('判'), '单字兜底也要在')
  })

  test('英文按词切分并小写', () => {
    const t = tokenize('Hello World')
    assert.ok(t.includes('hello'))
    assert.ok(t.includes('world'))
  })

  test('中英混排都能切', () => {
    const t = tokenize('用 find 命令')
    assert.ok(t.includes('find'))
    assert.ok(t.includes('命令'))
    assert.ok(t.includes('用'))
  })

  test('标点被当分隔符，不产生空词', () => {
    const t = tokenize('a, b; c')
    assert.deepEqual(t, ['a', 'b', 'c'])
  })

  test('空与非字符串得到空数组', () => {
    assert.deepEqual(tokenize(''), [])
    assert.deepEqual(tokenize(null), [])
    assert.deepEqual(tokenize(undefined), [])
  })
})

describe('query · 检索', () => {
  const nodes = [
    { id: 'a', text: '我认为确定性取代比相似度阈值可靠', tags: ['记忆'], subject: 'supersede', relation: '优于', object: 'similarity' },
    { id: 'b', text: '中文检索需要二字滑窗预分词', tags: ['检索'], subject: null, relation: null, object: null },
    { id: 'c', text: '图谱只做导航，不做事实载荷', tags: ['图谱'], subject: null, relation: null, object: null },
  ]

  test('中文查询能命中（这正是 FTS5 做不到的）', () => {
    const r = search(nodes, '滑窗')
    assert.equal(r.total, 1)
    assert.equal(r.results[0].id, 'b')
  })

  test('中文跨词命中', () => {
    const r = search(nodes, '二字滑窗')
    assert.ok(r.results.some((n) => n.id === 'b'))
  })

  test('多词默认 AND（都要命中）', () => {
    const r = search(nodes, '图谱 导航')
    assert.equal(r.total, 1)
    assert.equal(r.results[0].id, 'c')
    assert.equal(r.relaxed, false)
  })

  test('AND 全无命中且多词 → 退化为 OR 并标记 relaxed', () => {
    const r = search(nodes, '图谱 完全不存在的词')
    assert.equal(r.relaxed, true, '必须标记是放宽过的，不能假装精确命中')
    assert.ok(r.results.length > 0)
  })

  test('单词无命中 → 空结果，不 relaxed', () => {
    const r = search(nodes, 'zzzz不存在')
    assert.equal(r.total, 0)
    assert.equal(r.relaxed, false)
  })

  test('三元组分量也参与检索（subject/object）', () => {
    const r = search(nodes, 'similarity')
    assert.ok(r.results.some((n) => n.id === 'a'))
  })

  test('limit 生效', () => {
    const r = search(nodes, '的', { limit: 1 })
    assert.ok(r.results.length <= 1)
  })

  test('空查询 → 空结果', () => {
    assert.equal(search(nodes, '').total, 0)
    assert.equal(search(nodes, '   ').total, 0)
  })

  test('单个汉字不把关 —— 防止"不"这种常见字把无关结果捞进来（实测踩过的坑）', () => {
    // The query 'zzzz\u4e0d\u5b58\u5728' should only hit a node containing the contiguous run \u300c\u4e0d\u5b58\u5728\u300d; none here, so 0 results.
    const r = search(nodes, 'zzzz不存在')
    assert.equal(r.total, 0, '单字兜底不得让无关节点冒充命中')
  })

  test('查询全部由单字组成时，单字才当必需项（否则永远搜不到）', () => {
    const r = search(nodes, '图')
    assert.ok(r.total > 0, '就查一个字时仍要能搜到')
  })

  test('bigram 跨标点不生成假词（「图谱 导航」不该产出「谱导」）', () => {
    const t = tokenize('图谱 导航')
    assert.ok(!t.includes('谱导'), '跨边界的假词必须被排除，否则 AND 检索静默退化')
    assert.ok(t.includes('图谱'))
    assert.ok(t.includes('导航'))
  })

  test('结果带 score 且是数字', () => {
    const r = search(nodes, '图谱')
    assert.equal(typeof r.results[0].score, 'number')
  })
})

describe('query · 摘要', () => {
  test('压平空白', () => {
    assert.equal(summarize('a\n\n  b   c'), 'a b c')
  })

  test('超长截断并加省略号', () => {
    const s = summarize('x'.repeat(200), 20)
    assert.equal(s.length, 20)
    assert.ok(s.endsWith('…'))
  })

  test('非字符串得到空串', () => {
    assert.equal(summarize(null), '')
  })
})
