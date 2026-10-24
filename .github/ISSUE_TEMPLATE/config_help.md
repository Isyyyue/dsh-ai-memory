---
name: Configuration help
about: The plugin installed but does not activate, or a tool is missing
title: ''
labels: question
assignees: ''
---

## Symptom

<!-- e.g. "no sidebar entry", "tools are missing", "panel says 读不到记忆库" -->

## What the host reports

```powershell
plugin_manager action=list_plugins
\	ext

\	ext
paste the dsh-ai-memory entry here
\	ext

## Checks already run

```powershell
npm test
node test/manifest-check.mjs
node test/verify-profile.mjs      # is the installed copy current?
node test/bundle-served.mjs       # is the client bundle being served?
\	ext

\	ext
paste output
\	ext

## Common causes, before you file this

| Symptom | Cause | Fix |
|---|---|---|
| Panel opens, shows `HTTP 404` | The bundle is installed but **disabled**, so host routes are not mounted | `plugin_manager action=set_bundle target=dsh-ai-memory enabled=true` |
| Tools missing entirely | Plugin failed to activate — most often a service read without `inject` | Check the host log for `dsh-ai-memory: failed` |
| Changes to `src/*.js` have no effect | The host reads modules once at startup | Restart DSH |
| Changes to `lib/client.js` have no effect | Client bundle is cached per loader specifier | Restart DSH |
