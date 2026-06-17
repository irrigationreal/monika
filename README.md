# Monika

Containerised runtime for Monika — Pi coding agent, memstore memory system,
agentd, bundled extensions, persona defaults, and the forum frontend packaged as
OCI images with explicit persistent runtime state.

## Quick start

```bash
# Build the runtime image.
docker build -f Containerfile -t monika:dev .

# Create a local deployment file and start the standalone runtime + forum.
cp compose.yaml.example compose.yaml
docker compose up -d --build

# Open Pi inside the container.
docker exec -it -w /workspace/monika monika pi
```

For test-only isolated startup, use the compose file under `tests/`:

```bash
docker compose -f tests/compose.monika-runtime.yaml up -d
docker exec -it monika-test pi
```

## Architecture

The Monika runtime is container-owned. The image owns:

- **Pi coding agent** at a pinned version
- **memstore** — SQLite FTS5 memory store
- **agentd** — HTTP/SSE bridge used by alternate frontends
- **Extensions** — stateful-memory, delegate, SSH/relocate, web-search, AgentLogs upload, etc.
- **AgentLogs CLI** — manual sharing of selected Pi sessions
- **Persona defaults** — SOUL.md, STYLE.md, REGISTER.md, topic addenda

The host owns only explicit mutable state under gitignored `runtime/`:

```text
runtime/
  data/                memstore database state; socket stays container-local at /tmp/memstore.sock
    pi-agent-auth/     writable Pi OAuth auth state, seeded from runtime/secrets/auth.json
  persona/             mounted to /app/.pi/stateful-memory
  pi-agent/sessions/   persistent Pi JSONL sessions for resume/reopen
  pi-agent/skills/     local skills, if any
  import/sessions/     historical Pi JSONL sessions for one-time memstore import
  forum/               forum SQLite projection DB and uploads
  agentlogs-home/      AgentLogs auth/config state for manual session uploads
  secrets/
    auth.json          optional initial Pi auth seed; copied once into /data/pi-agent-auth
    models.json        optional model definitions
    keybindings.json   optional Pi keybindings
    secrets.env        optional provider/API env vars sourced at startup
    forum.env          optional forum bootstrap/auth settings
    git-identity.env   optional git identity (GIT_USER_NAME/GIT_USER_EMAIL)
    gitconfig          optional full git config, including signing settings
    ssh/               optional SSH config/keys for git and manual relocate
    gnupg/             optional GPG keyring copied to /tmp/gnupg for gpg-agent
```

`runtime/` is intentionally ignored by git and excluded from Docker build context.
For this deployment model, the practical backup unit is the repository checkout plus
its gitignored `runtime/` directory. Keep `runtime/` as real files/directories, not
symlinks.

Pi JSONL sessions remain canonical. Forum SQLite is a projection/metadata store;
agent execution, memory lifecycle, tools, and memstore stay behind `agentd` in the
Monika container.

## Deployment compose

The tracked deployment template is:

```text
compose.yaml.example
```

Copy it to the ignored local deployment file:

```bash
cp compose.yaml.example compose.yaml
```

Common local settings can be overridden with environment variables before running
Docker Compose:

```bash
MONIKA_WORKSPACE=/home/monika/repos \
CODEX_FORUM_BASE_URL=http://monika.shadowsea.org:4310 \
docker compose up -d --build
```

The default workspace mount is `/home/monika/repos:/workspace`. Inside the
container, project paths should use `/workspace/...`.

The forum is part of the main compose deployment and listens on port 4310 by
default. It talks to `agentd` at `http://monika:7724` on the Docker network.

## Git, SSH, and signing state

Standalone mode keeps git credentials and signing material in runtime-owned
secrets instead of bind-mounting the host home directory. The deployment supports:

```text
runtime/secrets/gitconfig   # full git config; may include commit.gpgsign and signingkey
runtime/secrets/gnupg/      # GPG keyring copied to /tmp/gnupg at startup
runtime/secrets/ssh/        # SSH config/keys mounted for git and explicit relocate
```

At startup, `entrypoint.sh` copies `runtime/secrets/gitconfig` to writable
container-local `$HOME/.gitconfig` and exports `GIT_CONFIG_GLOBAL` so git can use signing
configuration while still allowing environment-provided identity overrides.

OpenSSH is strict about ownership of user config and key files. If SSH inside the
container reports bad owner/permissions, fix the host-side runtime secret files,
for example:

```bash
sudo chown -R root:root runtime/secrets/ssh
chmod 700 runtime/secrets/ssh
chmod 600 runtime/secrets/ssh/*
```

## Host-side Pi launcher

For convenient host shell usage, source the example launcher:

