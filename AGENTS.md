# Monika Runtime Repo

This repo builds Monika's runtime containers and supporting services.

## Layout

- `Containerfile`, `entrypoint.sh`, `compose.yaml` — primary Monika runtime container.
- `services/agentd/` — Pi-backed HTTP/SSE daemon used by alternate frontends.
- `services/memstore/` — SQLite FTS5 memory/observation service.
- `services/forum/` — Monika forum frontend imported from `irrigationreal/monika-forum`.
- `config/extensions/` — bundled Pi extensions.
- `config/persona/` — bundled default persona files for standalone/test mode.
- `docs/forum.md` — forum/agentd architecture notes.

## Operating rules

- Do not restart the live `monika` container from inside an active Pi session unless the user is prepared to reconnect.
- The forum is a UI/projection service only. Pi JSONL sessions remain canonical.
- Forum SQLite stores metadata/projection state; it must not talk directly to memstore or invent memory origins.
- One forum topic maps to one canonical Pi session.
- Agent execution, tools, memory lifecycle, stateful-memory, and memstore stay behind `agentd` in the Monika container.
- Keep `compose.forum.yaml` as an optional overlay; the normal Monika runtime compose flow should not require the forum.

## Forum development

Forum-specific code lives under `services/forum/`; read `services/forum/AGENTS.md` before changing it.

Use `nix-shell` for temporary tooling when needed, for example:

```bash
nix-shell -p nodejs_22 pnpm --run 'cd services/forum && pnpm test'
```

When forum tests need writable upload storage, set `CODEX_FORUM_UPLOADS_DIR` to a temp path.
