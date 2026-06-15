# Monika forum frontend

Monika includes a forum frontend for Monika/Pi sessions while keeping all agent execution inside the Monika runtime container.

## Architecture

The forum must **not** embed Pi or talk to memstore directly. The separation is:

- `monika` container: Pi SDK/runtime, extensions, stateful-memory, memstore,
  and `agentd`.
- `monika-forum` container: forum UI/API and forum metadata database only.
- `agentd`: a small HTTP/SSE service inside the Monika container exposing an
  ECHS-compatible subset that the existing codex-forum bridge consumes.

Pi JSONL sessions remain canonical for agent conversation state. Forum SQLite is
a projection/metadata layer: topics/posts, identities, uploads, mapping tables,
reactions, sync state, and UI metadata.

## Provenance

The forum service lives at `services/forum`. It was imported from the archived
Monika-specific forum repository after PR https://github.com/irrigationreal/monika-forum/pull/1,
merge commit `bba058013b1a59d295373f949f4d4f25100e174b`.

That repository repurposed the Irrigate Collective Codex Forum project as the
Monika frontend. Upstream project: https://github.com/irrigationreal/codex-forum

Future development should happen in this repository. The old `monika-forum`
repository is retained as historical provenance.

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
- Default listen address: `127.0.0.1:7724`.
- Host-mode agent dir: `/home/monika/.pi/agent` via `PI_CODING_AGENT_DIR`.

Implemented endpoints:

- `GET /healthz`
- `GET /v1/models`
- `GET /v1/pi/sessions`
  - lists Pi JSONL sessions
  - includes `mtime_ms` and `size_bytes` for cheap sync detection
  - includes `parent_session_path` / `parent_session_id` when the Pi JSONL header has `parentSession`
- `GET /v1/pi/sessions/:id/export`
  - returns parsed entries for one canonical Pi JSONL session
  - includes assistant provider/model, thinking text, and tool metadata when present
- `GET /v1/pi/sessions/:id/context`
  - returns best Pi-derived session context usage/model metadata for a canonical JSONL session
- `POST /v1/conversations`
  - creates a new Pi session/runtime
  - accepts `parent_pi_session_id` / `parent_pi_session_path`, writes Pi's native `parentSession` header, and appends a `monika.lineage` custom JSONL entry when lineage metadata is supplied
- `POST /v1/conversations/open`
  - opens an existing Pi session by `pi_session_id` or `pi_session_path`
  - returns the existing live conversation if already loaded
- `GET /v1/conversations/:id`
- `GET /v1/conversations/:id/history`
- `GET /v1/conversations/:id/context`
  - returns live runtime context/model metadata from Pi
- `GET /v1/conversations/:id/events`
- `POST /v1/conversations/:id/messages`
- `POST /v1/conversations/:id/interrupt`
- `POST /v1/conversations/:id/close`
  - disposes the live runtime and emits Pi `session_shutdown`
  - stateful-memory saves using canonical Pi session path/origin
- `POST /v1/conversations/:id/handoff/draft`
  - generates a disposable handoff prompt from the canonical Pi session branch using the same `getBranch()` / `convertToLlm()` / `serializeConversation()` pattern as the Pi TUI handoff extension
  - does not create a new Pi session, forum topic, or lineage row until the forum confirms the handoff
- `POST /v1/conversations/:id/memory/save`
  - currently returns 501; explicit checkpoint save without closing is not
    implemented until Pi exposes a safe public hook
- `POST /v1/conversations/:id/pause` and `/resume` as no-op compatibility

Conversation records include `session_id` and `session_path`. Forum-supplied model/reasoning options are mapped to Pi `setModel()` / `setThinkingLevel()` using Pi model IDs directly (for example `codex/gpt-5.5`). The event stream
maps Pi SDK events into ECHS-like events consumed by the forum bridge:
`turn_started`, `turn_delta`, `reasoning_delta`, `item_started`,
`tool_completed`, `item_completed`, `turn_usage`, `turn_completed`,
`turn_interrupted`, and `turn_error`.

## Forum integration state

The live forum DB is `/home/monika/.pi/forum/data.db`; uploads are under
`/home/monika/.pi/forum/uploads`.

