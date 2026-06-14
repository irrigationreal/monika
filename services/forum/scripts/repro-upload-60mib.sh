#!/usr/bin/env bash
set -euo pipefail

BASE_URL=${BASE_URL:-http://localhost:4310}
AUTH_TOKEN=${AUTH_TOKEN:-}
FORUM_ID=${FORUM_ID:-}
FILE_PATH=${FILE_PATH:-/tmp/codex-forum-60mib.bin}

if [[ -z "$AUTH_TOKEN" ]]; then
  echo "AUTH_TOKEN is required (Bearer token from /auth/login)." >&2
  exit 1
fi

if [[ ! -f "$FILE_PATH" ]]; then
  echo "Generating 60MiB file at $FILE_PATH"
  dd if=/dev/zero of="$FILE_PATH" bs=1M count=60 status=progress
fi

if [[ -z "$FORUM_ID" ]]; then
  forum_payload='{"name":"Upload Repro 60MiB","description":"Temporary forum for upload repro"}'
  forum_id=$(curl -sS -X POST "$BASE_URL/forums" \
    -H "Content-Type: application/json" \
    -d "$forum_payload" \
    | python - <<'PY'
import json, sys
print(json.load(sys.stdin)["id"])
PY
  )
else
  forum_id="$FORUM_ID"
fi

topic_payload='{"title":"Upload repro 60MiB","body":"Upload repro"}'
topic_id=$(curl -sS -X POST "$BASE_URL/forums/$forum_id/topics" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -d "$topic_payload" \
  | python - <<'PY'
import json, sys
print(json.load(sys.stdin)["id"])
PY
)

post_id=$(curl -sS "$BASE_URL/topics/$topic_id/posts" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  | python - <<'PY'
import json, sys
data = json.load(sys.stdin)
print(data["items"][0]["id"])
PY
)

echo "Uploading $FILE_PATH to post $post_id"

curl -sS -X POST "$BASE_URL/posts/$post_id/attachments" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -F "file=@${FILE_PATH}" \
  | python - <<'PY'
import json, sys
payload = json.load(sys.stdin)
print("Uploaded attachment", payload["id"], "sizeBytes=", payload["sizeBytes"])
PY
