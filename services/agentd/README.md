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
│   ├── compaction-operation.mjs   Idempotent canonical compaction recognition
│   ├── message-provenance.mjs     Subagent continuation provenance and settlement
│   └── subagent-cancellation.mjs  Scoped descendant cancellation support
└── test/                          Provider-independent lifecycle tests
```

`Containerfile` installs the service into `/opt/agentd`. `entrypoint.sh` starts
memstore first and then agentd unless `MONIKA_AGENTD_ENABLED=0`.

## API families

The exact route definitions in `src/server.mjs` are authoritative. The service
exposes these conceptual groups:

- **health and models** — runtime health and available authenticated models;
- **Pi sessions** — list, export, context, ownership, and durable cancellation;
- **conversations** — create/open, history/context, SSE events, prompt, interrupt,
  compact, handoff, and close;
- **artifacts** — legacy descriptor-safe export from canonical allowlisted roots;
- **administration** — quiescence, drain, subagent workload/repair/retention, and
  privacy-safe aggregate analytics.

Conversation records expose canonical `session_id` and `session_path`. Model and
thinking settings use Pi model identifiers directly.

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
Renewable ownership leases let the TUI evict an idle loaded agentd runtime, reject
unsafe takeover of active work, heartbeat its claim, and release it on exit.
Deployment quiescence treats a live interactive lease as a blocker.

A cached agentd conversation is not itself canonical authority. Runtime state must
be reconciled with the JSONL tree when a session may have advanced elsewhere.

## Forum-native forks

Agentd exposes an idle-only, optimistic before-user fork operation for the forum.
It validates the current session format, active-branch user boundary, completed
assistant response, and expected dynamic leaf. A detached `SessionManager` extracts
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

## Compaction

Agentd exposes idle-only Pi compaction with an operation ID and expected canonical
leaf. A response lost after Pi appends the compaction is recognized from canonical
ancestry so a retry does not compact twice.

Manual forum compaction is a durable forum job around this synchronous agentd
operation. Canonical parent automatic compaction is an isolated topic policy applied
through agentd and never inherited by disposable children.

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
remain pending for operator review. See
[`../../docs/subagents.md`](../../docs/subagents.md).

## Deployment safety

Quiescence reports active turns, loaded conversations, interactive ownership,
memstore save state, subagent execution, uncertain remote effects, and whether a
drain is required. Drain rejects new work and closes idle conversations so their
shutdown memory saves complete before container replacement.

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
