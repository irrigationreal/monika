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
  local forum_ready="${7:-1}"
  local forum_acquire_response="${8:-1}"
  local forum_wait_timeout_ms="${9:-30000}"
  local forum_renew_response="${10:-1}"
  local tmp log bin deploy_root status

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
    up)
      echo up >> "$CALL_LOG"
      if printf '%s\n' "$*" | grep -Eqw 'monika|forum'; then
        # Admission is process-local: it must exist at the instant Compose
        # begins, and a forum replacement then clears the old process marker.
        test -f "$FORUM_ADMISSION_MARKER"
      fi
      if printf '%s\n' "$*" | grep -qw forum; then
        rm -f "$FORUM_ADMISSION_MARKER"
      fi
      if printf '%s\n' "$*" | grep -qw monika; then
        test -f "$DRAIN_MARKER"
        echo replacement > "$REPLACEMENT_MARKER"
      fi
      exit 0
      ;;
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
    -H|--data|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  */api/deploy/admission/acquire)
    [ "$method" = "POST" ] || exit 1
    echo forum-acquire >> "$CALL_LOG"
    if [ -f "$FORUM_ADMISSION_MARKER" ]; then
      echo forum-renew >> "$CALL_LOG"
      if [ "${FORUM_RENEW_RESPONSE:-1}" != "1" ]; then
        rm -f "$FORUM_ADMISSION_MARKER"
        exit 22
      fi
    fi
    echo acquired > "$FORUM_ADMISSION_MARKER"
    [ "${FORUM_ACQUIRE_RESPONSE:-1}" = "1" ] || exit 22
    echo '{"acquired":true,"operationId":"test-operation","state":"acquired","blockers":[],"expiresAt":"2099-01-01T00:00:00.000Z"}'
    ;;
  */api/deploy/admission/cancel)
    [ "$method" = "POST" ] || exit 1
    echo forum-cancel >> "$CALL_LOG"
    if [ -f "$FORUM_ADMISSION_MARKER" ]; then
      rm -f "$FORUM_ADMISSION_MARKER"
      echo '{"ok":true,"released":true,"operationId":"test-operation"}'
    else
      echo forum-cancel-noop >> "$CALL_LOG"
      echo '{"ok":true,"released":false,"operationId":"test-operation"}'
    fi
    ;;
  */v1/admin/quiescence) echo '{"ok":true,"status":"safe_to_stop","draining":false,"blockers":[],"drain_required":[]}' ;;
  */v1/admin/drain)
    [ "$method" = "POST" ] || exit 1
    echo drain >> "$CALL_LOG"
    echo durable > "$DRAIN_MARKER"
    echo '{"ok":true,"status":"safe_to_stop","draining":true,"blockers":[],"drain_required":[]}'
    ;;
  */v1/admin/drain/cancel)
    [ "$method" = "POST" ] || exit 1
    if [ -f "$REPLACEMENT_MARKER" ]; then
      test -f "$DRAIN_MARKER"
    fi
    echo cancel >> "$CALL_LOG"
    rm -f "$DRAIN_MARKER"
    echo '{"ok":true,"status":"safe_to_stop","draining":false,"blockers":[],"drain_required":[]}'
    ;;
  */healthz) echo '{"ok":true,"status":"healthy"}' ;;
  */readyz)
    echo ready >> "$CALL_LOG"
    [ "${FORUM_READY:-1}" = "1" ] || exit 22
    echo '{"ok":true}'
    ;;
  *) echo "unexpected curl URL: $url" >&2; exit 1 ;;
