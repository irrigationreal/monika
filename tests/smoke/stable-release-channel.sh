#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/deploy-if-safe"
HEAD_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)"
PARENT_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD^)"
MONIKA_DIGEST="sha256:$(printf '1%.0s' {1..64})"
FORUM_DIGEST="sha256:$(printf '2%.0s' {1..64})"
LAST_LOG=""

make_fixtures() {
  local directory="$1" latest_mode="$2" asset_mode="$3" target_commit="$4" asset_url="$5"
  "$ROOT_DIR/scripts/write-stable-manifest" \
    "$directory/asset.json" \
    2026.01.02 \
    "$target_commit" \
    ghcr.io/irrigationreal/monika \
    "$MONIKA_DIGEST" \
    "$FORUM_DIGEST"
  python3 - "$directory/latest.json" "$directory/asset.json" "$latest_mode" "$asset_mode" \
    "$target_commit" "$asset_url" <<'PY'
import json
import sys
from pathlib import Path

latest_path, asset_path, latest_mode, asset_mode, commit, asset_url = sys.argv[1:]
latest = {
    "draft": False,
    "prerelease": False,
    "tag_name": "2026.01.02",
    "target_commitish": commit,
    "assets": [{"name": "stable-manifests.json", "url": asset_url}],
}
asset = json.loads(Path(asset_path).read_text())
canonical_asset = {
    "schemaVersion": 1,
    "deploymentContractVersion": 1,
    "stableTag": "2026.01.02",
    "commit": commit,
    "images": {
        "monika": {
            "repository": "ghcr.io/irrigationreal/monika",
            "manifestDigest": "sha256:" + "1" * 64,
        },
        "forum": {
            "repository": "ghcr.io/irrigationreal/monika-forum",
            "manifestDigest": "sha256:" + "2" * 64,
        },
    },
}
if asset != canonical_asset:
    raise SystemExit("write-stable-manifest output drifted from the independently pinned v1 contract")
if latest_mode == "malformed":
    Path(latest_path).write_text("{not-json")
else:
    if latest_mode == "missing-asset": latest["assets"] = []
    if latest_mode == "prerelease": latest["prerelease"] = True
    if latest_mode == "draft": latest["draft"] = True
    if latest_mode == "short-commit": latest["target_commitish"] = "abc123"
    Path(latest_path).write_text(json.dumps(latest))
if asset_mode == "malformed":
    Path(asset_path).write_text("{not-json")
else:
    if asset_mode == "schema": asset["schemaVersion"] = 2
    if asset_mode == "contract": asset["deploymentContractVersion"] = 2
    if asset_mode == "repository": asset["images"]["forum"]["repository"] = "ghcr.io/example/forum"
    if asset_mode == "digest": asset["images"]["monika"]["manifestDigest"] = "sha256:nope"
    if asset_mode == "tag": asset["stableTag"] = "2026.01.03"
    if asset_mode == "commit": asset["commit"] = "0" * 40
    if asset_mode == "unknown-field": asset["extra"] = True
    Path(asset_path).write_text(json.dumps(asset))
PY
}

run_case() {
  local name="$1" expected="$2" latest_mode="$3" asset_mode="$4"
  local running_revision="$5" target_commit="$6" current_id="$7" target_id="$8"
  local expect_quiescence="$9"
  shift 9
  local tmp bin deploy_root asset_url status
  tmp="$(mktemp -d)"
  bin="$tmp/bin"
  deploy_root="$tmp/deploy"
  LAST_LOG="$tmp/calls.log"
  mkdir -p "$bin" "$deploy_root"
  cp "$SCRIPT" "$deploy_root/deploy-if-safe"
  printf 'services: {}\n' > "$deploy_root/compose.yaml"

  asset_url="https://api.github.com/repos/irrigationreal/monika/releases/assets/7"
  for argument in "$@"; do
    case "$argument" in
      MONIKA_STABLE_RELEASE_API_URL=https://releases.example.test/*)
        asset_url="https://releases.example.test/api/assets/7"
        ;;
    esac
  done
  make_fixtures "$tmp" "$latest_mode" "$asset_mode" "$target_commit" "$asset_url"
  : > "$LAST_LOG"

  cat > "$bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'docker' >> "$CALL_LOG"; printf ' %q' "$@" >> "$CALL_LOG"; printf '\n' >> "$CALL_LOG"
if [ "${1:-}" = compose ]; then
  shift
  while [ "${1:-}" = -f ] || [ "${1:-}" = --profile ]; do shift 2; done
  case "${1:-}" in
    pull)
      printf 'selected %s %s\n' "$MONIKA_IMAGE" "$MONIKA_FORUM_IMAGE" >> "$CALL_LOG"
      exit 0
      ;;
    ps)
      if [ "${2:-}" = -q ] && [ "${FRESH_INSTALL:-0}" != 1 ]; then
        case "${3:-}" in monika) echo cid-monika ;; forum) echo cid-forum ;; esac
      fi
      exit 0
      ;;
    up) exit 0 ;;
  esac
