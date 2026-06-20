# Monika autodeploy runbook

Monika redeploys are intentionally boring: host automation verifies that the live checkout is current, pulls container images, asks the running apps whether stopping is safe, backs up the whole runtime capsule, and only then recreates containers. The automation does **not** infer safety from Docker state and it does **not** mutate git checkouts.

This runbook describes a host-side deployment lifecycle for standalone Monika runtimes. It is written so an operator or agent can reproduce the model from a cold start on any trusted Docker host.

## Components

| Component | Responsibility |
|---|---|
| `compose.yaml` | Local deployment file for the live Monika runtime. Copied from `compose.yaml.example` and kept out of git. |
| `scripts/deploy-if-safe` | Host-side deploy entry point. Pulls images, checks quiescence, creates backups, applies images, and prunes old artifacts. |
| agentd quiescence API | Reports whether Pi work/memstore saves are safe to stop and performs deploy drain. |
| forum deploy API | Reports whether forum robot dispatch, Pi sync, and robot state are safe to stop. Requires `CODEX_FORUM_DEPLOY_TOKEN`. |
| systemd timer | Periodically invokes `scripts/deploy-if-safe` from the host. |

The deployment source of truth for unattended updates is the container image tag, not the git checkout. The checkout still matters as the reviewed local deployment contract: compose files, deploy scripts, docs, and runtime layout live there. Autodeploy may fetch and inspect git state, but it must not pull or modify files.

A typical `main`-tracking deployment uses:

```text
ghcr.io/irrigationreal/monika:main
ghcr.io/irrigationreal/monika-forum:main
```

Git is only used to provide the local compose file, deploy script, docs, and rollback context.

## Network boundary

The forum is user-facing and binds to the configured forum port. agentd is not public. The compose template exposes agentd to the host only on loopback:

```yaml
ports:
  - "127.0.0.1:${MONIKA_AGENTD_PORT:-7724}:7724"
```

This lets host automation call:

```text
http://127.0.0.1:7724/v1/admin/quiescence
http://127.0.0.1:7724/v1/admin/drain
```

Do not bind agentd to `0.0.0.0` unless it has gained a proper external security model. For the intended host-side automation model, localhost is the trusted admin boundary; users with Docker access already have effective root-equivalent control over the runtime.

The forum itself is user-facing, so its deploy-quiescence endpoint also requires an application-level deploy token. Store the token in `runtime/secrets/forum.env` as `CODEX_FORUM_DEPLOY_TOKEN`; the forum container reads it through Compose, and the host-side systemd unit should load the same file with `EnvironmentFile=` so `scripts/deploy-if-safe` can send it. Generate it separately from `CODEX_FORUM_INTERNAL_API_TOKEN`:

```bash
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
```

## Deploy lifecycle

`scripts/deploy-if-safe` performs this sequence in normal deploy mode:

1. Fetch and inspect the live git checkout without modifying it.
2. Defer if the checkout is dirty, detached, lacks an upstream, cannot fetch, or is behind upstream.
3. Pull the configured Monika and forum images.
4. Compare the pulled image IDs with the currently running containers.
5. Exit cleanly if no image change is available.
6. Ask the forum whether it is safe to stop, authenticating with the deploy token.
7. Ask agentd whether it is safe to stop; if only idle conversations are loaded, request deploy drain.
8. Create and verify a whole-repo backup archive.
9. Recreate only the `monika` and `forum` services with Docker Compose.
10. Print `docker compose ps` for the managed services.
11. Prune old redeploy backups by retention bucket.
12. Prune old dangling Docker images conservatively.

The script exits `75` (`EX_TEMPFAIL`) when deployment should be retried later. systemd treats this as a successful deferral, not as a failed unit.

## Manual commands

Attempt a safe deploy:

```bash
cd /home/monika/repos/monika
./scripts/deploy-if-safe
```

Create a quiescence-gated backup without deploying:

```bash
cd /home/monika/repos/monika
./scripts/deploy-if-safe --backup-only
```

Override images for a manual rollback or test:

```bash
cd /home/monika/repos/monika
MONIKA_IMAGE=ghcr.io/irrigationreal/monika:sha-OLD \
MONIKA_FORUM_IMAGE=ghcr.io/irrigationreal/monika-forum:sha-OLD \
./scripts/deploy-if-safe
```

If the command exits `75`, do not force a restart. Wait for active work to finish and retry.

## Backups

Redeploy backups are complete runtime capsules: the archive contains the entire live Monika repo, including `runtime/secrets`, sessions, forum data, local compose configuration, scripts, docs, and git metadata. This makes restore simple and avoids partial-restore ambiguity.

Backups are stored under:

```text
runtime/backups/redeploy/
```

Archive format:

```text
monika-redeploy-YYYYmmddTHHMMSSZ.tar.zst
monika-redeploy-YYYYmmddTHHMMSSZ.tar.gz
```

Compression defaults to `auto`: zstd level 3 with all CPUs when `zstd` is available, otherwise gzip level 6. Override with `MONIKA_DEPLOY_BACKUP_COMPRESSION=zstd` or `MONIKA_DEPLOY_BACKUP_COMPRESSION=gzip`. zstd and gzip levels can be adjusted with `MONIKA_DEPLOY_BACKUP_ZSTD_LEVEL` and `MONIKA_DEPLOY_BACKUP_GZIP_LEVEL`.

