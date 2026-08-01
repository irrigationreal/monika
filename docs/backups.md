# Backup and disaster recovery model

Monika has four deliberately different storage artifacts. Do not describe one as a
substitute for another.

| Artifact | Purpose | Durable/off-host? | Restore shape |
|---|---|---|---|
| local redeploy capsule | Quiescence-gated rollback immediately before redeploy | local only | whole live checkout archive |
| transient Btrfs capture | Read-only point-in-time input for an off-host job | no; deleted on exit | never restore from this |
| `monika-restic` | Routine portable disaster recovery with history | B2 | `restic restore` |
| WORM capsule | Standalone last-resort immutable recovery tier | separate Object-Locked B2 buckets | one tar.zst |

The Shadowsea `monika-backup.nix` module is the authority for off-host scheduling,
credentials, upload validation and monitoring. This repository does not contain a
second writer. In particular, do not add B2 credentials or an upload command to
`deploy-if-safe`, a container, Compose, or a script under the live checkout. Root
backup services execute only Nix-store scripts; the writable checkout is data.

## Backup selection and consistency

Only the canonical live repository is selected:

```text
/persist/home/monika/repos/monika
```

`/home/monika/repos/monika` must have the same device and inode as that canonical
path (the persistence bind mount identity check). The host first snapshots
`/persist` read-only. It fails closed below a 10 GiB free-space floor or if Monika
contains a nested Btrfs subvolume, because such a subvolume would be omitted from a
parent snapshot. A blocking global flock under `/run/monika-backup` serializes every mode, abandoned transient snapshots
are removed, and EXIT/TERM cleanup removes the current capture.

The only payload exclusions are:

```text
runtime/backups/
out/
```

The first prevents recursive local redeploy archives; the second is generated
output. Runtime SQLite databases and their `-wal`/`-shm` companions, Pi JSONL,
sessions, secrets and local Compose configuration remain included.

Before WORM upload, every detected SQLite database plus WAL/SHM is copied from the
snapshot into writable scratch and must return `PRAGMA quick_check = ok`. Every
completed JSONL line must parse. A single malformed unterminated final line is
recorded as a recoverable crash-consistent append tail rather than durable corruption;
restore validation may truncate only that tail. The in-archive manifest records those results, the
Monika Git revision/dirty state, deployed image digests and tool versions. GNU tar
preserves numeric owners, modes, ACLs and xattrs where supported, streams through
zstd and rclone crypt, and never writes a local full capsule.

## Schedules and verification

- hourly restic: use stable host/tag grouping (`stanza-monika`/`active`), retain 48
  hourly, 35 daily, 13 weekly and 12 monthly; then run a metadata repository check;
- six-hour WORM: every six hours, stale after eight hours;
- daily WORM: fixed UTC calendar, stale after 30 hours;
- weekly WORM: fixed UTC calendar, stale after eight days.

The three WORM writer keys are write-only; the mutable restic writer key also requires read, list, and delete for checks and pruning. Stanza can prove stream completion and snapshot
cleanup locally, but cannot truthfully claim remote visibility. It uploads encrypted
completion evidence only after cleanup. Control uses independent read-only keys to
decrypt that evidence and verifies the exact raw B2 capsule and evidence objects,
compliance Object Lock metadata of at least 14, 120, and 365 days respectively
from B2's upload timestamp (with at most the documented two-hour default-application
margin), AES256 SSE-B2, and age. Writer evidence only records the requested tier and
is not trusted as retention proof. Production relies on separately tested bucket
SSE-B2 and compliance-retention defaults; rclone uploads send no per-upload retention
or SSE headers so multipart uploads cannot silently drop them. Only then does Control
update a verified marker. Each tier uses a separate bucket-scoped Control reader key;
the mutable restic reader credential remains separate from those readers and from
Stanza's three WORM write-only keys. Control passes `--no-lock` for Restic metadata
checks so this active reader remains genuinely read-only. After independent verification
and both restore drills passed, WORM lifecycle cleanup was enabled: hide objects after
15, 121, and 366 days for the six-hour, daily, and weekly tiers, delete hidden versions
one day later, and cancel unfinished multipart uploads after seven days. Compliance
Object Lock remains authoritative against premature deletion. There are no success notifications; failed
units and stale tiers alert through the authenticated `shadowsea-alerts` ntfy route,
with bounded retry for transient delivery failures. On Control, mutable active
credentials live in `monika-backup-control/restic.env`; WORM reader variables live
in `control.env`, so the two authority sets are not sourced together.

## Stop/start fence for every restore

Never restore over a running deployment. On Stanza, stop both timers **and** any
already active oneshot services, then verify every unit is inactive before touching
the canonical tree:

```bash
timers=(monika-redeploy.timer monika-backup-active.timer monika-backup-worm-6h.timer monika-backup-worm-daily.timer monika-backup-worm-weekly.timer)
services=(monika-redeploy.service monika-backup-active.service monika-backup-worm-6h.service monika-backup-worm-daily.service monika-backup-worm-weekly.service)
sudo systemctl stop "${timers[@]}" "${services[@]}"
for unit in "${timers[@]}" "${services[@]}"; do
  test "$(systemctl is-active "$unit")" = inactive || exit 1
done
cd /persist/home/monika/repos/monika
docker compose stop
test -z "$(docker compose ps --status running --quiet)"
```

After file/database verification, start the deployment and explicitly re-enable and
restart every timer (do not merely assume its previous state):

