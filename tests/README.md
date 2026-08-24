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
subagent child paths are omitted from both normal sync and direct import paths,
and that channel-neutral canonical utterances project individually; live-first and
sync-first races converge on identical transformed body, metadata, parent, follow-up,
and attachment handoff state without a fake user post. Deployment-admission tests
cover token auth, response DTO shape, idempotent ownership renewal/expiry, Pi-sync pause/wait/resume,
preparing revocation, acquired publication rollback, tracked in-flight agent/Director work, delayed handoff races,
explicit-dispatch atomicity, pending/running forks, and global durable blockers.

## Agentd tests

Provider-independent Pi lifecycle and workspace-loading tests live under
`services/agentd/test/`:

```bash
cd services/agentd
pnpm test
```

The container build runs this suite after installing agentd's frozen production
lockfile, so the tests exercise the same Pi packages shipped in the image. The
agentd test command creates explicit temporary runtime, result/session, and
runtime-instance roots; tests must never inherit the live `/data/pi-subagents`
root. Session-resolution coverage proves known-path dispatch reads only one target
amid 1,800 decoys and rejects containment escapes, symlinks, malformed/mismatched
headers, unresolved fork candidates, and ancestor-directory swaps both after
opening the validation descriptor and around Pi's unavoidable pathname reopen.
Shutdown seam tests prove HTTP/SSE termination and forced exit remain bounded when
canonical cleanup is fenced. HTTP safety coverage uses a real aborted HTTP socket
and keeps reset/destroyed clients from terminating agentd while preserving ordinary
errors. The subagent lifecycle tests use temporary files and injected process
inspection—no Docker timing, sleeps, model calls, or live state. They cover
passive restart recovery with zero recovered Pi messages/transcript writes,
structurally validated canonical settlement after exact claim, explicit
`awaited`/`follow_up`/`silent` delivery, audited manual delivery resolution,
durable origin and pre-spawn launch capture, event-independent convergence of
stale loaded leases, strict process-terminal proof, container-epoch legacy
migration, same-runtime PID/start-identity survival and death, fail-closed
traversal, audited quarantine, grouped item-adjacent follow-up attribution,
canonical-session Stop Robot cancellation for loaded/unloaded parents, scoped
nested custody and top-level/nested fixed-point discovery, idempotent operation
recovery, symlink-safe control records, preserved effects uncertainty, explicit scheduled-run
non-support, runtime-root isolation, scoped nested result paths, delivery
acknowledgements, stale-inventory rejection, and conservative
14-day compaction that protects resumable/unproven history. Analytics coverage
includes calendar-aligned partial day/week buckets, privacy-safe schema mapping,
URL filter normalization, stale-request fencing, responsive keyboard-inspectable
charts, and sortable client pagination without a model provider or live session.
The reviewed pi-subagents patch wraps its unit,
integration, and E2E scripts in a fresh HOME, temp runtime/results/session root,
and runtime-instance path, so package tests cannot touch deployment state. Forum
tests cover loaded-only startup reattachment, dispatch-generation
retry/cancellation fencing, bounded uncertain stop results, canonical unloaded-parent
stop, no-Continue gating, text-only interrupted-trace freezing, and dashboard
blocker/delivery/history grouping.

## Web search tests

The native-first web search helper has dependency-free Node coverage with fully
mocked HTTP and model-registry boundaries:

```bash
tests/web-search.sh
# equivalent focused invocation:
node --test tests/web-search.test.mjs
```

The suite covers provider/session ordering and legacy migration, native pool
origin and catalog validation, all three native wire protocols, resolved auth,
Exa/Brave/Tavily compatibility, sequential fallback, cancellation and deadlines,
cooldowns, response bounds, URL sanitization, redaction, and exhaustion. It never
uses provider credentials or live network services.

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
`monika-delegate` stable persona trio and first-person bounded-continuation framing,
absence of ambient WAKE/FACTS/observations, read-only recall exclusively for the
Monika delegate, the Terra/Sol profile policy, parent delegation guidance, explicit
extension allowlists, and child-local compaction without persistence.

