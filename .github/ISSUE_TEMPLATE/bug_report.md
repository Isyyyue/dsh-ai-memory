---
name: Bug report
about: Something behaves differently from what the code and docs claim
title: ''
labels: bug
assignees: ''
---

## What happened

<!-- One or two sentences. What did you expect, what did you get? -->

## Steps to reproduce

1.
2.
3.

## Environment

- DSH version: <!-- the host's own version, e.g. 0.2.1-rc.2 -->
- dsh-ai-memory version: <!-- from package.json, or the commit you built -->
- Node.js version:
- OS:

## Evidence

<!--
Paste actual output. "It doesn't work" cannot be investigated; a stack trace,
a ledger line, or a tool response can.

⚠️ Do NOT paste a real ledger. It contains your judgments and conversation
content. Reproduce with a temporary directory instead:

    const { openLibrary, createOperations } = await import('./src/index.js')
    const lib = openLibrary('/tmp/repro')
    const ops = createOperations(lib)
-->

\	ext
paste output here
\	ext

## Is it silent?

<!--
This project's worst failures do not throw. If nothing errored and the result
was simply wrong, say so — that is a different class of bug and is treated as
more serious.
-->

- [ ] It threw an error
- [ ] No error, but the result was wrong
- [ ] No error, and I only noticed later that something was missing
