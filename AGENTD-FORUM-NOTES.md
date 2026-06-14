# Monika agentd + forum integration notes

This branch uses `codex-forum` as an alternate web frontend for Monika/Pi
sessions while keeping all agent execution inside the Monika runtime container.

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

## Branches

- `~/repos/monika`: `experiment/agentd-forum-backend`
- `~/repos/monika-forum`: `experiment/pi-agentd-backend`

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
- `GET /v1/pi/sessions/:id/export`
  - returns parsed entries for one canonical Pi JSONL session
- `POST /v1/conversations`
  - creates a new Pi session/runtime
- `POST /v1/conversations/open`
  - opens an existing Pi session by `pi_session_id` or `pi_session_path`
  - returns the existing live conversation if already loaded
- `GET /v1/conversations/:id`
- `GET /v1/conversations/:id/history`
- `GET /v1/conversations/:id/events`
- `POST /v1/conversations/:id/messages`
- `POST /v1/conversations/:id/interrupt`
- `POST /v1/conversations/:id/close`
  - disposes the live runtime and emits Pi `session_shutdown`
  - stateful-memory saves using canonical Pi session path/origin
- `POST /v1/conversations/:id/memory/save`
  - currently returns 501; explicit checkpoint save without closing is not
    implemented until Pi exposes a safe public hook
- `POST /v1/conversations/:id/pause` and `/resume` as no-op compatibility

Conversation records include `session_id` and `session_path`. The event stream
maps Pi SDK events into ECHS-like events consumed by the forum bridge:
`turn_started`, `turn_delta`, `reasoning_delta`, `item_started`,
`tool_completed`, `item_completed`, `turn_usage`, `turn_completed`,
`turn_interrupted`, and `turn_error`.

## Forum integration state

The live forum DB is `/home/monika/.pi/forum/data.db`; uploads are under
`/home/monika/.pi/forum/uploads`.

Implemented in monika-forum:

- `pi_import_runs`, `pi_session_links`, and `pi_message_links` tables.
- CLI historical importer:

  ```bash
  cd ~/repos/monika-forum
  corepack pnpm import:pi-sessions -- \
    --agentd http://127.0.0.1:7724 \
    --db /home/monika/.pi/forum/data.db
  ```

- Live historical import completed from a clean DB:
  - 598 sessions
  - 13,691 initial visible posts
  - 51,225 initial Pi message links
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
- Model selection/thinking level from the forum are not yet fully mapped onto Pi
  `setModel()` / `setThinkingLevel()` behavior.
- Handoff and context meter are not implemented yet.

## Do not lose these design decisions

- Pi JSONL sessions remain canonical for agent conversation state.
- Forum SQLite is a projection/metadata layer.
- One forum topic should map to one Pi session.
- Historical import and ongoing sync should include all sessions, but curated cwd
  mappings and system forums should prevent the main project forums from
  becoming noisy.
- Fork/delegate/sleep sessions are imported and routed to system areas.
- Forum never talks directly to memstore and never invents memory origins.
  Memory dedupe must use canonical Pi session path/id.
