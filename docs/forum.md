# Monika forum frontend

Monika includes a forum frontend for Monika/Pi sessions while keeping all agent
execution inside the Monika runtime container.

## Architecture

The forum must **not** embed Pi or talk to memstore directly. The separation is:

- `monika` container: Pi SDK/runtime, bundled extensions, stateful-memory,
  memstore, and `agentd`.
- `monika-forum` container: forum UI/API and forum metadata database only.
- `agentd`: a small HTTP/SSE service inside the Monika container exposing the API
  consumed by the forum bridge.

Pi JSONL sessions remain canonical for agent conversation state. Forum SQLite is
a projection/metadata layer: topics/posts, identities, uploads, mapping tables,
reactions, sync state, and UI metadata.

Host mode has been removed. Pi tools operate inside the container by default; host
or infrastructure access should be explicit through SSH/`relocate`.

## Provenance

The forum service lives at `services/forum`. It was imported from the archived
Monika-specific forum repository after PR https://github.com/irrigationreal/monika-forum/pull/1,
merge commit `bba058013b1a59d295373f949f4d4f25100e174b`.

That repository repurposed the Irrigate Collective Codex Forum project as the
Monika frontend. Upstream project: https://github.com/irrigationreal/codex-forum

Future development should happen in this repository. The old `monika-forum`
repository is retained as historical provenance.

## Forum CI and image publishing

Forum changes are checked by `CI / Forum Container`, which follows the Vesper
branch-gate pattern: `forum-container-changes` decides whether the build is
relevant, `forum-container-build` runs the forum unit/E2E tests and container
build, and `forum-container-checks` is the stable required branch-protection
check.

Forum/agentd compatibility belongs in `CI / Integration`. That workflow is
currently a passing placeholder so branch protection can require
`integration-checks`; grow it with compose-based health checks and forum↔agentd
request smoke tests when those tests are ready.

The forum image is published from this repository by `Image / Forum` as
`ghcr.io/irrigationreal/monika-forum:main` and `sha-*`. Nightly and stable release
workflows publish or promote `:nightly`, date-style release tags, and `:latest`.

## agentd

Source:

```text
services/agentd/
  package.json
  src/server.mjs
```

Container wiring:

- `Containerfile` installs agentd into `/opt/agentd`.
- `entrypoint.sh` starts memstore first, then starts agentd unless
  `MONIKA_AGENTD_ENABLED=0`.
- Deployment compose binds agentd to `0.0.0.0:7724` inside the Monika container and exposes it to the host on loopback only for deploy automation.
- The Pi agent dir is `/app/.pi/agent` via `PI_CODING_AGENT_DIR`.

Implemented endpoints:

- `GET /healthz`
- `GET /v1/models`
- `GET /v1/pi/sessions`
- `GET /v1/pi/sessions/:id/export`
- `GET /v1/pi/sessions/:id/context`
- `POST /v1/conversations`
- `POST /v1/conversations/open`
- `GET /v1/conversations/:id`
- `GET /v1/conversations/:id/history`
- `GET /v1/conversations/:id/context`
- `GET /v1/conversations/:id/events`
- `POST /v1/conversations/:id/messages`
- `POST /v1/conversations/:id/interrupt`
- `POST /v1/conversations/:id/close`
- `POST /v1/conversations/:id/handoff/draft`
- `POST /v1/conversations/:id/memory/save` currently returns 501 until Pi exposes
  a safe public checkpoint hook.
- `POST /v1/conversations/:id/pause` and `/resume` as no-op compatibility.

Conversation records include `session_id` and `session_path`. Forum-supplied
model/reasoning options are mapped to Pi `setModel()` / `setThinkingLevel()` using
Pi model IDs directly, for example `codex/gpt-5.5`. The event stream maps Pi SDK
events into forum-consumed turn, reasoning, tool, usage, completion, interrupt,
and error events. The echsBridge adds a `tool_started` event (not from agentd) to
the SSE bus when each tool run is created, enabling per-tool checkpoint recording
for trace interleaving. See "Live trace and saved trace architecture" below.

## Forum integration state

The live standalone forum DB is `runtime/forum/data.db`; uploads are under
`runtime/forum/uploads/`. Inside the containers these appear as `/forum/data.db`
and `/forum/uploads/`.

Implemented in `services/forum`:

- `pi_import_runs`, `pi_session_links`, and `pi_message_links` tables.
- Forum replies in linked/imported topics call `POST /v1/conversations/open` and
  continue the canonical Pi session instead of creating a parallel session.
- Forum-created Pi conversations immediately write a `pi_session_links` row using
  the `session_id` and `session_path` returned by agentd.
- Background sync worker is enabled by default:
  - `MONIKA_PI_SYNC_ENABLED=1`
  - `MONIKA_PI_SYNC_INTERVAL_MS=5000`
