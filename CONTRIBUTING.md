# Contributing

Thanks for helping improve `dsh-ai-memory`.

The README is in Chinese because that is where the project is discussed; code,
comments, commit messages, and this document are in English so the reasoning
stays readable to anyone reading the diff.

## Before you start

- Read the [README](./README.md) to understand the ledger and the supersession
  model. The one idea worth internalising first: **similarity cannot tell a
  contradiction from a restatement**, which is why supersession is decided on a
  structural `(subject, relation, scope)` key and never on embeddings.
- Read [UPGRADE-SPEC.md](./UPGRADE-SPEC.md) if your change touches questions,
  cycles, or the self model — it records which parts are done and which
  constraints are easy to break by accident.

## Hard rules

These exist because each one corresponds to a failure that already happened:

1. **No runtime dependencies.** The plugin is installed into a profile with
   `link:`, which gives it no `node_modules`. Adding one makes the whole plugin
   fail to activate — silently.
2. **Never read a service you did not declare in `inject`.** `ctx` is a
   restricted proxy; reading an undeclared name throws, and the host then
   refuses to start the entire app.
3. **Do not add `webServer` to `inject`.** It is a scoped optional dependency;
   making it required loses the tools in profiles that lack it.
4. **Do not commit a real ledger, a personal path, or a credential.** The
   ledger contains someone's judgments and conversation content.
5. **Run `node test/inline-worker.mjs` after editing the graph worker.**
   `lib/client.js` carries an inlined copy and a test compares them byte for
   byte.
6. **Do not bypass `atomically()` when writing the ledger.** Reading state
   outside the lock reintroduces the racy `seq` allocation the lock exists to
   prevent.

## Development checks

Node.js 22 or newer. No install step — there are no dependencies.

```powershell
npm test                        # unit suite
node test/e2e.mjs               # lifecycle, end to end
node test/manifest-check.mjs    # manifest, syntax, and hard-constraint checks
```

Two manual verifications, used when the corresponding area changes:

```powershell
node test/verify-physics.mjs       # graph forces vs. Obsidian's measured values
node test/verify-concurrency.mjs   # multi-process ledger writes
```

If a check needs a local DSH host, say so in the pull request rather than
skipping it silently.

## What a good change looks like

- **Behaviour changes come with a test that fails without them.** This is not
  ceremony: adding tests for the previous round of changes surfaced two silent
  bugs (a field never written to the event, a field never forwarded) that had
  left 302 tests green.
- **Prefer a measurement to an argument.** "This is 8.4× too compact, here is
  the input and the output" is reviewable; "this feels wrong" is not.
- **Keep commits focused.** One behaviour per commit, so a revert is a revert.
- **Update comments that are now false.** A stale comment is a future bug: it
  is how a hard-coded threshold survived a rewrite that was supposed to remove
  it.

## Pull requests

Fill in the template. The two fields that matter most are *how it was verified*
(paste the output) and *behaviour change* (does this reinterpret existing
ledgers?).

## Reporting bugs

Use the issue templates. For anything that looks like a security problem, see
[SECURITY.md](./SECURITY.md) — do not open a public issue.
