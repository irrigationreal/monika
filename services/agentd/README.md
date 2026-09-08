# agentd

`agentd` is Monika's Pi-backed HTTP/SSE runtime daemon. It embeds Pi through the
SDK so alternate frontends can open and continue canonical Pi sessions without
embedding the agent runtime themselves.

Agentd owns loaded Pi runtimes, provider/model selection, event streaming,
interactive ownership leases, cancellation, compaction, subagent lifecycle
reconciliation, aggregate runtime analytics, and deployment quiescence. It does
not replace Pi JSONL as conversation authority and it does not make the forum a
memory or execution service.

## Boundaries

```text
Forum / administrative client
              │
              ▼
           agentd
              │
              ▼
       Pi SDK + extensions ──▶ tools / stateful-memory / memstore
              │
              ▼
     canonical Pi JSONL sessions
```

- Pi JSONL is canonical conversation state.
- Forum SQLite is a projection and UI metadata store.
- Memstore indexes normalized transcripts and observations; it is not the live
  conversation store.
- Agentd is loopback/Docker-network infrastructure, not a public Internet API.
- Host access remains explicit through reviewed SSH tooling.

See [`../../docs/architecture.md`](../../docs/architecture.md) for the complete
system model and [`../../docs/forum.md`](../../docs/forum.md) for forum projection.

## Source layout

```text
services/agentd/
├── package.json
├── pnpm-lock.yaml
├── src/
│   ├── server.mjs                 HTTP/SSE service and Pi runtime ownership
│   ├── drain-state.mjs            Durable deploy-drain lease state
│   ├── dispatch-acceptance.mjs    Pre-acceptance failure marker vocabulary
│   ├── session-resolution.mjs     Direct canonical-path validation
│   ├── http-safety.mjs            Disconnect-safe HTTP/SSE writes
│   ├── compaction-operation.mjs   Idempotent canonical compaction recognition
│   ├── forum-fork-operation.mjs   Durable before-user branch extraction
│   ├── forum-clone-operation.mjs  Durable exact-current-leaf branch extraction
│   ├── message-provenance.mjs     Subagent continuation provenance and settlement
│   └── subagent-cancellation.mjs  Scoped descendant cancellation support
└── test/                          Provider-independent lifecycle tests
```

`Containerfile` installs the service into `/opt/agentd`. `entrypoint.sh` starts
memstore first and then agentd unless `MONIKA_AGENTD_ENABLED=0`. In daemon mode
PID 1 supervises both essential children: it forwards shutdown to agentd before
memstore, reaps both, and exits nonzero if either dies unexpectedly so Docker can
restart the complete runtime. Agentd stops accepting HTTP and closes SSE before
canonical cleanup, then allows Pi close/memory save up to
`MONIKA_AGENTD_SHUTDOWN_DEADLINE_MS` (30 seconds by default). At that deadline it
forcibly closes remaining HTTP connections and exits nonzero rather than hanging
behind a session-operation fence. The Monika health check requires the memstore
socket and healthy, undrained agentd.

## API families

The exact route definitions in `src/server.mjs` are authoritative. The service
exposes these conceptual groups:

- **health and models** — runtime health and available authenticated models;
- **Pi sessions** — list, export, context, ownership, and durable cancellation;
- **conversations** — create/open, history/context, SSE events, prompt, interrupt,
  compact, fork, exact-current-leaf clone, handoff, and close;
- **artifacts** — legacy descriptor-safe export from canonical allowlisted roots;
- **administration** — quiescence, drain, subagent workload/repair/retention, and
  privacy-safe aggregate analytics.