Implemented in `services/forum`:

- `pi_import_runs`, `pi_session_links`, and `pi_message_links` tables.
- CLI historical importer:

  ```bash
  cd ~/repos/monika/services/forum
  corepack pnpm import:pi-sessions -- \
    --agentd http://127.0.0.1:7724 \
    --db /home/monika/.pi/forum/data.db
  ```

- Live historical import completed from a clean DB, followed by sync, classification cleanup, handoff testing, and parent-lineage backfill. Current snapshot after the Jun 14 handoff work:
  - 604 Pi-linked topics/sessions
  - 13,793 visible posts
  - 52,860 Pi message links
  - 66 sessions with parent lineage; 23 resolve to an imported parent forum topic
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
- Bootstrap identities are now `neon`, `Pi CLI`, `robot`, and `Director`.
- Forum-native handoff is implemented:
  - The UI exposes a two-stage inline handoff panel above Quick Reply.
  - Draft generation is disposable UI state; no Pi/forum state is created until final confirmation.
  - Final confirmation creates the destination topic, creates a parented Pi session through agentd, writes lineage metadata, posts the edited draft, and dispatches the first robot turn.
  - Destination forum, workspace override, draft-generation model/reasoning, launch model/reasoning, and editable generation prompt are exposed.
- `pi_session_links` stores `parent_pi_session_id`, `parent_pi_session_path`, `lineage_kind`, and `lineage_source`. Parent backlinks are shown when the parent session maps to an imported forum topic.
- Historical sessions with Pi JSONL `parentSession` headers were retroactively backfilled as `lineage_kind='parent'` / `lineage_source='pi-jsonl-header'`; older sessions without Pi header lineage cannot be inferred reliably.

## Pi session taxonomy configuration

The historical importer and background Pi sync use the same configurable taxonomy
classifier. The classifier decides where imported Pi sessions are filed in the
forum and what cwd should be assigned when it creates a new imported forum.

Configuration is optional. If `MONIKA_PI_SESSION_TAXONOMY_CONFIG` is unset, the
forum uses a generic standalone default: `General`, `System / ...`, and
`Monika Runtime` for `/workspace/monika` or matching home-keyword sessions.
For deployments with host-specific project paths, set:

```bash
MONIKA_PI_SESSION_TAXONOMY_CONFIG=/path/to/taxonomy.local.json
```

The config file is JSON. See:

- `docs/examples/forum-taxonomy.example.json` for generic local runtime defaults
- `docs/examples/forum-taxonomy.stanza.example.json` for a host-mode deployment template

A taxonomy config has three parts:

- `defaults`: fallback forum target and fallback cwd for unmapped sessions
- `system`: parent/targets/cwd for sleep, delegate, and fork sessions
- `rules`: cwd-prefix and home-keyword mappings to project forums

Matching is deterministic: system sessions are classified first, then cwd prefixes
are matched by longest prefix, then configured home/default cwd sessions can match
keywords in the first user message, then the default target is used.

Cwd values must be paths visible inside the Monika/agentd container, not merely
host paths. Existing forums are not mutated when the classifier finds a cwd; the
classifier cwd is only used when creating a new imported forum. This avoids
poisoning existing host-mode forums with standalone paths such as `/workspace`.
If `MONIKA_PI_SESSION_TAXONOMY_CONFIG` is set and the file is missing or invalid,
forum startup/sync should fail loudly rather than silently falling back to unsafe
defaults.

## Local deployment with `compose.local.yaml`

Local standalone mode can run the forum as an optional profile without host
networking or host-mode shell access:

```bash
cd ~/Repos/monika
mkdir -p runtime/secrets
cp docs/examples/forum.env.example runtime/secrets/forum.env
# Edit runtime/secrets/forum.env and replace the example password/token.
docker compose -f compose.local.yaml --profile forum up -d --build
```

Local defaults:

