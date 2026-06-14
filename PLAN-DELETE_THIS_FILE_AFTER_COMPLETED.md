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

## Completed so far

- Added `services/agentd` to the Monika repo.
- Built agentd into the Monika container and start it from `entrypoint.sh` after
  memstore.
- agentd exposes an ECHS-compatible HTTP/SSE subset backed by Pi SDK sessions.
- Added `compose.forum.yaml` in the Monika repo to run the forum separately while
  pointing it at `http://127.0.0.1:7724`.
- Updated monika-forum runtime config to accept `MONIKA_AGENTD_BASE_URL` while
  keeping `CODEX_FORUM_ECHS_BASE_URL` as a compatibility alias.
- Added monika-forum docs at `docs/MONIKA_AGENTD.md`.
- Fixed forum Docker runtime enough for the experiment: runtime has needed deps,
  workspace source files, Vue static serving, and SPA fallback.
- Verified live deployment on stanza:
  - `agentd`: `http://127.0.0.1:7724/healthz`
  - forum: `http://127.0.0.1:4310/healthz`
  - browser via SOCKS: `http://stanza:4310`
- Verified forum -> agentd -> Pi -> forum smoke test with reply `agentd-ok`.

## Next major tasks

### 1. Historical Pi session import

Implement idempotent import of existing Pi sessions into forum topics.

Requirements:

- scan `~/.pi/agent/sessions/**/*.jsonl`
- parse session headers (`type=session`, `id`, `cwd`, `timestamp`)
- parse message entries into forum posts
- map Pi session file/session id to forum topic id
- map Pi message ids to forum post ids
- rerunning import must not duplicate topics/posts
- imported assistant posts should use robot identity
- historical user posts should be attributed to Neon
- new sessions discovered from Pi CLI should be attributed to `Pi CLI` unless
  better metadata exists

Likely add forum DB tables or system settings for:

- `pi_session_links`
- `pi_message_links`
- import state/checkpoints

### 2. Workspace/forum mapping

Add curated cwd-prefix mappings with longest-prefix-wins behavior.

Initial suggested project forums:

- The Zeta Directive: `/home/monika/repos/TheZetaDirective`
- Monika Runtime: `/home/monika/repos/monika`, `/home/monika/.pi`
- Shadowsea: `/persist/shadowsea`
- Vesper: `/home/monika/repos/vesper`
- OpenStarbound: `/home/monika/repos/OpenStarbound`
- neosynth-arise: `/home/monika/repos/neosynth-arise`
- General: fallback

Add system forums:

- System / Forks
- System / Delegates
- System / Sleep

Eventually add UI to edit mappings and reclassify existing imported sessions.

### 3. Fork/delegate/sleep classification

During import classify sessions:

- path under `sessions/forks/` => fork
- first user message contains `FOCUSED TASK MODE` => delegate
- sleep-cycle prompts/output => sleep
- otherwise normal

Route fork/delegate/sleep sessions to system forums and preserve parent/child
links where possible.

### 4. Identity/bootstrap cleanup

Current seeded human identity is `pp`; replace with proper local identities:

- Neon: historical imported user posts and forum user
- Pi CLI: new CLI-created user messages
- robot/Monika: assistant posts

Remove or replace the manual smoke-test API key. Add a proper local bootstrap or
admin/dev auth flow before any durable deployment.

### 5. agentd improvements

Current agentd is minimal. Needed improvements:

- open/resume an existing Pi session by file/path
- create forum-visible session records for sessions created outside forum
- expose richer model metadata from Pi models.json/model registry:
  context window, max tokens, input modalities, reasoning support
- map forum model selection to Pi `setModel()`
- map forum reasoning/thinking selection to Pi `setThinkingLevel()`
- support follow-up mode explicitly, not just queue/steer-ish behavior
- expose command catalog eventually, probably via a Pi extension using
  `pi.getCommands()`
- expose context usage estimate/current model context window
- add endpoints for memory save and forum-native handoff

### 6. Forum-native handoff

Do not rely on `/handoff` directly from the forum; current `/handoff` is
TUI-interactive. Implement a forum-native equivalent:

1. user clicks Handoff on a topic
2. user enters goal
3. agentd serializes current session branch and asks the model to generate a
   focused handoff prompt
4. forum shows editable draft
5. forum creates a linked new topic/Pi session
6. user submits edited prompt

This preserves Neon's workflow: no compaction; handoff instead.

### 7. Context meter

Add per-topic/session context visibility:

- current model
- context window size
- estimated or actual context usage
- warning thresholds, e.g. 60/80/90 percent
- suggested handoff action when high

Use actual usage from Pi JSONL entries when available, otherwise estimate from
branch transcript size.

### 8. Memory lifecycle

Verify forum-created Pi sessions bind Pi extensions and get stateful-memory
behavior:

- memory enrichment on first prompt/resumed prompt
- persona/facts/wake/observations injection
- topic addenda selection

Add explicit forum actions/endpoints:

- Save to memory now
- Close session
- maybe idle autosave later

Repeated memstore saves should use session path as origin so dedup/replacement
works as it does today.

### 9. Production-ish cleanup

Before exposing beyond local tunnel/Tailscale-only testing:

- run forum container as non-root with sane ownership or use a named volume
- remove manual API key
- configure auth/admin account or confirm Tailscale-only trust boundary
- decide route: probably `https://stanza.tawny-stork.ts.net/forum`
- update CORS/base URL/router base if serving under a subpath
- consider NixOS/Tailscale Serve config in `/persist/shadowsea`
- improve Dockerfile so runtime does not need dev dependencies/tsx

## Useful commands

Health:

```bash
curl -fsS http://127.0.0.1:7724/healthz && echo
curl -fsS http://127.0.0.1:4310/healthz && echo
curl -fsS http://127.0.0.1:4310/api/healthz && echo
```

Run forum locally on stanza:

```bash
cd ~/repos/monika
docker compose -f compose.yaml -f compose.forum.yaml up -d --build forum
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
