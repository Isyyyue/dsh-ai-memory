import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createState, QUESTION_STATUS } from '../../src/ledger.js'
import { pressure, rankQuestions } from '../../src/attention.js'

describe('attention · 未闭合问题压力', () => {
  const now = 2_000_000
  test('fatigue 生效：attempts 越多压力单调下降', () => {
    const base = { urgency: 0.9, confidence: 0.1, openedAt: now, lastTouchedAt: now }
    assert.ok(pressure({ ...base, attempts: 0 }, now) > pressure({ ...base, attempts: 10 }, now))
  })

  test('高紧急度但疲劳的问题会让位给新问题', () => {
    const old = { urgency: 1, confidence: 0, attempts: 20, openedAt: now, lastTouchedAt: now }
    const fresh = { urgency: 0.6, confidence: 0.1, attempts: 0, openedAt: now, lastTouchedAt: now }
    assert.ok(pressure(fresh, now) > pressure(old, now))
  })

  test('rankQuestions 排除 closed 与 abandoned', () => {
    const state = createState()
    state.questions.set('open', { id: 'open', status: QUESTION_STATUS.OPEN, urgency: 1, confidence: 0, attempts: 0, openedAt: now, lastTouchedAt: now })
    state.questions.set('closed', { id: 'closed', status: QUESTION_STATUS.CLOSED, urgency: 1, confidence: 0, attempts: 0, openedAt: now, lastTouchedAt: now })
    state.questions.set('abandoned', { id: 'abandoned', status: QUESTION_STATUS.ABANDONED, urgency: 1, confidence: 0, attempts: 0, openedAt: now, lastTouchedAt: now })
    assert.deepEqual(rankQuestions(state, now).map((x) => x.question.id), ['open'])
  })

  test('空状态返回空数组', () => assert.deepEqual(rankQuestions(createState(), now), []))

  test('pressure 永远在 0..1', () => {
    for (const q of [
      { urgency: -10, confidence: 10, attempts: -3, openedAt: now + 1e9 },
      { urgency: 10, confidence: -10, attempts: 1e9, openedAt: now - 1e12 },
      {},
    ]) {
      const value = pressure(q, now)
      assert.ok(value >= 0 && value <= 1 && Number.isFinite(value))
    }
  })
})
