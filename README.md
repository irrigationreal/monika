# Monika

Containerised runtime for Monika — pi coding agent + memstore memory system + extensions
and persona files, packaged as a single OCI image.

## Quick start

```bash
# Build
docker build -f Containerfile -t monika:dev .

# Standalone mode (isolated, no host access, ephemeral Docker volume)
docker compose -f compose.test.yaml up -d
docker exec -it monika-test pi

# Standalone mode with runtime persistence (container-only, explicit mounts, no host shell)
docker compose -f compose.local.yaml up -d --build
docker exec -it monika pi

# Host mode (stanza — SSH host shell, bind-mounted state)
docker compose up -d
docker exec -it monika pi
```

## Architecture

The container bundles:
- **Pi coding agent** at a pinned version (reproducible, atomic upgrades)
- **memstore** — SQLite FTS5 memory store (Go binary, runs as a background process)
- **Extensions** — stateful-memory, delegate, SSH, web-search, AgentLogs upload, etc.
- **AgentLogs CLI** — manual sharing of selected Pi sessions
- **Persona files** — SOUL.md, STYLE.md, REGISTER.md, topic addenda

Optional runtime shapes:
- **Forum frontend** — `services/forum`, run through the `compose.local.yaml` `forum` profile or `compose.forum.yaml`, talks to Monika through `agentd` while keeping Pi JSONL as canonical state
- **Agent runner** — `runner/` and `scripts/agent-runner` provide disposable one-off Pi jobs using the same Monika image with explicit task/workspace/output mounts

### Modes

**Host mode**: Container runs attached to the host. Pi's bash tool executes commands
on the host via SSH to localhost with ControlMaster multiplexing (~11ms per command).
Read/write/edit/grep tools operate on host files through bind mounts. Memstore runs
inside the container. The `relocate` tool can switch context to other SSH targets
mid-session.

**Standalone mode**: Container runs fully isolated. Pi's tools operate on the
container's own filesystem. Memstore runs with a fresh database. No host access.
Used for testing new versions, extension changes, or running on systems without
host shell requirements.

Standalone can also be run with explicit persistence using `compose.local.yaml`.
This keeps the same security model — no host shell, no host network, no auto-relocate
into the host — but mounts selected host-owned state from `runtime/`: persona files,
memstore data, Pi session logs, import sessions, AgentLogs auth/config, secrets, and
an explicit workspace. Manual `relocate` via the SSH extension remains available when
keys/config permit it.

The same image serves these configurations — runtime configuration (bind mounts, env vars)
determines the behavior.

**Runner mode**: The image can also run short-lived non-interactive jobs through
`/app/bin/agent-runner.mjs` or the local `scripts/agent-runner` Docker wrapper. Runner
mode mounts task input at `/task`, a workspace at `/workspace`, disposable scratch at
`/scratch`, and durable results at `/outputs`. It preserves the useful Monika/Pi runtime
by default, disables Pi session persistence and `agentd` for disposable execution, and
adds explicit controls such as `--no-tools`, `--tools`, `--timeout`, and `--system`.
See `runner/README.md` for the full contract.

### Host shell mechanism

Pi's `shellPath` setting points to `/usr/local/bin/host-shell`, a wrapper script that:
- In host mode (`MONIKA_HOST_MODE=1`): SSHes to `monika@127.0.0.1` with ControlMaster
- In standalone mode: falls back to `/bin/bash` directly

The SSH tunnel is over loopback only — no network, no DNS, no TLS. sshd on the host
is `Restart=always`. ControlMaster auto-reconnects if the master process dies.

The `--ssh user@remote` pi extension works independently — it spawns its own SSH
connections via `child_process.spawn("ssh", ...)`, completely separate from the
host-shell wrapper. The `relocate` tool switches context mid-session.

## Minimal requirements

### Standalone mode — just needs LLM credentials

Everything else (pi, memstore, extensions, persona) is bundled in the image.

```bash
# Option A: Pool config URL (downloads models.json at startup)
docker run -e POOL_CONFIG_URL=https://your-pool/config/pi/token monika:dev

# Option B: Mount a models.json directly
docker run -v ./models.json:/app/.pi/agent/models.json:ro monika:dev

# Option C: API key env vars (provider-specific)
docker run -e ANTHROPIC_API_KEY=sk-... monika:dev
```

Add `-v mydata:/data` for persistent memstore and sessions across container restarts.

### Optional persistence with `runtime/`

Ephemeral standalone mode is still useful for smoke tests and clean-room validation.
For day-to-day local use, `compose.local.yaml` keeps the standalone security model
but adds explicit persistence through a gitignored `runtime/` directory next to the
repo.

The image should own code: pi, extensions, memstore, and bundled default persona files.
The host should own private or durable state. The `runtime/` layout standardizes that
boundary without baking local state into the image:

