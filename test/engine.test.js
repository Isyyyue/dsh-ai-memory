/**
 * Tests for the ledger and the supersession engine.
 *
 * Testing philosophy (following viya-memory's practice): **being importable does
 * not mean it runs**. Every assertion must actually fold an event sequence and
 * actually compute a verdict, rather than merely checking that a function
 * exists.
 *
 * The community-recognized "silent failure" paths get dedicated coverage too —
 * the most dangerous bug in a memory plugin is the one that raises no error.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  createState,
  applyEvent,
  foldEvents,
  activeNodes,
  nodeOf,
  backlinksOf,
  outlinksOf,
  supersedeChain,
  STATUS,
  KIND,
} from '../src/ledger.js'
import { normalizeComponent, assertionKey, classify, planWrite, makeNodeId } from '../src/supersede.js'

/** Build a node.created event, so each test does not repeat the whole shape. */
function created(seq, at, data) {
  return { seq, at, type: 'node.created', data }
}

describe('ledger · folding events into state', () => {
  test('an empty ledger folds into empty state with no problems', () => {
    const s = foldEvents([])
    assert.equal(s.nodes.size, 0)
    assert.deepEqual(s.problems, [])
  })

  test('node.created creates a node, active by default with revision 1', () => {
    const s = foldEvents([created(1, 1000, { id: 'a', text: 'I hold that X' })])
    const n = nodeOf(s, 'a')
    assert.ok(n)
    assert.equal(n.text, 'I hold that X')
    assert.equal(n.status, STATUS.ACTIVE)
    assert.equal(n.revision, 1)
    assert.equal(n.validFrom, 1000)
    assert.equal(n.validTo, null)
    assert.equal(n.kind, KIND.JUDGMENT, 'judgment is the default when kind is not given')
  })

  test('an unknown event type is recorded in problems, never silently swallowed', () => {
    const s = foldEvents([{ seq: 1, at: 1, type: 'node.exploded', data: {} }])
    assert.equal(s.problems.length, 1)
    assert.match(s.problems[0].reason, /unknown event type/)
  })

  test('one bad event does not make the whole store unreadable (the rest still apply)', () => {
    const s = foldEvents([
      created(1, 10, { id: 'good', text: 'a good node' }),
      { seq: 2, at: 20, type: 'nonsense', data: {} },
      created(3, 30, { id: 'also-good', text: 'another good node' }),
    ])
    assert.equal(s.nodes.size, 2, 'both good nodes must be present')
    assert.equal(s.problems.length, 1, 'the bad event is recorded')
  })

  test('a duplicate id is recorded as a problem and does not overwrite the existing node', () => {
    const s = foldEvents([
      created(1, 10, { id: 'dup', text: 'version one' }),
      created(2, 20, { id: 'dup', text: 'attempted overwrite' }),
    ])
    assert.equal(nodeOf(s, 'dup').text, 'version one', 'first one wins; it is not overwritten')
    assert.equal(s.problems.length, 1)
  })

  test('node.revised keeps history and increments revision', () => {
    const s = foldEvents([
      created(1, 10, { id: 'a', text: 'first draft' }),
      { seq: 2, at: 20, type: 'node.revised', data: { id: 'a', text: 'the revised one', reason: 'more precise wording' } },
    ])
    const n = nodeOf(s, 'a')
    assert.equal(n.text, 'the revised one')
    assert.equal(n.revision, 2)
    assert.equal(n.history.length, 2)
    assert.equal(n.history[1].before, 'first draft')
    assert.equal(n.history[1].reason, 'more precise wording')
  })
})