fi
if [ "${1:-}" = inspect ]; then
  if [[ "${3:-}" == *org.opencontainers.image.revision* ]]; then
    printf '%s\n' "$RUNNING_REVISION"
  else
    printf '%s\n' "$CURRENT_ID"
  fi
  exit 0
fi
if [ "${1:-}" = image ] && [ "${2:-}" = inspect ]; then
  if [[ "${4:-}" == *org.opencontainers.image.revision* ]]; then
    printf '%s\n' "${TARGET_LABEL_REVISION:-$TARGET_COMMIT}"
  else
    printf '%s\n' "$TARGET_ID"
  fi
  exit 0
fi
exit 1
SH
  chmod +x "$bin/docker"

  cat > "$bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl' >> "$CALL_LOG"; printf ' %q' "$@" >> "$CALL_LOG"; printf '\n' >> "$CALL_LOG"
url=""; output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -H|-w|-X|--data|--connect-timeout|--max-time|--max-redirs|--max-filesize|--proto|--proto-redir) shift 2 ;;
    -L|-f|-s|-S|-fsS) shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  */releases/latest)
    [ "${FAIL_RELEASE_API:-0}" != 1 ] || exit 22
    cp "$LATEST_FIXTURE" "$output"
    ;;
  */releases/assets/7|*/api/assets/7)
    [ "${FAIL_ASSET_API:-0}" != 1 ] || exit 22
    cp "$ASSET_FIXTURE" "$output"
    ;;
  */api/deploy/admission/acquire|*/v1/admin/quiescence)
    echo quiescence >> "$CALL_LOG"
    exit 22
    ;;
  *) echo "unexpected URL: $url" >&2; exit 22 ;;
esac
SH
  chmod +x "$bin/curl"

  # Use the real checked-out repository as ROOT so stable ancestry checks run
  # against its Git object database. Compose remains fully stubbed and reads
  # only the isolated fixture file.
  set +e
  env \
    -u MONIKA_IMAGE \
    -u MONIKA_FORUM_IMAGE \
    -u MONIKA_RELEASE_CHANNEL \
    -u MONIKA_STABLE_RELEASE_API_URL \
    -u MONIKA_STABLE_RELEASE_TOKEN \
    -u MONIKA_DEPLOY_ALLOW_STABLE_MIGRATION \
    -u MONIKA_PUBLIC_INGRESS \
    -u GITHUB_TOKEN \
    -u MONIKA_FORUM_DEPLOY_TOKEN \
    -u CODEX_FORUM_DEPLOY_TOKEN \
    -u FAIL_RELEASE_API \
    -u FAIL_ASSET_API \
    -u TARGET_LABEL_REVISION \
    -u FRESH_INSTALL \
    CALL_LOG="$LAST_LOG" \
    LATEST_FIXTURE="$tmp/latest.json" \
    ASSET_FIXTURE="$tmp/asset.json" \
    RUNNING_REVISION="$running_revision" \
    TARGET_COMMIT="$target_commit" \
    CURRENT_ID="$current_id" \
    TARGET_ID="$target_id" \
    PATH="$bin:$PATH" \
    MONIKA_DEPLOY_ROOT="$ROOT_DIR" \
    MONIKA_DEPLOY_COMPOSE_FILE="$deploy_root/compose.yaml" \
    MONIKA_DEPLOY_REQUIRE_GIT_CURRENT=0 \
    CODEX_FORUM_DEPLOY_TOKEN=test-token \
    "$@" \
    "$deploy_root/deploy-if-safe" > "$tmp/stdout" 2> "$tmp/stderr"
  status=$?
  set -e

  if [ "$status" -ne "$expected" ]; then
    echo "$name: expected status $expected, got $status" >&2
    cat "$tmp/stdout" "$tmp/stderr" "$LAST_LOG" >&2
    return 1
  fi
  if grep -q Traceback "$tmp/stderr"; then
    echo "$name: validation leaked a Python traceback" >&2
    cat "$tmp/stderr" >&2
    return 1
  fi
  if [ "$expect_quiescence" = 1 ]; then
    grep -q '^quiescence$' "$LAST_LOG" || {
      echo "$name: expected to reach established quiescence lifecycle" >&2
      cat "$LAST_LOG" >&2
      return 1
    }
  elif grep -q '^quiescence$' "$LAST_LOG"; then
    echo "$name: reached quiescence unexpectedly" >&2
    cat "$LAST_LOG" >&2
    return 1
  fi

  CASE_STDOUT="$tmp/stdout"
  CASE_STDERR="$tmp/stderr"
  CASE_TMP="$tmp"
}

