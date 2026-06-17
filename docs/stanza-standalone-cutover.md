# Stanza standalone cutover

Stanza is migrating from host mode to standalone-persistent mode. In the new shape,
the `monika` container owns Pi, extensions, memstore, and `agentd`; mutable state
lives under `~/repos/monika/runtime/`. The forum stays on the existing host-facing
port `127.0.0.1:4310`.

## Backup invariant

After cutover, the practical restore unit is:

```text
~/repos/monika/
```

including the gitignored `runtime/` directory. `runtime/` must contain real files,
not symlinks. Container-internal symlinks are allowed, but the host-side backup
source should stay boring and copyable.

The cutover script also creates a timestamped cold backup under:

```text
~/repos/monika-cutover-backups/<timestamp>/
```

It copies the old `~/.pi` rather than moving or deleting it, so rollback can return
to host mode without restoring from backup unless something unexpected happens.

## Operator procedure

Run this from a Stanza host shell, not from inside an active Pi session:

```bash
cd ~/repos/monika
scripts/stanza-standalone-cutover.sh plan
scripts/stanza-standalone-cutover.sh preflight
scripts/stanza-standalone-cutover.sh --yes execute
```

`execute` performs:

1. preflight checks
2. stop old host-mode containers
3. cold backup
4. runtime copy and path migration
5. start `compose.stanza.yaml`
6. health/data verification

If anything fails before the new deployment starts, leave the terminal output intact
and inspect the phase that failed. The script logs each major command.

## Rollback

If the cutover fails or the new deployment behaves incorrectly before meaningful
new work happens, run:

```bash
cd ~/repos/monika
scripts/stanza-standalone-cutover.sh --yes rollback
```

Rollback stops `compose.stanza.yaml` and restarts the old host-mode compose files:

```bash
docker compose -f compose.yaml -f compose.forum.yaml up -d
```

Because migration copies old state into `runtime/`, rollback does not mutate the
old `~/.pi` source of truth.

## Path migration

Copied operational paths are rewritten from host mode to standalone mode:

```text
/home/monika/.pi/agent/sessions -> /app/.pi/agent/sessions
/home/monika/.pi                -> /app/.pi
/home/monika/repos              -> /workspace
/persist/...                    -> /workspace/monika
```

The script rewrites forum `pi_session_links`, forum cwd fields, memstore entry
origins, memstore `origin-map.json`, recent-session indexes, and Pi session JSONL
headers (`cwd` / `parentSession`). It does not rewrite semantic memory body text.

## Manual host access

Standalone mode does not auto-relocate to the host. For host or infrastructure work,
use the SSH extension manually after cutover, for example:

```text
relocate stanza:/home/monika
```

The cutover script writes `runtime/secrets/ssh/config` with a `stanza` host entry
using Docker's `host.docker.internal` gateway.