describe('ledger · bi-temporal supersession (retire rather than delete)', () => {
  test('node.superseded closes valid_to and records supersededBy; the node remains', () => {
    const s = foldEvents([
      created(1, 100, { id: 'old', text: 'the port is 8000', subject: 'svc', relation: 'port', object: '8000' }),
      created(2, 200, { id: 'new', text: 'the port is 8080', subject: 'svc', relation: 'port', object: '8080' }),
      { seq: 3, at: 200, type: 'node.superseded', data: { id: 'old', byId: 'new', reason: 'migration' } },
    ])
    const old = nodeOf(s, 'old')
    assert.equal(old.status, STATUS.SUPERSEDED)
    assert.equal(old.validTo, 200, 'valid_to is closed')
    assert.equal(old.supersededBy, 'new')
    assert.ok(nodeOf(s, 'old'), 'the old node **is still in the ledger**; nothing was deleted')
    assert.equal(s.nodes.size, 2)
  })

  test('only active nodes take part in search', () => {
    const s = foldEvents([
      created(1, 100, { id: 'old', text: 'A' }),
      created(2, 200, { id: 'new', text: 'B' }),
      { seq: 3, at: 200, type: 'node.superseded', data: { id: 'old', byId: 'new' } },
    ])
    const act = activeNodes(s)
    assert.equal(act.length, 1)
    assert.equal(act[0].id, 'new')
  })

  test('the supersession chain can be walked all the way to its end (evolution history)', () => {
    const s = foldEvents([
      created(1, 100, { id: 'v1', text: 'first version of the idea' }),
      created(2, 200, { id: 'v2', text: 'second version of the idea' }),
      created(3, 300, { id: 'v3', text: 'third version of the idea' }),
      { seq: 4, at: 200, type: 'node.superseded', data: { id: 'v1', byId: 'v2' } },
      { seq: 5, at: 300, type: 'node.superseded', data: { id: 'v2', byId: 'v3' } },
    ])
    const { chain, terminal } = supersedeChain(s, 'v1')
    assert.deepEqual(chain.map((n) => n.id), ['v1', 'v2', 'v3'])
    assert.equal(terminal.id, 'v3')
    assert.equal(terminal.status, STATUS.ACTIVE)
  })

  test('a cyclic supersession chain does not loop forever (dirty-data guard)', () => {
    const s = foldEvents([
      created(1, 100, { id: 'a', text: 'A' }),
      created(2, 200, { id: 'b', text: 'B' }),
      { seq: 3, at: 200, type: 'node.superseded', data: { id: 'a', byId: 'b' } },
      { seq: 4, at: 300, type: 'node.superseded', data: { id: 'b', byId: 'a' } },
    ])
    const { chain } = supersedeChain(s, 'a')
    assert.equal(chain.length, 2, 'it stops on a cycle instead of looping forever')
  })

  test('node.withdrawn is the other kind of retirement (withdrawn, not superseded by anyone)', () => {
    const s = foldEvents([
      created(1, 10, { id: 'x', text: 'I was wrong' }),
      { seq: 2, at: 20, type: 'node.withdrawn', data: { id: 'x', reason: 'insufficient evidence' } },
    ])
    const n = nodeOf(s, 'x')
    assert.equal(n.status, STATUS.WITHDRAWN)
    assert.equal(n.supersededBy, null, 'withdrawal is not supersession')
    assert.equal(activeNodes(s).length, 0)
  })

  test('a supersession pointing at a missing node → problem, no crash', () => {
    const s = foldEvents([{ seq: 1, at: 1, type: 'node.superseded', data: { id: 'ghost', byId: 'nope' } }])
    assert.equal(s.problems.length, 1)
    assert.match(s.problems[0].reason, /missing node/)
  })
})

