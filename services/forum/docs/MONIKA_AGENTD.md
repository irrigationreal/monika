# Monika agentd forum backend

The forum talks to Monika through `agentd` in the `monika` container. Pi remains canonical; the forum database is a
projection/metadata store.

Current deployment assumptions:

```text
MONIKA_AGENTD_BASE_URL=http://monika:7724
CODEX_FORUM_DB=/forum/data.db
CODEX_FORUM_UPLOADS_DIR=/forum/uploads
CODEX_WORK_DIR=/workspace
```

Use the repository-level `compose.yaml.example` as the deployment template. Copy it to ignored `compose.yaml` and run
Docker Compose from the repo root:

```bash
cp compose.yaml.example compose.yaml
docker compose up -d --build
```

For architecture, endpoint, sync, taxonomy, attachment, handoff, and analytics details, see:

```text
docs/forum.md
```

## Internal analytics query

The forum server calls `POST /v1/admin/analytics/query` with an aggregate-only,
bounded request:

```json
{
  "from": "2026-07-01T00:00:00.000Z",
  "to": "2026-08-01T00:00:00.000Z",
  "bucket": "day",
  "pi_session_ids": ["allowlisted-canonical-session-id"],
  "min_tool_samples": 5
}
```

The range is `[from, to)`, cannot exceed 366 days, and supports UTC `day` or
Monday-based `week` buckets. At most 5,000 session IDs may be supplied. The forum
resolves those IDs from its authorized topic links; agentd does not infer forum
or tenant ownership. Agentd returns only sanitized aggregates and coverage
counts. It never returns message text, raw errors, tool arguments/results,
paths, or canonical IDs. The process-local aggregate cache defaults to a
30-second TTL (`MONIKA_AGENTD_ANALYTICS_CACHE_TTL_MS`).

The browser-facing route is `GET /api/admin/analytics`; it requires an admin
identity and combines the canonical runtime result with forum-native distinctive
vocabulary. Runtime failure is represented as `runtime.available=false` while
forum vocabulary remains available.

## SSE event types

The forum server's SSE stream (`/api/topics/:topicId/state/stream`) relays events
from the stream bus. Event payloads are filtered per subscriber: unauthenticated
public readers receive only redacted state and completion signals, while
authenticated users receive the detailed live trace events below.

Key event types for live trace rendering:

| Event | Payload | When it fires |
|---|---|---|
| `state` | Robot activity snapshot including `recentToolRuns`, `currentPlan`, and `activity` | Any robot state change |
| `context_updated` | Typed Pi session-context snapshot | A measured turn usage arrives, the selected model is applied, or compaction succeeds |
| `reasoning_delta` | `{ delta: string }` | Pi thinking/reasoning tokens arrive |
| `assistant_delta` | `{ delta: string }` | Pi visible text tokens arrive |
| `tool_started` | `{ toolRunId, tool, callId }` | Each tool run is created in the DB (before the corresponding `state` update) |
| `assistant_reset` | `{ reason: string }` | New user message dispatched, or robot interrupted |
| `assistant_message` | `{ text: string }` for authenticated users; `{}` for public readers | Response complete; final text committed as a post |

`tool_started` was added specifically for trace interleaving — it fires per-tool
in real time, while `state.recentToolRuns` arrives batched with all tools already
present. Client-side checkpoint recording must use `tool_started`, not
`recentToolRuns` diffing.

Session context has a separate lifecycle from high-frequency robot activity. The
initial authenticated `GET /api/topics/:topicId/state` response carries the best
available context snapshot, and `context_updated` refreshes it at semantic
boundaries. Clients retain the last known snapshot when ordinary `state` events
or transient agentd failures contain no context; they must not clear the meter.
Live runtime measurements are preferred when available even though Pi marks them
as estimates (`exact: false`), while durable historical usage remains the fallback.

## Errors and manual compaction

Agentd reports terminal Pi provider failures as `turn_error` only after
`agent_settled`; failed attempts that Pi successfully retries are not terminal forum
errors. The forum persists terminal failures as operational timeline events.

Manual compaction uses `POST /v1/conversations/:id/compact` with an operation ID and
expected Pi leaf ID. Agentd accepts it only while fully idle and calls Pi's public
`AgentSession.compact()` API. The forum's admin-only workflow then creates and
dispatches a user-attributed recovery-checkpoint post. See `docs/forum.md` for full
persistence, visibility, and failure semantics.
