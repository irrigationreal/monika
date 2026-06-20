# Monika agentd forum backend

The forum talks to Monika through `agentd` in the `monika` container. Pi remains
canonical; the forum database is a projection/metadata store.

Current deployment assumptions:

```text
MONIKA_AGENTD_BASE_URL=http://monika:7724
CODEX_FORUM_DB=/forum/data.db
CODEX_FORUM_UPLOADS_DIR=/forum/uploads
CODEX_WORK_DIR=/workspace/monika
```

Use the repository-level `compose.yaml.example` as the deployment template. Copy it
to ignored `compose.yaml` and run Docker Compose from the repo root:

```bash
cp compose.yaml.example compose.yaml
docker compose up -d --build
```

For architecture, endpoint, sync, taxonomy, attachment, and handoff details, see:

```text
docs/forum.md
```

## SSE event types

The forum server's SSE stream (`/api/topics/:topicId/state/stream`) relays events
from the stream bus. Event payloads are filtered per subscriber: unauthenticated
public readers receive only redacted state and completion signals, while
authenticated users receive the detailed live trace events below.

Key event types for live trace rendering:

| Event | Payload | When it fires |
|---|---|---|
| `state` | Full `RobotStateDto` including `recentToolRuns`, `currentPlan`, `activity` | Any robot state change |
| `reasoning_delta` | `{ delta: string }` | Pi thinking/reasoning tokens arrive |
| `assistant_delta` | `{ delta: string }` | Pi visible text tokens arrive |
| `tool_started` | `{ toolRunId, tool, callId }` | Each tool run is created in the DB (before the corresponding `state` update) |
| `assistant_reset` | `{ reason: string }` | New user message dispatched, or robot interrupted |
| `assistant_message` | `{ text: string }` for authenticated users; `{}` for public readers | Response complete; final text committed as a post |

`tool_started` was added specifically for trace interleaving — it fires per-tool
in real time, while `state.recentToolRuns` arrives batched with all tools already
present. Client-side checkpoint recording must use `tool_started`, not
`recentToolRuns` diffing.
