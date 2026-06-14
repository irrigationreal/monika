# Monika agentd + forum integration notes

This branch experiments with using `codex-forum` as an alternate web frontend
for Monika/Pi sessions while keeping all agent execution inside the Monika
runtime container.

## Architecture

The forum must **not** embed Pi or talk to memstore directly. The separation is:

- `monika` container: Pi SDK/runtime, extensions, stateful-memory, memstore,
  and `agentd`.
- `monika-forum` container: forum UI/API and forum metadata database only.
- `agentd`: a small HTTP/SSE service inside the Monika container exposing an
  ECHS-compatible subset that the existing codex-forum bridge can consume.

This keeps memstore single-owned by the Monika container and avoids a second Pi
runtime in the forum container.

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
- `POST /v1/conversations`
- `GET /v1/conversations/:id`
- `GET /v1/conversations/:id/history`
- `GET /v1/conversations/:id/events`
- `POST /v1/conversations/:id/messages`
- `POST /v1/conversations/:id/interrupt`
- `POST /v1/conversations/:id/pause` and `/resume` as no-op compatibility

The event stream maps Pi SDK events into ECHS-like events consumed by the
existing forum `EchsBridge`: `turn_started`, `turn_delta`, `reasoning_delta`,
`item_started`, `tool_completed`, `item_completed`, `turn_usage`,
`turn_completed`, `turn_interrupted`, and `turn_error`.

## Local deployment on stanza

The live Monika container runs in host network mode. Do **not** restart it from
inside a Pi session unless the user is prepared to reconnect; restarting the
container terminates the active session.

After changing agentd/container code, test with a throwaway image before asking
the user to restart the live container:

```bash
cd ~/repos/monika
docker build -f Containerfile -t monika-agentd-test:latest .
docker run -d --rm -e MONIKA_AGENTD_HOST=0.0.0.0 -e MONIKA_AGENTD_PORT=7724 -p 17724:7724 monika-agentd-test:latest
curl -fsS http://127.0.0.1:17724/healthz
```

To rebuild the live image tag:

```bash
cd ~/repos/monika
docker compose build monika
```

Then the user must recreate the live container from a host shell:

```bash
cd ~/repos/monika
docker compose up -d --force-recreate monika
curl -fsS http://127.0.0.1:7724/healthz && echo
```

## Forum local compose

`compose.forum.yaml` starts the forum as a separate container and points it at
agentd:

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
curl -fsS http://127.0.0.1:4310/healthz && echo
curl -fsS http://127.0.0.1:4310/api/healthz && echo
curl -fsS http://127.0.0.1:4310/api/models | head
```

## Current state / caveats

- Basic forum -> agentd -> Pi -> forum roundtrip works. A smoke topic received
  the exact robot reply `agentd-ok`.
- The forum DB is at `/home/monika/.pi/forum/data.db` and uploads are under
  `/home/monika/.pi/forum/uploads`.
- The forum container currently runs as root to avoid bind-mount permission
  issues with the host-owned `~/.pi/forum` directory. This is acceptable for the
  experiment but should be cleaned up before production exposure.
- The seeded human identity is still the codex-forum default `pp`; this should
  become `Neon`, and a `Pi CLI` identity should be added for imported/new CLI
  sessions.
- A manual smoke-test API key was inserted into the forum DB during testing;
  replace this with a proper bootstrap/admin/dev auth flow or delete it before
  serious use.
- The forum Dockerfile currently installs dev dependencies in the runtime image
  because the server starts with `tsx src/server.ts` and workspace package
  exports point at `src/index.ts`. This is fine for the experiment but should be
  cleaned up by either compiling runnable JS or changing package exports.

## Do not lose these design decisions

- Pi JSONL sessions remain canonical for agent conversation state.
- Forum SQLite is a projection/metadata layer: topics/posts, identity metadata,
  reactions, uploads, mapping tables, etc.
- One forum topic should map to one Pi session.
- Historical imports should include all sessions, but curated cwd mappings and
  system forums should prevent the main project forums from becoming noisy.
- Fork/delegate/sleep sessions should be imported but routed to system areas and
  linked back to parents where possible.

## Historical import implementation notes

This branch now exposes one-session-at-a-time Pi JSONL export for the forum import
CLI:

- `GET /v1/pi/sessions` lists session headers.
- `GET /v1/pi/sessions/:id/export` returns parsed entries for a single session.

The forum still does **not** read Pi files directly and still does **not** talk to
memstore. Import remains a projection from canonical Pi sessions into forum
SQLite.
