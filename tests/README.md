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
and opt-in live backend canaries. Forum unit coverage verifies that dedicated
subagent child paths are omitted from sync and that live and historical async
completion continuations project once beneath their recorded origin without a
fake user post.

## Agentd tests

Provider-independent Pi lifecycle and workspace-loading tests live under
`services/agentd/test/`:

```bash
cd services/agentd
pnpm test
```

The container build runs this suite after installing agentd's frozen production
lockfile, so the tests exercise the same Pi packages shipped in the image. The
subagent lifecycle tests cover durable origin capture, separation of logical and
process-terminal completion, grouped completion attribution, restart artifact
reconciliation, public v1 stop RPC use, global persisted-run scans,
canonical completion provenance, and conservative 14-day terminal-session
retention.

## Stateful-memory tests

Progressive recall selection, excerpt bounds, pagination, enrichment budgets, and
pi-subagents child context boundaries have provider-independent Node tests:

```bash
nix-shell -p nodejs_22 --run \
  'node --experimental-default-type=module --test \
    tests/stateful-memory/recall-utils.test.js \
    tests/stateful-memory/child-context.test.js'
```

The child-context suite verifies topic-only specialist prompts, the
`monika-delegate` stable persona trio, absence of WAKE/FACTS/observations and
memory tools, explicit `extensions` allowlists, and child-local compaction.

Memstore's Go suite covers FTS search, save deduplication, and append-only observation
supersession/retraction:

```bash
nix-shell -p go gcc --run \
  'cd services/memstore && CGO_ENABLED=1 go test -tags fts5 ./...'
```

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
4. `pi --version` reports the repository's exact Pi pin;
5. npm's 10-day dependency cooldown, pnpm 10.26.2, and the pinned agent-browser version are active;
6. the reviewed pi-subagents 0.37.2 gitHead (`8063333661476ca48afbca826dc4aab8707c72d3`) is installed, `defaultExtensions=[]` and isolated child profiles are configured, and legacy force-tools/delegate extensions are absent;
7. interactive project-trust state is linked into persistent `/data`;
8. agentd sends a complete Pi turn to a local OpenAI Responses fixture, which requires `pi_run`, `browser`, `subagent`, `subagent_wait`, and `subagent_supervisor` while rejecting the legacy `delegate` tool;
9. every strict function schema in the serialized request satisfies OpenAI's
   `additionalProperties: false` and required-property rules;
10. an interactive Pi ownership lease evicts an idle agentd runtime, blocks forum reopen and deployment, heartbeats, and releases cleanly;
11. agentd quiescence reports the reloaded idle conversation and deploy drain closes it;
12. `scripts/deploy-if-safe --backup-only` can create and verify an isolated runtime capsule backup through a mock forum quiescence endpoint;
13. the container stops cleanly on SIGTERM.

The model fixture runs in a second throwaway container on an isolated Docker
network. It exercises Pi's real extension loading, tool serialization, provider
request, streaming response parsing, and agentd turn lifecycle without contacting
an external provider. This catches invalid strict tool schemas during image CI;
real-provider canaries remain separate because they require secrets, network
availability, and quota. Provider-independent agentd lifecycle coverage also
lives in `services/agentd/test/`, including the distinction between Pi's
`agent_end` and authoritative `agent_settled` completion.

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

### `smoke/forum-runtime.sh`

Validates that a forum runtime image starts, serves health and static frontend,
and contains only production dependencies.

```bash
docker build -f services/forum/Containerfile -t monika-forum-test ./services/forum
tests/smoke/forum-runtime.sh monika-forum-test
```

The script verifies:

1. the container starts with ephemeral state and a dummy agentd URL;
2. `/healthz` returns `{"ok":true}`;
3. `GET /` serves the built frontend HTML;
4. representative dev-only packages (vitest, vite, typescript, eslint, prettier,
   vue-tsc, playwright, husky, lint-staged) are absent from `node_modules`;
5. runtime-critical packages (tsx, fastify, better-sqlite3, sharp) are present;
6. workspace packages (core, contracts, adapters) are present with source files;
7. build toolchain (python3, make, g++, pnpm) is absent from the runtime image;
8. native modules (better-sqlite3, sharp) load successfully.

## Test compose

`tests/compose.monika-runtime.yaml` is a test-only standalone compose file for
manual runtime startup with ephemeral Docker volumes. It is not a deployment
template. Use `compose.yaml.example` for real deployments.

```bash
docker compose -f tests/compose.monika-runtime.yaml up -d
docker exec -it monika-test pi
```
