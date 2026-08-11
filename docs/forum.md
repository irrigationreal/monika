# Monika forum integration

This document owns the cross-service contract between the forum, agentd, canonical Pi sessions, and deployment lifecycle.
Forum product behavior and implementation details live beside the component in
[`services/forum/`](../services/forum/README.md); generic agentd behavior lives in
[`services/agentd/`](../services/agentd/README.md).

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

## Component documentation

- [Monika-specific forum behavior](../services/forum/docs/MONIKA_BEHAVIOR.md) — homepage freshness and component provenance
- [Live trace architecture](../services/forum/docs/LIVE_TRACE.md) — event flow, redaction, checkpoints, rendering, and debugging
- [Forum README](../services/forum/README.md) — product overview, configuration, features, and local development
- [Forum deployment](../services/forum/docs/DEPLOYMENT.md) — authentication and forum-specific deployment
- [agentd README](../services/agentd/README.md) — runtime API, ownership, compaction, analytics, and daemon lifecycle
- [Subagents](subagents.md) — delegated execution, identity boundaries, provenance, cancellation, and recovery

## Admin analytics

`/admin/analytics` is an admin-only deployment view composed from two sources.
The forum queries its own projection for distinctive vocabulary and resolves the
allowlist of canonical Pi session IDs through `pi_session_links → topics →
forums`. It sends only that allowlist and a bounded UTC window to agentd's
internal `POST /v1/admin/analytics/query` endpoint. The browser never calls
agentd or reads Pi JSONL directly. No analytics tables, memstore queries, or
model calls are involved.

Agentd scans only the active branch of allowlisted parent sessions and returns
aggregate data. A successful assistant response is a terminal `stop`/`length`
message with visible text and positive usage; interim tool-call messages are
excluded. Token footprint is the median summed usage for that population. Tool
failure rates use paired tool results with explicit boolean outcomes, normalize
only bounded operation labels, and require five samples for the headline.
`relocate_status`, `relocate_remote`, and `relocate_local` are separate operations;
compound shell calls with multiple recognized command occurrences are `bash:mixed`.
The runtime response includes only an immutable image commit and creation timestamp
(or explicit nulls for local/unversioned builds), so deployment boundaries can be
selected without exposing host or registry metadata. Tool rows also expose allowlisted
backend (`local`, `relocated_ssh`, `locked_ssh`, or `unknown`) and outcome counts (`success`, `no_match`, invalid input, not found,
dependency, transport, cancellation, timeout, or generic execution). Older tool
results without structured provenance remain `unknown` rather than being guessed.
Errors use fixed categories and count distinct affected turns without returning
raw errors. Parent-blocked p95 is the nearest-rank p95 of matched
`subagent_wait` result-message elapsed time from 0 through 24 hours; it is an
observed timestamp proxy, not exact execution duration. Delegation rates exclude
active, uncertain, malformed, or unproven-success lifecycle records. Historical
delegation coverage is bounded by lifecycle-artifact retention.

Model-vendor usage uses the same successful-response population and UTC day or
Monday-based week buckets. Analytics presets begin at UTC midnight so a 30-day
daily view has exactly 30 calendar buckets; the current day and any clipped week
remain explicitly marked as partial. Agentd schema version 2 preserves each
bucket's aligned calendar start/end separately from its observed `[from,to)`
interval and records the aggregate generation time, which remains stable across
process-local cache hits.

Distinctive vocabulary uses non-deleted, non-silent
forum posts in the selected range, separates human/admin from
robot/persona/system authors, and removes forum envelopes, code, URLs, markup,
and deterministic stopwords. Version 1 ranks repeated terms by a
corpus-relative smoothed log-rate score and returns no excerpts.

Tool-result history is not retroactively rewritten. Sessions created before the
relocate reliability fix may contain successful SSH transitions recorded as
theme-initialization errors and genuine textual `RELOCATE FAILED` results recorded
as successes. Operation/backend/outcome dimensions make that contaminated cohort
visible, but post-fix reliability should be evaluated from the new runtime deployment
boundary rather than by reinterpreting canonical history.