Memstore's Go suite covers FTS search, save deduplication, and append-only observation
supersession/retraction:

```bash
nix-shell -p go gcc --run \
  'cd services/memstore && CGO_ENABLED=1 go test -tags fts5 ./...'
```

## SSH transport and relocation

Run:

```bash
node --test \
  tests/ssh-lock.test.mjs \
  tests/ssh-relocate.test.mjs \
  tests/ssh-search-transport.test.mjs
```

These suites use pure state-machine, fake-process, and local fixed-script boundaries;
they never contact a real SSH host. They cover locked-target integrity, stdin-framed
positional transport (including empty, trailing-newline, and large values), atomic
large-file writes, symlink rejection, hostile grep/find values, no-match and
invalid-input exit codes, mode-safe UI failures, semantic relocation errors,
unavailable-state reporting, and read/write transition fencing. Mandatory CI must not depend on Stanza; any Stanza
canary is manual, read-only, and must not touch the live checkout.

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
5. npm's 10-day dependency cooldown, pnpm 11.21.0 with fail-closed 10-day release-age enforcement, and the pinned agent-browser version are active;
6. the reviewed pi-subagents 0.37.2 gitHead (`8063333661476ca48afbca826dc4aab8707c72d3`) is installed, the dedicated runtime/session/operator roots are global, the operator root exists with mode `0700`, unsafe relative or shared top-level operator-root overrides fail startup, a container runtime identity exists, durable pre-spawn launch/drain and artifact-finalization patches are present, forked children use per-run directories, `defaultExtensions=[]` and isolated child profiles are configured, and legacy force-tools/delegate extensions are absent;
7. interactive project-trust state is linked into persistent `/data`;
8. agentd sends a complete Pi turn to a local OpenAI Responses fixture, which requires `pi_run`, `browser`, `web_search`, `subagent`, `subagent_wait`, and `subagent_supervisor` while rejecting the legacy `delegate` tool;
9. every strict function schema in the serialized request satisfies OpenAI's
   `additionalProperties: false` and required-property rules;
10. an interactive Pi ownership lease evicts an idle agentd runtime, blocks forum reopen and deployment, heartbeats, and releases cleanly;
11. agentd quiescence reports the reloaded idle conversation and deploy drain closes it;
12. a replacement container sharing only isolated `/data` restores that drain, rejects new work, and becomes healthy only after cancellation clears the durable state;
13. `scripts/deploy-if-safe --backup-only` can acquire/cancel mock forum deployment admission and create and verify an isolated runtime capsule backup;
14. the container stops cleanly on SIGTERM;
15. isolated second runtimes exit nonzero and reap their sibling when either agentd or memstore dies unexpectedly.

The model fixture runs in a second throwaway container on an isolated Docker
network. It exercises Pi's real extension loading, tool serialization, provider
request, streaming response parsing, and agentd turn lifecycle without contacting
an external provider. This catches invalid strict tool schemas during image CI;
real-provider canaries remain separate because they require secrets, network
availability, and quota. Provider-independent agentd lifecycle coverage also
lives in `services/agentd/test/`, including separate ordered outward messages, the distinction between Pi's
`agent_end` and idle-only `agent_settled`, v1/v2 origin provenance, durable grouped
retry contributors, mixed structured/legacy attachment dedupe, and no-follow
legacy artifact descriptor/TOCTOU checks. Retention fixtures match
real package status files by omitting redundant `asyncDir`; tests verify that the
scanner supplies the scoped containing path while conflicting explicit paths fail
closed.

### `smoke/deploy-if-safe-drain-lifecycle.sh`

Validates the deploy script's agentd drain lifecycle using stubbed `docker` and
`curl` commands. It does not contact the live runtime or Docker daemon.

```bash
tests/smoke/deploy-if-safe-drain-lifecycle.sh
```

The script verifies:

1. a forum-only image update does not drain agentd;
2. every applied update acquires forum admission, renews the same owned lease immediately before Compose, and fails
   closed before Compose when that lease is lost or expired;
