# Tests

This directory contains repo-level tests that can run both locally and in CI. CI
should call these scripts rather than embedding test logic directly in workflow
YAML.

## Test philosophy

Tests in this repo are branch gates for Monika's runtime. They should be:

- **Lean** — check the failure mode directly and avoid broad end-to-end flows when
a smaller invariant gives the same signal.
- **Non-flaky** — no dependency on live model providers, external APIs, wall-clock
race assumptions, or mutable production state unless a test is explicitly marked
as a canary.
- **Locally runnable** — the same command used by CI should work from a developer
shell with Docker available.
- **Isolated** — smoke tests must use throwaway containers, ephemeral data, and no
live memstore database or host-mode Monika mounts.
- **Readable** — logs should show the image under test, what was verified, and the
first useful diagnostic on failure without dumping large raw payloads.

## Forum tests

Forum source tests live under `services/forum/`. Repo-level wrappers live in
`tests/forum/` so CI can call scripts rather than embedding test logic directly
in workflow YAML.

```bash
tests/forum/unit.sh
tests/forum/e2e.sh
```

See `tests/forum/README.md` for the split between Vitest, mocked Playwright E2E,
and opt-in live backend canaries.

## Smoke tests

### `smoke/monika-runtime.sh`

Validates that a Monika runtime image can start in standalone mode and bootstrap
Pi enough to serve agentd requests.

```bash
docker build -f Containerfile -t monika-test .
tests/smoke/monika-runtime.sh monika-test
```

The script verifies:

1. the container starts with bundled `/app/.pi` state and ephemeral `/data`;
2. memstore creates its Unix socket;
3. agentd answers `/healthz`;
4. `pi --version` works inside the container;
5. agentd can create a Pi conversation without sending an LLM prompt;
6. agentd quiescence reports the loaded idle conversation and deploy drain closes it;
7. `scripts/deploy-if-safe --backup-only` can create and verify an isolated runtime capsule backup through a mock forum quiescence endpoint;
8. the container stops cleanly on SIGTERM.

The smoke test deliberately does **not** call a real model provider. Provider
canaries belong in a separate trusted-branch workflow because they require
secrets, network availability, and quota.

### `smoke/deploy-if-safe-drain-lifecycle.sh`

Validates the deploy script's agentd drain lifecycle using stubbed `docker` and
`curl` commands. It does not contact the live runtime or Docker daemon.

```bash
tests/smoke/deploy-if-safe-drain-lifecycle.sh
```

The script verifies:

1. a forum-only image update does not drain agentd;
2. a monika image update starts drain before backup;
3. the deploy script renews drain immediately before Compose runs;
4. the deploy script cancels drain after Compose reports the deployment applied.

This protects the failure mode where agentd stays in deploy drain after a
forum-only update because the monika container was not recreated.

## Test compose

`tests/compose.monika-runtime.yaml` is a test-only standalone compose file for
manual runtime startup with ephemeral Docker volumes. It is not a deployment
template. Use `compose.yaml.example` for real deployments.

```bash
docker compose -f tests/compose.monika-runtime.yaml up -d
docker exec -it monika-test pi
```
