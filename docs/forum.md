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

### Homepage snapshot freshness

The Vue forum state is module-scoped and survives client-side route changes. The
homepage therefore refreshes its active forums, archived forums, and three recent
posts on every route entry instead of treating non-empty arrays as permanently
fresh caches. Existing values remain rendered while their replacements load.
Each loader uses latest-request-wins assignment so an older overlapping response
cannot replace a newer snapshot.

This is deliberately route-entry refresh rather than polling or a homepage SSE
subscription. It bounds network and listener lifetimes to ordinary navigation,
while migration 34's partial `idx_posts_recent_created_at` index keeps the global
undeleted-post recency query efficient as post history grows.

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
`ghcr.io/irrigationreal/monika-forum:main` and `sha-*`. For releases, Nightly
builds Forum and Monika from the same commit and publishes immutable coordinated
candidate manifests plus `:nightly`. Stable automatically promotes those exact
candidate digests to a date-style tag and `:latest` after a seven-day soak. See
`docs/releases.md` for the complete lifecycle.

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
- `GET /v1/pi/sessions/:id/ownership`
- `POST /v1/pi/sessions/:id/ownership/claim`
- `POST /v1/pi/sessions/:id/ownership/heartbeat`
- `POST /v1/pi/sessions/:id/ownership/release`
- `POST /v1/conversations`
- `POST /v1/conversations/open`
- `GET /v1/conversations/:id`
- `GET /v1/conversations/:id/history`
- `GET /v1/conversations/:id/context`
- `GET /v1/conversations/:id/events`
- `POST /v1/conversations/:id/messages`
- `POST /v1/conversations/:id/interrupt`
- `POST /v1/conversations/:id/compact` (idle-only manual Pi compaction with optimistic leaf validation)
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

### Subagents and background completions

The parent agentd runtime loads the reviewed `pi-subagents` 0.37.2 package. Parent
sessions expose `subagent`, `subagent_wait`, and `subagent_supervisor`; the package
supports foreground execution, parallel groups, chains, dynamic fanout, and async
runs. Agent profiles define direct child tools instead of inheriting the parent's
tool set. `subagents.defaultExtensions` is `[]`, so ambient extensions are absent
unless a profile explicitly opts in.

Specialist children receive project instructions plus turn-routed topic addenda,
but no Monika persona or autobiographical memory. `monika-delegate` is the explicit
identity-bearing profile: it receives the stable SOUL.md, STYLE.md, and REGISTER.md
persona trio plus routed topics and bounded read-only `recall`/`recall_session`.
WAKE.md, FACTS.md, observations, and recent sessions are not injected ambiently.
No child profile exposes memory mutation or observation-lifecycle tools, automatic
transcript ingestion, save/shutdown memory hooks, or sleep. This is a capability and
lifecycle boundary rather than an OS sandbox; shell-capable profiles retain normal
runtime permissions and must not circumvent it. Sleep remains its own sequential
full-persona fork workflow under
`/app/.pi/agent/sessions/forks/`.

Agentd sets the child session root to
`/app/.pi/agent/sessions/subagent/`. Forum sync rejects both that path and explicit
`kind: subagent` listings, so disposable child transcripts never become forum
topics or memstore sessions. This is distinct from the legacy `System / Delegates`
taxonomy, which remains only for importing historical custom-delegate sessions
marked with `=== FOCUSED TASK MODE ===`.

For async work, agentd owns the lifetime rather than allowing print-mode auto-drain
to hold the initiating forum response open. Package lifecycle, result, and recovery
artifacts persist below `/data/pi-subagents/`; the child JSONL remains in the
dedicated session root. Agentd records a `monika.subagent.run` entry in the
canonical parent JSONL with the run ID, originating turn/topic/post, and async
directory. Active runs block idle reaping, conversation close, interactive
ownership takeover until stopped, and deployment quiescence. Interrupt/takeover
requests use pi-subagents' public v1 stop RPC; drain does not close conversations
that still own active work.

