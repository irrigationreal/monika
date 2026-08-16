# Standalone deployment

Monika runs as two coordinated application containers:

- `monika` owns Pi, agentd, memstore, tools, extensions, and memory lifecycle;
- `forum` owns the web UI/API and its projection database.

The tracked [`compose.yaml.example`](../compose.yaml.example) is the canonical
standalone deployment template. Copy it to ignored `compose.yaml` and keep
host-specific changes out of Git.

## Start from published images

```bash
cp compose.yaml.example compose.yaml
mkdir -p runtime
test -e runtime/persona || cp -a config/persona runtime/persona
export MONIKA_WORKSPACE="$(dirname "$(pwd -P)")"

docker compose pull
docker compose up -d
```

Run these commands from a checkout whose directory is named `monika`. The
workspace override maps its parent into the containers as `/workspace`; use an
explicit repository parent instead if the checkout lives elsewhere.

The guarded persona copy initializes the persistent mount from the tracked
defaults. Subsequent runs and image updates do not overwrite the deployment's
evolving persona.

The forum listens on host loopback port 4310 by default. Agentd uses fixed port
7724 inside the Compose network and publishes it on host loopback port 7724 for
health and deployment automation; it is not a public API. `MONIKA_AGENTD_PORT`
changes only that host-side published port in Compose. Compose waits for the
supervised Monika runtime (memstore socket plus healthy, undrained agentd) before
starting the forum, and uses the forum's minimal `/readyz` backend readiness for
the integrated container health check. Outside Compose, the image healthcheck
continues to honor `MEMSTORE_SOCKET` and an explicitly configured internal
`MONIKA_AGENTD_PORT`. Public `/healthz`
remains liveness-only. If agentd or memstore exits unexpectedly, PID 1 stops the
sibling and exits nonzero so `restart: unless-stopped` can recover the complete
runtime instead of leaving a partially alive container.

Open interactive Pi inside the runtime:

```bash
docker exec -it -w /workspace/monika monika pi
```

The default workspace mount maps `/home/monika/repos` on the host to `/workspace`
in both containers. Override it before Compose starts when needed:

```bash
MONIKA_WORKSPACE=/path/to/repos docker compose up -d
```

## Build locally

The Compose template also contains build definitions. To build both application
images from the checkout:

```bash
docker compose up -d --build
```

To build only the Monika runtime image:

```bash
docker build -f Containerfile -t monika:dev .
```

Use [`tests/compose.monika-runtime.yaml`](../tests/compose.monika-runtime.yaml)
or [`tests/smoke/monika-runtime.sh`](../tests/smoke/monika-runtime.sh) for
throwaway validation. Never mount the live memstore database into a second
container. See [`tests/README.md`](../tests/README.md).

## Persistent state

The image owns software and bundled defaults. The host owns mutable state below
the gitignored `runtime/` directory:

```text
runtime/
├── data/
│   ├── memstore/                  Transcript and observation database
│   ├── pi-agent-auth/             Writable Pi OAuth state
│   ├── pi-agent-models/           Refreshed built-in model catalog cache
│   ├── pi-agent-trust/            Interactive project-trust decisions
│   ├── pi-subagents/              Async execution lifecycle and results
│   └── pi-subagent-operator-state/ Delivery custody and operator audit ledger
├── persona/                   Evolving persona, orientation, facts, and dreams
├── pi-agent/
│   ├── sessions/              Canonical Pi JSONL sessions
│   └── skills/                Deployment-local skills
├── import/sessions/           Historical sessions for explicit import
├── forum/                     Forum SQLite database and uploads
├── agentlogs-home/            AgentLogs authentication and configuration
└── secrets/                   Provider, forum, Git, SSH, and signing state
```

The repository checkout plus its `runtime/` directory is the practical local
deployment unit. Keep these as ordinary files and directories rather than
symlinks. Backup consistency, portable recovery, and WORM archives have stricter
contracts documented in [`backups.md`](backups.md).

### Canonical and derived state

Pi JSONL sessions are canonical conversation history. Memstore contains searchable
normalized transcripts and observations. Forum SQLite contains a projection of Pi
history plus forum-native metadata. Restoring only a derived database is not a
substitute for restoring canonical sessions.

## Secrets

Compose mounts `runtime/secrets/` read-only into the Monika container. Supported
inputs include:

```text
runtime/secrets/
├── auth.json             Optional initial Pi OAuth seed
├── models.json           Optional deployment-owned model definitions
├── keybindings.json      Optional Pi keybindings
├── secrets.env           Provider and search API environment variables
├── forum.env             Forum bootstrap/auth and shared internal tokens
├── git-identity.env      Optional Git name/email overrides
├── gitconfig             Optional complete Git configuration
├── ssh/                  SSH configuration, keys, known_hosts, target descriptors
└── gnupg/                Optional GPG keyring copied into container-local storage
```

Pi OAuth credentials are mutable. At first start, `auth.json` seeds a writable copy
under `runtime/data/pi-agent-auth/`; later token refreshes update that persistent
copy rather than the read-only secret mount. Model catalog and trust state are
likewise persisted under `runtime/data/`.

