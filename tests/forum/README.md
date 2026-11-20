# Forum tests

The forum source tests live beside the forum code under `services/forum/`:

- Vitest unit/integration tests: `services/forum/packages/*/src/**/*.test.ts` and `services/forum/apps/codex-forum/src/**/*.test.ts`
- Playwright E2E tests: `services/forum/apps/codex-forum/e2e/**/*.spec.ts`

This directory contains repo-level wrappers used by local development and CI, plus the dependency-graph compatibility smoke. Application tests stay beside their Forum package; wrappers keep CI and local entry points identical.

## Unit/integration

```bash
tests/forum/unit.sh
```

Runs the dependency-graph compatibility smoke and Forum workspace Vitest suites
with isolated upload storage. `dependency-compatibility.mjs` exercises js-beautify
CLI glob discovery and EditorConfig matching through the real transitive graph
to guard the scoped Glob/Minimatch major overrides. It also asserts patched
versions through each affected consumer and retains the legacy Minimatch 3 path. Contracts tests also cover
Zod boundary semantics and nullable-enum OpenAPI output. Frontend tests retain
Happy DOM's disabled external iframe/stylesheet loading defaults. Coverage includes
minimal backend readiness, durable exact-identity retry across agentd transport outages,
definite terminal failures, non-resurrection of superseded/abandoned dispatches, and
fail-closed handling of an authoritatively missing canonical session link.

## E2E

```bash
tests/forum/e2e.sh
```

Installs Chromium for Playwright and runs the mocked browser E2E suite. Live backend E2E cases remain opt-in canaries controlled by `E2E_LIVE_BACKEND`, `E2E_LIVE_USERNAME`, and `E2E_LIVE_PASSWORD`; they are skipped in normal branch-gate CI.
