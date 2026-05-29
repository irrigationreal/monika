# Monika

Containerised runtime for Monika — pi coding agent + memstore memory system + extensions
and persona files, packaged as a single OCI image.

## Quick start

```bash
# Build
docker build -f Containerfile -t monika:dev .

# Test mode (isolated, no host access)
docker compose -f compose.test.yaml up -d
docker exec -it monika-test pi

# Production mode (stanza — bind-mounted host, SSH host shell)
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

**Production**: Container runs with host filesystem bind-mounted. Pi's bash tool
executes commands on the host via SSH to localhost with ControlMaster multiplexing
(~11ms per command). Read/write/edit/grep tools operate on host files directly through
bind mounts. memstore runs inside the container. Full host access: nix-shell, sudo,
nixos-rebuild all work through the SSH tunnel.

**Test**: Container runs fully isolated. Pi's tools operate on the container filesystem.
memstore runs with a fresh database. No host access. Used for testing new versions,
extension changes, or persona updates before promoting to production.

The same image serves both modes — runtime configuration (bind mounts, env vars)
determines the behavior.

### Host shell mechanism

Pi's `shellPath` setting points to `/usr/local/bin/host-shell`, a wrapper script that:
- In production (`MONIKA_HOST_MODE=1`): SSHes to `monika@127.0.0.1` with ControlMaster
- In test mode: falls back to `/bin/bash` directly

The SSH tunnel is over loopback only — no network, no DNS, no TLS. sshd on the host
is `Restart=always`. ControlMaster auto-reconnects if the master process dies.

The `--ssh user@remote` pi extension works independently — it spawns its own SSH
connections via `child_process.spawn("ssh", ...)`, completely separate from the
host-shell wrapper.

## Files

```
Containerfile          Multi-stage build (Go memstore + Debian slim + Node.js + pi)
entrypoint.sh          Starts memstore, detects mode, runs command
host-shell             SSH wrapper for host bash execution
compose.yaml           Production deployment (stanza)
compose.test.yaml      Isolated test mode
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
docker compose -f compose.test.yaml up -d
docker exec -it monika-test pi   # verify it works
docker compose -f compose.test.yaml down

# Promote to production
docker tag monika:dev monika:latest
docker compose up -d
```