`GET /healthz` is a lightweight liveness/readiness dependency: request handling
uses cached in-memory state and never scans lifecycle or Pi session archives,
reads build files, prunes ownership records, or waits for canonical-session work. Build
metadata is loaded once before the HTTP listener starts. Existing lifecycle count
fields remain present but are informational snapshots from the last successful
lifecycle scan. Their `subagent_lifecycle_freshness` object reports
`last_successful_scan` with `scanned_at_ms`/`age_ms`, or `not_yet_scanned` with
null timestamps and conservative counts before the first successful scan.
`interactive_pi_sessions` is also explicitly approximate: it is the cached
size of durable claimed and pending ownership records and can temporarily include
expired records. Use `GET /v1/admin/quiescence`, not health, for authoritative
quiescence; that endpoint freshly prunes and reports both kinds of interactive blocker.
Active-subagent and effects-unknown blockers preserve aggregate `code`/`count` and
include at most 20 deterministically ordered opaque items containing only
`run_key`, `run_id`, `execution_state`, and `effects_state`. `item_limit`,
`truncated`, and `omitted_count` describe capping; paths, tasks, and output are
never included.

Conversation records expose canonical `session_id` and `session_path`. When both
are supplied on reopen, agentd opens and validates exactly that canonical path:
it must remain under the session root, be a non-symlink regular file, match the
header ID, and remain outside unresolved fork/clone quarantine. Loaded branch checks use
the same target-only path. Archive-wide discovery remains only for explicit session
listing and ID-only legacy callers. Model and thinking settings use Pi model
identifiers directly.

## Event lifecycle and provenance

Agentd maps Pi SDK events into frontend-consumable turn, reasoning, text, tool,
usage, interruption, error, and settlement events. A canonical outward utterance
is a persisted Pi assistant item, independent of channel. Agentd emits every such
item separately and in order. Pi's internal `agent_settled` marks the runtime's
idle boundary; agentd exposes that boundary as wire `turn_completed`, which may
follow zero, one, or several outward items. It never aggregates a response or
publishes an unpersisted raw completion buffer.

`monika.message.provenance` v1 carries legacy forum topic/post identity. V2 carries
the ordered contributor utterance IDs and normalized execution origins used by
forum and external adapters. Queue/steer mechanics remain prompt facts, not
utterance identity. Agentd owns canonical claim and settlement; an adapter's
remote send/ack remains best effort.

The forum bridge adds forum-native events and persists projection checkpoints.
Those are forum behavior, not agentd's canonical conversation record. See
[`../../docs/forum.md`](../../docs/forum.md).

## Conversation ownership

Interactive Pi and agentd must not write the same JSONL session concurrently.
An absent fresh-session JSONL is an unmaterialized launcher and creates no startup
request or ownership record. Its first `input` must reserve the validated intended
canonical ID/path durably before agent processing or launcher bash execution.
Reservation failure is fail-closed. When Pi first persists the JSONL,
`POST .../ownership/promote` validates the exact path/header/inode under the
session operation fence before turning the pending record into a claimed renewable
lease. Unused launchers leave no record; used launchers remain fenced across agentd
restart and recover by promoting their retained capability before ordinary claim.

Existing sessions use `POST .../ownership/claim` with `client_id` and canonical
`session_path`; agentd resolves that path once inside the mutation critical
section. Claims let the TUI evict an idle loaded runtime and reject unsafe active
takeover. `heartbeat` and `release` use the random `lease_token` plus route session
ID as O(1) token-index lookups without session discovery or archive scans. Tokens
are never logged. Deployment quiescence treats both claimed leases and pending
reservations as blockers, while the lightweight health count remains approximate.

A cached agentd conversation is not itself canonical authority. Runtime state must
be reconciled with the JSONL tree when a session may have advanced elsewhere.

Forum callers that request `durable_session: true` must also send a stable, URL-safe
`creation_id`; ordinary forum post-dispatch creation uses its durable dispatch ID. Agentd writes a creation
record with the intended Pi session ID/path under
`/data/agentd-operations/forum-creations` before anchoring JSONL. After lineage is durable it appends a completed-creation marker; a retry reopens only that
same fully operation-marked session. If a `creating` record has missing or ambiguous canonical
evidence, creation fails closed for manual recovery rather than allocating another
session. `creation_id` reuse with different creation parameters is rejected.

