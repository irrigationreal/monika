# Monika autodeploy runbook

Monika redeploys are intentionally boring: host automation verifies that the live checkout is current, pulls container images, asks the running apps whether stopping is safe, backs up the whole runtime capsule, and only then recreates containers. The automation does **not** infer safety from Docker state and it does **not** mutate git checkouts.

This runbook describes a host-side deployment lifecycle for standalone Monika runtimes. It is written so an operator or agent can reproduce the model from a cold start on any trusted Docker host.

## Components

| Component | Responsibility |
|---|---|
| `compose.yaml` | Local deployment file for the live Monika runtime. Copied from `compose.yaml.example` and kept out of git. |
| `scripts/deploy-if-safe` | Host-side deploy entry point. Pulls images, checks quiescence, creates backups, applies images, and prunes old artifacts. |
| agentd quiescence API | Reports whether forum turns, interactive Pi sessions, and memstore saves are safe to stop and performs deploy drain. |
| forum deploy API | Acquires/cancels an expiring deployment-admission fence after pausing/waiting Pi sync and evaluating durable robot work. Diagnostic quiescence remains available. Requires `CODEX_FORUM_DEPLOY_TOKEN`. |
| `cloudflared` (optional) | Outbound-only public forum ingress enabled with the `public-ingress` Compose profile. |
| systemd timer | Periodically invokes `scripts/deploy-if-safe` from the host. |

Subagent execution ownership and effects safety are separate. `active` and
`uncertain` runs block because ownership is live or unproven. Pending delivery is
nonblocking. Effects-unknown does not fabricate a live process, but safe deployment
also fails closed until the evidence is reconciled or an operator records an audited
effects resolution; it must never be automatically replayed or dismissed.

The deployment source of truth for unattended updates is the selected container release channel, not the git checkout. The default `main` channel follows the two container tags; the opt-in `stable` channel follows a GitHub release asset that binds the coordinated pair to exact manifest digests. The checkout still matters as the reviewed local deployment contract: compose files, deploy scripts, docs, and runtime layout live there. Autodeploy may fetch and inspect git state, but it must not pull or modify files.

The unchanged default is `main` and uses:

```text
ghcr.io/irrigationreal/monika:main
ghcr.io/irrigationreal/monika-forum:main
```

Git is only used to provide the local compose file, deploy script, docs, ancestry checks, and rollback context.

### Image channels and overrides

Set `MONIKA_RELEASE_CHANNEL=stable` in the **host scheduler's service environment** to opt into coordinated stable autodeploy. A root Compose `.env` file is read by `docker compose`, but it does not automatically export values to `scripts/deploy-if-safe`; do not rely on it for the scheduler unless the scheduler explicitly exports or loads that value. Leaving the variable unset, or setting it to `main`, preserves the existing `:main` behavior and requires no stanza migration.

Stable resolution calls the canonical GitHub latest-release API, requires a non-draft/non-prerelease release with exactly one `stable-manifests.json` asset, and validates version 1 of both its schema and deployment contract. The asset must bind the release tag and full commit to the canonical Monika and Forum repositories and exact `sha256` manifest digests. The script pulls `repository@sha256:...` references and verifies both pulled images' `org.opencontainers.image.revision` labels against the release commit. It never treats `latest`, a Git tag, or `git ls-remote` as coordinated artifact authority. Stable autodeploy becomes usable only when the first stable release carrying `stable-manifests.json` is published; older releases are intentionally not backfilled or accepted as a fallback.

Canonical GitHub API calls may use `GITHUB_TOKEN` and are bounded. `MONIKA_STABLE_RELEASE_API_URL` exists for isolated mirrors/tests, but must be HTTPS, must return same-origin asset API URLs, and requires a separate `MONIKA_STABLE_RELEASE_TOKEN`; `GITHUB_TOKEN` is never sent to a custom URL. Missing, unavailable, or malformed release metadata defers with exit 75 before application quiescence.

Manual image rollback/test overrides remain available, but are deliberately paired: set both non-empty `MONIKA_IMAGE` and `MONIKA_FORUM_IMAGE`, or neither. A one-sided or empty override is rejected. Explicit pairs take precedence over channel resolution and should name a reviewed coordinated pair.

## Network boundary

The forum is user-facing but binds to host loopback by default; production public
traffic should reach it through the private Compose network from a trusted tunnel
or reverse proxy. Agentd is not public. The compose template exposes both host-side
administrative surfaces on loopback:

```yaml
services:
  monika:
    ports:
      - "127.0.0.1:${MONIKA_AGENTD_PORT:-7724}:7724"
  forum:
    ports:
      - "${MONIKA_FORUM_BIND:-127.0.0.1:4310:4310}"
```