```text
runtime/
  data/                memstore database state; socket stays container-local at /tmp/memstore.sock
  persona/             mounted to /app/.pi/stateful-memory
  pi-agent/sessions/   mounted to /app/.pi/agent/sessions for resume/reopen
  import/sessions/     historical Pi JSONL sessions for one-time memstore import
  agentlogs-home/      AgentLogs auth/config state for manual session uploads
  secrets/
    auth.json          optional Pi auth file
    models.json        optional model definitions
    secrets.env        optional provider/API env vars sourced at startup
    git-identity.env   optional git identity (GIT_USER_NAME/GIT_USER_EMAIL)
    ssh/               optional SSH config/keys for git and manual relocate
    gnupg/             optional GPG keyring copied to /tmp/gnupg for gpg-agent
```

`runtime/` is intentionally ignored by git and excluded from Docker build context.
This keeps secrets and memories out of the image while still making the local runtime
reproducible: rebuild the image from git, keep optional state in `runtime/`.

### Host mode — needs SSH key + host mounts

| Mount | Purpose | Required? |
|---|---|---|
| `~/.pi` | State: sessions, memories, auth, memstore DB | Yes |
| `~/` (or working dirs) | File access for read/write/edit/grep tools | Yes |
| `/persist/keys` (or `~/.ssh`) | SSH key for host-shell wrapper | Yes |
| `~/.config` | secrets.env (API keys), GPG config | Recommended |
| `~/.agentlogs` → `/agentlogs-home` | AgentLogs auth/config for manual session uploads | Optional |
| `~/.config/gnupg` → `/root/.gnupg` | Git commit signing inside container | Optional |

Environment variables for host mode:
| Variable | Value | Purpose |
|---|---|---|
| `HOME` | `/home/monika` | Working directory context |
| `MEMSTORE_SOCKET` | `~/.pi/memstore/memstore.sock` | Tell extensions where memstore is |
| `MONIKA_HOST_MODE` | `1` | Enables SSH host shell wrapper |
| `RELOCATE_TARGET` | `monika@127.0.0.1:/home/monika` | Auto-relocate on session start |
| `AGENTLOGS_HOME` | `/agentlogs-home` | Dedicated writable home for AgentLogs CLI state |

Host prerequisites:
- sshd running on the host
- Container's SSH key in the host user's `authorized_keys`
- `network_mode: host` in compose (for SSH + network transparency)

## GitHub Actions

The repo uses separate pull-request CI gates so branch protection can fail or skip checks by subsystem. These workflows intentionally avoid branch `push` triggers to prevent duplicate runs; `pull_request` re-runs on every PR update via the `synchronize` event, and `merge_group` runs the same required gates for GitHub merge queue candidates:

- `CI / Monika Container` (`ci-monika-container.yml`) uses `monika-container-changes` → `monika-container-build` → `monika-container-checks`. It builds the Monika image and runs `tests/smoke/monika-runtime.sh` to verify standalone startup, memstore, agentd, Pi CLI, and conversation create/close. Require `monika-container-checks` in branch rules.
- `CI / Forum Container` (`ci-forum-container.yml`) uses `forum-container-changes` → `forum-container-build` → `forum-container-checks`. Require `forum-container-checks` in branch rules.
- `CI / Integration` (`ci-integration.yml`) uses `integration-changes` → `integration-placeholder` → `integration-checks`. It is a placeholder today; require `integration-checks` now so the branch rule is already in place when real agentd/forum compatibility tests are added.

Publishing workflows are intentionally separate from CI gates:

- `Image / Monika` publishes multi-arch `ghcr.io/irrigationreal/monika:main` and `sha-*` on `main` changes.
- `Image / Forum` publishes multi-arch `ghcr.io/irrigationreal/monika-forum:main` and `sha-*` on forum image changes.
- `Release / Nightly` builds rolling `:nightly` images once per day when `main` has changed, and recreates the `nightly` prerelease.
- `Release / Stable` is manual and promotes existing `sha-*` images to a date-style release tag and `latest`; it refuses to overwrite an existing release and does not rebuild artifacts.

## Files

```
Containerfile          Multi-stage build (Go memstore + Debian slim + Node.js + pi)
entrypoint.sh          Starts memstore, detects mode, runs command
host-shell             SSH wrapper for host bash execution
bin/agent-runner.mjs   Headless one-off Pi runner entrypoint
scripts/agent-runner   Local Docker wrapper for disposable runner jobs
scripts/agentlogs-monika  AgentLogs wrapper with dedicated writable HOME
tests/                Local/CI smoke and integration test harnesses
runner/                Runner docs, prompts, and example job specs
compose.yaml           Host mode deployment (stanza)
compose.test.yaml      Standalone mode (isolated)
compose.local.yaml     Standalone mode with runtime persistence and optional forum profile
compose.stanza.yaml    Stanza standalone-persistent production deployment
compose.forum.yaml     Legacy optional host-mode forum frontend overlay
services/memstore/     memstore Go source
services/agentd/       Pi-backed HTTP/SSE daemon for alternate frontends
services/forum/        Monika forum frontend
docs/forum.md          Forum/agentd architecture notes
config/extensions/     Pi extensions (stateful-memory, delegate, ssh, AgentLogs upload, etc.)
config/persona/        Persona files (SOUL, STYLE, REGISTER, topics)
config/settings.json   Pi settings with shellPath configured
config/stateful-memory.json  Memory extension config
runtime/               Gitignored host-owned state for standalone persistence
```