The archive excludes:

```text
runtime/backups/
out/
```

`runtime/backups/` is excluded to prevent recursive backup growth. `out/` is generated output and not part of the runtime capsule.

Some runtime files may be root-owned inside the live checkout because they are mounted into containers as credentials. The backup step first checks whether the deploy user can read and traverse the whole runtime capsule, excluding `runtime/backups/` and `out/`. If the capsule is readable, the archive is created without privilege escalation. If unreadable paths are present and the deploy user is not root, the script runs only the archive read through non-interactive `sudo`, then returns ownership of the finished temporary archive to the deploy user.

Hosts using unattended deploys should either keep the runtime capsule readable by the deploy user or allow that user passwordless sudo for the backup read path. The deploy script is still intended to run as the runtime owner with Docker access, not as root; sudo is only a fallback for reading root-owned files during backup creation.

### Retention policy

Pruning happens only after a new backup has been created and verified. The retention buckets keep:

- the newest backup unconditionally;
- the newest two backups from the current UTC day;
- the newest one backup from the previous UTC day, or from the previous 48 hours if no previous-day backup exists;
- the newest one backup from the last seven days outside today/yesterday.

The buckets are unioned, so quiet periods may retain fewer than four archives. The newest archive is always preserved.

## Restoring from backup

Stop the timer first so it does not race the restore:

```bash
sudo systemctl stop monika-redeploy.timer
```

Restore the latest archive:

```bash
cd /home/monika/repos
mv monika monika.broken.$(date -u +%Y%m%dT%H%M%SZ)
tar -xf /path/to/monika-redeploy-YYYYmmddTHHMMSSZ.tar.zst -C /home/monika/repos
cd /home/monika/repos/monika
docker compose up -d --remove-orphans monika forum
```

Verify:

```bash
docker compose ps
curl -fsS http://127.0.0.1:4310/api/healthz
. /home/monika/repos/monika/runtime/secrets/forum.env
curl -fsS -H "authorization: Bearer $CODEX_FORUM_DEPLOY_TOKEN" \
  http://127.0.0.1:4310/api/deploy/quiescence
curl -fsS http://127.0.0.1:7724/v1/admin/quiescence
```

Re-enable the timer after the restored runtime is healthy:

```bash
sudo systemctl enable --now monika-redeploy.timer
```

## Worktree discipline

Treat the checkout referenced by `MONIKA_DEPLOY_ROOT` as live deployment state. On stanza this is `/home/monika/repos/monika`; on another host it may be a different path. Keep that checkout on the branch intentionally used for live deployment, normally `main`, and do not do feature work there. The checkout must have a configured upstream and must not be behind that upstream for autodeploy to proceed.

Use separate worktrees/directories for development, for example:

```text
/home/monika/repos/monika-worktrees/<branch>
/home/monika/repos/monika-redeploy-safety
```

Do not point the systemd timer at a development worktree. Do not make the timer run `git pull`. Source checkout changes should be deliberate and reviewed; unattended automation may fetch to inspect drift, but it should only apply image tag changes.

## Docker image pruning

After a successful deploy, the script runs:

```bash
docker image prune -f --filter "until=168h"
```

This removes old dangling image layers while avoiding the destructive behavior of `docker image prune -a`. Do not use `-a` automatically; it can remove rollback candidates and unrelated images.

## macOS / launchd notes

`deploy-if-safe` requires GNU tar for backup archives. macOS ships BSD tar as `/usr/bin/tar`, which is not compatible with the script's GNU tar invocation. Install GNU tar with Homebrew. zstd is recommended for smaller/faster backups, but the script falls back to gzip when `MONIKA_DEPLOY_BACKUP_COMPRESSION=auto` and zstd is unavailable:

```bash
brew install gnu-tar zstd
```

The script automatically uses `gtar` when `tar` is not GNU tar. You can also set an explicit path:

```bash
MONIKA_DEPLOY_TAR_BIN=/opt/homebrew/bin/gtar ./scripts/deploy-if-safe --backup-only
```

For `launchd`, make sure the job environment can find Homebrew tools and Docker/OrbStack's CLI. A wrapper should normally set a PATH similar to:

```bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
```

If the runtime capsule is readable by the deploy user, macOS launchd deploys do not need sudo for backup creation. If root-owned runtime files are present, configure passwordless sudo for the narrow backup-read path or fix host-side ownership/permissions before enabling unattended deploys.

## systemd timer model

On NixOS hosts, Nix can own the timer and service. On other Linux hosts, the same model can be implemented with ordinary systemd units. The service should run as the runtime owner with Docker access, use a `flock` lock to prevent overlapping manual/timer runs, and treat exit `75` as a successful deferral.

Operational checks:

```bash
systemctl list-timers monika-redeploy.timer
systemctl status monika-redeploy.service
journalctl -u monika-redeploy -n 100 --no-pager
```

Normal deferrals are quiet journal entries. They should not page or notify. A non-75 failure leaves the systemd unit failed for operator review.