After restart, agentd restores run mappings from the parent JSONL, reconciles the
persistent `status.json` artifact and package lifecycle events, and asks the
package to trigger recovered results. Logical completion alone does not release
lifecycle ownership: exact observed process-terminal proof is required. The
package's natural `subagent-notify` continuation is attributed as
`source_kind: subagent-completion`, persisted as canonical message provenance, and
projected exactly once beneath the originating forum post when available. Grouped
notifications retain all contributing run origins. Live bridge projection and
later sync share the canonical Pi message link, preventing duplicate completion
posts.

Agentd runs conservative retention daily. A child session is removed only after
14 days when its status is proven terminal, it is not active, and its parent
session has no ownership lease. Malformed, uncertain, active, leased, and
unproven-terminal runs are retained; lifecycle artifacts remain for diagnostics.

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
- Sync polls agentd list/export endpoints, indexes canonical entry topology,
  imports active-branch messages idempotently, and reconciles forum-origin
  messages by canonical provenance before using `[FORUM TURN]` or text matching
  as legacy fallbacks.
- Forum-created, Pi-imported, and hybrid topics share one reconciliation path.
  Forum-origin messages wait for bridge persistence, while external Pi CLI
  continuations project after the settlement/idle gate. Ambiguous bridge-owned
  messages move to `needs_manual_review`; ignored and resolved anomalies remain
  as audit history.
- Admin → Sync Health exposes anomaly counts, global and targeted rescans,
  silent historical backfill, optional backfill+bump, ignore actions, a dry-run
  repair inventory, and an explicit repaired-topic bump endpoint.
- Bootstrap identities are `neon`, `Pi CLI`, `robot`, and `Director`.
- Forum-native handoff is implemented with disposable draft generation and final
  confirmation that creates the destination topic, parented Pi session, lineage
  metadata, edited draft post, and first robot turn.
- `pi_session_links` stores `parent_pi_session_id`, `parent_pi_session_path`,
  `lineage_kind`, and `lineage_source`.

### Provenance-aware Pi reconciliation

Forum-created, Pi-imported, and hybrid sessions use one reconciliation engine.
Topic tags are taxonomy, not permanent writer ownership: a session can move
between forum and Pi CLI while retaining one canonical JSONL history.

Agentd appends versioned `monika.message.provenance` custom entries for forum
dispatches and emits the terminal canonical Pi message ID. The live bridge uses
that ID to link its post directly; `[FORUM TURN]` envelopes and normalized
body/time matching remain legacy fallbacks. Custom provenance does not enter the
model context.

Session export includes the current leaf and active root-to-leaf IDs. The forum
indexes immutable topology in `pi_entry_index`, records heads in
`pi_session_heads`, and only projects visible messages from the active branch.
Posts that later leave the active branch are preserved and recorded in
`pi_projection_divergences`, leaving room for future branch browsing without
deleting forum history.

Unmarked active-branch Pi CLI user and assistant messages are projected after a
60-second settlement window once the forum robot is idle. Content heuristics are
not used: terse real input is still conversation. Structural entries, compaction
summaries, tool results, custom state, and forum-origin intermediate tool-use
assistant entries are indexed but not emitted as separate posts. New external
continuations bump the topic once; high-confidence legacy repairs are silent.

Posts already linked to canonical Pi are excluded from later catch-up envelopes,
preventing imported CLI input from being sent back into the same session. Admin
Sync Health uses “rescan” for reconciliation, while explicit backfill remains a
separate action. `GET /api/admin/pi-sync/repair-inventory` returns a dry-run list
of unresolved candidates and proposed actions. Historical repairs remain silent;
an admin can intentionally resurface a repaired thread with
`POST /api/admin/pi-sync/topics/:topicId/bump-repaired`.

### Interactive Pi ownership

`config/extensions/session-ownership.ts` prevents agentd and an interactive Pi
TUI from independently writing the same canonical session. It hooks Pi's
cancellable `session_before_switch` event, so the normal `pi` then `/resume`
workflow remains unchanged. Initial command-line resumes use a guarded
`session_start` fallback. Non-TUI runtimes, including agentd itself, do not claim
interactive ownership.