The agentd result cache is process-local and expires after 30 seconds by default.
If agentd is unavailable, the forum returns vocabulary with an explicit runtime
unavailable state rather than manufacturing zero operational metrics. Responses
contain no prompts, commands, paths, raw errors, session/tool/run IDs, or post
text. Forum presentation behavior is documented beside the component in
[`services/forum/README.md`](../services/forum/README.md).

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
- General topic responses expose only public-safe semantic lineage (`kind` and a
  `parentTopicId` when that parent is visible to the requester). Canonical Pi
  session IDs, JSONL paths, working directories, raw lineage source, and import
  identifiers are returned only by the existing admin-authorized session and
  inspector endpoints.

### Canonical utterances, provenance, and reconciliation

Forum-created, Pi-imported, and hybrid sessions use one reconciliation engine.
Topic tags are taxonomy, not permanent writer ownership: a session can move
between forum, Pi CLI, and an external adapter while retaining one canonical
JSONL history. An utterance is channel-neutral and is identified by its persisted
Pi message ID. One run may persist zero, one, or multiple ordered outward
assistant utterances before the single idle boundary.

Agentd appends `monika.message.provenance` beside canonical messages. Version 1
preserves the forum topic/post identity for older clients. Version 2 also carries
the durable ordered contributor utterance IDs and normalized execution origins.
The live bridge links by canonical IDs; `[FORUM TURN]` envelopes and normalized
body/time matching are legacy-only fallbacks. Provenance custom entries do not
enter model context.

Inbound durable dispatches group only consecutive posts with the same normalized
origin (channel, surface, and scope). The last post supplies model/mode options,
while the complete ordered contributor set is retained in provenance across a
lost-response retry. Different origins never leak into one catch-up envelope.
The forum also persists the normalized origin of the currently active causal turn.
Only an exact origin-key match may use Pi steering; Discord, Matrix, and web work
from any other origin is enqueued as a later follow-up turn. The active origin is
retained across accepted-dispatch retry/restart and is cleared only when canonical
settlement, interruption, or idle reconciliation proves that turn ended.
Discord and Matrix adapters can only offer best-effort behavior at their external
API boundary; their forum post, external dedupe reference, and local dispatch are
transactional, but remote acknowledgement or outbound publication is not
canonical settlement.

Pi's internal `agent_settled` event means the runtime reached the idle boundary;
it is not a request to aggregate text or publish an unpersisted raw completion.
Agentd emits each persisted outward item individually, then maps settlement to the
wire `turn_completed` event, which can follow zero outward items. The forum marks
activity idle only after this wire boundary, while live text remains an in-progress
trace rather than a post.

Live SSE and sync call the same deterministic assistant-projection service. The
service applies outbound tamper and default-persona semantics, strips compatibility
markers, normalizes parent/follow-up metadata, and claims the canonical
`(pi_session_id, pi_message_id)` once. `assistant_projections` and
`attachment_handoffs` stage attachment custody before a post is publicly visible.
A durable pending-attachment reservation gives each staged source to exactly one
assistant projection before its handoff can become linked; a competing projection
is retained as `needs_manual_review` with a conflict anomaly. Projection SQLite
`rowid` is the canonical arrival order within a Pi session/topic: a later projection
cannot create its visible post or deliver its completion callback while an earlier
projection is pending, linking, or retryably failed. Recovery drains ready posts and
callbacks in that same order. Terminal `needs_manual_review` projections are a
documented projection gap/anomaly and do not deadlock later canonical items.
Reservations survive handoff lease recovery and finalization crash windows and are
removed with their topic. Stale leases, finalization crash windows, and pending forum
notification delivery resume on startup without one conflicted projection aborting
other recovery. Live-first and sync-first races therefore converge on the same
body, metadata, parent, follow-up badge, attachments, and handoff state. A delayed
result stays at its chronological position in the topic; its “Background follow-up
to #N” link points back to the numbered origin post rather than moving or nesting
the result beside that earlier post.

Session export includes the current leaf and active root-to-leaf IDs. The forum
indexes immutable topology in `pi_entry_index`, records heads in
`pi_session_heads`, and only projects visible messages from the active branch.
Posts that later leave the active branch are preserved and recorded in
`pi_projection_divergences`, leaving room for future branch browsing without
deleting forum history.