# Unset remains the current :main pair and does not consult release metadata.
run_case main-default 0 valid valid "$HEAD_SHA" "$HEAD_SHA" same same 0
if ! grep -Fq 'selected ghcr.io/irrigationreal/monika:main ghcr.io/irrigationreal/monika-forum:main' "$LAST_LOG" || grep -q '/releases/latest' "$LAST_LOG"; then
  echo "main-default: default image selection changed or queried stable metadata" >&2
  exit 1
fi

# Manual rollback/test overrides remain paired and bypass channel resolution.
run_case paired-overrides 0 valid valid "$HEAD_SHA" "$HEAD_SHA" same same 0 \
  MONIKA_RELEASE_CHANNEL=stable MONIKA_IMAGE=monika:test MONIKA_FORUM_IMAGE=forum:test
run_case one-sided-override 64 valid valid "$HEAD_SHA" "$HEAD_SHA" same same 0 MONIKA_IMAGE=monika:test
run_case empty-override 64 valid valid "$HEAD_SHA" "$HEAD_SHA" same same 0 MONIKA_IMAGE= MONIKA_FORUM_IMAGE=forum:test

# Backup-only never selects deployment images, so unrelated channel/override
# configuration must not alter its admission-driven deferral contract.
set +e
env \
  PATH="$CASE_TMP/bin:$PATH" \
  CALL_LOG="$CASE_TMP/backup-calls.log" \
  MONIKA_DEPLOY_ROOT="$ROOT_DIR" \
  MONIKA_DEPLOY_COMPOSE_FILE="$CASE_TMP/deploy/compose.yaml" \
  MONIKA_DEPLOY_REQUIRE_GIT_CURRENT=0 \
  MONIKA_RELEASE_CHANNEL=invalid \
  MONIKA_IMAGE=one-sided-is-irrelevant \
  CODEX_FORUM_DEPLOY_TOKEN=test-token \
  "$CASE_TMP/deploy/deploy-if-safe" --backup-only > "$CASE_TMP/backup-stdout" 2> "$CASE_TMP/backup-stderr"
backup_status=$?
set -e
if [ "$backup_status" -ne 75 ] || grep -q 'unsupported MONIKA_RELEASE_CHANNEL\|must be set together' "$CASE_TMP/backup-stderr"; then
  echo "backup-only: deployment image configuration affected backup mode" >&2
  cat "$CASE_TMP/backup-stdout" "$CASE_TMP/backup-stderr" >&2
  exit 1
fi

# The stable happy path is exact-digest pinned, bounded, revision-checked, and a no-op when current.
run_case stable-no-op 0 valid valid "$HEAD_SHA" "$HEAD_SHA" same same 0 \
  MONIKA_RELEASE_CHANNEL=stable GITHUB_TOKEN=canonical-token
if ! grep -Fq "selected ghcr.io/irrigationreal/monika@$MONIKA_DIGEST ghcr.io/irrigationreal/monika-forum@$FORUM_DIGEST" "$LAST_LOG" || \
   ! grep -Fq -- '--connect-timeout 5 --max-time 15 --max-redirs 3 --max-filesize 1048576' "$LAST_LOG" || \
   ! grep -Fq 'authorization:\ Bearer\ canonical-token' "$LAST_LOG"; then
  echo "stable-no-op: digest pinning, request bounds, or canonical credential use missing" >&2
  cat "$LAST_LOG" >&2
  exit 1
fi

# All release/asset contract failures happen before application quiescence with EX_TEMPFAIL.
for specification in \
  'api-unavailable valid valid FAIL_RELEASE_API=1' \
  'asset-unavailable valid valid FAIL_ASSET_API=1' \
  'latest-malformed malformed valid _' \
  'latest-missing-asset missing-asset valid _' \
  'latest-prerelease prerelease valid _' \
  'latest-draft draft valid _' \
  'latest-short-commit short-commit valid _' \
  'asset-malformed valid malformed _' \
  'asset-schema valid schema _' \
  'asset-contract valid contract _' \
  'asset-repository valid repository _' \
  'asset-digest valid digest _' \
  'asset-tag valid tag _' \
  'asset-commit valid commit _' \
  'asset-unknown-field valid unknown-field _'; do
  read -r name latest asset extra <<< "$specification"
  args=(MONIKA_RELEASE_CHANNEL=stable)
  [ "$extra" = _ ] || args+=("$extra")
  run_case "$name" 75 "$latest" "$asset" "$HEAD_SHA" "$HEAD_SHA" same same 0 "${args[@]}"
