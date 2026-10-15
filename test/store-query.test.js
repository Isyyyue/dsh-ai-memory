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

describe('store · JSONL parsing', () => {
  test('empty text → empty ledger', () => {
    const { events, problems } = parseLedger('')
    assert.deepEqual(events, [])
    assert.deepEqual(problems, [])
  })

  test('bad lines are collected, good lines still parse (one bad line does not destroy the store)', () => {
    const text = [
      JSON.stringify({ seq: 1, at: 1, type: 'node.created', data: { id: 'a', text: 'A' } }),
      '{ this is not valid JSON',
      JSON.stringify({ seq: 2, at: 2, type: 'node.created', data: { id: 'b', text: 'B' } }),
    ].join('\n')
    const { events, problems } = parseLedger(text)
    assert.equal(events.length, 2, 'both good lines must be read out')
    assert.equal(problems.length, 1)
    assert.equal(problems[0].line, 2, 'the failing line number is reported')
  })

  test('sorted by seq: a misplaced hand edit still folds correctly', () => {
    const text = [
      JSON.stringify({ seq: 3, at: 3, type: 'node.created', data: { id: 'c' } }),
      JSON.stringify({ seq: 1, at: 1, type: 'node.created', data: { id: 'a' } }),
      JSON.stringify({ seq: 2, at: 2, type: 'node.created', data: { id: 'b' } }),
    ].join('\n')
    const { events } = parseLedger(text)
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3])
  })

  test('arrays and null lines are rejected (not valid events)', () => {
    const { problems } = parseLedger('[1,2,3]\nnull\n')
    assert.equal(problems.length, 2)
  })

  test('serialize → parse round-trips identically', () => {
    const evs = [
      { seq: 1, at: 10, type: 'node.created', data: { id: 'a', text: 'contains "quotes" and\na newline' } },
      { seq: 2, at: 20, type: 'edge.linked', data: { from: 'a', to: 'b', type: 'related' } },
    ]
    const { events, problems } = parseLedger(serializeLedger(evs))
    assert.deepEqual(problems, [])
    assert.deepEqual(events, evs)
  })
})

describe('store · read, write and append', () => {
  test('reading a nonexistent file → empty ledger, no throw (a first run is a normal state)', () => {
    const p = join(work, 'nope', LEDGER_FILE)
    const r = readLedger(p)
    assert.equal(r.exists, false)
    assert.deepEqual(r.events, [])
  })

  test('appendEvents creates the directory and writes', () => {
    const p = join(work, 'sub', 'deep', LEDGER_FILE)
    const r = appendEvents(p, [{ seq: 1, at: 1, type: 'node.created', data: { id: 'a', text: 'A' } }])
    assert.equal(r.ok, true)
    assert.equal(r.appended, 1)
    assert.equal(readLedger(p).events.length, 1)
  })

  test('appending does not rewrite history (two appends = both lines present)', () => {
    const p = join(work, 'append2', LEDGER_FILE)
    appendEvents(p, [{ seq: 1, at: 1, type: 'node.created', data: { id: 'a', text: 'A' } }])
    appendEvents(p, [{ seq: 2, at: 2, type: 'node.created', data: { id: 'b', text: 'B' } }])
    const { events } = readLedger(p)
    assert.equal(events.length, 2)
  })

  test('appending an empty array is a no-op', () => {
    const p = join(work, 'empty', LEDGER_FILE)
    const r = appendEvents(p, [])
    assert.equal(r.ok, true)
    assert.equal(r.appended, 0)
    assert.equal(existsSync(p), false, 'no empty file is created')
  })
})

