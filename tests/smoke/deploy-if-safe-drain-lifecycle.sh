#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/deploy-if-safe"

run_case() {
  local name="$1"
  local monika_current="$2"
  local monika_target="$3"
  local forum_current="$4"
  local forum_target="$5"
  local public_ingress="$6"
  local tmp log bin deploy_root

  tmp="$(mktemp -d)"
  log="$tmp/calls.log"
  bin="$tmp/bin"
  deploy_root="$tmp/monika"
  mkdir -p "$bin" "$deploy_root/runtime/backups/redeploy"
  cp "$SCRIPT" "$deploy_root/deploy-if-safe"
  echo "compose" > "$deploy_root/compose.yaml"
  echo "payload" > "$deploy_root/payload.txt"

  cat > "$bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
{
  printf 'docker'
  printf ' %q' "$@"
  printf '\n'
} >> "$CALL_LOG"
if [ "${1:-}" = "compose" ]; then
  shift
  while [ "${1:-}" = "-f" ] || [ "${1:-}" = "--profile" ]; do
    shift 2
  done
  case "${1:-}" in
    pull) exit 0 ;;
    ps)
      if [ "${2:-}" = "-q" ]; then
        case "${3:-}" in
          monika) echo cid-monika ;;
          forum) echo cid-forum ;;
        esac
      fi
      exit 0
      ;;
    up) echo up >> "$CALL_LOG"; exit 0 ;;
  esac
fi
if [ "${1:-}" = "inspect" ]; then
  case "${4:-}" in
    cid-monika) echo "$MONIKA_CURRENT_ID" ;;
    cid-forum) echo "$FORUM_CURRENT_ID" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "${1:-}" = "image" ] && [ "${2:-}" = "inspect" ]; then
  case "${5:-}" in
    "$MONIKA_IMAGE") echo "$MONIKA_TARGET_ID" ;;
    "$MONIKA_FORUM_IMAGE") echo "$FORUM_TARGET_ID" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "${1:-}" = "image" ] && [ "${2:-}" = "prune" ]; then
  exit 0
fi
exit 1
SH
  chmod +x "$bin/docker"

  cat > "$bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %q\n' "$*" >> "$CALL_LOG"
method="GET"
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -H|--data) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  */api/deploy/quiescence) echo '{"safeToStop":true}' ;;
  */v1/admin/quiescence) echo '{"ok":true,"status":"safe_to_stop","draining":false,"blockers":[],"drain_required":[]}' ;;
  */v1/admin/drain)
    [ "$method" = "POST" ] || exit 1
    echo drain >> "$CALL_LOG"
    echo '{"ok":true,"status":"safe_to_stop","draining":true,"blockers":[],"drain_required":[]}'
    ;;
  */v1/admin/drain/cancel)
    [ "$method" = "POST" ] || exit 1
    echo cancel >> "$CALL_LOG"
    echo '{"ok":true,"status":"safe_to_stop","draining":false,"blockers":[],"drain_required":[]}'
    ;;
  */healthz) echo '{"ok":true,"status":"healthy"}' ;;
  *) echo "unexpected curl URL: $url" >&2; exit 1 ;;
esac
SH
  chmod +x "$bin/curl"

  CALL_LOG="$log" \
  PATH="$bin:$PATH" \
  MONIKA_DEPLOY_ROOT="$deploy_root" \
  MONIKA_DEPLOY_COMPOSE_FILE="$deploy_root/compose.yaml" \
  MONIKA_DEPLOY_REQUIRE_GIT_CURRENT=0 \
  MONIKA_DEPLOY_BACKUP_COMPRESSION=gzip \
  MONIKA_PUBLIC_INGRESS="$public_ingress" \
  MONIKA_IMAGE="monika:test" \
  MONIKA_FORUM_IMAGE="forum:test" \
  MONIKA_CURRENT_ID="$monika_current" \
  MONIKA_TARGET_ID="$monika_target" \
  FORUM_CURRENT_ID="$forum_current" \
  FORUM_TARGET_ID="$forum_target" \
  CODEX_FORUM_DEPLOY_TOKEN=test-token \
  "$deploy_root/deploy-if-safe" >"/tmp/deploy-if-safe-$name.out" 2>"/tmp/deploy-if-safe-$name.err"

  if [ "$public_ingress" = "1" ]; then
    if ! grep -Eq ' up -d --no-deps cloudflared$' "$log"; then
      echo "public-ingress deploy should independently reconcile cloudflared" >&2
      cat "$log" >&2
      return 1
    fi
  elif grep -q 'cloudflared' "$log"; then
    echo "generic deploy should not activate cloudflared" >&2
    cat "$log" >&2
    return 1
  fi

  case "$name" in
    forum-only|no-ingress)
      if grep -q '^drain$' "$log"; then
        echo "forum-only deploy should not drain agentd" >&2
        cat "$log" >&2
        return 1
      fi
      if ! grep -Eq ' up -d --no-deps forum$' "$log" || grep -Eq ' up -d --no-deps monika( |$)' "$log"; then
        echo "forum-only deploy must recreate forum without touching Monika" >&2
        cat "$log" >&2
        return 1
      fi
      ;;
    monika-update)
      local drains cancels
      drains="$(grep -c '^drain$' "$log" || true)"
      cancels="$(grep -c '^cancel$' "$log" || true)"
      if [ "$drains" -lt 2 ] || [ "$cancels" -lt 1 ]; then
        echo "monika deploy should drain twice and cancel after deploy (drains=$drains cancels=$cancels)" >&2
        cat "$log" >&2
        return 1
      fi
      if ! grep -Eq ' up -d --no-deps monika$' "$log"; then
        echo "Monika image update should recreate Monika explicitly" >&2
        cat "$log" >&2
        return 1
      fi
      ;;
    no-update)
      if grep -Eq ' up -d --no-deps (monika|forum)$' "$log"; then
        echo "no-update ingress reconciliation must not touch application containers" >&2
        cat "$log" >&2
        return 1
      fi
      ;;
  esac

  rm -rf "$tmp"
}

run_case forum-only same same old-forum new-forum 1
run_case monika-update old-monika new-monika same same 1
run_case no-update same same same same 1
run_case no-ingress same same old-forum new-forum 0

echo "deploy-if-safe drain lifecycle smoke passed"
