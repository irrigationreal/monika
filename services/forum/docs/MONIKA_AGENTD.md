# Monika agentd integration

This former all-in-one guide has been split so each behavior has one canonical
home:

- [`../../../docs/forum.md`](../../../docs/forum.md) owns the cross-service
  forum↔agentd↔canonical-session contract, including projection, provenance,
  analytics boundaries, ownership, compaction coordination, and attachments.
- [`../../agentd/README.md`](../../agentd/README.md) owns generic agentd runtime,
  API, lifecycle, ownership, and development documentation.
- [`../../../docs/subagents.md`](../../../docs/subagents.md) owns delegated
  execution, identity boundaries, durable lifecycle, cancellation, and recovery.
- [`LIVE_TRACE.md`](LIVE_TRACE.md) owns forum SSE, trace rendering, checkpoints,
  visibility, and debugging.
- [`DEPLOYMENT.md`](DEPLOYMENT.md) owns forum-specific authentication and
  deployment details; the complete runtime starts from
  [`../../../docs/deployment.md`](../../../docs/deployment.md).

The Monika deployment uses:

```text
CODEX_FORUM_AGENT_BACKEND=monika-pi
MONIKA_AGENTD_BASE_URL=http://monika:7724
CODEX_FORUM_DB=/forum/data.db
CODEX_FORUM_UPLOADS_DIR=/forum/uploads
CODEX_WORK_DIR=/workspace
```

Pi JSONL remains canonical. Forum SQLite is projection and forum-native metadata, never an alternate agent or memory
store. Agentd's optional `dispatch_acceptance: "not_accepted"` error marker is the only proof that a dispatch failed
before acceptance. A separate `dispatch_retry: "safe"` marker identifies draining as safe for exact-identity automatic
retry; other marked setup/dependency failures are terminal/manual. Markerless 5xx/network failures retain ambiguous
exact-identity retry indefinitely. HTTP status alone never authorizes canonical-link or creation-ledger cleanup.