esac
SH
  chmod +x "$bin/curl"

  set +e
  CALL_LOG="$log" \
  DRAIN_MARKER="$tmp/drain-state" \
  REPLACEMENT_MARKER="$tmp/replacement" \
  FORUM_ADMISSION_MARKER="$tmp/forum-admission" \
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
  FORUM_READY="$forum_ready" \
  FORUM_ACQUIRE_RESPONSE="$forum_acquire_response" \
  FORUM_RENEW_RESPONSE="$forum_renew_response" \
  MONIKA_FORUM_ADMISSION_WAIT_TIMEOUT_MS="$forum_wait_timeout_ms" \
  MONIKA_FORUM_POST_DEPLOY_TIMEOUT_MS=1000 \
  CODEX_FORUM_DEPLOY_TOKEN=test-token \
  "$deploy_root/deploy-if-safe" >"/tmp/deploy-if-safe-$name.out" 2>"/tmp/deploy-if-safe-$name.err"
  status=$?
  set -e

  if [ "$forum_wait_timeout_ms" -le 0 ]; then
    if [ "$status" -eq 0 ] || grep -q '^forum-acquire$' "$log"; then
      echo "non-positive forum admission wait timeout must fail before curl" >&2
      cat "$log" >&2
      return 1
    fi
    rm -rf "$tmp"
    return 0
  fi

  if [ "$forum_renew_response" != "1" ]; then
    if [ "$status" -ne 75 ] || grep -q '^up$' "$log" || [ -e "$tmp/forum-admission" ]; then
      echo "lost or expired forum renewal must tempfail before Compose" >&2
      cat "$log" >&2
      return 1
    fi
    rm -rf "$tmp"
    return 0
  fi

  if [ "$forum_acquire_response" != "1" ]; then
    if [ "$status" -ne 75 ] || [ "$(grep -c '^forum-acquire$' "$log" || true)" -ne 1 ] || [ "$(grep -c '^forum-cancel$' "$log" || true)" -lt 1 ] || [ -e "$tmp/forum-admission" ]; then
      echo "ambiguous forum acquisition must tempfail and release admission through the exit trap" >&2
      cat "$log" >&2
      return 1
    fi
    rm -rf "$tmp"
    return 0
  fi

  if [ "$forum_ready" != "1" ]; then
    if [ "$status" -eq 0 ] || ! grep -q '^ready$' "$log" || grep -q 'docker image prune' "$log"; then
      echo "failed forum readiness must fail deploy before image pruning" >&2
      cat "$log" >&2
      return 1
    fi
    if [ "$(grep -c '^forum-acquire$' "$log" || true)" -ne 2 ] || [ "$(grep -c '^forum-cancel$' "$log" || true)" -lt 1 ] || [ -e "$tmp/forum-admission" ]; then
      echo "failed deploy must release forum admission through the exit trap" >&2
      cat "$log" >&2
      return 1
    fi
    rm -rf "$tmp"
    return 0
  fi
  if [ "$status" -ne 0 ]; then
    cat "/tmp/deploy-if-safe-$name.err" >&2
    return "$status"
  fi

  if [ "$name" != "no-update" ]; then
    local up_line ready_line status_line prune_line acquire_line cancel_forum_line
    acquire_line="$(grep -n '^forum-renew$' "$log" | tail -n 1 | cut -d: -f1)"
    if ! grep -Fq -- '--max-time\ 35.000' "$log"; then
      echo "forum admission curl must be bounded beyond the server wait timeout" >&2
      cat "$log" >&2
      return 1
    fi
    if ! grep 'deploy/admission/cancel' "$log" | grep -Fq -- '--max-time\ 5\' ||
      ! grep 'readyz' "$log" | grep -Fq -- '--max-time\ '; then
      echo "forum cancellation and readiness curls must be bounded" >&2
      cat "$log" >&2
      return 1
    fi
    cancel_forum_line="$(grep -n '^forum-cancel$' "$log" | tail -n 1 | cut -d: -f1)"
    up_line="$(grep -n '^up$' "$log" | tail -n 1 | cut -d: -f1)"
    ready_line="$(grep -n '^ready$' "$log" | tail -n 1 | cut -d: -f1)"
    status_line="$(grep -nE '^docker .*compose .* ps( |$)' "$log" | tail -n 1 | cut -d: -f1)"
    prune_line="$(grep -n 'docker image prune' "$log" | tail -n 1 | cut -d: -f1)"
    if [ -z "$acquire_line" ] || [ "$acquire_line" -ge "$up_line" ] || [ -z "$cancel_forum_line" ] || [ "$cancel_forum_line" -le "$ready_line" ] || [ "$status_line" -le "$cancel_forum_line" ] || [ "$status_line" -ge "$prune_line" ] || [ -e "$tmp/forum-admission" ]; then
      echo "applied updates must renew admission immediately before Compose, then cancel the surviving or replacement process after readiness" >&2
      cat "$log" >&2
      return 1
    fi
    if [ "$monika_current" != "$monika_target" ]; then
      local cancel_line healthy_line
      cancel_line="$(grep -n '^cancel$' "$log" | tail -n 1 | cut -d: -f1)"
      healthy_line="$(grep -n '/healthz' "$log" | tail -n 1 | cut -d: -f1)"
      if [ -z "$cancel_line" ] || [ -z "$healthy_line" ] || [ "$cancel_line" -ge "$ready_line" ] || [ "$healthy_line" -ge "$ready_line" ]; then
        echo "agentd drain cancel and healthy proof must precede forum readiness" >&2
        cat "$log" >&2
        return 1
      fi
    fi
  fi

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
      if ! grep -q '^forum-cancel-noop$' "$log"; then
        echo "forum replacement cancel should be an idempotent no-op against the new process" >&2
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
      if grep -q '^forum-cancel-noop$' "$log" || [ "$(grep -c '^forum-cancel$' "$log" || true)" -lt 1 ]; then
        echo "Monika-only deploy must explicitly cancel the surviving forum lease" >&2
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
      if grep -q '^forum-acquire$' "$log"; then
        echo "no-update deploy should not acquire forum admission" >&2
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
run_case forum-readiness-failure same same old-forum new-forum 0 0
run_case forum-acquire-response-lost same same old-forum new-forum 0 1 0
run_case forum-zero-wait same same old-forum new-forum 0 1 1 0
run_case forum-renewal-lost same same old-forum new-forum 0 1 1 30000 0

echo "deploy-if-safe drain lifecycle smoke passed"
