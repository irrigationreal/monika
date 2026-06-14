# Monika agentd backend

This Monika frontend mode uses Monika's Pi-backed `agentd` service instead of a
standalone ECHS deployment. `agentd` lives in the `irrigationreal/monika` runtime
container with Pi, extensions, stateful-memory, and memstore, and exposes the
ECHS-compatible HTTP/SSE subset consumed by the existing forum bridge.

The forum container should **not** run Pi and should **not** talk to memstore
directly. It owns forum metadata only; agent sessions, memory enrichment, model
settings, tool execution, canonical session files, and memory saves stay behind
the `agentd` boundary.

## Repository location

The forum service now lives in the Monika runtime repository under
`services/forum`. The former `irrigationreal/monika-forum` repository is retained
as historical provenance for the import, and future source-of-truth development
should happen in `irrigationreal/monika`.

## Required environment

```bash
CODEX_FORUM_AGENT_BACKEND=monika-pi
MONIKA_AGENTD_BASE_URL=http://127.0.0.1:7724
CODEX_FORUM_DB=/home/monika/.pi/forum/data.db
CODEX_FORUM_UPLOADS_DIR=/home/monika/.pi/forum/uploads
CODEX_FORUM_ENABLE_AUTH=1
MONIKA_PI_SYNC_ENABLED=1
MONIKA_PI_SYNC_INTERVAL_MS=5000
```

`MONIKA_AGENTD_BASE_URL` is the preferred name. `CODEX_FORUM_ECHS_BASE_URL`
still works as a compatibility alias because the current bridge is still mostly
ECHS-shaped internally.

## Local stanza deployment

From `~/repos/monika`:

```bash
docker compose -f compose.yaml -f compose.forum.yaml up -d --build forum
```

The forum currently listens on:

```text
http://127.0.0.1:4310
```

When using an SSH SOCKS proxy such as `ssh -CND 4096 monika@stanza`, open:

```text
http://stanza:4310
```

Do not open `http://127.0.0.1:4310` through a SOCKS tunnel unless Firefox is
configured to proxy loopback; otherwise `127.0.0.1` means the browser machine.
A direct tunnel alternative is:

```bash
ssh -L 14310:127.0.0.1:4310 monika@stanza
# open http://127.0.0.1:14310
```

## Current status

Working:

- `agentd` health at `http://127.0.0.1:7724/healthz`
- forum health at `http://127.0.0.1:4310/healthz`
- forum API health at `http://127.0.0.1:4310/api/healthz`
- model listing through forum -> agentd, including Pi default model and context metadata
- basic forum -> agentd -> Pi -> forum roundtrip
- historical Pi session import
- linked/imported topic continuation via canonical Pi session open
- forum-created Pi session linking
- automatic Pi -> forum catch-up sync
- memory-safe close through Pi `session_shutdown`
- forum model/reasoning selection mapped to Pi `setModel()` / `setThinkingLevel()`
- reply UI context meter using best Pi-provided usage/context data with warning when not exact
- forum-native handoff with disposable draft generation, parented Pi session creation, and lineage/backlink UI
- Pi parent lineage projection from JSONL `parentSession` headers and `monika.lineage` custom entries

Current live DB state after the initial clean import, sync testing, one-time classification cleanup, handoff testing, and parent-lineage backfill:

- DB: `/home/monika/.pi/forum/data.db`
- Imported Pi sessions/topics: 604
- Visible posts: 13,793
- Pi message links: 52,860
- Sessions with parent lineage: 66
- Parent lineage rows with an imported parent topic backlink: 23
- Handoff sessions created through the forum: 1
- One-time cleanup backup: `/home/monika/.pi/forum/data.db.before-pi-reclass-20260614T172157Z`
- Sync may increase post/message-link counts as Pi sessions change.
- Identities: `neon` (human login), `Monika` (robot), `Pi CLI` (system), and `Director` (robot).

## Historical Pi session import

The import path is CLI-first because this is an occasional admin/recovery
operation. Normal ongoing catch-up is handled by the background sync worker.

From `~/repos/monika-forum`:

```bash
corepack pnpm import:pi-sessions -- \
  --agentd http://127.0.0.1:7724 \
  --db /home/monika/.pi/forum/data.db
```

