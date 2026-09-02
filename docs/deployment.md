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
runtime instead of leaving a partially alive container. When the image is invoked
with an explicit command (including runner mode), PID 1 does not `exec` away this
ownership: it forwards SIGTERM/SIGINT, preserves the foreground command status, and
gracefully terminates and waits for memstore after the command completes.

Open interactive Pi inside the runtime:

```bash
docker exec -it -w /workspace/monika monika pi
```

Ordinary Pi and agentd startup uses `PI_OFFLINE=1`. This gates Pi's automatic
startup package resolution and update checks; it does not authorize or prohibit an
explicit `pi install`. Package administration remains Pi-owned. Administrator
commands set `PI_OFFLINE=0` explicitly to record online-maintenance intent rather
than as an authorization mechanism:

```bash
docker exec -it -e PI_OFFLINE=0 monika pi install npm:package@1.2.3
docker exec -it -e PI_OFFLINE=0 -e GIT_TERMINAL_PROMPT=0 monika \
  pi install git:github.com/owner/repository@<commit>
docker exec -it -e PI_OFFLINE=0 monika pi update --extensions
docker exec -it -e PI_OFFLINE=0 monika pi remove npm:package
```

Keep Git terminal prompting disabled for package maintenance so an unexpected
credential challenge fails visibly instead of blocking Pi. Configure a reviewed
credential helper or SSH source explicitly when an administrator intends to install
a private package.

Perform package maintenance only after the forum and agentd report no active or
queued work, then recreate Monika through the normal safe deployment path. Loaded
conversations do not hot-reload package resources, so continuing before recreation
can mix old and new package code in one runtime. Never run package maintenance from
a second container against live Monika state.

Pin install sources explicitly and back up `runtime/data/pi-agent-packages/`
before package maintenance. Exact npm pins, including `pi-agent-browser`, rotate
only with `pi install npm:name@NEW_VERSION`; `pi update --extensions` does not
change an exact npm version in settings. A failed install is not written to
`settings.json`; Pi installs first and persists the package choice only after
success. To roll back package maintenance, stop the runtime and restore the whole
package-state backup (settings plus `npm/` and `git/`) together; do not mix a
settings file from one revision with install trees from another.

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
│   ├── pi-agent-packages/         Pi settings package choices plus npm/git installs
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
normalized transcripts and observations. Default no-session runner jobs retain recall
and explicit observation tools but do not automatically archive their transcript.
`RUNNER_SAVE_SESSION=true` creates canonical JSONL and waits for the exact memstore
archive job to commit before shutdown. Forum SQLite contains a projection of Pi
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

Pi package-manager state lives under `runtime/data/pi-agent-packages/` and is
linked to `/app/.pi/agent/{settings.json,npm,git}`. On every startup the runtime
atomically rebuilds settings from the image defaults while retaining only the
deployment-owned `packages` array. This intentionally discards other interactive
settings edits, matching the prior image-default behavior. First boot seeds the
reviewed `pi-agent-browser` npm package from immutable image state produced by
`pi install`; `/opt/pi-subagents` remains image-local. Bundled `extensions/`,
`agents/`, and other default resources are never moved into package persistence.

Do not commit `runtime/` or store public-ingress connector credentials anywhere
inside the mounted workspace tree.

### Web search configuration

`web_search` defaults to the sequential order `native, exa, brave, tavily`.
Set `WEB_SEARCH_PROVIDER_ORDER` in `runtime/secrets/secrets.env` to change the
deployment default, or use `/search_providers provider,provider` in Pi to store an
explicit v2 order in the current session. `/search_providers reset` returns that
session to the deployment default. Existing sessions that explicitly selected
only Brave/Tavily retain their exact legacy order.

Optional external-provider credentials are `EXA_TOKEN`,
`BRAVE_SEARCH_API_KEY` (with `BRAVE_API_KEY` retained as an alias), and
`TAVILY_API_KEY`. Exa is attempted before Brave and Tavily in the canonical
order. Each provider request is bounded and sequential; operational, auth,
quota, timeout, malformed, unavailable, and empty-result failures may fall
through, while caller cancellation stops immediately.

Native search does not depend on the conversation's active model. It discovers
advertised web-search routes from configured pool models in quality order
(Grok, Codex, Antigravity, Kimi, Z.AI, Claude). Set the optional
`WEB_SEARCH_POOL_ORIGIN` to an HTTPS origin when discovery cannot infer one from
at least two configured pool providers sharing an origin. Catalog and native
route requests remain same-origin and use credentials resolved by Pi's model
registry; the extension does not read `models.json` directly. The catalog must
be served at `GET /api/pool/models` using schema version 1 and the native route
contract documented by the pool service. `WEB_SEARCH_NATIVE_ATTEMPTS` may bound
native route attempts from 1 through 4 (default 2).

Only the successful native call's normalized token usage is attached to the tool
result. Failed attempts do not expose raw provider usage or upstream bodies.
All returned answers, titles, snippets, and source URLs are explicitly labeled
as untrusted external web-derived data.

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
and checks durable dispatch intent), then retains agentd drain through replacement. When both application images change,
the host replaces Monika alone, cancels and proves the restored drain healthy, renews Forum admission, and only then
replaces Forum; this preserves the template's healthy-agentd startup dependency without creating a circular Compose wait.
The forum admission and agentd drain are cancelled on completion or abort.

Autodeploy remains on `main` when `MONIKA_RELEASE_CHANNEL` is unset. Operators may
opt into coordinated exact-digest stable releases by setting
`MONIKA_RELEASE_CHANNEL=stable` in the host scheduler environment. A Compose `.env`
file does not configure the host script unless its value is explicitly exported.
Stable is usable only after a release publishes the versioned
`stable-manifests.json` asset; there is no fallback to an older release or rolling
`latest`.

Further contracts:

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