- Sync polls agentd list/export endpoints, imports new/changed sessions
  idempotently, and links forum-origin `[FORUM TURN]` Pi user messages back to
  the originating forum post rather than duplicating them.
- Live forum topics are single-writer for public posts while the bridge is active.
  If sync sees an unmatched visible Pi message in such a topic, it records a
  bounded `pi_sync_anomalies` row instead of importing immediately or retrying
  forever in the hot path. Deferred anomalies retry briefly, then move to
  `needs_manual_review` for explicit admin repair.
- Admin → Sync Health exposes current anomaly counts, a manual sync trigger,
  targeted per-session sync, silent historical backfill, optional backfill+bump,
  and ignore actions. Ignored/resolved anomalies remain as audit history.
- Bootstrap identities are `neon`, `Pi CLI`, `robot`, and `Director`.
- Forum-native handoff is implemented with disposable draft generation and final
  confirmation that creates the destination topic, parented Pi session, lineage
  metadata, edited draft post, and first robot turn.
- `pi_session_links` stores `parent_pi_session_id`, `parent_pi_session_path`,
  `lineage_kind`, and `lineage_source`.

## Pi session taxonomy configuration

The historical importer and background Pi sync use the same configurable taxonomy
classifier. The classifier decides where imported Pi sessions are filed in the
forum and what cwd should be assigned when it creates a new imported forum.

Configuration is optional. If `MONIKA_PI_SESSION_TAXONOMY_CONFIG` is unset, the
forum uses a generic standalone default: `General`, `System / ...`, and
`Monika Runtime` for `/workspace/monika` or matching home-keyword sessions.

To customize routing, copy the example to an ignored runtime path:

```bash
cp docs/examples/forum-taxonomy.example.json runtime/forum/taxonomy.local.json
```

Then set this in `runtime/secrets/forum.env` or compose environment:

```bash
MONIKA_PI_SESSION_TAXONOMY_CONFIG=/forum/taxonomy.local.json
```

Cwd values must be paths visible inside the Monika/agentd container, not merely
host paths. With the default deployment this means `/workspace/...`, `/app/.pi/...`,
`/forum/...`, `/tmp`, or `/data` depending on the use case.

If `MONIKA_PI_SESSION_TAXONOMY_CONFIG` is set and the file is missing or invalid,
forum startup/sync should fail loudly rather than silently falling back to unsafe
defaults.

## Deployment

The forum is part of the main standalone deployment template:

```bash
cp compose.yaml.example compose.yaml
docker compose up -d --build
```

For safe unattended or operator-driven redeploys, use the root deployment runbook in [`docs/autodeploy.md`](autodeploy.md). That document owns the live checkout/worktree rules, image-only autodeploy policy, backup behavior, and host timer model.

Default paths and URLs:

- Forum URL: `http://localhost:4310` unless `CODEX_FORUM_BASE_URL` is overridden.
- Forum DB/uploads: `runtime/forum/data.db` and `runtime/forum/uploads/`.
- agentd binding in the Monika container: `0.0.0.0:7724`.
- agentd host binding for deploy automation: `127.0.0.1:${MONIKA_AGENTD_PORT:-7724}:7724`.
- Forum-to-agentd URL inside Docker: `http://monika:7724`.
- Default work directory: `/workspace/monika`.
- Runtime secrets: `runtime/secrets/forum.env` and `runtime/secrets/secrets.env`.

Health checks:

```bash
docker compose exec monika curl -fsS http://forum:4310/healthz
docker compose exec monika curl -fsS http://forum:4310/api/healthz
docker compose exec monika curl -fsS http://forum:4310/api/models
```

Do **not** restart the live `monika` container from inside an active Pi session;
restarting the container terminates the session.

## Current caveats

- The forum container currently runs as root to avoid bind-mount permission issues
  with host-owned runtime directories. This should be revisited if the deployment
  is exposed beyond the trusted host/tailnet boundary.
- The forum Containerfile currently installs dev dependencies in the runtime image
  because the server starts with `tsx src/server.ts` and workspace package exports
  point at `src/index.ts`.
- Explicit checkpoint memory save without closing is not implemented. Use close
  for a safe stateful-memory save path, because close emits Pi `session_shutdown`.
- Forum model selection/thinking level is mapped onto Pi `setModel()` /
  `setThinkingLevel()` using Pi model IDs directly.
- A context meter is available in the reply UI using the best Pi-provided usage
  data; it warns when the value is not exact current context.

## Do not lose these design decisions

- Pi JSONL sessions remain canonical for agent conversation state.
- Forum SQLite is a projection/metadata layer.
- One forum topic should map to one Pi session.
- Historical import and ongoing sync should include all sessions, but curated cwd
  mappings and system forums should prevent the main project forums from becoming
  noisy.