`MONIKA_AGENTD_PORT` is the host-side published-port override only; Compose keeps
agentd health and forum-to-agentd traffic on container port 7724. The deploy
script derives its default loopback URL from the same host override (an explicit
`MONIKA_AGENTD_BASE_URL` still takes precedence).

This lets host automation call:

```text
http://127.0.0.1:7724/v1/admin/quiescence
http://127.0.0.1:7724/v1/admin/drain
http://127.0.0.1:4310/api/deploy/admission/acquire
http://127.0.0.1:4310/api/deploy/admission/cancel
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
3. When `MONIKA_PUBLIC_INGRESS=1`, reconcile only the digest-pinned `cloudflared` service with `--no-deps`.
4. Select the image pair. The default/main and explicit-override paths use their configured references. The stable path resolves and strictly validates the latest release asset after ingress reconciliation, then exports exact digest references.
5. Pull both images. For stable, verify their OCI revision labels and apply the migration guard before application quiescence.
6. Compare the pulled image IDs with the running containers. If no image change is available, prove Forum `/readyz` before exiting so a retry cannot hide a replacement that installed its target image but failed the prior readiness gate.
7. Acquire an expiring forum admission lease with a caller-generated operation ID and the deploy token. Acquisition synchronously closes robot admission, pauses new Pi sync cycles, boundedly waits for any in-flight sync, then evaluates current-generation durable dispatches and the other forum blockers. A robot-eligible post arriving during preparation revokes the attempt and commits with its dispatch; after acquisition, such a post receives retryable 503 without a visible/orphan post.
8. If the `monika` image changed, start agentd deploy drain. Drain is a lock, so the script POSTs `/v1/admin/drain` even when agentd was already `safe_to_stop`; this rejects new work between the safety check and Docker shutdown.
9. Create and verify a whole-repo backup archive.
10. If the `monika` image changed, re-check/re-start agentd drain immediately before Compose runs. This closes the race where a long backup or external drain cancel could otherwise reopen agentd to new work.
11. Revalidate ownership and renew the same forum admission lease immediately before the first container replacement. A lost or expired lease fails closed before Compose.
12. If Monika changed, recreate only `monika` with `--no-deps`. The replacement restores the original unexpired deploy drain from `/data`; wait for the new agentd to accept `/v1/admin/drain/cancel` and report healthy/undrained.
13. If Forum also changed, renew the still-running old forum process's admission lease again after agentd is healthy, then recreate only `forum` with `--no-deps`. Staging a joint update prevents Forum's healthy-agentd Compose dependency from withholding control needed to cancel Monika's restored drain. A forum-only update also cannot recreate Monika because of unrelated Compose configuration drift.
14. After every applied Monika or forum image change, wait a bounded interval for the exact unprefixed forum `/readyz`; a failure stops before pruning.
15. Cancel/reopen the forum admission lease, including after forum-only, Monika-only, and backup-only success. The exit trap best-effort cancels it on every abort; automatic lease expiry is the final fail-safe.
16. Print `docker compose ps` for the managed services.
17. Prune old redeploy backups by retention bucket.
18. Prune old dangling Docker images conservatively.

Forum-only image updates do not drain agentd because the `monika` container is not expected to restart. The recreated forum passively reattaches only conversations agentd still reports loaded; it does not reopen missing Pi sessions. A coordinated runtime restart leaves historical sessions unloaded and recovered completion/request evidence non-waking until explicit new work. Backup-only mode still drains and cancels agentd so the runtime capsule is quiescence-gated.

Public ingress is opt-in. Set `MONIKA_PUBLIC_INGRESS=1` on a host that has installed
the tunnel connector token. Every deploy attempt reconciles `cloudflared` before
application image comparison, so a stopped connector or reviewed digest/config
change is repaired even when Monika/forum are already current. The connector is
never allowed to pull an unreviewed moving image. See
[`public-ingress.md`](public-ingress.md) for provisioning and recovery.

The script exits `75` (`EX_TEMPFAIL`) when deployment should be retried later. This includes active or uncertain async-subagent execution and an active interactive Pi ownership lease: deployment waits rather than terminating work. systemd treats this as a successful deferral, not as a failed unit. Forum Deploy on Finish persists its request and retries after exit 75 instead of losing the one-shot intent.

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

On the first move from a running `main` image to an older stable release, the migration guard will normally defer because that is a deliberate downgrade. Inspect the reported running and target commits, then acknowledge only that reviewed attempt with `MONIKA_DEPLOY_ALLOW_STABLE_MIGRATION=1`. Fresh installs, exact matches, and running revisions proven to be ancestors of the stable target advance without it. Missing/unknown labels, older targets, and divergent histories require the same acknowledgment. Do **not** persist this one-shot variable in the timer or scheduler configuration.

If the command exits `75`, do not force a restart. Inspect both forum deploy status and `curl -fsS http://127.0.0.1:7724/v1/admin/subagents`, wait for active work to finish, and retry. An `uncertain` run requires runtime/PID reconciliation or the audited quarantine procedure in `docs/redeployment.md`; an `effects_state: "unknown"` run requires remote-effect investigation and an audited effects attestation. Never remove lifecycle files merely to make either counter disappear.