done

run_case target-revision-mismatch 75 valid valid "$HEAD_SHA" "$HEAD_SHA" same same 0 \
  MONIKA_RELEASE_CHANNEL=stable TARGET_LABEL_REVISION=0000000000000000000000000000000000000000

# Fresh installs and a known ancestor advance without acknowledgement. Updates then enter the unchanged admission/drain lifecycle.
run_case fresh-install 75 valid valid '' "$HEAD_SHA" old new 1 MONIKA_RELEASE_CHANNEL=stable FRESH_INSTALL=1
run_case forward-update 75 valid valid "$PARENT_SHA" "$HEAD_SHA" old new 1 MONIKA_RELEASE_CHANNEL=stable

# Older, missing/unknown, and divergent running revisions require a deliberate one-shot acknowledgement.
run_case older-target-guard 75 valid valid "$HEAD_SHA" "$PARENT_SHA" same same 0 MONIKA_RELEASE_CHANNEL=stable
run_case older-target-acknowledged 0 valid valid "$HEAD_SHA" "$PARENT_SHA" same same 0 \
  MONIKA_RELEASE_CHANNEL=stable MONIKA_DEPLOY_ALLOW_STABLE_MIGRATION=1
run_case missing-running-revision 75 valid valid '' "$HEAD_SHA" same same 0 MONIKA_RELEASE_CHANNEL=stable
run_case unknown-running-revision 75 valid valid 3333333333333333333333333333333333333333 "$HEAD_SHA" same same 0 MONIKA_RELEASE_CHANNEL=stable

# Ingress reconciliation precedes stable metadata resolution, even when the API is temporarily unavailable.
run_case ingress-before-api-failure 75 valid valid "$HEAD_SHA" "$HEAD_SHA" same same 0 \
  MONIKA_RELEASE_CHANNEL=stable MONIKA_PUBLIC_INGRESS=1 FAIL_RELEASE_API=1
up_line="$(grep -n ' up -d --no-deps cloudflared$' "$LAST_LOG" | cut -d: -f1)"
api_line="$(grep -n '/releases/latest' "$LAST_LOG" | cut -d: -f1)"
if [ -z "$up_line" ] || [ -z "$api_line" ] || [ "$up_line" -ge "$api_line" ]; then
  echo "ingress-before-api-failure: connector was not reconciled before release resolution" >&2
  cat "$LAST_LOG" >&2
  exit 1
fi

# Custom sources are HTTPS-only and require their own credential; GITHUB_TOKEN is not forwarded.
run_case custom-source 0 valid valid "$HEAD_SHA" "$HEAD_SHA" same same 0 \
  MONIKA_RELEASE_CHANNEL=stable \
  MONIKA_STABLE_RELEASE_API_URL=https://releases.example.test/api/releases/latest \
  MONIKA_STABLE_RELEASE_TOKEN=custom-token \
  GITHUB_TOKEN=must-not-leak
if ! grep -Fq 'authorization:\ Bearer\ custom-token' "$LAST_LOG" || grep -Fq 'must-not-leak' "$LAST_LOG"; then
  echo "custom-source: credential separation failed" >&2
  cat "$LAST_LOG" >&2
  exit 1
fi
run_case custom-source-no-token 75 valid valid "$HEAD_SHA" "$HEAD_SHA" same same 0 \
  MONIKA_RELEASE_CHANNEL=stable MONIKA_STABLE_RELEASE_API_URL=https://releases.example.test/api/releases/latest GITHUB_TOKEN=must-not-leak
run_case custom-source-http 75 valid valid "$HEAD_SHA" "$HEAD_SHA" same same 0 \
  MONIKA_RELEASE_CHANNEL=stable MONIKA_STABLE_RELEASE_API_URL=http://releases.example.test/api/releases/latest MONIKA_STABLE_RELEASE_TOKEN=custom-token

# compose.yaml.example keeps the established :main defaults.
grep -Fq 'image: ${MONIKA_IMAGE:-ghcr.io/irrigationreal/monika:main}' "$ROOT_DIR/compose.yaml.example"
grep -Fq 'image: ${MONIKA_FORUM_IMAGE:-ghcr.io/irrigationreal/monika-forum:main}' "$ROOT_DIR/compose.yaml.example"

echo "stable release channel smoke passed"