describe('ledger · bidirectional links and backlinks', () => {
  const base = foldEvents([
    created(1, 10, { id: 'a', text: 'A' }),
    created(2, 20, { id: 'b', text: 'B' }),
    { seq: 3, at: 30, type: 'edge.linked', data: { from: 'a', to: 'b', type: 'complements' } },
  ])

  test('backlinks = who references me', () => {
    const back = backlinksOf(base, 'b')
    assert.equal(back.length, 1)
    assert.equal(back[0].from, 'a')
    assert.equal(back[0].type, 'complements')
  })

  test('outlinks = whom I reference', () => {
    const out = outlinksOf(base, 'a')
    assert.equal(out.length, 1)
    assert.equal(out[0].to, 'b')
  })

  test('one node pair can carry several relations at once (complement and tension are not mutually exclusive)', () => {
    const s = foldEvents([
      created(1, 10, { id: 'a', text: 'A' }),
      created(2, 20, { id: 'b', text: 'B' }),
      { seq: 3, at: 30, type: 'edge.linked', data: { from: 'a', to: 'b', type: 'complements' } },
      { seq: 4, at: 40, type: 'edge.linked', data: { from: 'a', to: 'b', type: 'tensions' } },
    ])
    assert.equal(s.edges.length, 2)
  })

  test('an exactly identical edge is deduplicated', () => {
    const s = foldEvents([
      created(1, 10, { id: 'a', text: 'A' }),
      created(2, 20, { id: 'b', text: 'B' }),
      { seq: 3, at: 30, type: 'edge.linked', data: { from: 'a', to: 'b', type: 'related' } },
      { seq: 4, at: 40, type: 'edge.linked', data: { from: 'a', to: 'b', type: 'related' } },
    ])
    assert.equal(s.edges.length, 1)
  })

  test('a self-link is rejected and recorded as a problem', () => {
    const s = foldEvents([
      created(1, 10, { id: 'a', text: 'A' }),
      { seq: 2, at: 20, type: 'edge.linked', data: { from: 'a', to: 'a' } },
    ])
    assert.equal(s.edges.length, 0)
    assert.equal(s.problems.length, 1)
  })

  test('an edge pointing at a nonexistent node is rejected (no one-way dangling edges)', () => {
    const s = foldEvents([created(1, 10, { id: 'a', text: 'A' }), { seq: 2, at: 20, type: 'edge.linked', data: { from: 'a', to: 'ghost' } }])
    assert.equal(s.edges.length, 0)
    assert.equal(s.problems.length, 1)
  })

  test('edge.unlinked removes the specified relation', () => {
    const s = foldEvents([
      created(1, 10, { id: 'a', text: 'A' }),
      created(2, 20, { id: 'b', text: 'B' }),
      { seq: 3, at: 30, type: 'edge.linked', data: { from: 'a', to: 'b', type: 'complements' } },
      { seq: 4, at: 40, type: 'edge.linked', data: { from: 'a', to: 'b', type: 'tensions' } },
      { seq: 5, at: 50, type: 'edge.unlinked', data: { from: 'a', to: 'b', type: 'complements' } },
    ])
    assert.equal(s.edges.length, 1)
    assert.equal(s.edges[0].type, 'tensions')
  })
})

describe('supersede · normalization', () => {
  test('full-width and half-width are unified (essential for CJK input)', () => {
    assert.equal(normalizeComponent('ＡＢＣ'), 'abc')
    assert.equal(normalizeComponent('abc'), 'abc')
  })

  test('case and whitespace are flattened', () => {
    assert.equal(normalizeComponent('  Hello   World  '), 'hello world')
  })

  test('a non-string yields an empty string (it does not throw)', () => {
    assert.equal(normalizeComponent(undefined), '')
    assert.equal(normalizeComponent(null), '')
    assert.equal(normalizeComponent(42), '')
  })

  test('a missing component means no assertion key', () => {
    assert.equal(assertionKey({ subject: 'a', relation: 'b' }), 'a\u0000b')
    assert.equal(assertionKey({ subject: 'a' }), null)
    assert.equal(assertionKey({ relation: 'b' }), null)
    assert.equal(assertionKey({}), null)
  })
})

describe('supersede · deterministic verdicts (the core of this plugin)', () => {
  const existing = [
    { id: 'old', subject: 'svc', relation: 'port', object: '8000', status: 'active', text: 'port 8000' },
  ]

  test('same key, different object → supersede (contradiction)', () => {
    const v = classify({ subject: 'svc', relation: 'port', object: '8080' }, existing)
    assert.equal(v.relation, 'supersede')
    assert.equal(v.target.id, 'old')
  })

  test('same key, same object → duplicate (restatement)', () => {
    const v = classify({ subject: 'svc', relation: 'port', object: '8000' }, existing)
    assert.equal(v.relation, 'duplicate')
  })

  test('the verdict is entirely independent of "how similar the wording is" — which is what the published findings require', () => {
    // These two sentences are nearly identical in wording, but the object differs → this must be a contradiction
    const a = classify({ subject: 'svc', relation: 'port', object: '8000' }, existing)
    const b = classify({ subject: 'svc', relation: 'port', object: '8080' }, existing)
    assert.equal(a.relation, 'duplicate')
    assert.equal(b.relation, 'supersede')
    // Conversely: very different wording with the same object → still a restatement
    const c = classify(
      { subject: 'service', relation: 'listening port', object: '8000' },
      [{ id: 'x', subject: 'svc', relation: 'port', object: '8000', status: 'active' }],
    )
    assert.equal(c.relation, 'novel', 'a different subject/relation is a different assertion and must not be conflated')
  })

  test('a different key → novel', () => {
    const v = classify({ subject: 'svc', relation: 'host', object: 'localhost' }, existing)
    assert.equal(v.relation, 'novel')
  })

  test('a missing triple → unkeyed (it takes no part in supersession but is still stored)', () => {
    const v = classify({ text: 'a judgment with no triple' }, existing)
    assert.equal(v.relation, 'unkeyed')
  })
})