- Forum URL: `http://localhost:4310`
- Forum DB/uploads: `runtime/forum/data.db` and `runtime/forum/uploads/`
- agentd binding in the Monika container: `0.0.0.0:7724`
- Forum-to-agentd URL: `http://monika:7724`
- Default work directory: `/workspace`
- Local forum bootstrap/internal secrets: `runtime/secrets/forum.env`
- Background Pi sync: enabled by default; set `MONIKA_PI_SYNC_ENABLED=0` in
  `runtime/secrets/forum.env` only when debugging.

The example forum env sets `CODEX_FORUM_AGENT_MODEL=codex/gpt-5.5` because it is
known to work with the current Monika/Pi runtime. Change that value in
`runtime/secrets/forum.env` if your local Pi model catalog uses a different
model id.

Local mode uses the built-in generic import/sync taxonomy by default. To customize
routing, copy `docs/examples/forum-taxonomy.example.json` to an ignored runtime
path such as `runtime/forum/taxonomy.local.json`, edit it for paths visible
inside the Monika container, and set this in `runtime/secrets/forum.env`:

```bash
MONIKA_PI_SESSION_TAXONOMY_CONFIG=/forum/taxonomy.local.json
```

Do not set `MONIKA_PI_SESSION_TAXONOMY_CONFIG` until the file exists; missing or
invalid taxonomy config is treated as a startup error so deployments do not
silently fall back to unsafe cwd defaults.

Historical import attributes imported user messages to `neon`; later Pi CLI
sessions discovered by sync are attributed to `Pi CLI` unless they are recognized
as forum-originated turns and linked back to the original forum post.

Health checks inside the Docker network:

```bash
docker compose -f compose.local.yaml --profile forum exec monika curl -fsS http://forum:4310/healthz
docker compose -f compose.local.yaml --profile forum exec monika curl -fsS http://forum:4310/api/healthz
docker compose -f compose.local.yaml --profile forum exec monika curl -fsS http://forum:4310/api/models
```

## Local deployment on stanza

The live Monika container runs in host network mode. Do **not** restart it from
inside a Pi session unless the user is prepared to reconnect; restarting the
container terminates the active session.

After changing agentd/container code, test with a throwaway image or temporary
port where possible. To rebuild the live image tag:

```bash
cd ~/repos/monika
docker compose build monika
```

Then the user should recreate the live container from a host shell:

```bash
cd ~/repos/monika
docker compose up -d --force-recreate monika
curl -fsS http://127.0.0.1:7724/healthz && echo
```

Forum compose:

```bash
cd ~/repos/monika
docker compose -f compose.yaml -f compose.forum.yaml up -d --build forum
```

Current forum URL on stanza:

```text
http://127.0.0.1:4310
```

When using an SSH SOCKS proxy (`ssh -D`), browse to:

```text
http://stanza:4310
```

because `http://127.0.0.1:4310` means the browser machine's loopback unless a
local `ssh -L` tunnel is used.

Health checks:

```bash
curl -fsS http://127.0.0.1:7724/healthz && echo
curl -fsS http://127.0.0.1:4310/healthz && echo
curl -fsS http://127.0.0.1:4310/api/healthz && echo
curl -fsS http://127.0.0.1:4310/api/models | head
```

## Current caveats

- The forum container currently runs as root to avoid bind-mount permission
  issues with the host-owned `~/.pi/forum` directory. This is acceptable for the
  experiment but should be cleaned up before production exposure.
- The forum Dockerfile currently installs dev dependencies in the runtime image
  because the server starts with `tsx src/server.ts` and workspace package
  exports point at `src/index.ts`. This is fine for the experiment but should be
  cleaned up by either compiling runnable JS or changing package exports.
- Explicit checkpoint memory save without closing is not implemented. Use close
  for a safe stateful-memory save path, because close emits Pi `session_shutdown`.
- Forum model selection/thinking level is now mapped onto Pi `setModel()` /
  `setThinkingLevel()` using Pi model IDs directly.
- A context meter is available in the reply UI using the best Pi-provided usage
  data; it warns when the value is not exact current context.
- Forum-native handoff is implemented. Exact lineage kind is available for new forum handoffs and newly patched Pi extensions; older imported parented sessions are shown honestly as `parent` when only the Pi `parentSession` header exists.

## Do not lose these design decisions