Do not commit `runtime/` or store public-ingress connector credentials anywhere
inside the mounted workspace tree.

## Forum configuration

Copy the example and generate separate random values for the internal attachment
and deploy APIs:

```bash
cp docs/examples/forum.env.example runtime/secrets/forum.env
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
```

Set the resulting values as `CODEX_FORUM_INTERNAL_API_TOKEN` and
`CODEX_FORUM_DEPLOY_TOKEN`. Bootstrap identity also belongs in `forum.env`.

Compose-level settings such as `CODEX_FORUM_BASE_URL`, password/passkey policy,
WebAuthn RP values, registration mode, and default model are interpolated by
`compose.yaml`; an `env_file` cannot supply those `${...}` values. Export them in
the host shell, place them in the ignored root `.env`, or edit the ignored
`compose.yaml` before publishing the forum. The example file distinguishes the two
configuration surfaces.

Forum-specific authentication and migration procedures live in
[`services/forum/docs/DEPLOYMENT.md`](../services/forum/docs/DEPLOYMENT.md).
The cross-service projection contract lives in [`forum.md`](forum.md).

## Network boundary and public ingress

By default both administrative host surfaces bind to loopback:

```text
127.0.0.1:4310  forum liveness/readiness and local UI
127.0.0.1:7724  supervised agentd readiness and deployment control
```

Public traffic should reach only the forum through a trusted reverse proxy or the
optional outbound Cloudflare Tunnel profile. Agentd must not be exposed publicly
without gaining a separate external authentication and authorization model.

See [`public-ingress.md`](public-ingress.md) for the production tunnel boundary,
credential custody, redirects, and verification.

## Git identity, signing, and SSH

The deployment may provide either environment identity overrides or a complete
Git configuration:

```text
runtime/secrets/git-identity.env
runtime/secrets/gitconfig
runtime/secrets/gnupg/
runtime/secrets/ssh/
```

At startup, `entrypoint.sh` copies the read-only Git configuration and GPG keyring
to writable container-local paths. Git identity defaults to
`Monika <monika@neosynth.net>` unless overridden.

OpenSSH rejects unsafe key ownership and permissions. A typical root-owned secret
layout is:

```bash
sudo chown -R root:root runtime/secrets/ssh
chmod 700 runtime/secrets/ssh
find runtime/secrets/ssh -maxdepth 1 -type f ! -name known_hosts -exec chmod 600 {} +
chmod 400 runtime/secrets/ssh/known_hosts
find runtime/secrets/ssh/targets -type d -exec chmod 500 {} +
find runtime/secrets/ssh/targets -type f -name '*.json' -exec chmod 400 {} +
```

Host mode does not exist. Local tools remain container-local. Infrastructure work
uses explicit interactive relocation or an administrator-configured locked
subagent target. See [`config/extensions/SSH.md`](../config/extensions/SSH.md) for
target descriptors, path boundaries, failure semantics, and transport hardening.

## Host-side Pi launcher

[`examples/pi-host-function.sh`](examples/pi-host-function.sh) provides a shell
function that maps host project paths into the container's `/workspace` mount:

```bash
cat docs/examples/pi-host-function.sh >> ~/.bashrc.local
source ~/.bashrc.local
```

The default mapping is:

```text
~/repos              -> /workspace
~/repos/monika       -> /workspace/monika
~/repos/other-repo   -> /workspace/other-repo
anything else        -> /workspace/monika
```

Override the host root with `MONIKA_HOST_WORKSPACE` and the fallback container
path with `MONIKA_CONTAINER_DEFAULT_CWD`.

## AgentLogs

The image includes a pinned AgentLogs CLI and Pi `/upload` command. Uploads are
manual; sessions are never sent automatically.

Authenticate through the dedicated persistent home:

```bash
docker exec -it monika agentlogs-monika login <agentlogs-hostname>
docker exec -it monika agentlogs-monika status
```

For non-interactive configuration, set `AGENTLOGS_SERVER_URL` and
`AGENTLOGS_AUTH_TOKEN` in runtime-owned secrets. Inside Pi, upload the current or a
selected session with:

```text
/upload
/upload <session-id-or-path>
```

Historical Pi sessions may be imported into memstore explicitly:

```bash
docker exec monika node /workspace/monika/scripts/import-sessions.mjs
```

Use `MONIKA_IMPORT_TAGS` to override the default `historical-import` tag.

## Updating a deployment

Manual Compose recreation can terminate active Pi work. Production updates should
use the admission-aware contract: the host acquires the forum's expiring robot-work fence (which pauses/waits Pi sync
and checks durable dispatch intent), then retains agentd drain through replacement. The forum admission and agentd drain
are cancelled on completion or abort:

- [`redeployment.md`](redeployment.md) defines what must be idle and how agentd
  drain works;
- [`autodeploy.md`](autodeploy.md) documents `scripts/deploy-if-safe` and the host
  timer model;
- [`backups.md`](backups.md) defines local rollback, off-host recovery, and restore
  fencing;
- [`releases.md`](releases.md) explains `main`, nightly candidates, and stable
  coordinated images.

Do not restart the live Monika container from an active Pi session. Prepare the
change and let the operator reconnect after a safe recreation.
