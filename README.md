# Monika

Containerised runtime for Monika — pi coding agent + memstore memory system + extensions
and persona files, packaged as a single OCI image.

## Quick start

```bash
# Build
docker build -f Containerfile -t monika:dev .

# Standalone mode (isolated, no host access)
docker compose -f compose.test.yaml up -d
docker exec -it monika-test pi

# Host mode (stanza — SSH host shell, bind-mounted state)
docker compose up -d
docker exec -it monika pi
```

## Architecture

The container bundles:
- **Pi coding agent** at a pinned version (reproducible, atomic upgrades)
- **memstore** — SQLite FTS5 memory store (Go binary, runs as a background process)
- **Extensions** — stateful-memory, delegate, SSH, web-search, etc.
- **Persona files** — SOUL.md, STYLE.md, REGISTER.md, topic addenda

### Two modes

**Host mode**: Container runs attached to the host. Pi's bash tool executes commands
on the host via SSH to localhost with ControlMaster multiplexing (~11ms per command).
Read/write/edit/grep tools operate on host files through bind mounts. Memstore runs
inside the container. The `relocate` tool can switch context to other SSH targets
mid-session.

**Standalone mode**: Container runs fully isolated. Pi's tools operate on the
container's own filesystem. Memstore runs with a fresh database. No host access.
Used for testing new versions, extension changes, or running on systems without
host shell requirements.

The same image serves both modes — runtime configuration (bind mounts, env vars)
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

### Host mode — needs SSH key + host mounts

| Mount | Purpose | Required? |
|---|---|---|
| `~/.pi` | State: sessions, memories, auth, memstore DB | Yes |
| `~/` (or working dirs) | File access for read/write/edit/grep tools | Yes |
| `/persist/keys` (or `~/.ssh`) | SSH key for host-shell wrapper | Yes |
| `~/.config` | secrets.env (API keys), GPG config | Recommended |
| `~/.config/gnupg` → `/root/.gnupg` | Git commit signing inside container | Optional |

Environment variables for host mode:
| Variable | Value | Purpose |
|---|---|---|
| `HOME` | `/home/monika` | Working directory context |
| `MEMSTORE_SOCKET` | `~/.pi/memstore/memstore.sock` | Tell extensions where memstore is |
| `MONIKA_HOST_MODE` | `1` | Enables SSH host shell wrapper |
| `RELOCATE_TARGET` | `monika@127.0.0.1:/home/monika` | Auto-relocate on session start |

Host prerequisites:
- sshd running on the host
- Container's SSH key in the host user's `authorized_keys`
- `network_mode: host` in compose (for SSH + network transparency)

## Files

```
Containerfile          Multi-stage build (Go memstore + Debian slim + Node.js + pi)
entrypoint.sh          Starts memstore, detects mode, runs command
host-shell             SSH wrapper for host bash execution
compose.yaml           Host mode deployment (stanza)
compose.test.yaml      Standalone mode (isolated)
services/memstore/     memstore Go source
config/extensions/     Pi extensions (stateful-memory, delegate, ssh, etc.)
config/persona/        Persona files (SOUL, STYLE, REGISTER, topics)
config/settings.json   Pi settings with shellPath configured
config/stateful-memory.json  Memory extension config
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
