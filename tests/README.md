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
5. agentd can create and close a Pi conversation without sending an LLM prompt.

The smoke test deliberately does **not** call a real model provider. Provider
canaries belong in a separate trusted-branch workflow because they require
secrets, network availability, and quota.

## Test compose

`tests/compose.monika-runtime.yaml` is a test-only standalone compose file for
manual runtime startup with ephemeral Docker volumes. It is not a deployment
template. Use `compose.yaml.example` for real deployments.

```bash
docker compose -f tests/compose.monika-runtime.yaml up -d
docker exec -it monika-test pi
```
