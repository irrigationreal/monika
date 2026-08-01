#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
doc="$root/docs/backups.md"
[[ -f $doc ]]
for required in \
  'local redeploy capsule' \
  'transient Btrfs capture' \
  'monika-restic' \
  'WORM capsule' \
  '/persist/home/monika/repos/monika' \
  'runtime/backups/' \
  'systemctl stop "${timers[@]}" "${services[@]}"' \
  'systemctl enable --now "${timers[@]}"' \
  'verified_object' \
  'sha256sum capsule.tar.zst' \
  'nixosConfigurations.stanza.config.system.build.toplevel' \
  'three WORM write-only bucket keys' \
  'compliance Object Lock metadata' \
  'independently encrypted offline storage' \
  'Never upload it to the Monika forum'; do
  grep -Fq "$required" "$doc" || { echo "backup documentation missing: $required" >&2; exit 1; }
done
grep -Fq 'docs/backups.md' "$root/docs/autodeploy.md"
grep -Fq 'sole writer' "$root/docs/autodeploy.md"
grep -Fq 'docs/backups.md' "$root/docs/redeployment.md"
printf 'backup documentation contract: PASS\n'