## Standalone mode with runtime persistence

Create/populate `runtime/` on the host, then run:

```bash
docker compose -f compose.local.yaml up -d --build
docker exec -it monika pi
```

Enable the optional local forum frontend with the `forum` profile:

```bash
mkdir -p runtime/secrets
cp docs/examples/forum.env.example runtime/secrets/forum.env
# Edit runtime/secrets/forum.env and replace the example password/token.
docker compose -f compose.local.yaml --profile forum up -d --build
```

The local forum listens on `http://localhost:4310`, stores projection state under
`runtime/forum/`, and talks to Pi through agentd in the Monika container. Local
mode uses `/workspace` as the default forum work directory; individual forums can
store more specific cwd defaults such as `/workspace/monika`.

For macOS/OrbStack, the default workspace mount is `${HOME}/Repos:/workspace`. Override
it with `MONIKA_WORKSPACE=/path/to/workspace` if needed.

Secrets are not committed. Place them under `runtime/secrets/`:

```text
runtime/secrets/auth.json        # optional Pi auth
runtime/secrets/models.json      # optional model definitions
runtime/secrets/secrets.env      # optional provider/API env vars
runtime/secrets/forum.env        # optional local forum bootstrap user + internal API token
runtime/secrets/git-identity.env # optional git identity (GIT_USER_NAME/GIT_USER_EMAIL)
runtime/secrets/ssh/             # mounted read-only to /root/.ssh and /app/.ssh
runtime/secrets/gnupg/           # copied at startup to /tmp/gnupg for gpg-agent
runtime/agentlogs-home/          # AgentLogs login/config state
```

Git identity is runtime-owned rather than hardcoded into the image. You can provide it
with environment variables, `runtime/secrets/git-identity.env`, `~/.pi/git-identity.env`,
or `~/.config/monika/git-identity.env`:

```bash
GIT_USER_NAME="Monika"
GIT_USER_EMAIL="monika@example.com"
```

## Stanza standalone cutover

Stanza should use standalone-persistent mode for production once migrated. The
container owns Pi/memstore/agentd, mutable state lives under `runtime/`, and
the forum remains exposed on the existing host-facing port. Run the cutover only
from a host shell, because stopping the current `monika` container terminates the
active Pi session:

```bash
cd ~/repos/monika
scripts/stanza-standalone-cutover.sh plan
scripts/stanza-standalone-cutover.sh preflight
scripts/stanza-standalone-cutover.sh --yes execute
```

See `docs/stanza-standalone-cutover.md` for backup, rollback, and path-migration
details. After cutover, `~/repos/monika/` including gitignored `runtime/` is the
practical restore unit; `runtime/` should contain real files, not symlinks.

## AgentLogs manual session sharing

The image includes a pinned AgentLogs CLI and a Pi `/upload` command. Sessions are
not uploaded automatically. Run `/upload` inside Pi when a session is ready to share.

AgentLogs auth/config is stored in a dedicated writable home at `/agentlogs-home`
(`runtime/agentlogs-home/` in local mode, `/home/monika/.agentlogs` in host mode),
not in Monika's normal `~/.config` mount. The wrapper also exposes Pi's real
session directory under that home, so AgentLogs can resolve session IDs.

Authenticate once from outside Pi:

```bash
docker exec -it monika agentlogs-monika login <agentlogs-hostname>
docker exec -it monika agentlogs-monika status
```

For non-interactive auth, provide runtime-owned secrets instead:

```bash
AGENTLOGS_SERVER_URL=https://your-agentlogs-host
AGENTLOGS_AUTH_TOKEN=...
```

Then work normally in Pi and run:

```text
/upload
```

You can also upload a specific Pi session file or ID:

```text
/upload <session-id-or-path>
```

Historical sessions can be imported after the container starts:

```bash
docker exec monika node /workspace/monika/scripts/import-sessions.mjs
```

By default, imported entries are tagged `historical-import`. Override tags with a
comma-separated `MONIKA_IMPORT_TAGS` value:

```bash
docker exec -e MONIKA_IMPORT_TAGS=historical-import,archive monika \
  node /workspace/monika/scripts/import-sessions.mjs
```

## Upgrading pi

Change the version in the `Containerfile`:
```dockerfile
RUN npm install -g @earendil-works/pi-coding-agent@X.Y.Z
```

Build, test, deploy:
```bash
docker build -f Containerfile -t monika:dev .

# Test in standalone mode first
docker build -f Containerfile -t monika-test .
tests/smoke/monika-runtime.sh monika-test

# Promote to host mode (from HOST shell, never inside pi)
docker compose up -d
```