Forum admission uses `MONIKA_FORUM_ADMISSION_WAIT_TIMEOUT_MS` (default 30 seconds) for its bounded in-flight-sync wait and `MONIKA_FORUM_ADMISSION_LEASE_MS` (default 30 minutes) for automatic expiry. It also blocks on tracked direct agent/model work plus pending/running fork operations. The host renews the same owned lease immediately before each applicable replacement boundary; expiry or ownership loss fails closed. During a joint update, the old forum remains running while Monika is replaced, so the host renews that process's lease again after agentd recovery and immediately before replacing Forum. Size the lease above the host's worst-case backup duration. The lease is process-local: Compose must begin while the old marker exists, replacing the forum removes that fence, and the post-readiness operation-scoped cancel against the replacement is an idempotent no-op. Monika-only and backup-only paths explicitly cancel the surviving lease. Forum cancel and readiness probes are curl-bounded so their outer deadlines remain effective.

For the single rollout from a forum image that predates admission, an exact `404` from acquire switches that attempt to bounded polling of the legacy authenticated quiescence endpoint. The host checks initially and again immediately before each replacement boundary: twice for a one-service update, or three times when a joint update stages Monika recovery before replacing Forum. Other HTTP and transport failures remain closed. Once the new forum starts, later attempts use admission normally; the compatibility path cannot bypass a server that implements the endpoint.

Agentd drain has a durable lease as defense in depth. `MONIKA_AGENTD_DRAIN_AUTO_CANCEL_MS` controls the lease passed by `deploy-if-safe` and defaults to 15 minutes. Agentd publishes its reason and absolute expiry under `/data` before drain succeeds, restores the remaining lease after container replacement, and clears it only when it expires or `/v1/admin/drain/cancel` succeeds. The deploy script still owns the normal lifecycle: drain, replace Monika alone, then cancel drain on the replacement before any coordinated Forum replacement.

## Backups

Redeploy backups are complete runtime capsules: the archive contains the entire live Monika repo, including `runtime/secrets`, sessions, forum data, local compose configuration, scripts, docs, and git metadata. This makes immediate rollback simple and avoids partial-restore ambiguity.

These local archives are **not** the off-host disaster recovery system. The host's
separate Nix-managed writer uses a transient read-only Btrfs capture, hourly portable
restic history and standalone Object-Locked WORM capsules. Root never executes this
checkout's scripts for those jobs. See [`docs/backups.md`](backups.md) for the four
artifact types and cold recovery procedures.

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

## Restoring a local redeploy capsule

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
# On the production public host, after restoring/rotating the connector token:
docker compose --profile public-ingress up -d --no-deps cloudflared
```

Verify:

```bash
docker compose ps
curl -fsS http://127.0.0.1:4310/api/healthz
curl -fsS http://127.0.0.1:4310/readyz
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

Do not point the systemd timer at a development worktree. Do not make the timer run `git pull`. Source checkout changes should be deliberate and reviewed; unattended automation may fetch to inspect drift, but it should only apply the selected container image pair.

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

On NixOS hosts, Nix can own the timer and service. On other Linux hosts, the same model can be implemented with ordinary systemd units. The service should run as the runtime owner with Docker access, use a `flock` lock to prevent overlapping manual/timer runs, and treat exit `75` as a successful deferral. Configure `MONIKA_RELEASE_CHANNEL=stable` in this service environment when opting in; Compose `.env` interpolation does not export it to the host script.

Operational checks:

```bash
systemctl list-timers monika-redeploy.timer
systemctl status monika-redeploy.service
journalctl -u monika-redeploy -n 100 --no-pager
```

Normal deferrals are quiet journal entries. They should not page or notify. A non-75 failure leaves the systemd unit failed for operator review.

This timer and its local capsule behavior are intentionally unchanged by the tiered
B2 service. Do not add cloud credentials or off-host upload behavior to
`deploy-if-safe`; Shadowsea's immutable Nix-store service is the sole writer.