3. Compose begins while the process-local forum marker exists; forum replacement clears it, replacement cancel is an
   idempotent no-op, and Monika-only/backup-only explicitly cancel the surviving lease;
4. a monika image update starts drain before backup;
5. the deploy script renews durable drain immediately before Compose runs;
6. a Monika replacement is applied only while both the forum-admission and durable-drain markers exist;
7. after Compose applies the update, agentd drain cancel and healthy/undrained proof precede bounded forum `/readyz`,
   bounded forum admission cancel, `compose ps`, and pruning in that order;
8. a readiness failure still attempts bounded best-effort forum cancellation through the exit trap;
9. an exact admission `404` uses bounded legacy quiescence twice for the pre-admission rollout, while never claiming a lease.

This protects both the old stuck-drain failure and the forum quiescence-to-restart
race, including release on success and failure.

### `smoke/stable-release-channel.sh`

Validates stable image selection with stubbed GitHub API, Docker, and runtime API
boundaries. It never contacts GitHub, a registry, Docker, or the live runtime.

```bash
tests/smoke/stable-release-channel.sh
```

Coverage generates its valid fixture through the same
`scripts/write-stable-manifest` producer used by the Stable workflow, checks that
output against an independently pinned v1 object, keeps unset
selection on the established `:main` defaults, leaves backup-only independent of
image-channel validation, proves paired explicit deploy overrides and rejects
one-sided/empty values, validates exact stable digest references, bounded API calls,
canonical/custom credential separation, and OCI revision labels, and fails malformed,
missing, unavailable, wrong-version,
wrong-tag/commit/repository/digest metadata before quiescence without Python
tracebacks. It also checks forward ancestry, downgrade/missing/unknown migration
fences and the one-shot acknowledgment, verifies an available stable update enters
the established admission/drain lifecycle, and keeps public-ingress reconciliation
before stable API resolution.

### `smoke/compose-agentd-port.sh`

Statically checks that Compose keeps agentd on internal port 7724 for service
health and forum traffic while `MONIKA_AGENTD_PORT` changes only the host-side
loopback publication.

```bash
tests/smoke/compose-agentd-port.sh
```

### `smoke/backup-doc-contract.sh`

Checks that the operator docs continue to distinguish local redeploy capsules,
transient Btrfs capture, portable restic restore and standalone WORM recovery, and
retain the canonical path/offline-custody safety statements. It is static and does
not contact B2 or the live runtime.

```bash
tests/smoke/backup-doc-contract.sh
```

### `smoke/forum-runtime.sh`

Validates that a forum runtime image starts, serves health and static frontend,
and contains only production dependencies.

```bash
docker build -f services/forum/Containerfile -t monika-forum-test ./services/forum
tests/smoke/forum-runtime.sh monika-forum-test
```

The script verifies:

1. the container starts with ephemeral state and a dummy agentd URL;
2. `/healthz` returns `{"ok":true}` because liveness is deliberately independent of backend readiness; shared route tests behaviorally cover the exact unprefixed `/readyz` handler used by Compose in both ready and unavailable states;
3. `GET /` serves the built frontend HTML;
4. representative dev-only packages (vitest, vite, typescript, eslint, prettier,
   vue-tsc, playwright, husky, lint-staged) are absent from `node_modules`;
5. runtime-critical packages (tsx, fastify, better-sqlite3, sharp) are present;
6. workspace packages (core, contracts, adapters) are present with source files;
7. build toolchain (python3, make, g++, pnpm) is absent from the runtime image;
8. native modules load successfully, including a real Sharp JPEG transform and metadata read. The Containerfile performs
   the same Sharp transform against the production deployment during every architecture-native image build, before
   publication.

## Test compose

`tests/compose.monika-runtime.yaml` is a test-only standalone compose file for
manual runtime startup with ephemeral Docker volumes. It is not a deployment
template. Use `compose.yaml.example` for real deployments.

```bash
docker compose -f tests/compose.monika-runtime.yaml up -d
docker exec -it monika-test pi
```
