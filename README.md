# dsh-ai-memory

A memory layer for an AI that holds **its own judgments** — judgment nodes, **deterministic
supersession**, a bi-temporal ledger, and bidirectional links. Rules are governed separately from
judgments, and the graph is the explainability surface.

> **Positioning (following the official DSH stance):** `the session log is the only source of truth; this plugin is a derived memory cache.`
> It **appends no session events** (doing so would make sessions impossible to reopen). Judgments
> live in their own ledger, and the current state is folded out of that ledger.

---

## The problem it solves

Out of the box, DSH only remembers what happened **inside a single session**. Cross-session
**judgments** — stances the model arrived at rather than facts it was told — have nowhere to live,
and a judgment cannot be looked up; it can only be grown.

This plugin lets an AI:

1. **Remember its own judgments**, not just facts;
2. **Change its mind** by **superseding** the old judgment instead of overwriting it — the old
   judgment is retired but **stays in the ledger**, so its provenance remains visible;
3. **Mark contradictions explicitly** when it finds them, instead of letting two entries coexist
   and contaminate each other;
4. **Keep its own rules**, where amending a rule requires a stated reason and is auditable and
   reversible;
5. **See on the graph** how this web grew.

---

## Why deterministic supersession rather than similarity

This is the most important design argument behind the plugin, and it has empirical backing
([arXiv 2606.26511](https://arxiv.org/abs/2606.26511), MemStrata):

> Across 98 annotated pairs, cosine similarity separates "contradiction" from "restatement" with
> an **AUROC of only 0.59 (close to random)**; and **contradictions are on average more similar to
> the original fact than restatements are** (0.812 vs 0.800) — because a "value flip"
> (8000 → 8080) is a **smaller edit** than a genuine paraphrase.

So: **similarity cannot, in principle, distinguish contradiction from restatement.** The decision
has to be structural:

> If a new fact **shares the (subject, relation) key with a stored fact but asserts a different
> object**, the new one supersedes the old — **regardless of how similar their embeddings are**.

The supersession engine here therefore **contains no similarity computation and no LLM call**: it
relies entirely on string normalization plus triple comparison. The benefits are testability,
reproducibility, zero dependencies, and zero latency.

**Two symmetric ablation results** set the engine's posture:

| Approach | Consequence |
|---|---|
| Aggressive merging (merge near-duplicates on write) | **Regresses below plain RAG** — it discards the detail needed to answer follow-up questions |
| No supersession at all | Hallucination rate **rises 6×**, which is **less safe than being inaccurate** (the model sees both old and new values and starts inventing) |

→ **"Preserve first, then supersede"**: compress along the contradiction axis only, and never merge
distinct facts.

---

## The six tools

| Tool | What it does |
|---|---|
| `memory_search` | Search existing judgments. **Must be called before writing** |
| `memory_write` | Write one judgment; given a triple, it performs deterministic supersession automatically |
| `memory_connect` | Create a bidirectional link: `complements` / `tensions` / `derives` / `depends` / `restates`; **both directions are written, no one-way edges** |
| `memory_history` | View the evolution trail: how many times it changed, who superseded it, where the supersession chain ends |
| `memory_rule` | Read / amend rules. **Amending a rule requires a reason** |
| `memory_stats` | Health check: judgment count, rule count, retired count, orphans, data problems |

### The three write outcomes

```
created     new judgment (no existing judgment on the same key)
supersede   same (subject, relation) key, different object → old judgment retired but preserved
duplicate   same key and same object → nothing is written to disk (one assertion needs no second card)
```

---

## Data model

### The ledger is the only source of truth (`~/.dsh/ai-memory/ledger.jsonl`)

Plain-text JSONL, **append-only, history is never rewritten**. Human-readable, git-diffable,
deletable, and hand-editable.

Seven event types:

```
node.created      new judgment / new rule
node.revised      text changed (historical versions preserved; not a refutation)
node.superseded   superseded (bi-temporal: closes the old node's valid_to, does not delete it)
node.withdrawn    withdrawn (self-detected as wrong, but not superseded by anything)
edge.linked       bidirectional link created
edge.unlinked     bidirectional link removed
rule.amended      rule changed (with a reason; auditable)
```

**Bi-temporal**: `validFrom`/`validTo` record **when the fact was true**, while `createdAt` records
**when the system learned it**.

### Everything derived is rebuildable

The graph, backlinks, the active set, and statistics — **all computed by folding the ledger**, and
deleting them loses no information. This matches the official requirement: plugin memory is a
derived cache.

---

## Configuration

Works with zero configuration. To change anything, override the config for the same id in the
profile's `cordis.patch.yml` (the user patch layer is applied after the bundle layer and
**survives upgrades**):

```yaml
- id: dsh-ai-memory
  name: dsh-ai-memory
  config:
    dir: 'D:\my-memory'      # default ~/.dsh/ai-memory
    injectIndex: true         # inject the judgment index at session start
    maxIndexEntries: 40       # max judgments listed in the index
    maxGraphNodes: 500        # max nodes in a graph snapshot
    enabled: true
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `dir` | string | `~/.dsh/ai-memory` | Memory store directory (holds `ledger.jsonl`) |
| `injectIndex` | boolean | `true` | Inject the judgment index into the system prompt at session start |
| `maxIndexEntries` | integer | `40` | Maximum judgments listed in the injected index |
| `maxGraphNodes` | integer | `500` | Maximum nodes in a graph snapshot; beyond this the snapshot reports `truncated` |
| `enabled` | boolean | `true` | When `false`, nothing is registered at all |

The injected index lists rules first, then active judgments up to `maxIndexEntries` (newest first),
then `insight` nodes on a smaller budget of `maxIndexEntries / 2` — insights are less load-bearing
than judgments, and occupying more context would dilute the rules and judgments that matter. The
index carries summaries, not full text; details are fetched on demand with `memory_search`.

---

## HTTP endpoints (graph panel data source)

| Route | Returns |
|---|---|
| `/plugins/dsh-ai-memory/snapshot` | Graph snapshot (nodes + edges + stats). `?retired=1` includes retired nodes |
| `/plugins/dsh-ai-memory/node?id=<id>` | Detail for a single judgment (including backlinks, supersession chain, revision history) |
| `/plugins/dsh-ai-memory/stats` | Statistics |

⚠️ **Security**: routes of the form `/plugins/<package-name>/...` **do not pass through** session
cookie validation (that only covers `/api` and WebSocket). The endpoints therefore perform two
checks themselves: **accept loopback origins only**, and **if an Origin header is present it must be
same-origin with Host**. Anything non-loopback or cross-origin is rejected with 403.

---

## Known boundaries (stated honestly)

- **No index layer**: every call rescans the whole ledger, O(all events). Tens of thousands of
  judgments would need an index; that is future work.
- **No concurrency lock**: two concurrent writes can both pass their checks and then append in an
  interleaved order (appends are atomic, so the worst case is an ordering problem, not lost data).
- **Extraction is the caller's job**: this plugin does no natural-language extraction — the triple
  is supplied by the model in `memory_write`. The academic side is explicit that **extraction
  quality, not the supersession mechanism, is the bottleneck** (97% for structured single values vs
  44% for messy natural language), and it is harder still in Chinese. This is the part the plugin
  deliberately does not touch.
- **The graph is a navigation layer**: nodes carry only a label (a summary), never the full text —
  details are fetched on demand with `memory_search`. This is deliberate (context bloat dilutes
  attention).

---

## Install

```powershell
plugin_manager action=install_bundle target=<absolute path to this directory>
```

Do not hand-edit the profile's `package.json` or `cordis.patch.yml`, and do not run pnpm inside the
profile directory — `install_bundle` handles both the package install and the bundle selection.

To disable or remove later (memory data is preserved either way):

```powershell
plugin_manager action=set_bundle target=dsh-ai-memory enabled=false
plugin_manager action=remove_bundle target=dsh-ai-memory
```

### ⚠️ The host must be restarted once after install

The **host half** (tools, injection, HTTP routes) takes effect immediately through HMR; the
**client half** (the graph panel) **requires a DSH restart**. The host collects `dsh.client` entries
during a startup scan, so a bundle installed after startup is not in that generation of JavaScript;
the browser therefore cannot get its `client.js`, **and no error is reported**.

After the restart, refresh the page and the judgment graph panel appears in the sidebar.
`node test/bundle-served.mjs` confirms whether the client bundle has entered the host's serving
table.

---

## Development

```powershell
cd dsh-plugins\plugins\dsh-ai-memory
node --test "test/**/*.test.js"   # unit tests (281)
node test/e2e.mjs                 # end-to-end lifecycle verification (40)
node test/manifest-check.mjs      # manifest + hard-constraint self-check
node test/bundle-served.mjs       # is the client bundle served by the host (--all adds a control)
```

The glob form is **required** for the unit tests: Node's default discovery would also run the
long-lived helper servers under `test/`.

**Zero external dependencies** is a hard constraint: installed into a profile via `link:`, the
plugin gets no `node_modules` of its own (two sibling plugins hit this, and it presents as "works
when installed, gone after a restart"). Tool definitions are therefore hand-written JSON Schema and
configuration is validated in-house.

---

## License

MIT — see [LICENSE](./LICENSE).
