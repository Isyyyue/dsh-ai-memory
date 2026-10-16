# Contributing

Thanks for helping improve `dsh-ai-memory`.

## Before you start

- Read the [README](./README.md) to understand the ledger and supersession model.
- Keep the plugin dependency-free. Do not add runtime dependencies without documenting the installation and bundle impact.
- Do not commit personal ledgers, local browser automation files, or host-specific configuration.

## Development checks

Use Node.js 22 or newer, then run:

```powershell
npm test
npm run test:e2e
node test/manifest-check.mjs
```

If an end-to-end check needs a local DSH host, describe that limitation in the pull request.

## Pull requests

- Explain the user-visible behavior and the reason for the change.
- Add or update tests for behavior changes.
- Keep commits focused and avoid unrelated formatting churn.
- Never include secrets, memory ledgers, or machine-specific paths.