Agentd grants renewable 90-second leases persisted under the Pi agent directory,
so an agentd restart does not silently create a second writer. Claiming an idle
loaded conversation evicts its cached runtime; claiming an active forum turn
requires an explicit interrupt-and-takeover choice. The extension heartbeats
every 30 seconds and releases its lease on session shutdown. Expiry recovers
ownership after a crashed terminal, while an expired heartbeat blocks further
TUI input until the administrator reclaims ownership, exits, or explicitly
continues unprotected. Agentd rejects forum reopen and message dispatch attempts
while a lease is active.

Session export also reconciles the loaded manager branch with the append-only
JSONL. If disk is a strict descendant of the cached leaf, export selects the disk
branch and marks it as external advancement. A true sibling divergence keeps the
loaded branch and reports a branch conflict. Before reusing an idle cached
conversation, agentd performs the same check and reloads it when disk advanced.
This is a backstop for continuations that bypass the ownership extension.

## Durable errors and manual compaction

Execution failures and compactions are projected as forum operational events, not
posts. `topic_operational_events` anchors each event after a real post while keeping
it out of post numbering, search, pagination counts, and Pi catch-up context. The
frontend renders anchored events in a theme-aware inter-post gutter: the gutter
replaces the normal post separator without moving the event into `.vb-post`, and
status tokens provide the error or success tone across light and dark themes. Raw
provider errors follow the trace visibility boundary: authenticated viewers can
expand the diagnostic text, while unauthenticated readers receive only the neutral
event summary. Pi JSONL remains authoritative; sync conservatively reconstructs
historical terminal errors from the active branch and ignores failed attempts that
Pi later recovered through retry or compact-and-retry. A terminal event classified as
`context_overflow` offers **Compact and recover** to admins; text recognition is only
a compatibility fallback for legacy events without structured classification.

Admins can choose **Compact** beside **Handoff** while a topic is idle. The forum
creates a durable compaction operation with a client-owned idempotency key and calls
agentd with the expected canonical Pi leaf. Client key generation supports both HTTPS
and the standalone HTTP deployment; it does not require the secure-context-only
`crypto.randomUUID()` browser API. Agentd rejects busy or stale sessions and invokes
Pi's public `AgentSession.compact()` API. Expected-leaf validation makes a lost HTTP
response retry-safe: an existing compaction child proves that the operation already
happened, so agentd does not compact twice. Automatic compaction remains disabled by
runtime policy.

After successful compaction, the forum atomically creates a user-attributed automated
recovery-checkpoint post and queues it through the normal durable post dispatcher.
The default prompt asks the assistant to restate goals, completed work, current work,
remaining steps, blockers, and possibly lost details without doing further work. If
compaction fails, the forum records a durable failure event and creates no recovery
post. If later dispatch fails, the existing post-dispatch retry path retries only the
checkpoint turn; it never repeats compaction.

Forum endpoints:

- `GET /api/topics/:topicId/operational-events`
- `POST /api/topics/:topicId/compactions` (admin only)
- `GET /api/topics/:topicId/compactions/:operationId` (admin only)

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
- Default work directory: `/workspace`; project forums should set a repository-specific cwd.
- Runtime secrets: `runtime/secrets/forum.env` and `runtime/secrets/secrets.env`.

The forum sends each configured cwd to agentd, which explicitly marks these
administrator-configured server workspaces as trusted for Pi SDK resource loading.
Project `AGENTS.md`, `.pi` resources, and `.agents/skills` therefore load without an
interactive prompt. This does not change direct Pi TUI behavior: interactive trust
prompts remain enabled, and their decisions persist under `/data/pi-agent-trust`.

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
  Close returns `409 active_subagent_runs` while background work still owns the
  parent conversation.
- Forum model selection/thinking level is mapped onto Pi `setModel()` /
  `setThinkingLevel()` using Pi model IDs directly.
