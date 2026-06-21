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

## Thread moves

Admins can move a topic between forums through `POST /admin/topics/:topicId/move`.
Moves are rejected with `409 Conflict` while an assistant response is active for
that topic; changing the forum/workspace underneath an in-flight Pi turn would
leave the forum metadata and canonical Pi session in different contexts.

Normal moves create a visible marker post, record a pending topic-move prompt,
reset the session's forum-context sync marker, and inject a `[THREAD MOVED
NOTICE]` into the next assistant turn so Pi receives the new forum instructions
and persona index.

Silent moves pass `silent: true`. They update the topic forum and external
surface mapping, but they do not create a marker post and do not queue a moved
notice. They also leave the Pi session/context sync fields untouched until a
later assistant turn actually runs in the new forum. If the topic is silently
moved away and then silently moved back before any assistant turn runs, the Pi
session context remains unchanged. If a later turn runs while the topic is in a
new forum, the bridge injects an internal `[FORUM CONTEXT REFRESH]` with the
current forum instructions and persona index before the user post.

Do not implement silent moves by inserting a `posts.silent = 1` marker. Silent
posts are still included in assistant catch-up context, so that would still alter
the canonical session.

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

`runtime/secrets/forum.env` should include generated `CODEX_FORUM_INTERNAL_API_TOKEN`
and `CODEX_FORUM_DEPLOY_TOKEN` values. The internal token is shared by the `monika`
and `forum` containers for pending-attachment uploads. The deploy token is shared by
the `forum` container and host-side deploy automation for quiescence checks. Both are
fail-closed when unset; generate separate random values or copy the shape from
`docs/examples/forum.env.example`.

Health checks:

```bash
docker compose exec monika curl -fsS http://forum:4310/healthz
docker compose exec monika curl -fsS http://forum:4310/api/healthz
```

The model catalog endpoint (`/api/models`) requires an authenticated forum user.

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
  the local file to the forum internal pending attachment endpoint with the
  shared `CODEX_FORUM_INTERNAL_API_TOKEN`, and returns the exact standalone
  `[forum-attachment id="..."]` reference to include in the final response.
- Forum route `POST /api/agent/topics/:topicId/pending-attachments` requires
  that shared token via `x-internal-token` (preferred) or `Authorization: Bearer
  ...` (compatibility), then stores the file in forum upload storage as a pending
  attachment with SHA-256 and TTL. If the server token is unset, the route returns
  a configuration error instead of accepting unauthenticated uploads.
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

Both show reasoning, assistant text, and tool calls in chronological order.

### Trace visibility boundary

Topic visibility controls access to final conversation content. Trace visibility is a separate server-side policy because plans, reasoning, tool calls, commands, paths, usage metadata, and live assistant drafts are operational details, not public post content.

Current policy:

- Unauthenticated readers of public topics may see final posts and a neutral live placeholder only: "Response in progress…".
- Authenticated users may receive detailed live state and stream events for visible topics.
- Saved trace history remains behind the admin-only session inspector surface.

The `/topics/:topicId/state` route redacts unauthenticated responses to a minimal busy/idle shape and ignores `view=full` / `include=plan,toolRuns` for public readers. The `/topics/:topicId/state/stream` route filters SSE events per subscriber: public readers receive redacted `state` events and stripped `assistant_message` completion signals, while reasoning deltas, assistant deltas, tool events, and error details are suppressed. Do not rely on Vue-only hiding for trace secrecy.

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

**Important timing note:** For operations like "write a large file," the model
generates the file content during the **thinking phase** (which can take 10-30
seconds), then calls the Write tool which executes in **milliseconds**. The slow
part is thinking, not tool execution.

### SSE event pipeline

```
Pi SDK events → agentd (server.mjs) → echsBridge (forum server) → SSE bus → browser
```

Key events emitted to the browser SSE stream:

| Event | Source | Purpose |
|---|---|---|
| `state` | echsBridge.emitState() | Full robot state snapshot including `recentToolRuns` (last 20) |
| `reasoning_delta` | Pi thinking_delta → agentd → echsBridge | Incremental reasoning/thinking text |
| `assistant_delta` | Pi text_delta → agentd turn_delta → echsBridge | Incremental visible assistant text |
| `tool_started` | echsBridge item_started handler | Per-tool notification when a tool run is created |
| `assistant_reset` | echsBridge.dispatchUserMessage() | Start of new response (reason: `new_turn`) or interrupt (reason: `interrupted`) |
| `assistant_message` | echsBridge turn_completed handler | Response done; final text committed as a post |

### Live trace: append-only committed segments

The live trace uses an **append-only committed-segment model**. Once content is
rendered, it never moves — new content only appears at the tail.

**Data model (`useForumState.ts`):**

```typescript
type TraceSegment =
  | { kind: 'reasoning'; text: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool'; toolRunId: string };
```

`committedSegments` is an ordered array of frozen segments. `reasoningDraft` and
`assistantDraft` are the live tail — text currently being streamed that hasn't
been committed yet.

**Commit flow:**

1. Reasoning/assistant deltas arrive → buffered via `requestAnimationFrame` →
   flushed into `reasoningDraft`/`assistantDraft`.
2. `tool_started` SSE event fires → `flushPendingDeltas()` synchronously drains
   buffers → current `reasoningDraft` committed as a reasoning segment → current
   `assistantDraft` committed as a text segment → tool segment pushed → both
   drafts cleared (fresh start for next inter-tool gap).
3. `assistant_message` fires → any remaining tail text is flushed, then the
   live trace is cleared (response complete, post takes over). The completion
   reload opts out of trace reconstruction so stale idle state cannot resurrect
   the just-finished plan or tool runs.

**Rendering (`liveTurnItems` computed in `TopicView.vue`):**

Iterates committed segments (stable, ordered) plus the pending tail drafts
(live, growing). For each tool segment, looks up the tool run from
`activityLog`. If the tool data hasn't arrived yet (race between `tool_started`
and `state`), renders a "Running tool…" placeholder.

`LiveAssistantTurn.vue` treats the current status item as pinned panel state and
renders only the latest 15 chronological live trace items beneath it. This is a
presentation-only cap: `committedSegments`, draft text, server checkpoints, and
saved Trace History remain complete. When a new chronological item arrives past
the cap, Vue transition classes fade the oldest visible item out at the top and
fade the newest item in at the bottom. Page refreshes during an active response
reconstruct the current state first, then immediately show the latest 15-item
window without inventing removal animations for cards the browser never saw.

### Interrupt handling

When the user clicks Stop:

1. `assistant_reset` fires with `reason: 'interrupted'`
2. Client sets `interruptedTrace = true` and stops accumulating new content
3. Committed segments are preserved (not cleared)
4. The trace header changes to "■ Response stopped" / "STOPPED"
5. The frozen trace remains visible until the next response starts

### Saved trace: server-side checkpoints

The echsBridge stores checkpoint data for post-completion trace reconstruction:

- `ctx.reasoningSummary` accumulates all reasoning text server-side
- `ctx.assistantText` accumulates all assistant text server-side
- When each tool starts, both lengths are recorded as checkpoints
- `reasoning_checkpoints_json` is stored in the `plans` table (migration 29)
- `assistantCheckpoints` + `assistantText` are included in the SSE state response

**Saved rendering (`PostTracePanel.vue`):**

If `reasoningCheckpoints` is available from the session inspector API, the
component splits the raw plan text at checkpoint boundaries, parses each segment
with `parseReasoningSteps`, and interleaves with tools sorted by `startedAt`.
Falls back to a compact non-interleaved view when checkpoints are absent
(pre-existing data or imported sessions).

**Refresh resilience:** On page refresh or reconnect mid-response,
`reconstructSegmentsFromState()` rebuilds committed segments from server state
using the stored checkpoints and accumulated text. Reconstruction only runs while
`activity !== 'idle'` and there is current live content (`currentPlan` or live
assistant text), including explicit initial state loads. Server state treats
`activity = 'idle'` as an invariant that clears `current_plan_id`; queued/waiting
turns also start without inheriting the previous plan. This keeps stale completed
plans from resurrecting the live panel or appearing at the start of the next live
turn.

### `parseReasoningSteps` and markdown handling

The reasoning parser splits text on `**bold**` markers to identify step boundaries.
Only `**...**` at the **start of a line** (after newline + optional whitespace) is
treated as a step boundary. Inline bold like `- **Gold** as currency` is kept as
detail text within the current step, not split into a separate card.

Fallback title for untitled reasoning: "Thinking" (not "Activity").

### Critical footguns

**SSE event buffering:** `reasoning_delta` and `assistant_delta` are buffered
client-side via `requestAnimationFrame`. `tool_started` and `state` events
process synchronously. Always call `flushPendingDeltas()` before committing
segments or recording checkpoints.

**`recentToolRuns` batching:** The `state` event's `recentToolRuns` array
contains ALL recent tools (last 10 from DB), not incremental additions. Tool
segments must be committed from `tool_started` events (which fire per-tool in
real time), not by diffing `recentToolRuns`.

**`activityLog` mutations:** Use immutable array updates
(`activityLog.value = [...activityLog.value, item]`) not `.push()`. In-place
mutations may not trigger Vue computed re-evaluation reliably through
intermediate computed refs.

**`assistant_reset` scope:** Fires once per user message dispatch (`new_turn`)
or on interrupt (`interrupted`). Does NOT fire between Pi turns within the same
agent loop. A single forum reply spans multiple Pi turns.

**Tool name casing:** Pi sends capitalised names (`Bash`, `Read`, `Edit`). The
DB `tool` column is normalised lowercase (`exec`, `read`, `apply_patch`). The
`command` column preserves the original. Use `kind` for formatting branches and
lowercase names for sub-type checks.

**Timeout units:** Pi's Bash tool sends `timeout` in seconds. Other tools may
use `timeoutMs` (milliseconds). `extractTimeoutMs` handles both conventions.

**Clock skew:** `ToolElapsedTimer` uses client-relative timing (records
`Date.now()` at mount). No `liveTurnStartedAt` timestamp filter exists — the
append-only model handles turn boundaries via `assistant_reset`.

**Imported/synced sessions:** Sessions imported from Pi JSONL files won't have
reasoning checkpoints (nullable column). `PostTracePanel` falls back gracefully.

### Debugging the trace pipeline

When investigating trace rendering issues, the event pipeline has multiple
stages where data can be lost or misordered. Use these debug techniques:

**Server-side SSE capture:** Capture the raw SSE stream to see what events the
server actually sends:
```bash
TOKEN=$(curl -s .../api/auth/login -d '...' | python3 -c '...')
timeout 30 curl -sN ".../api/topics/$TOPIC/state/stream" \
  -H "Authorization: Bearer $TOKEN" | grep '^event:'
```
Verify `tool_started` events appear between `state` events, and that
`assistant_delta` bursts arrive between tool events.

**Client-side console logging:** Add temporary `console.warn` in:
- `syncToolActivity` — verify tools are added/updated in `activityLog`
- `tool_started` handler — verify segments are committed
- `liveTurnItems` computed — verify items are produced (log count + types)
- `LiveAssistantTurn` component — verify props are received (use a `watch`)
- `resetRobotActivity` — add `new Error().stack` to identify the caller

**Common patterns:**
- Items produced but not rendered → Vue reactivity issue (check immutable updates)
- `tool_started` not firing → SSE stream not connected or wrong topic
- Tools "updated" but never "added NEW" → tools already in `activityLog` from
  initial `loadState`, or `recentToolRuns` includes old tools
- Segments cleared mid-response → unexpected `resetRobotActivity` call (check
  stack trace to find caller: `assistant_reset`, plan-ID transition, or
  `handleAssistantMessage`)