describe('store · atomic write and overwrite guard (the protection the field measured)', () => {
  test('mtime mismatch → write refused (a hand edit by someone else is not clobbered)', () => {
    const dir = join(work, 'guard')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, LEDGER_FILE)
    writeFileSync(p, 'original\n', 'utf8')
    const staleMtime = 12345 // a value that cannot possibly match
    const r = atomicWrite(p, 'should not land\n', staleMtime)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'stale')
    assert.equal(readFileSync(p, 'utf8'), 'original\n', 'the original file is untouched')
  })

  test('mtime match → write succeeds', () => {
    const dir = join(work, 'guard2')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, LEDGER_FILE)
    writeFileSync(p, 'v1\n', 'utf8')
    const mt = readLedger(p).mtimeMs
    const r = atomicWrite(p, 'v2\n', mt)
    assert.equal(r.ok, true)
    assert.equal(readFileSync(p, 'utf8'), 'v2\n')
  })

  test('first creation (expectedMtimeMs = undefined) is not checked', () => {
    const p = join(work, 'create', LEDGER_FILE)
    const r = atomicWrite(p, 'fresh\n', undefined)
    assert.equal(r.ok, true)
    assert.equal(readFileSync(p, 'utf8'), 'fresh\n')
  })

  test('a write leaves no temporary-file residue', () => {
    const p = join(work, 'tmpcheck', LEDGER_FILE)
    atomicWrite(p, 'x\n', undefined)
    const leftovers = readdirSync(join(work, 'tmpcheck')).filter((f) => f.includes('.tmp'))
    assert.deepEqual(leftovers, [], 'the temporary file must be renamed away or cleaned up')
  })

  test('temporary files are cleaned up on failure too', () => {
    const dir = join(work, 'tmpfail')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, LEDGER_FILE)
    writeFileSync(p, 'orig\n', 'utf8')
    const r = atomicWrite(p, 'nope\n', 999999)
    assert.equal(r.ok, false)
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'))
    assert.deepEqual(leftovers, [], 'the failure path must not leave litter')
  })
})

describe('query · Chinese tokenization (FTS5 does not segment Chinese, so this had to be solved here)', () => {
  test('Chinese yields two-character sliding windows plus a single-character fallback', () => {
    const t = tokenize('\u5224\u65ad\u8fdb\u5316')
    assert.ok(t.includes('\u5224\u65ad'), 'the bigram must be present')
    assert.ok(t.includes('\u65ad\u8fdb'), 'the window must slide')
    assert.ok(t.includes('\u8fdb\u5316'), 'the bigram must be present')
    assert.ok(t.includes('\u5224'), 'the single-character fallback must be present too')
  })

  test('English is split on words and lowercased', () => {
    const t = tokenize('Hello World')
    assert.ok(t.includes('hello'))
    assert.ok(t.includes('world'))
  })

  test('mixed Chinese and English both tokenize', () => {
    const t = tokenize('\u7528 find \u547d\u4ee4')
    assert.ok(t.includes('find'))
    assert.ok(t.includes('\u547d\u4ee4'))
    assert.ok(t.includes('\u7528'))
  })

  test('punctuation acts as a separator and produces no empty terms', () => {
    const t = tokenize('a, b; c')
    assert.deepEqual(t, ['a', 'b', 'c'])
  })

  test('empty and non-string input yield an empty array', () => {
    assert.deepEqual(tokenize(''), [])
    assert.deepEqual(tokenize(null), [])
    assert.deepEqual(tokenize(undefined), [])
  })
})

