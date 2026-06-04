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

## Files

```
Containerfile          Multi-stage build (Go memstore + Debian slim + Node.js + pi)
entrypoint.sh          Starts memstore, detects mode, runs command
host-shell             SSH wrapper for host bash execution
scripts/agentlogs-monika  AgentLogs wrapper with dedicated writable HOME
compose.yaml           Host mode deployment (stanza)
compose.test.yaml      Standalone mode (isolated)
compose.local.yaml     Standalone mode with runtime persistence
services/memstore/     memstore Go source
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

For macOS/OrbStack, the default workspace mount is `${HOME}/Repos:/workspace`. Override
it with `MONIKA_WORKSPACE=/path/to/workspace` if needed.

Secrets are not committed. Place them under `runtime/secrets/`:

```text
runtime/secrets/auth.json        # optional Pi auth
runtime/secrets/models.json      # optional model definitions
runtime/secrets/secrets.env      # optional provider/API env vars
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
docker compose -f compose.test.yaml up -d
docker exec -it monika-test pi   # verify it works
docker compose -f compose.test.yaml down

# Promote to host mode (from HOST shell, never inside pi)
docker compose up -d
```
