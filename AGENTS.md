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

- Your current active session is likely running out of the live `monika` container, so do not restart the live `monika` container from inside an active Pi session. Instead, you should try to make sure everything is ready for the user to restart it.
- When testing throwaway Monika containers, do **not** mount the live/in-use memstore database. Use ephemeral memstore state so two containers cannot lock or mutate the same SQLite DB.
- The forum is a UI/projection service only. Pi JSONL sessions remain canonical.
- Forum SQLite stores metadata/projection state; it must not talk directly to memstore or invent memory origins.
- One forum topic maps to one canonical Pi session.
- Agent execution, tools, memory lifecycle, stateful-memory, and memstore stay behind `agentd` in the Monika container.
- Keep `compose.forum.yaml` as an optional overlay; the normal Monika runtime compose flow should not require the forum.

## GitHub Actions / branch gates

Container CI follows a three-stage branch-protection pattern copied from Vesper:

1. `*-changes` decides whether relevant files changed.
2. `*-build` or placeholder test jobs run only when needed and may fail.
3. `*-checks` always runs and is the stable branch-rule gate.

Current CI gates:

- `monika-container-checks` from `CI / Monika Container` — builds the Monika runtime image when runtime-relevant files change.
- `forum-container-checks` from `CI / Forum Container` — builds the forum image when forum-relevant files change.
- `integration-checks` from `CI / Integration` — currently a documented placeholder that always passes/skips; grow this into agentd/forum compatibility checks.

Image publishing workflows:

- `Image / Monika` publishes multi-arch `ghcr.io/irrigationreal/monika:main` and `sha-*` from `main`.
- `Image / Forum` publishes multi-arch `ghcr.io/irrigationreal/monika-forum:main` and `sha-*` from `main`.
- `Release / Nightly` publishes rolling `:nightly` images and recreates a `nightly` prerelease when `main` changes.
- `Release / Stable` manually promotes existing `sha-*` images to a date-style release tag and `latest`; it does not rebuild artifacts.

## Container commands

Run these from the host shell. Restarting the live `monika` container kills active
Pi sessions; restart it only when the user is prepared to reconnect.

Build the Monika runtime without cache:

```bash
docker compose build --no-cache monika
```

Recreate the Monika runtime:

```bash
docker compose up -d --force-recreate monika
```

Build the forum frontend without cache:

```bash
docker compose -f compose.yaml -f compose.forum.yaml build --no-cache forum
```

Recreate the forum frontend only:

```bash
docker compose -f compose.yaml -f compose.forum.yaml up -d --force-recreate forum
```

Build/recreate the forum frontend normally:

```bash
docker compose -f compose.yaml -f compose.forum.yaml up -d --build forum
```

For throwaway Monika runtime tests, prefer standalone/test compose files or an
ephemeral volume. Do not bind-mount `/home/monika/.pi/memstore` or another live
memstore database into a second container.

## Forum development

Forum-specific code lives under `services/forum/`; read `services/forum/AGENTS.md` before changing it.

Use `nix-shell` for temporary tooling when needed, for example:

```bash
nix-shell -p nodejs_22 pnpm --run 'cd services/forum && pnpm test'
```

When forum tests need writable upload storage, set `CODEX_FORUM_UPLOADS_DIR` to a temp path.
