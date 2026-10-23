# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-10-24

The release that changes what the ledger can represent: a judgment is no
longer the only thing memory can hold. Memory can now carry **unfinished
questions**, which is what lets a thinking cycle start when no user is
present.

### Added

- **`scope`: the third dimension of the assertion key.** With only
  `(subject, relation)`, exactly one answer could be live at a time, so
  "dev runs on 8000" and "prod runs on 8080" were collapsed into a
  supersession and the ledger recorded a change of mind that never happened.
  Same subject/relation with a different scope is now a different assertion,
  and both stay active. An absent scope means the global scope and produces a
  byte-identical key to before, so existing ledgers need no migration.
- **Open questions** (`question.opened` / `touched` / `closed` / `abandoned`).
  A judgment records a conclusion; a question records an obligation to keep
  thinking. `src/attention.js` ranks them by urgency, unresolved gap,
  staleness and a fatigue term that decays repeated attempts so one hard
  question cannot absorb every cycle.
- **Thinking cycles** (`cycle.started` / `cycle.ended`). `produced: 0` is a
  first-class outcome: "thought about it and had nothing to say" is a real
  result, and a system that must emit something every turn is answering, not
  thinking.
- **`trigger`** on every judgment: `user` / `evidence` / `self`. Recorded,
  never inferred. This is the only field that makes "it is evolving on its
  own" checkable rather than felt — count the `self` judgments and see how
  many survived.
- **Three tools**: `memory_question`, `memory_cycle`, `memory_self`
  (fragile subjects, repeated mistakes, blind spots, self ratio).
- **`memory_connect` unlink**, and a whitelist that forbids hand-made
  `supersedes` edges — that relation may only come from the engine.
- **`GET /plugins/dsh-ai-memory/questions`** for the graph panel, reusing the
  existing loopback + same-origin guard.
- **`retiredCount`** in the graph snapshot, so the panel can say how many
  superseded judgments are hidden instead of silently omitting them.

### Fixed

- **Duplicate node ids silently dropped judgments.** `makeNodeId` produced
  `n_<seq>_<last 6 base36 chars of the timestamp>`. Two processes that read
  the same `state.seq` compute the same `seq + 1`, and if their clocks land
  in the same millisecond they also compute the same timestamp suffix — so
  both emit a byte-identical id and the second `node.created` is discarded.
  Measured: 8 processes × 5 writes left 40 ledger lines but only **29 folded
  nodes**; eleven judgments existed in the file and were invisible to search
  and injection. The suffix is now 64 bits of entropy.
- **`seq` order was not equal to commit order.** Unique ids stop nodes from
  being dropped; they do not stop two writers computing the same `seq`, and
  `foldEvents` sorts by `seq` while `supersedeChain` walks links in that
  order. All write paths now run read-decide-append inside a ledger lock.
- **The lock's own creation race.** Creating the lock with `O_EXCL` and then
  writing the owner leaves a window where the file exists but is empty; a
  second process reads `''`, treats it as abandoned and deletes it. Measured
  maximum concurrent depth was **2**. The owner is now staged in a temp file
  and hard-linked into place, so the content is complete the instant the path
  becomes visible.
- **`classify()` picked the oldest same-key node** as the supersession
  target, because `sameKey = n` overwrote nothing on later iterations. The
  newest node is the position actually being contradicted.
- **`kind` could silently downgrade.** `VALID_KINDS` derived from
  `Object.values(KIND)` (which includes `persona`) while `applyEvent`
  accepted only rule/insight, so `memory_write({kind:'persona'})` stored
  `persona` and folded it back as `judgment` with no problem recorded. Both
  sides now derive from `NODE_KINDS`, and an unknown kind records a problem.
- **Graph physics now matches Obsidian.** Three measured differences:
  a missing `distanceMin` clamp (near-field repulsion was up to **30×** too
  strong, which is what made the layout jitter), link strength as a constant
  instead of `1/min(degA, degB)` (**20×** too strong on hubs), and a bias
  formula that inverted which end moves. Label opacity now follows
  Obsidian's `clamp(log2(scale) + 1 - textFadeMultiplier, 0, 1)` instead of a
  hard `scale > 0.85` threshold, so zooming fades rather than jumps.
- **Injection had no budget for rules.** 60 rules all entered the prompt
  (7006 characters); `maxIndexEntries` only governed judgments.

### Guardrails

Unattended self-writing is now constrained, because these three failures are
certainties otherwise:

1. A `self` write may only create an `insight`, never a `judgment` or `rule`
   — with no one to correct it, it would otherwise grow more confident from
   its own ledger.
2. A `self` write must cite a real memory id or a real file path, so a
   fabricated rationale cannot become a fact three days later.
3. `persona` accept cannot be triggered by `self`; only the user can promote
   a candidate trait.

### Changed

- `makeNodeId` is no longer reproducible for the same `(at, seq)`.
  Uniqueness replaces reproducibility; tests that need a fixed id pass one in
  explicitly via `planWrite`'s `newId`.
- `peerDependencies` now declares `@deepseek-ai/dsh`, so the host's
  compatibility check is no longer a no-op.

### Known limits

- Every operation re-reads the whole ledger; past tens of thousands of
  judgments this needs an index layer.
- Personality candidates are proposed by the caller; the plugin stores,
  confirms and evolves them, it does not extract traits from prose.
- Visual verification of the panel still requires a DSH host; the renderer is
  covered by unit tests but has not been eyeballed in this release.

## [0.1.0] — 2026-10-17

First release: append-only bi-temporal ledger, deterministic supersession on
`(subject, relation)`, bi-directional links, governed rules with rollback,
two-phase personality growth, eight tools, and a Canvas force-directed graph
panel.

[0.2.0]: https://github.com/Isyyyue/dsh-ai-memory/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Isyyyue/dsh-ai-memory/releases/tag/v0.1.0