```bash
cat docs/examples/pi-host-function.sh >> ~/.bashrc.local
source ~/.bashrc.local
```

The `pi()` function maps host project paths under `~/repos` into the container's
`/workspace` mount so sessions open in the matching project directory:

```text
~/repos              -> /workspace
~/repos/monika       -> /workspace/monika
~/repos/other-repo   -> /workspace/other-repo
anything else        -> /workspace/monika
```

Override the host workspace root with `MONIKA_HOST_WORKSPACE` and the fallback
container cwd with `MONIKA_CONTAINER_DEFAULT_CWD`.

## Manual host or remote access

Host mode has been removed. Pi tools operate inside the container by default.
When host or infrastructure work is needed, use the SSH extension/`relocate`
explicitly, for example:

```text
relocate stanza:/home/monika
```

This keeps host access visible and reversible instead of making every shell command
implicitly execute on the host.

## Runner mode

The same Monika image can run short-lived, non-interactive jobs through
`/app/bin/agent-runner.mjs` or the local `scripts/agent-runner` Docker wrapper.
Runner mode is for disposable tasks, not the long-lived forum/Pi deployment. It
mounts task input at `/task`, a workspace at `/workspace`, scratch space at
`/scratch`, and durable outputs at `/outputs`.

Runner mode keeps the useful Monika/Pi runtime available by default, but disables
Pi session persistence and `agentd` unless explicitly requested. It supports
controls such as `--no-tools`, `--tools`, `--timeout`, and `--system`.

See `runner/README.md` for the full contract and examples.

## GitHub Actions

The repo uses separate pull-request CI gates so branch protection can fail or skip
checks by subsystem. These workflows intentionally avoid branch `push` triggers to
prevent duplicate runs; `pull_request`, `merge_group`, and manual dispatch provide
fresh checks for PRs and merge queue candidates.

- `CI / Monika Container` builds the Monika image and runs `tests/smoke/monika-runtime.sh`.
- `CI / Forum Container` builds the forum image when forum-relevant files change.
- `CI / Integration` is currently a placeholder gate for future agentd/forum compatibility checks.

Publishing workflows are intentionally separate from CI gates:

- `Image / Monika` publishes multi-arch `ghcr.io/irrigationreal/monika:main` and `sha-*`.
- `Image / Forum` publishes multi-arch `ghcr.io/irrigationreal/monika-forum:main` and `sha-*`.
- `Release / Nightly` publishes rolling nightly images.
- `Release / Stable` promotes existing `sha-*` images to date-style release tags and `latest`.

## Files

```text
Containerfile             Multi-stage build: Go memstore + Debian slim + Node.js + Pi
entrypoint.sh             Starts memstore/agentd and wires runtime state
bin/agent-runner.mjs      Headless one-off Pi runner entrypoint
scripts/agent-runner      Local Docker wrapper for disposable runner jobs
scripts/agentlogs-monika  AgentLogs wrapper with dedicated writable HOME
scripts/deploy-if-safe   Quiescence-gated Docker Compose redeploy helper
scripts/import-sessions.mjs  Historical session import helper
runner/                   Runner docs, prompts, and example job specs
tests/                    Local/CI smoke and integration test harnesses
tests/compose.monika-runtime.yaml  Test-only isolated compose file
compose.yaml.example      Canonical standalone deployment template
compose.yaml              Ignored local deployment file copied from the example
services/memstore/        memstore Go source
services/agentd/          Pi-backed HTTP/SSE daemon for alternate frontends
services/forum/           Monika forum frontend
docs/forum.md             Forum/agentd architecture notes
docs/redeployment.md      Quiescence/drain redeployment contract
config/extensions/        Pi extensions copied into the image
config/persona/           Bundled default persona files
config/settings.json      Pi settings
config/stateful-memory.json  Memory extension config
runtime/                  Gitignored host-owned persistent state
```

## AgentLogs manual session sharing

The image includes a pinned AgentLogs CLI and a Pi `/upload` command. Sessions are
not uploaded automatically. Run `/upload` inside Pi when a session is ready to share.

AgentLogs auth/config is stored in a dedicated writable home at `/agentlogs-home`
(`runtime/agentlogs-home/` in the compose deployment), not in Monika's normal
`~/.config` mount. The wrapper also exposes Pi's real session directory under that
home, so AgentLogs can resolve session IDs.

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

## Upgrading Pi

Change the version in the `Containerfile`:

```dockerfile
RUN npm install -g @earendil-works/pi-coding-agent@X.Y.Z
```

Build and test:

```bash
docker build -f Containerfile -t monika-test .
tests/smoke/monika-runtime.sh monika-test
```

Then rebuild/recreate the deployment from a host shell when ready:

```bash
docker compose up -d --build
```