Use `--dry-run` to classify sessions without writing rows, `--limit N` for a
small test import, and `--reset-db` only when intentionally replacing the whole
forum DB. Existing imported topics are not automatically moved by this command;
if the classification rules need another historical cleanup, do that as a
one-off migration rather than turning reclassification into standing import
workflow.

The importer calls agentd; it does not mount or scan `~/.pi/agent/sessions`
inside the forum container. Pi session IDs/paths are stored in `pi_session_links`
and Pi message IDs in `pi_message_links` so reruns are idempotent and future
memory lifecycle actions can preserve canonical Pi origins for memstore dedupe.

`pi_session_links` also stores lightweight lineage projection columns:
`parent_pi_session_id`, `parent_pi_session_path`, `lineage_kind`, and
`lineage_source`. These are projection metadata only; Pi JSONL remains canonical.
Historical sessions that had Pi's native `parentSession` header were backfilled as
`lineage_kind='parent'` / `lineage_source='pi-jsonl-header'`. Exact kinds such as
`handoff`, `delegate`, and `sleep` are only available when newer code wrote a
`monika.lineage` custom JSONL entry.

Historical user posts from the initial import are attributed to `neon`. New Pi
CLI-discovered user messages from ongoing sync are attributed to `Pi CLI` unless
they are recognized as forum-originated messages.

## Forum-native handoff

Handoff is implemented as a forum-native flow, not by invoking Pi's TUI-bound
`/handoff` command.

Flow:

1. The user opens the inline Handoff panel above Quick Reply.
2. The forum calls `POST /topics/:topicId/handoff/draft`, which proxies to
   agentd `POST /v1/conversations/:id/handoff/draft`.
3. agentd generates a disposable draft from the canonical Pi branch using Pi's
   `getBranch()` + `convertToLlm()` + `serializeConversation()` pattern.
4. The user edits the draft, destination forum, optional workspace override, and
   launch model/reasoning.
5. Final confirmation creates the destination topic, creates a parented Pi
   session through agentd, writes lineage metadata, stores the first user post,
   and dispatches the robot turn immediately.

No Pi session, forum topic, or lineage row is created during draft generation.
Only final confirmation creates canonical state.

The topic header shows parent lineage when available. If the parent Pi session is
also linked to a forum topic, the banner includes an "Open parent thread" link.
When only Pi's `parentSession` header is known and no custom lineage kind exists,
the UI deliberately labels it as "Parent session" rather than guessing.

## Session continuity

The forum treats `pi_session_links` as the durable mapping from one forum topic
to one canonical Pi JSONL session.

Runtime behavior:

- When replying in a linked/imported topic, the bridge calls
  `POST /v1/conversations/open` and continues the existing Pi session rather
  than creating a parallel session.
- When the forum creates a new Pi conversation, it records the returned Pi
  `session_id` and `session_path` in `pi_session_links` immediately.
- If a linked conversation is not currently loaded in agentd, the forum opens it
  on demand before sending the next message.
- The selected model/reasoning options are sent to agentd as Pi model IDs and
  applied through Pi's native model/thinking APIs.

## Automatic sync

A background sync worker is enabled by default:

```bash
MONIKA_PI_SYNC_ENABLED=1          # default; set 0 to disable
MONIKA_PI_SYNC_INTERVAL_MS=5000   # default polling interval
```

Sync remains forum-owned projection logic: it calls agentd list/export endpoints,
never memstore. `GET /v1/pi/sessions` includes `mtime_ms` and `size_bytes`, so
the forum can detect changed session files cheaply before exporting the full
session.

Reconciliation rules:

- Already-linked Pi messages are skipped.
- Forum-originated Pi user messages are detected by their `[FORUM TURN]`
  metadata and linked back to the originating forum post instead of duplicated.
- Assistant posts are reconciled by exact body match where possible.
- New Pi CLI-created sessions are routed through the same cwd/system mapping as
  the historical importer.

## Memory lifecycle safety

- The forum never talks directly to memstore.
- The forum never invents memory origins such as `forum-topic:<id>`.
- Memory save/dedupe identity remains the canonical Pi session path/id.
- `POST /topics/:topicId/robot/close` closes the live agent conversation for a
  topic through agentd.
- agentd `POST /v1/conversations/:id/close` emits Pi's normal
  `session_shutdown`, allowing stateful-memory to save using the canonical Pi
  session path/origin.