- Pi JSONL sessions remain canonical for agent conversation state.
- Forum SQLite is a projection/metadata layer.
- One forum topic should map to one Pi session.
- Historical import and ongoing sync should include all sessions, but curated cwd
  mappings and system forums should prevent the main project forums from
  becoming noisy.
- Fork/delegate/sleep sessions are imported and routed to system areas. New delegate/sleep/handoff extension paths append `monika.lineage` custom JSONL entries for future imports/sync.
- Forum never talks directly to memstore and never invents memory origins.
  Memory dedupe must use canonical Pi session path/id.

## Forum attachments and artifacts (current bridge implementation)

Attachment support is implemented as a hybrid reference model rather than treating Pi
JSONL as a blob store:

- Forum uploads remain in forum-owned upload storage.
- Forum attachment rows now store optional `sha256` for verification.
- When dispatching a post to agentd, the forum sends internal attachment descriptors
  (ID, filename, MIME, size, SHA-256, storage path, URL) alongside the normal text
  envelope. Raw paths are not exposed to browser clients.
- agentd only reads attachment files from allowlisted upload roots
  (`MONIKA_AGENTD_ATTACHMENT_ALLOWED_ROOTS`, default `/home/monika/.pi/forum/uploads`).
- agentd appends `customType: "monika.forum.attachment"` entries to the canonical Pi
  JSONL session recording attachment metadata, hash, storage reference, and
  presentation mode.
- Small supported images are passed to Pi as image input when the active model supports
  images and the file is below `MONIKA_AGENTD_ATTACHMENT_IMAGE_INLINE_MAX_BYTES`
  (default 5 MiB).
- Small UTF-8 text-like files below `MONIKA_AGENTD_ATTACHMENT_TEXT_EXTRACT_MAX_BYTES`
  (default 64 KiB) are inserted into the prompt as bounded phpBB-style
  `[attachment ...]...[/attachment]` blocks. These blocks explicitly mark extracted
  attachment text as quoted content, not direct instructions.
- Larger or binary attachments are represented as metadata-only attachment blocks.

Outbound agent artifacts currently use a bridge/fallback marker:

```text
[artifact path="/home/monika/out.zip" filename="out.zip" mime="application/zip"]
```

The forum strips artifact markers from persisted robot post bodies, resolves the file
through agentd when the forum container cannot see the path directly, copies it into
normal forum upload storage, and creates a regular forum attachment row. agentd exposes
`POST /v1/artifacts/resolve` for this, constrained by `MONIKA_AGENTD_ARTIFACT_ALLOWED_ROOTS`
(default `/home/monika:/tmp`) and `MONIKA_AGENTD_ARTIFACT_EXPORT_MAX_BYTES` (default 50 MiB).
Pi session sync strips artifact markers from assistant text before reconciliation/import
so raw marker posts are not duplicated.

Known next step: replace the path-marker artifact flow with a tool-first forum upload
flow. The intended model is a Pi/forum tool such as `forum_upload_attachment(path, ...)`
that uploads an artifact into forum storage before the final answer and returns a stable
`[forum-attachment id="..."]` reference for the final post. The marker path should remain
as a fallback until the tool flow is proven.

### Tool-first forum attachment upload (implemented after bridge commit)

A first pass of the preferred tool-first outbound attachment flow is implemented in source:

- Pi extension `forum-attachments.ts` registers `forum_upload_attachment(path, filename?, mimeType?)`.
- The tool reads `.codex-forum/requester.json` for the current topic id, uploads the local
  file to the forum internal pending attachment endpoint, and returns the exact standalone
  `[forum-attachment id="..."]` reference to include in the final response.
- Forum route `POST /api/agent/topics/:topicId/pending-attachments` stores the file in
  forum upload storage as a pending attachment with SHA-256 and TTL.
- Robot post persistence consumes standalone `[forum-attachment id="..."]` lines outside
  fenced code blocks, links matching pending attachments to the post as normal attachments,
  and strips the reference line from the rendered body.
- Legacy `[artifact ...]` markers are now also consumed only as standalone lines outside
  fenced code blocks.

This code still needs container rebuild/recreate before live testing.
