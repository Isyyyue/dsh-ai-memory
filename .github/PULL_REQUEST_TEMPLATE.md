## What this changes

<!-- One paragraph. What behaviour is different after this PR? -->

## Why

<!--
The reason, not the diff. If this fixes a bug, describe how it manifested —
"silently", "only under concurrency", "only on a narrow panel" — because the
class of failure determines how it should be tested.
-->

## How it was verified

<!--
Paste the actual commands and their result lines. A claim of "tests pass"
without output is not verification.

    npm test                 → ℹ pass 381 / ℹ fail 0
    node test/e2e.mjs        → 40/40 passed
    node test/checks/manifest-check.mjs → passed
-->

```
paste output
```

## Checklist

- [ ] `npm test` passes, and the test count went **up** if behaviour changed
- [ ] New behaviour has a test that would **fail without this change**
- [ ] Ran `node test/checks/inline-worker.mjs` if `lib/client.graph-worker.js` changed
      (the worker source is inlined into `lib/client.js` and compared byte for byte)
- [ ] No new runtime dependency (`link:` installs get no `node_modules`)
- [ ] No real ledger, personal path, or credential in the diff
- [ ] Doc/comment updated where the old text would now be wrong

## Behaviour change, if any

<!--
Does this alter how existing ledgers are interpreted? Anything that changes
supersession, assertion keys, or injection content needs a note here, because
silent reinterpretation of past data is the failure this project cares most
about avoiding.
-->