describe('query · search', () => {
  const nodes = [
    { id: 'a', text: '\u6211\u8ba4\u4e3a\u786e\u5b9a\u6027\u53d6\u4ee3\u6bd4\u76f8\u4f3c\u5ea6\u9608\u503c\u53ef\u9760', tags: ['\u8bb0\u5fc6'], subject: 'supersede', relation: '\u4f18\u4e8e', object: 'similarity' },
    { id: 'b', text: '\u4e2d\u6587\u68c0\u7d22\u9700\u8981\u4e8c\u5b57\u6ed1\u7a97\u9884\u5206\u8bcd', tags: ['\u68c0\u7d22'], subject: null, relation: null, object: null },
    { id: 'c', text: '\u56fe\u8c31\u53ea\u505a\u5bfc\u822a\uff0c\u4e0d\u505a\u4e8b\u5b9e\u8f7d\u8377', tags: ['\u56fe\u8c31'], subject: null, relation: null, object: null },
  ]

  test('a Chinese query hits (exactly what FTS5 cannot do)', () => {
    const r = search(nodes, '\u6ed1\u7a97')
    assert.equal(r.total, 1)
    assert.equal(r.results[0].id, 'b')
  })

  test('a Chinese query hits across word boundaries', () => {
    const r = search(nodes, '\u4e8c\u5b57\u6ed1\u7a97')
    assert.ok(r.results.some((n) => n.id === 'b'))
  })

  test('multiple terms default to AND (all must hit)', () => {
    const r = search(nodes, '\u56fe\u8c31 \u5bfc\u822a')
    assert.equal(r.total, 1)
    assert.equal(r.results[0].id, 'c')
    assert.equal(r.relaxed, false)
  })

  test('AND with no hits and more than one term → degrades to OR and is flagged relaxed', () => {
    const r = search(nodes, '\u56fe\u8c31 \u5b8c\u5168\u4e0d\u5b58\u5728\u7684\u8bcd')
    assert.equal(r.relaxed, true, 'relaxation must be flagged; a relaxed hit must not masquerade as an exact one')
    assert.ok(r.results.length > 0)
  })

  test('a single term with no hits → empty result, not relaxed', () => {
    const r = search(nodes, 'zzzz\u4e0d\u5b58\u5728')
    assert.equal(r.total, 0)
    assert.equal(r.relaxed, false)
  })

  test('triple components take part in search too (subject/object)', () => {
    const r = search(nodes, 'similarity')
    assert.ok(r.results.some((n) => n.id === 'a'))
  })

  test('limit takes effect', () => {
    const r = search(nodes, '\u7684', { limit: 1 })
    assert.ok(r.results.length <= 1)
  })

  test('empty query → empty result', () => {
    assert.equal(search(nodes, '').total, 0)
    assert.equal(search(nodes, '   ').total, 0)
  })

  test('a single CJK character does not gate — a common character must not drag in unrelated results (a measured pitfall)', () => {
    // The query 'zzzz\u4e0d\u5b58\u5728' should only hit a node containing the contiguous run \u300c\u4e0d\u5b58\u5728\u300d; none here, so 0 results.
    const r = search(nodes, 'zzzz\u4e0d\u5b58\u5728')
    assert.equal(r.total, 0, 'the single-character fallback must not let unrelated nodes pass as hits')
  })

  test('only when the query is made up entirely of single characters do those characters become required (otherwise nothing could ever match)', () => {
    const r = search(nodes, '\u56fe')
    assert.ok(r.total > 0, 'a one-character query must still be searchable')
  })

  test('bigrams do not generate fake terms across punctuation (\u300c\u56fe\u8c31 \u5bfc\u822a\u300d must not produce \u300c\u8c31\u5bfc\u300d)', () => {
    const t = tokenize('\u56fe\u8c31 \u5bfc\u822a')
    assert.ok(!t.includes('\u8c31\u5bfc'), 'a cross-boundary fake term must be excluded, or AND search degrades silently')
    assert.ok(t.includes('\u56fe\u8c31'))
    assert.ok(t.includes('\u5bfc\u822a'))
  })

  test('results carry a numeric score', () => {
    const r = search(nodes, '\u56fe\u8c31')
    assert.equal(typeof r.results[0].score, 'number')
  })
})

describe('query · summarize', () => {
  test('flattens whitespace', () => {
    assert.equal(summarize('a\n\n  b   c'), 'a b c')
  })

  test('truncates overlong text and appends an ellipsis', () => {
    const s = summarize('x'.repeat(200), 20)
    assert.equal(s.length, 20)
    assert.ok(s.endsWith('…'))
  })

  test('non-string input yields an empty string', () => {
    assert.equal(summarize(null), '')
  })
})
