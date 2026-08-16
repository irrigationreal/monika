# Forum tests

The forum source tests live beside the forum code under `services/forum/`:

- Vitest unit/integration tests: `services/forum/packages/*/src/**/*.test.ts` and `services/forum/apps/codex-forum/src/**/*.test.ts`
- Playwright E2E tests: `services/forum/apps/codex-forum/e2e/**/*.spec.ts`

This directory contains repo-level wrappers used by local development and CI. Keep the test logic in the forum package; keep these scripts thin so CI and local runs exercise the same commands.

## Unit/integration

```bash
tests/forum/unit.sh
```

Runs the forum workspace Vitest suites with isolated upload storage. Coverage includes
minimal backend readiness, durable exact-identity retry across agentd transport outages,
definite terminal failures, non-resurrection of superseded/abandoned dispatches, and
fail-closed handling of an authoritatively missing canonical session link.

## E2E

```bash
tests/forum/e2e.sh
```

Installs Chromium for Playwright and runs the mocked browser E2E suite. Live backend E2E cases remain opt-in canaries controlled by `E2E_LIVE_BACKEND`, `E2E_LIVE_USERNAME`, and `E2E_LIVE_PASSWORD`; they are skipped in normal branch-gate CI.