- Explicit checkpoint save without closing is intentionally not implemented yet;
  agentd returns 501 for `/v1/conversations/:id/memory/save` until Pi exposes a
  safe public hook for that behavior.

## Current caveats

- The forum container currently runs as root in `compose.forum.yaml` because the
  host bind-mounted `~/.pi/forum` directory is owned by the host `monika` user
  and the image's `codex` user cannot write it. This is acceptable for the
  experiment but should be cleaned up before production exposure.
- The forum Docker runtime currently installs dev dependencies because the server
  starts with `tsx src/server.ts`, and workspace packages export `src/index.ts`.
  A production cleanup should compile runnable JS or change package exports.
- Model selection and reasoning/thinking settings are now mapped onto Pi
  `setModel()` / `setThinkingLevel()` behavior using Pi model IDs directly.
- A first-pass context meter is implemented in the reply UI. It shows the best
  Pi-provided usage value and warns when that value is not exact current context.
- Forum-native handoff is implemented and has been tested in browser, including parent backlinks for new handoff topics.
- Historical parent lineage can only be reconstructed where Pi JSONL already had a `parentSession` header; older exact lineage kinds cannot be inferred retroactively.

## Design decisions

- Pi JSONL sessions remain canonical for agent conversation state.
- Forum SQLite is a projection/metadata layer.
- One forum topic should map to one Pi session.
- Historical import and ongoing sync should include all sessions, but curated cwd
  mappings should route sessions into project forums with a General fallback.
- Fork/delegate/sleep sessions route to system forums.
- New handoff/delegate/sleep code should write Pi-native lineage metadata as `customType: "monika.lineage"`; forum DB lineage columns are only projections of canonical Pi state.
- Forum must not embed Pi and must not talk to memstore directly.

## Attachments and agent artifacts

The forum/agentd attachment model deliberately avoids using Pi JSONL as a raw blob store.
Pi JSONL is canonical for conversation state and for attachment manifests/provenance; forum
upload storage remains the blob store.

Inbound user uploads:

1. Browser uploads still enter through the forum attachment routes.
2. Forum stores the blob in upload storage and records attachment metadata plus optional
   SHA-256 in SQLite.
3. When dispatching the post to agentd, forum sends attachment descriptors to agentd in
   addition to the normal forum text envelope.
4. agentd validates paths against configured allowed upload roots, records
   `customType: "monika.forum.attachment"` in Pi JSONL, and presents content by policy:
   - small supported images as Pi image input when the active model supports images;
   - small UTF-8 text-like files as bounded `[attachment ...]...[/attachment]` quoted
     content blocks;
   - large/binary/unsupported files as metadata-only blocks.

Outbound agent artifacts currently use a transitional marker flow. A robot response may
include a standalone line like:

```text
[artifact path="/home/monika/out.zip" filename="out.zip" mime="application/zip"]
```

The bridge strips that marker from the persisted forum post, resolves the file either from
forum-visible local filesystem or through agentd `POST /v1/artifacts/resolve`, copies it
into normal forum upload storage, and creates a regular attachment row on the robot post.
The resolver is allowlist- and size-limited. Pi sync strips artifact markers before
assistant-message reconciliation so raw marker text is not imported as a duplicate post.

This marker flow is a bridge, not the desired final UX. The planned next step is a
Pi/forum tool-first flow: Monika calls a tool to upload a local artifact into forum storage
before final response, receives a stable `[forum-attachment id="..."]` reference, and
includes that reference as a standalone line in the final post. The forum then links the
already-uploaded pending attachment to the post.

### Tool-first outbound uploads

The preferred outbound artifact flow is now implemented in source but needs rebuild/recreate
before live testing:

1. Monika calls the Pi extension tool `forum_upload_attachment(path, filename?, mimeType?)`.
2. The tool reads `.codex-forum/requester.json` to identify the current topic.
3. The tool uploads the file to `POST /api/agent/topics/:topicId/pending-attachments`.
4. The forum stores the blob as a pending attachment with SHA-256 and TTL, returning a
   stable `[forum-attachment id="..."]` reference.
5. Monika includes that reference as a standalone line in the final reply.
6. The bridge strips the reference line outside code fences and links the pending attachment
   to the robot post as a normal forum attachment.

This avoids final-answer path scraping for the normal path. The older `[artifact ...]`
path-marker bridge remains as fallback and is now parsed only as standalone lines outside
Markdown code fences.