- A context meter is available in the reply UI using the best Pi-provided usage
  data. Context is a typed snapshot with an independent lifecycle: the initial
  topic state provides it, `context_updated` refreshes it after model selection,
  measured turn usage, and successful compaction, and unrelated live activity or
  transient refresh failures retain the last known value. Loaded-runtime
  estimates are preferred over older historical usage and are visibly marked as
  not exact current context.

## Do not lose these design decisions

- Pi JSONL sessions remain canonical for agent conversation state.
- Forum SQLite is a projection/metadata layer.
- One forum topic should map to one Pi session.
- Historical import and ongoing sync include canonical user-facing sessions, but
  omit disposable pi-subagents child sessions under the dedicated child root.
  Curated cwd mappings and system forums prevent other internal sessions from
  making project forums noisy.
- Sleep forks and historical custom-delegate/fork sessions are imported into
  system areas. `System / Delegates` and its focused-task marker describe legacy
  compatibility, not the current pi-subagents child path. Handoff and sleep
  lineage remain represented by canonical `monika.lineage` JSONL entries.
- Forum never talks directly to memstore and never invents memory origins. Memory
  dedupe must use canonical Pi session path/id.

## Message Templates

Authenticated forum users can manage private, account-owned **Message Templates**
from User Control Panel → Message Templates. Administrators can separately manage
system templates from the Admin Panel. Templates contain a literal message body,
an optional new-thread title, an optional organizational category, reply and/or
new-thread applicability, and either all-forum or exact-forum scope.

The effective-template API authorizes the current forum and filters applicability
on the server before returning template names or bodies. For selected-forum
templates, effective responses expose only the requested forum association; full
scope membership remains confined to the owner's management API. Personal
templates are never exposed through the system administration API, and
impersonation tokens do
not grant access to another account's personal template library. Updates, deletes,
and ordering use optimistic integer revisions so stale browser tabs cannot silently
overwrite newer changes.

Selecting a template copies its text into the browser draft. It does not submit,
select a model, change robot or silent-post behavior, expand variables, or create
special provenance. Only the ordinary resulting post body/title reaches forum
posts and canonical Pi JSONL. Editing or deleting a template cannot alter an
existing post or Pi session. Template metadata remains private forum authoring
state and is excluded from forum search, SSE, sync, and memstore.

API surfaces:

- `GET /api/message-templates/effective?context=reply|new_thread&forumId=...`
- Personal management under `/api/message-templates` and
  `/api/message-templates/mine`
- Admin-managed system templates under `/api/admin/message-templates`

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

| Event               | Source                                         | Purpose                                                                         |
| ------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `state`             | echsBridge.emitState()                         | Full robot state snapshot including `recentToolRuns` (last 20)                  |
| `reasoning_delta`   | Pi thinking_delta → agentd → echsBridge        | Incremental reasoning/thinking text                                             |
| `assistant_delta`   | Pi text_delta → agentd turn_delta → echsBridge | Incremental visible assistant text                                              |
| `tool_started`      | echsBridge item_started handler                | Per-tool notification when a tool run is created                                |
| `assistant_reset`   | echsBridge.dispatchUserMessage()               | Start of new response (reason: `new_turn`) or interrupt (reason: `interrupted`) |
| `assistant_message` | echsBridge turn_completed handler              | Response done; final text committed as a post                                   |

agentd does not translate Pi's `agent_end` directly into `turn_completed`. An agent
run may still retry, compact and retry, or process a queued continuation after that
event. agentd stages final text and usage at `agent_end`, then emits exactly one
`turn_completed` at Pi's `agent_settled` boundary. This prevents the forum from
committing a post and becoming idle while Pi still intends to continue.

### Live trace: append-only committed segments

The live trace uses an **append-only committed-segment model**. Once content is
rendered, it never moves — new content only appears at the tail.

**Data model (`useForumState.ts`):**

```typescript
type TraceSegment =
  | { kind: "reasoning"; text: string }
  | { kind: "assistant_text"; text: string }
  | { kind: "tool"; toolRunId: string };
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