External Pi CLI user and assistant messages have no automatic raw-completion
shortcut. They project only after the settlement window and an idle robot prove
the active branch stable. Content heuristics are not used: terse real input is
still conversation. Structural entries, compaction summaries, tool results,
custom state, and non-outward tool-use assistant entries are indexed but not
emitted as separate posts. New external continuations bump the topic once;
high-confidence legacy repairs are silent.

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

## Durable errors and compaction

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
atomically records a pending compaction request with a client-owned idempotency key
and the latest forum-projected canonical Pi leaf, then returns `202 Accepted` without
waiting on agentd. Agentd remains the authority for the idle gate, expected-leaf
claim, Pi operation, and canonical settlement; the forum only retries and projects
the durable request across the network boundary. The
confirmation modal only remains open until that durable
acceptance; afterward an in-topic status states that the browser may leave. New
web posts, handoffs, robot/Director continuations, topic status/deletion, and
an auto-compaction policy change remain fenced until the durable recovery checkpoint
has been accepted by agentd. Discord/Matrix messages arriving meanwhile commit their
forum post, external deduplication reference, session-message projection, and dispatch
atomically. Those pending posts are excluded from the checkpoint's catch-up context,
then dispatch exactly once behind it. `GET /api/topics/:topicId/compactions` rehydrates
active/latest state after a
reload. Client key generation supports both HTTPS and the standalone HTTP deployment;
it does not require the secure-context-only `crypto.randomUUID()` browser API.

The worker requeues pending and interrupted-running operations on startup. Agentd
rejects busy or stale sessions and invokes Pi's public `AgentSession.compact()` API.
Expected-leaf validation makes both lost HTTP responses and forum restarts retry-safe:
an existing compaction child proves that the operation already happened, so agentd
does not compact twice. Definite agentd 4xx rejections become terminal failures;
network/5xx uncertainty remains a durably pending operation with a persisted retry
time and is retried until canonical evidence resolves it. The forum then completes
the previously interrupted projection instead of manufacturing a failure after an
unknown response or leaving a permanent `running` row.

Automatic compaction is a separate default-off, topic-persistent policy exposed in
new-thread, full-reply, and quick-reply options. Only administrators may change the
shared setting, and an existing topic may change it only while idle with no pending
dispatch. Replies carry the current optimistic setting revision so a stale tab cannot
silently overwrite another change. Existing, imported, and handoff-created topics
start disabled. Other participants receive read-only visibility because compaction
affects their shared canonical context.

The forum sends the desired policy whenever it creates, opens, recreates, or dispatches
to an agentd conversation. Agentd applies it with a conversation-local,
non-persistent `SettingsManager.applyOverrides()` overlay. It must not call Pi's
`AgentSession.setAutoCompactionEnabled()`, whose settings-manager setter persists the
shared global setting. Consequently unrelated parent sessions and direct Pi CLI use
remain governed by the global default, which stays disabled.

When enabled, Pi owns threshold detection and overflow recovery. Threshold compaction
summarizes older context near the model limit. On the first context-overflow failure,
Pi compacts and retries the original request inside the same forum response; agentd
still commits only when it observes Pi's internal `agent_settled`. Automatic
compactions create idempotent
maintenance operational events keyed by the canonical Pi compaction entry, refresh
the context meter, and never create recovery-checkpoint posts. Summary text remains
only in canonical Pi JSONL and is not copied into forum SQLite. Automatic failures are
visible as failed maintenance events; terminal overflow still follows the ordinary
turn-error path.

After successful manual compaction, the forum atomically creates a user-attributed automated
recovery-checkpoint post and queues it through the normal durable post dispatcher.
Operation success therefore means **Pi compacted and the checkpoint was queued**; the
checkpoint assistant turn has its own ordinary dispatch/live-trace lifecycle. The
default prompt asks the assistant to restate goals, completed work, current work,
remaining steps, blockers, and possibly lost details without doing further work. If
compaction fails, the forum records a durable failure event and creates no recovery
post. If later dispatch fails, the existing post-dispatch retry path retries only the
checkpoint turn; it never repeats compaction. After automatic retries are exhausted—or if an old checkpoint was superseded or
abandoned—an admin-visible topic status exposes **Retry recovery checkpoint**, which
idempotently resets only that durable dispatch. A lost retry response can be repeated
without creating another checkpoint or repeating compaction.

