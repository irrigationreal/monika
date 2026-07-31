# Monika Runtime Repo

This repo builds Monika's runtime containers and supporting services.

## Layout

- `Containerfile`, `entrypoint.sh`, `compose.yaml.example` — primary standalone Monika runtime deployment template.
- `compose.yaml` — local ignored deployment file copied from `compose.yaml.example`.
- `services/agentd/` — Pi-backed HTTP/SSE daemon used by alternate frontends.
- `services/memstore/` — SQLite FTS5 memory/observation service.
- `services/forum/` — Monika forum frontend imported from `irrigationreal/monika-forum`.
- `config/extensions/` — bundled Pi extensions copied into the image; this repo is the runtime source of truth for extensions.
- `config/persona/` — bundled default persona files for standalone/test mode.
- `tests/` — locally runnable smoke and integration tests used by CI gates, including test-only compose files.
- `docs/forum.md` — forum/agentd architecture notes.

## Operating rules

- Your current active session is likely running out of the live `monika` container, so do not restart the live `monika` container from inside an active Pi session. Instead, make sure everything is ready for the user to restart it.
- Treat the live deployment checkout (on stanza: `/home/monika/repos/monika`) as deployment state, not a development worktree. Keep it on the intended live branch, normally `main`; do not do feature work there; do not point host autodeploy automation at another worktree.
- Use separate worktrees/directories for development branches. The autodeploy path must never run `git pull`; it may fetch/read git state to defer when the live checkout is dirty or behind upstream, but checkout updates remain deliberate operator actions.
- Be careful editing `compose.yaml`, `scripts/deploy-if-safe`, `runtime/`, or anything bind-mounted into live containers from the live checkout. These files can affect the active runtime even before a container restart.
- The runtime is standalone/container-owned. Do not reintroduce host mode, automatic host-shell execution, host-network deployment, or bind-mounted host `~/.pi` as canonical state.
- Host/infra work should use explicit SSH relocation, not implicit host execution.
- When testing throwaway Monika containers, do **not** mount the live/in-use memstore database. Use ephemeral memstore state so two containers cannot lock or mutate the same SQLite DB.
- The forum is a UI/projection service only. Pi JSONL sessions remain canonical.
- Forum SQLite stores metadata/projection state; it must not talk directly to memstore or invent memory origins.
- One forum topic maps to one canonical Pi session.
- Agent execution, tools, memory lifecycle, stateful-memory, and memstore stay behind `agentd` in the Monika container.

## GitHub Actions / branch gates

Container CI follows a three-stage branch-protection pattern copied from Vesper. These CI gates run on `pull_request`, `merge_group`, and manual dispatch, not branch `push`, so open PRs and merge-queue candidates get fresh checks without duplicate push/PR runs:

1. `*-changes` decides whether relevant files changed.
2. `*-build` or placeholder test jobs run only when needed and may fail.
3. `*-checks` always runs and is the stable branch-rule gate.

Current CI gates:

- `monika-container-checks` from `CI / Monika Container` — builds the Monika runtime image and runs `tests/smoke/monika-runtime.sh` when runtime-relevant files change.
- `forum-container-checks` from `CI / Forum Container` — runs forum unit/E2E tests and builds the forum image when forum-relevant files change.
- `integration-checks` from `CI / Integration` — currently a documented placeholder that always passes/skips; grow this into agentd/forum compatibility checks.

Image publishing workflows:

- `Image / Monika` publishes multi-arch `ghcr.io/irrigationreal/monika:main` and `sha-*` from `main`.
- `Image / Forum` publishes multi-arch `ghcr.io/irrigationreal/monika-forum:main` and `sha-*` from `main`.
- `Release / Nightly` builds Monika and Forum from the same commit, publishes immutable `candidate-<full-sha>` manifests, updates rolling `:nightly` images, and recreates the `nightly` prerelease when `main` changes.
- `Release / Stable` runs daily and promotes the current coordinated candidate to a release tag based on its UTC publication date and to `latest` after a seven-day soak. Manual dispatch can bypass only the timer. It promotes exact digests and does not rebuild artifacts. See `docs/releases.md`.

## Container commands

Run these from the host shell. Restarting the live `monika` container kills active
Pi sessions; restart it only when the user is prepared to reconnect.

Initial local deployment setup:

```bash
cp compose.yaml.example compose.yaml
```

Build the Monika runtime without cache:

```bash
docker compose build --no-cache monika
```

Recreate the full runtime and forum deployment:

```bash
docker compose up -d --force-recreate
```

Recreate only the forum frontend:

```bash
docker compose up -d --force-recreate forum
```

Build/recreate normally:

```bash
docker compose up -d --build
```

For throwaway Monika runtime tests, prefer `tests/smoke/monika-runtime.sh <image>`
or `tests/compose.monika-runtime.yaml` with ephemeral volumes. Do not bind-mount
`runtime/data/memstore`, `/app/.pi/memstore`, or another live memstore database
into a second container. Keep repo-level tests lean, non-flaky, and documented in
`tests/README.md`.

## Forum development

Forum-specific code lives under `services/forum/`; read `services/forum/AGENTS.md` before changing it.

Use `nix-shell` for temporary tooling when needed, for example:

```bash
nix-shell -p nodejs_22 pnpm --run 'cd services/forum && pnpm test'
```

When forum tests need writable upload storage, set `CODEX_FORUM_UPLOADS_DIR` to a temp path.
