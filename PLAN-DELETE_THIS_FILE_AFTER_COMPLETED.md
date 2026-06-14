# Plan: Monika forum as Pi frontend

Delete this file after the experiment has either been completed and documented
properly, or abandoned.

## Goal

Use codex-forum as an alternate web interface for Monika/Pi sessions while
keeping Pi, extensions, session files, and memstore inside the Monika runtime
container. The forum is a UI/metadata layer, not a second agent runtime.

## Current branches

- `~/repos/monika`: `experiment/agentd-forum-backend`
- `~/repos/monika-forum`: `experiment/pi-agentd-backend`

## Current verified state on stanza

- `monika` container runs memstore + agentd.
- `agentd`: `http://127.0.0.1:7724/healthz`
- `monika-forum` container runs on port `4310`.
- Forum health: `http://127.0.0.1:4310/healthz`
- Forum API health: `http://127.0.0.1:4310/api/healthz`
- Browser via SOCKS tunnel: `http://stanza:4310`
- Forum SQLite DB: `/home/monika/.pi/forum/data.db`
- Uploads: `/home/monika/.pi/forum/uploads`

## Completed so far

### Runtime split

- Added `services/agentd` to the Monika repo.
- Built agentd into the Monika container and start it from `entrypoint.sh` after
  memstore.
- agentd exposes an ECHS-compatible HTTP/SSE subset backed by Pi SDK sessions.
- Added `compose.forum.yaml` in the Monika repo to run the forum separately while
  pointing it at `http://127.0.0.1:7724`.
- Updated monika-forum runtime config to accept `MONIKA_AGENTD_BASE_URL` while
  keeping `CODEX_FORUM_ECHS_BASE_URL` as a compatibility alias.
- Fixed forum Docker runtime enough for the experiment: runtime has needed deps,
  workspace source files, Vue static serving, and SPA fallback.
- Verified basic forum -> agentd -> Pi -> forum roundtrip.

### Historical import

- Implemented agentd Pi session archive endpoints:
  - `GET /v1/pi/sessions`
  - `GET /v1/pi/sessions/:id/export`
- Implemented forum import schema:
  - `pi_import_runs`
  - `pi_session_links`
  - `pi_message_links`
- Implemented CLI importer:
  - `corepack pnpm import:pi-sessions -- --agentd http://127.0.0.1:7724 --db /home/monika/.pi/forum/data.db`
  - supports `--reset-db`, `--dry-run`, and `--limit N`
- Live import completed into a clean DB:
  - 598 Pi sessions
  - 13,691 initial visible posts
  - 51,225 initial Pi message links
- Curated cwd routing and system routing are implemented.

### Session continuity and catch-up

- agentd supports `POST /v1/conversations/open` to load an existing canonical Pi
  JSONL session by `pi_session_id` or `pi_session_path`.
- agentd conversation records include `session_id` and `session_path`.
- forum replies in linked/imported topics continue the linked Pi session instead
  of creating a parallel session.
- forum-created Pi conversations are immediately written to `pi_session_links`.
- forum has a background sync worker enabled by default:
  - `MONIKA_PI_SYNC_ENABLED=1` by default
  - `MONIKA_PI_SYNC_INTERVAL_MS=5000` by default
- sync polls agentd list/export endpoints, detects changed sessions via
  `mtime_ms`/`size_bytes`, and imports missing messages idempotently.
- forum-originated Pi user messages containing `[FORUM TURN]` metadata are linked
  back to the originating forum post instead of duplicated.

### Memory lifecycle safety

- Forum still does **not** talk to memstore directly.
- Memory origin/dedupe remains the canonical Pi session path/id.
- agentd `POST /v1/conversations/:id/close` disposes the live runtime and emits
  Pi `session_shutdown`, allowing stateful-memory to save the canonical session.
- forum exposes `POST /topics/:topicId/robot/close` to close a live linked Pi
  session through agentd.
- Explicit checkpoint save without closing is **not implemented**: agentd returns
  501 for `/v1/conversations/:id/memory/save` because no safe public Pi hook has
  been identified yet.

### Identity/bootstrap cleanup

- Bootstrap now seeds/renames the default human identity to `neon` instead of
  `pp`.
- `Pi CLI` system identity is seeded for future Pi CLI-discovered user messages.
- The old manual smoke-test API key was removed when the forum DB was reset for
  the live historical import.

## Remaining work

1. Validate a real browser/API continuation of an imported topic end-to-end.
2. Add sync/link/session status UI and a visible close action.
3. Improve sync/projection quality: better titles, fork/delegate parent links,
   visible Pi session id/path/cwd metadata, optional dedicated sync columns.
4. Map forum model/thinking controls to Pi model/thinking behavior.
5. Implement forum-native handoff.
6. Implement a context meter.
7. Production-ish cleanup: non-root container or named volume, auth/exposure
   decision, Tailscale Serve route, CORS/base path, runtime without dev deps/tsx.

## Useful commands

Health:

```bash
curl -fsS http://127.0.0.1:7724/healthz && echo
curl -fsS http://127.0.0.1:4310/healthz && echo
curl -fsS http://127.0.0.1:4310/api/healthz && echo
```

Run/rebuild forum locally on stanza:

```bash
cd ~/repos/monika
docker compose -f compose.yaml -f compose.forum.yaml up -d --build forum
```

Historical import / recovery:

```bash
cd ~/repos/monika-forum
corepack pnpm import:pi-sessions -- \
  --agentd http://127.0.0.1:7724 \
  --db /home/monika/.pi/forum/data.db
```

Browser access through SOCKS tunnel:

```text
http://stanza:4310
```

Direct local tunnel alternative:

```bash
ssh -L 14310:127.0.0.1:4310 monika@stanza
# then open http://127.0.0.1:14310
```

Never restart the Monika container from inside an active Pi session unless the
user is prepared to reconnect.