- Fork/delegate/sleep sessions are imported and routed to system areas. New
  delegate/sleep/handoff extension paths append `monika.lineage` custom JSONL
  entries for future imports/sync.
- Forum never talks directly to memstore and never invents memory origins. Memory
  dedupe must use canonical Pi session path/id.

## Forum attachments and artifacts

Attachment support is implemented as a hybrid reference model rather than treating
Pi JSONL as a blob store:

- Forum uploads remain in forum-owned upload storage.
- Forum attachment rows store optional `sha256` for verification.
- When dispatching a post to agentd, the forum sends internal attachment
  descriptors alongside the normal text envelope. Raw paths are not exposed to
  browser clients.
- agentd only reads attachment files from allowlisted upload roots
  (`MONIKA_AGENTD_ATTACHMENT_ALLOWED_ROOTS`, default `/forum/uploads`).
- agentd appends `customType: "monika.forum.attachment"` entries to the canonical
  Pi JSONL session recording attachment metadata, hash, storage reference, and
  presentation mode.
- Small supported images are passed to Pi as image input when the active model
  supports images and the file is below `MONIKA_AGENTD_ATTACHMENT_IMAGE_INLINE_MAX_BYTES`.
- Small UTF-8 text-like files below `MONIKA_AGENTD_ATTACHMENT_TEXT_EXTRACT_MAX_BYTES`
  are inserted into the prompt as bounded phpBB-style attachment blocks.
- Larger or binary attachments are represented as metadata-only attachment blocks.

Outbound agent artifacts currently support a bridge/fallback marker:

```text
[artifact path="/workspace/monika/out.zip" filename="out.zip" mime="application/zip"]
```

The forum strips artifact markers from persisted robot post bodies, resolves the
file through agentd when the forum container cannot see the path directly, copies
it into normal forum upload storage, and creates a regular forum attachment row.
agentd exposes `POST /v1/artifacts/resolve` for this, constrained by
`MONIKA_AGENTD_ARTIFACT_ALLOWED_ROOTS` and `MONIKA_AGENTD_ARTIFACT_EXPORT_MAX_BYTES`.
Pi session sync strips artifact markers from assistant text before reconciliation/import.

Preferred outbound upload flow:

- Pi extension `forum-attachments.ts` registers `forum_upload_attachment(path, filename?, mimeType?)`.
- The tool reads `.codex-forum/requester.json` for the current topic id, uploads
  the local file to the forum internal pending attachment endpoint, and returns
  the exact standalone `[forum-attachment id="..."]` reference to include in the
  final response.
- Forum route `POST /api/agent/topics/:topicId/pending-attachments` stores the
  file in forum upload storage as a pending attachment with SHA-256 and TTL.
- Robot post persistence consumes standalone `[forum-attachment id="..."]` lines
  outside fenced code blocks, links matching pending attachments to the post as
  normal attachments, and strips the reference line from the rendered body.
- Legacy `[artifact ...]` markers are also consumed only as standalone lines
  outside fenced code blocks.

## Live trace and saved trace architecture

The forum renders two views of agent activity during and after a response:

- **Live trace**: real-time chronological timeline shown while the robot is
  responding, rendered by `LiveAssistantTurn.vue` in `TopicView.vue`.
- **Saved trace** ("Trace History"): collapsible post-completion view rendered by
  `PostTracePanel.vue`, using data from the session inspector API.

Both aim to show reasoning, assistant text, and tool calls in chronological order,
interleaved as they actually occurred during the agent loop.

### Pi agent loop event flow

A single forum reply triggers a Pi agent loop that may span multiple LLM turns:

```
Turn 1: thinking → text → tool_call(s)
  ↓ tools execute
Turn 2: thinking → text → tool_call(s)
  ↓ tools execute
Turn N: thinking → text (final) → assistant_message
```

Each turn is one LLM call. Within a turn, the model produces thinking tokens,
then visible text tokens, then tool-use blocks. Tools execute after the full
response, then the next turn begins with tool results.

### SSE event pipeline

```
Pi SDK events → agentd (server.mjs) → echsBridge (forum server) → SSE bus → browser
```

Key events emitted to the browser SSE stream:

| Event | Source | Purpose |
|---|---|---|
| `state` | echsBridge.emitState() | Full robot state snapshot including `recentToolRuns` (last 10) |
| `reasoning_delta` | Pi thinking_delta → agentd → echsBridge | Incremental reasoning/thinking text |
| `assistant_delta` | Pi text_delta → agentd turn_delta → echsBridge | Incremental visible assistant text |
| `tool_started` | echsBridge item_started handler | Per-tool notification when a tool run is created |
| `assistant_reset` | echsBridge.dispatchUserMessage() | Fires once at the start of a new user message dispatch |
| `assistant_message` | echsBridge turn_completed handler | Response is done; final text committed as a post |