```bash
timers=(monika-redeploy.timer monika-backup-active.timer monika-backup-worm-6h.timer monika-backup-worm-daily.timer monika-backup-worm-weekly.timer)
cd /persist/home/monika/repos/monika
docker compose up -d
sudo systemctl enable --now "${timers[@]}"
for unit in "${timers[@]}"; do systemctl is-active --quiet "$unit" || exit 1; done
```

Then perform the forum/agentd health checks from `docs/autodeploy.md`.

## Routine restic restore

Use a trusted isolated machine and the root-only recovery credentials, and apply the
stop/start fence above.

1. Load the mutable `monika-restic` environment without echoing values.
2. Run `actual=$(restic cat config | jq -er .id)` and compare it byte-for-byte with
   `restic-repository-id`. Stop on a mismatch; never initialize a replacement
   repository implicitly.
3. Run `restic check`, list snapshots, and restore the selected snapshot to an empty
   scratch directory.
4. Confirm the restored path is `monika/`, inspect Git/image state, and run SQLite
   quick checks with each WAL/SHM trio present.
5. Move the existing live tree aside, place the restored tree at the canonical path,
   and retain root ownership/modes before completing the start half of the fence.

Restic is portable: recovery does not require a Btrfs destination.

## Standalone WORM restore

On an isolated host, configure the matching tier's **read-only** rclone crypt remote
and securely copy Control's root-only
`/var/lib/monika-backup-monitor/verified/<tier>.json` to `verified.json`. Use this
exact lookup/matching/checksum procedure (example tier shown):

```bash
set -euo pipefail
tier=worm-weekly
remote=monika-worm-weekly-read
verified_object=$(jq -er 'select(.tier == "worm-weekly" and .remoteVisibility == true and .retentionVerified == true and .sseVerified == true) | .object' verified.json)
mkdir -p evidence-candidates
rclone lsf "$remote:evidence/$tier" --files-only >evidence-names.txt
matches=0
while IFS= read -r name; do
  rclone cat "$remote:evidence/$tier/$name" >"evidence-candidates/$name"
  if [[ $(jq -r '.object // empty' "evidence-candidates/$name") == "$verified_object" ]]; then
    evidence="evidence-candidates/$name"; evidence_name=$name; matches=$((matches + 1))
  fi
done <evidence-names.txt
[[ $matches == 1 ]]
encode() { rclone cryptencode "$remote:" "$1" | awk -F '\t' 'NF { value=$NF } END { print value }'; }
[[ $(encode "evidence/$tier/$evidence_name") == "$(jq -er .evidenceEncryptedObject "$evidence")" ]]
[[ $(encode "$verified_object") == "$(jq -er .encryptedObject "$evidence")" ]]
rclone copyto "$remote:$verified_object" capsule.tar.zst
expected_sha256=$(jq -er .stream.sha256 "$evidence")
actual_sha256=$(sha256sum capsule.tar.zst | awk '{print $1}')
[[ $actual_sha256 == "$expected_sha256" ]]
zstd -dc capsule.tar.zst | tar -xOf - manifest.json | jq -e . >manifest.json
```

This matches the exact Control-verified object, both encrypted raw-name commitments,
and the writer's plaintext compressed-stream checksum before extraction. Next:

1. Apply the stop half of the common restore fence on Stanza.
2. Extract with GNU tar and `--numeric-owner --acls --xattrs` onto a filesystem that
   supports the metadata.
3. Verify the manifest Git revision/image digests and repeat all SQLite quick checks.
4. Restore the resulting `monika` directory at the canonical path, then apply the
   start half of the fence and health validation.

A WORM capsule is standalone; it does not need restic indexes or historical packs.
Object Lock does not make its contained application data automatically valid, which
is why manifest and database validation remain mandatory.

## Emergency recovery kit

The generator is owned by the Shadowsea flake, not this writable Monika checkout.
On a host already rebuilt from Shadowsea it is `/run/current-system/sw/bin/monika-backup-recovery-kit`.
On an isolated Nix machine, obtain it from an audited Shadowsea checkout without
running checkout code as root:

```bash
cd /path/to/audited-shadowsea
system=$(nix build --no-link --print-out-paths .#nixosConfigurations.stanza.config.system.build.toplevel)
generator="$system/sw/bin/monika-backup-recovery-kit"
```

On that trusted isolated host, root supplies separately transported copies of both
host credential directories explicitly:

```bash
sudo monika-backup-recovery-kit /mnt/offline-kit \
  /run/recovery-input/stanza-monika-backup \
  /run/recovery-input/control-monika-backup-control
```

Do not enable broad host access to gather them; use root-only scratch or encrypted
removable media. The generated root-only plaintext directory and mode-0600 archive contain the
**actual** writer and Control rclone configs, mutable restic password/repository pin,
three WORM write-only bucket keys, three separate bucket-scoped Control reader keys,
crypt secrets, checksums, pinned tool versions/paths and cold restore instructions.
The mutable restic key is not a WORM key, and no WORM write-only key can be used for
recovery reads. The kit does not invent a recovery key.

Neon must copy this artifact immediately to independently encrypted offline storage
and verify its checksum there. Never upload it to the Monika forum or another
application service. Treat any online plaintext copy according to the incident
custody and secure-removal policy, and rotate exposed credentials after recovery.

## Validation failure behavior

A failed SQLite or JSONL check does not discard the only captured copy. The WORM job
records the failure in `manifest.json`, uploads the capsule for salvage, and then
fails the systemd unit so ntfy and the Control freshness path can surface it. Treat
that as an integrity incident: preserve the immutable object, inspect the named
source records, and repair or explicitly account for the source corruption rather
than disabling validation.