## Forum-native forks

Agentd exposes an idle-only, optimistic before-user fork operation for the forum.
`GET /v1/conversations/:id/fork-boundaries` returns the canonical active branch,
eligible user-entry IDs, and leaf from one detached session snapshot. The mutation
path uses the same boundary classifier and rejects a changed leaf before creating a
child. Because before-user extraction discards the selected user entry and everything
after it, that discarded turn may be tool-using, failed, interrupted, or unanswered;
its completion state is not a fork-safety condition. The first canonical user remains
excluded by the V1 inherited-history contract. A detached `SessionManager` extracts
the child branch without replacing the loaded parent or changing parent bytes. A
filesystem operation ledger makes retries idempotent and quarantines the child from
generic session listing until the forum acknowledges durable projection
materialization. Crash recovery adopts only a child carrying the exact durable operation
marker; an unmarked or ambiguous child outcome becomes a manual-recovery source fence
rather than a heuristic adoption. The ledger retains the candidate session directory,
exact parent path, operation timestamp, and branch boundary. Generic discovery quarantines
all sessions plausibly created in that scope—including unmarked candidates after the state
has become `manual_recovery`—without opening, adopting, or modifying them. While
acknowledgement or manual recovery is unresolved, conversation writes, canonical
cancellation reconciliation, and interactive ownership claims against the parent are fenced.
Every parent writer takes the same per-session operation lock and checks the durable fork
fence inside that lock immediately before mutation; the fork operation takes the lock
directly so it does not recursively deadlock on its own newly published fence. Model and
thinking selection are intentionally not part of branch extraction: the forum persists
them with the fork operation and opening dispatch, then agentd applies them through Pi's
session configuration before accepting the child conversation's opening prompt.

## Forum-native exact duplicates

Agentd exposes `GET /v1/conversations/:id/clone-snapshot`,
`POST /v1/conversations/:id/clone`, and `POST /v1/forum-clones/:operationId/ack` as a
separate durable operation. Clone takes the current active Pi leaf and uses a detached
`SessionManager.createBranchedSession(currentLeaf)`, the same native branch extraction as
`runtime.fork(leaf, { position: 'at' })`, without replacing the parent runtime. It preserves
compaction and other entries on that exact branch and does not enqueue a prompt or start a
model turn. Expected-leaf validation rejects stale snapshots, and parent JSONL bytes are
verified unchanged before success is recorded.

The clone ledger has its own operation namespace and request hash. Exact retries return the
same child; a creating-state retry adopts only a child carrying the matching operation marker.
Missing or multiple marked evidence becomes `clone_manual_recovery`, not another allocation.
Unacknowledged and ambiguous candidates are quarantined from list/find discovery. Fork and
clone ledgers are checked together under the per-session operation coordinator, so either
operation fences dispatch, compaction, cancellation, ownership changes, and the other branch
operation until acknowledgement. Forum-created clone sessions carry explicit `clone` lineage.

## Compaction

Agentd exposes idle-only manual Pi compaction with an operation ID and expected canonical
leaf. A response lost after Pi appends the compaction is recognized from canonical
ancestry so a retry does not compact twice.

Manual forum compaction is a durable forum job around this synchronous agentd
operation. Canonical parent automatic compaction is an isolated topic policy applied
through agentd and never inherited by disposable children. When enabled, threshold
compaction may occur between tool execution and the next assistant request in the
same run. Agentd forwards compaction status without completing that run; only
`agent_settled` permits final response projection.

## Subagents

Agentd projects the reviewed `pi-subagents` lifecycle into parent sessions,
quiescence, cancellation, and administrative workload APIs. Versioned artifacts
separate execution, outcome, effects, and delivery dimensions; no single legacy
status number owns workflow meaning. It reconciles process state independently
from result delivery and never treats pending projection as a live process.