describe('supersede · events produced by planWrite', () => {
  const ctx = { at: 1000, nextSeq: 0, newId: 'n_new' }

  test('novel → only node.created is produced', () => {
    const s = createState()
    const { events, outcome } = planWrite(s, { text: 'a new idea', subject: 'a', relation: 'b', object: 'c' }, ctx)
    assert.equal(outcome.action, 'created')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'node.created')
  })

  test('supersede → created + superseded + one supersedes edge', () => {
    const s = foldEvents([created(1, 100, { id: 'old', text: 'old', subject: 'svc', relation: 'port', object: '8000' })])
    const { events, outcome } = planWrite(s, { text: 'new', subject: 'svc', relation: 'port', object: '8080', reason: 'migration' }, ctx)
    assert.equal(outcome.action, 'supersede')
    assert.equal(outcome.supersededId, 'old')
    assert.deepEqual(events.map((e) => e.type), ['node.created', 'node.superseded', 'edge.linked'])
    assert.equal(events[2].data.type, 'supersedes')
  })

  test('duplicate → no events at all, no new node', () => {
    const s = foldEvents([created(1, 100, { id: 'old', text: 'old', subject: 'svc', relation: 'port', object: '8000' })])
    const { events, outcome } = planWrite(s, { text: 'the same thing', subject: 'svc', relation: 'port', object: '8000' }, ctx)
    assert.equal(outcome.action, 'duplicate')
    assert.deepEqual(events, [], 'a restatement writes nothing to disk')
    assert.equal(outcome.nodeId, 'old')
  })

  test('all produced events fold back into a self-consistent state (no problems, correct statuses)', () => {
    const s0 = foldEvents([created(1, 100, { id: 'old', text: 'old', subject: 'svc', relation: 'port', object: '8000' })])
    const { events } = planWrite(s0, { text: 'new', subject: 'svc', relation: 'port', object: '8080' }, ctx)
    const s1 = foldEvents([
      created(1, 100, { id: 'old', text: 'old', subject: 'svc', relation: 'port', object: '8000' }),
      ...events,
    ])
    assert.deepEqual(s1.problems, [], 'feeding this module output back into fold must produce no problems')
    assert.equal(activeNodes(s1).length, 1)
    assert.equal(nodeOf(s1, 'old').status, STATUS.SUPERSEDED)
    assert.equal(nodeOf(s1, 'n_new').status, STATUS.ACTIVE)
  })

  test('sequence numbers increase and never collide with existing events', () => {
    const s = foldEvents([created(1, 100, { id: 'old', text: 'old', subject: 'a', relation: 'b', object: '1' })])
    const { events } = planWrite(s, { text: 'new', subject: 'a', relation: 'b', object: '2' }, { at: 200, nextSeq: 1, newId: 'x' })
    const seqs = events.map((e) => e.seq)
    assert.deepEqual(seqs, [2, 3, 4], 'numbering continues after nextSeq')
  })
})

describe('supersede · id generation', () => {
  test('same moment and same sequence number → reproducible', () => {
    assert.equal(makeNodeId(1000, 7), makeNodeId(1000, 7))
  })

  test('a different sequence number → a different id', () => {
    assert.notEqual(makeNodeId(1000, 7), makeNodeId(1000, 8))
  })
})

describe('silent-failure coverage (the community-recognized top hazard)', () => {
  test('applyEvent mutates the same object in place (the reduce semantics fold relies on)', () => {
    const s = createState()
    const r = applyEvent(s, created(1, 1, { id: 'a', text: 'A' }))
    assert.equal(r, s, 'it must return the same reference, or reduce would lose state')
    assert.equal(s.nodes.size, 1)
  })

  test('fold depends on nothing beyond the event array order (pure function)', () => {
    const evs = [created(1, 1, { id: 'a', text: 'A' }), created(2, 2, { id: 'b', text: 'B' })]
    const s1 = foldEvents(evs)
    const s2 = foldEvents(evs)
    assert.deepEqual([...s1.nodes.keys()], [...s2.nodes.keys()])
    assert.notEqual(s1, s2, 'every fold produces a fresh state; no global state is reused')
  })

  test('problems are observable — bad data never pretends to have succeeded', () => {
    const s = foldEvents([{ seq: 1, at: 1, type: 'bogus', data: {} }])
    assert.ok(s.problems.length > 0, 'a problem must be visible')
  })
})