Forum endpoints (admin only except operational-event visibility):

- `GET /api/topics/:topicId/operational-events`
- `GET /api/topics/:topicId/compactions`
- `POST /api/topics/:topicId/compactions` (`202 Accepted`, including idempotent repeats)
- `GET /api/topics/:topicId/compactions/:operationId`
- `POST /api/topics/:topicId/compactions/:operationId/retry-checkpoint`

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

Then set this through the host shell, ignored root `.env`, or ignored
`compose.yaml` so Compose can interpolate it:

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

Complete runtime setup lives in [Standalone deployment](deployment.md).
Forum-specific authentication and migration remain in the
[forum deployment guide](../services/forum/docs/DEPLOYMENT.md).

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
  omit disposable pi-subagents child sessions by explicit agentd kind or dedicated
  child-root path. This applies equally to fresh and fork-context children.
  Curated cwd mappings and system forums prevent other internal sessions from
  making project forums noisy.
- Sleep forks and historical custom-delegate/fork sessions are imported into
  system areas. `System / Delegates` and its focused-task marker describe legacy
  compatibility, not the current pi-subagents child path. Handoff and sleep
  lineage remain represented by canonical `monika.lineage` JSONL entries.
- Forum never talks directly to memstore and never invents memory origins. Memory
  dedupe must use canonical Pi session path/id.


## Forum component features

Message Templates and private drafts are documented in the
[forum README](../services/forum/README.md). Homepage freshness and component
provenance live in
[Monika-specific forum behavior](../services/forum/docs/MONIKA_BEHAVIOR.md), while
trace presentation and checkpoints live in
[Live trace architecture](../services/forum/docs/LIVE_TRACE.md).

## Forum attachments and artifacts

Attachment support is implemented as a hybrid reference model rather than treating
Pi JSONL as a blob store:

- Browser downloads use opaque attachment IDs backed by attachment rows bound to
  a post and topic. Topic visibility is checked through that persisted
  relationship before the file is streamed.
- The legacy `/api/robot-attachments?path=...` filesystem-path proxy and
  `[[attach:path]]` renderer have been retired. Never authorize an arbitrary
  output path using an independently supplied topic ID.
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

Structured attachment references are the primary outbound contract:

- Pi extension `forum-attachments.ts` registers
  `forum_upload_attachment(path, filename?, mimeType?)`. It reads the current
  topic from `.codex-forum/requester.json`, uploads bytes to the authenticated
  internal pending endpoint, and appends a versioned
  `monika.forum.attachment.ref` custom entry containing `pendingAttachmentId`,
  topic, filename, MIME type, size, SHA-256, and expiry. Pi's custom-entry append
  result supplies the durable entry ID used as `refEntryId`; it is not invented
  independently by the extension.
- Agentd binds structured refs to the next canonical outward assistant provenance.
  Live and sync feed those refs into the same durable handoff service. Structured
  and legacy references to the same `pendingAttachmentId` are deduplicated before
  custody, so one storage file cannot create duplicate attachment rows.
- Forum route `POST /api/agent/topics/:topicId/pending-attachments` requires the
  shared internal token and stores a hash-bound, expiring pending object. A post
  becomes visible only after all handoffs validate topic, expiry, size, SHA-256,
  and source custody and link the resulting attachment rows.

Standalone `[forum-attachment id="..."]` and `[artifact path="..."]` lines remain
legacy compatibility inputs outside fenced code blocks; they are never the primary
identity. The latter may call agentd `POST /v1/artifacts/resolve`, which is bounded
by allowed roots and maximum bytes. Agentd opens the final file with `O_NOFOLLOW`,
validates the opened descriptor's inode and canonical containment, and reads from
that descriptor so symlink and pathname-swap races fail closed. The deterministic
projection path removes compatibility markers from the visible body in both live
and sync recovery.
