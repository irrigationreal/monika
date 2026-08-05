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
- **administration** — quiescence, drain, subagent workload/repair/retention, and
  privacy-safe aggregate analytics.

Conversation records expose canonical `session_id` and `session_path`. Model and
thinking settings use Pi model identifiers directly.

## Event lifecycle

Agentd maps Pi SDK events into frontend-consumable turn, reasoning, text, tool,
usage, completion, interruption, and error events. Authoritative completion follows
Pi settlement and persisted canonical messages rather than assuming an earlier
text or tool event ended the turn.

The forum bridge adds some forum-native events and persists projection checkpoints.
Those are forum behavior, not agentd's canonical conversation record. See
[`../../docs/forum.md`](../../docs/forum.md).

## Conversation ownership

Interactive Pi and agentd must not write the same JSONL session concurrently.
Renewable ownership leases let the TUI evict an idle loaded agentd runtime, reject
unsafe takeover of active work, heartbeat its claim, and release it on exit.
Deployment quiescence treats a live interactive lease as a blocker.

A cached agentd conversation is not itself canonical authority. Runtime state must
be reconciled with the JSONL tree when a session may have advanced elsewhere.

## Compaction

Agentd exposes idle-only Pi compaction with an operation ID and expected canonical
leaf. A response lost after Pi appends the compaction is recognized from canonical
ancestry so a retry does not compact twice.

Manual forum compaction is a durable forum job around this synchronous agentd
operation. Canonical parent automatic compaction is an isolated topic policy applied
through agentd and never inherited by disposable children.

## Subagents

Agentd projects the reviewed `pi-subagents` lifecycle into parent sessions,
quiescence, cancellation, and administrative workload APIs. It reconciles durable
execution state independently from result delivery and never treats pending result
projection as a live process.

Recovered historical results do not open a parent session or wake a model. Canonical
completion provenance can settle a result on the next explicit open; unproven
results remain pending for operator review. See
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

## Development

Install and run the provider-independent suite:

```bash
corepack pnpm@10.26.2 install --frozen-lockfile
pnpm test
```

The tests create explicit temporary runtime, lifecycle, result, session, and
runtime-instance roots. They must never inherit live `/data/pi-subagents` state.
See [`../../tests/README.md`](../../tests/README.md) for suite coverage and container
smoke validation.