Delivery disposition is explicit: `awaited`, `follow_up`, or `silent`. A durable
claim proves exact result custody but not visible delivery; settlement requires
identity-bound canonical provenance and the disposition's visibility rule. Scoped
nested run keys and per-run custody paths prevent one descendant from settling or
deleting another descendant's result.

Recovered historical results do not open a parent session or wake a model. Proven
pending `follow_up` work can continue on the next explicit open; unproven results
remain pending for operator review. The administrative workload and retention GETs
are presentation projections: they coalesce concurrent scans and serve immutable
JSON DTOs. Workload has a two-second freshness TTL and may serve stale data for at
most ten seconds; retention preview has a thirty-second freshness TTL and may serve
stale data for at most two minutes. Quiescence/deployment, cancellation, close,
retention apply, operator resolution, idle reaping, and cleanup always perform
fresh lifecycle scans and never consume those caches. See
[`../../docs/subagents.md`](../../docs/subagents.md).

## Deployment safety

Client disconnects are request-transport events, not canonical turn cancellation.
Finite bodies are consumed before session-operation waits, disconnected responses
and SSE subscribers are discarded safely, and an already accepted prompt continues
to canonical settlement for idempotent retry.

Error JSON may include the backward-compatible marker
`dispatch_acceptance: "not_accepted"` only when agentd can prove the request failed
before prompt dispatch acceptance. Conversation create/open initialization and
synchronous `POST .../messages` failures before Pi's `preflightResult(true)` are
marked, and HTTP 200 waits until that callback has durably recorded acceptance.
Draining responses additionally carry `dispatch_retry: "safe"`, explicitly allowing
the same durable identity to retry. Other marked failures require manual retry.
After acceptance, execution remains asynchronous and failures/transport loss remain
markerless and ambiguous; clients must not infer acceptance certainty from status alone.

Quiescence reports active turns, loaded conversations, interactive ownership,
memstore save state, subagent execution, uncertain remote effects, and whether a
drain is required. Drain rejects new work and closes idle conversations so their
shutdown memory saves complete before container replacement. Deploy drain writes
its reason and lease expiry to `/data/agentd-drain-state.json` before success; an
unexpired lease is restored after replacement until cancel clears it. The path is
configurable with the absolute `MONIKA_AGENTD_DRAIN_STATE_FILE` value. Expiry keeps
the original 15-minute default across restart, while SIGTERM-only shutdown state
is not persisted as a deploy drain.

The complete safety and repair contract lives in
[`../../docs/redeployment.md`](../../docs/redeployment.md). Host automation lives in
[`../../docs/autodeploy.md`](../../docs/autodeploy.md).

## Analytics

The administrative analytics endpoint accepts bounded time ranges and an
allowlisted set of canonical session IDs supplied by the caller. It returns
sanitized aggregates and coverage information only—never message text, raw tool
arguments/results, paths, errors, or canonical identifiers.

The forum authorizes the browser request and resolves its visible linked sessions
before calling agentd. Agentd does not infer forum tenancy.

## Legacy artifact export

`POST /v1/artifacts/resolve` exists only for compatibility with standalone
`[artifact ...]` references. Structured pending-attachment refs are primary. The
compatibility reader opens with `O_NOFOLLOW`, validates the opened descriptor is a
regular file whose current inode and canonical path remain inside an allowed root,
and reads bytes from that descriptor. Symlinks, containment escapes, and path
replacement during validation fail closed.

## Development

Install and run the provider-independent suite:

```bash
corepack pnpm@11.21.0 install --frozen-lockfile
pnpm test
```

The tests create explicit temporary runtime, lifecycle, result, session, and
runtime-instance roots. They must never inherit live `/data/pi-subagents` state.
See [`../../tests/README.md`](../../tests/README.md) for suite coverage and container
smoke validation.