### Live trace: checkpoint-based interleaving

The live trace interleaves reasoning, assistant text, and tool cards using
**checkpoints** — snapshots of accumulated text lengths at the moment each tool
starts.

**Recording checkpoints (client-side, `useForumState.ts`):**

1. `reasoning_delta` and `assistant_delta` events accumulate text in
   `reasoningDraft` and `assistantDraft` (buffered via `requestAnimationFrame`).
2. When a `tool_started` SSE event arrives, `flushPendingDeltas()` synchronously
   drains both buffers, then records:
   - `reasoningCheckpoints.push(reasoningDraft.value.length)`
   - `assistantCheckpoints.push(assistantDraft.value.length)`
3. `state` events update tool run data via `syncToolActivity`.

**Rendering (`liveTurnItems` computed in `TopicView.vue`):**

The computed iterates tools in order. For each tool, it slices both the reasoning
draft and assistant draft at the corresponding checkpoint boundaries, parses/renders
each segment, and emits it before the tool card. Remaining text after the last
tool appears at the end.

### Saved trace: server-side checkpoints

The same checkpoint concept is stored server-side for post-completion rendering.

**Recording (echsBridge):**

When `item_started` fires for a tool, the echsBridge records
`ctx.reasoningSummary.length` into `ctx.reasoningCheckpoints`. These are persisted
to the `plans.reasoning_checkpoints_json` column when the plan is updated.

**Rendering (`PostTracePanel.vue`):**

If `reasoningCheckpoints` is available from the session inspector API, the
component splits the raw plan text at checkpoint boundaries, parses each segment
with `parseReasoningSteps`, and interleaves with tools sorted by `startedAt`.
Falls back to legacy layout (reasoning at top, tools below) when checkpoints are
absent (pre-existing data or imported sessions).

### Critical footguns

**SSE event timing and buffering:**
`reasoning_delta` and `assistant_delta` events are buffered client-side via
`requestAnimationFrame` for performance. `state` events (carrying tool run data)
process synchronously. If you record checkpoints during `state` processing without
flushing the pending delta buffers first, the checkpoints will reflect stale text
lengths. Always call `flushPendingDeltas()` before recording any checkpoint.

**`recentToolRuns` batching:**
The `state` event's `recentToolRuns` array contains ALL recent tools (last 10 from
DB), not incremental additions. By the time the first `state` event reaches the
client, all tools from the current turn may already exist. This is why checkpoints
must be triggered by `tool_started` events (which fire per-tool in real time), not
by detecting new tools in `recentToolRuns`.

**`assistant_reset` scope:**
`assistant_reset` fires once per user message dispatch, NOT between Pi turns within
the same agent loop. It clears `assistantDraft`, `reasoningDraft`, and all activity
state. Do not add additional reset points without understanding that a single forum
reply spans multiple Pi turns.

**Plan ID transitions:**
The `state` event handler checks for `activePlanId !== null && nextPlanId === null`
to detect turn boundaries. This fires when the server clears the current plan
(e.g., at message dispatch). It resets drafts and activity. Be careful not to
create spurious null transitions that would wipe accumulated trace state mid-response.

**Clock skew for remote users:**
Server timestamps (`tool.startedAt`) may differ from browser `Date.now()` by
seconds. The `ToolElapsedTimer` component uses client-relative timing (records
`Date.now()` at mount, ticks from there) to avoid this. Never compute live elapsed
time as `Date.now() - serverTimestamp` — it breaks for any user not on the same
host.

**Tool name casing:**
Pi sends tool names capitalised (`Bash`, `Read`, `Edit`, `Grep`, `Write`). The
echsBridge normalises these to lowercase categories (`exec`, `read`, `apply_patch`)
in the `tool` column. But the `command` column preserves the original Pi name
(e.g., `Bash {"command":"...","timeout":15}`). Client-side formatting must use
`kind` (already normalised) for branching, not tool name string comparisons, and
must lowercase names before sub-type matching (e.g., `lowerName === 'write_stdin'`).

**Timeout units:**
Pi's Bash tool sends `timeout` in seconds (`"Timeout in seconds"`). Other tools
may use `timeoutMs` (milliseconds). The `extractTimeoutMs` function handles both
conventions: `timeoutMs`/`timeout_ms` → kept as-is; `timeout` → multiplied by
1000. Do not assume a single unit convention.

**Imported/synced sessions:**
Sessions imported from Pi JSONL files via `importPiSessions.ts` or background sync
will not have reasoning checkpoints (the column is nullable). `PostTracePanel`
falls back gracefully. Checkpoint reconstruction from JSONL data is theoretically
possible but not implemented.
