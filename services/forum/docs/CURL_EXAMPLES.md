# cURL Examples

All examples assume the API is reachable under the `/api` prefix.

Set your base URL:

```bash
export CODEX_FORUM_BASE_URL="https://forum.irrigate.cc"
```

## Health

```bash
curl -sS "$CODEX_FORUM_BASE_URL/api/healthz"
```

## Login (session token)

```bash
curl -sS \
  -H 'Content-Type: application/json' \
  -d '{"username":"pp","password":"pp"}' \
  "$CODEX_FORUM_BASE_URL/api/auth/login"
```

Store the returned `token`:

```bash
export CODEX_FORUM_TOKEN="cforum_..."
```

## Current user

```bash
curl -sS \
  -H "Authorization: Bearer $CODEX_FORUM_TOKEN" \
  "$CODEX_FORUM_BASE_URL/api/auth/me"
```

## List forums

```bash
curl -sS "$CODEX_FORUM_BASE_URL/api/forums" | jq
```

## Create topic

```bash
export FORUM_ID="..."

curl -sS \
  -H "Authorization: Bearer $CODEX_FORUM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"API topic","body":"Created via curl."}' \
  "$CODEX_FORUM_BASE_URL/api/forums/$FORUM_ID/topics"
```

## Reply to a topic

```bash
export TOPIC_ID="..."

curl -sS \
  -H "Authorization: Bearer $CODEX_FORUM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"body":"Reply via curl."}' \
  "$CODEX_FORUM_BASE_URL/api/topics/$TOPIC_ID/posts"
```

## API keys

API key management is admin-only. Use an admin session token for the examples in this section.

### Create API key (token returned once)

```bash
curl -sS \
  -H "Authorization: Bearer $CODEX_FORUM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"label":"curl key","scopes":["read","write"]}' \
  "$CODEX_FORUM_BASE_URL/api/api-keys"
```

Store the returned key (starts with `cfk_...`):

```bash
export CODEX_FORUM_API_KEY="cfk_..."
```

### Use API key (Authorization header)

```bash
curl -sS \
  -H "Authorization: Bearer $CODEX_FORUM_API_KEY" \
  "$CODEX_FORUM_BASE_URL/api/forums"
```

### Use API key (X-Api-Key header)

```bash
curl -sS \
  -H "X-Api-Key: $CODEX_FORUM_API_KEY" \
  "$CODEX_FORUM_BASE_URL/api/forums"
```

## Downloads

These documentation assets require authenticated read access:

```bash
curl -sS \
  -H "Authorization: Bearer $CODEX_FORUM_TOKEN" \
  "$CODEX_FORUM_BASE_URL/api/openapi.json"

curl -sS \
  -H "Authorization: Bearer $CODEX_FORUM_TOKEN" \
  "$CODEX_FORUM_BASE_URL/api/postman/collection.json"
```

- OpenAPI spec: `GET /api/openapi.json` — **manual reference only**; the contracts in
  `packages/contracts/src/schemas.ts` are the canonical API boundary.
- Postman collection: `GET /api/postman/collection.json`

## Message Templates

Create a private all-forum reply template:

```bash
curl -sS -X POST "$CODEX_FORUM_BASE_URL/api/message-templates" \
  -H "Authorization: Bearer $CODEX_FORUM_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Approval","category":"Review","body":"Approved after review.","threadTitle":null,"forumScope":"all","forumIds":[],"contexts":["reply"],"enabled":true}'
```

List templates effective in one composer (filtering and forum authorization happen server-side):

```bash
curl -sS "$CODEX_FORUM_BASE_URL/api/message-templates/effective?context=reply&forumId=$FORUM_ID" \
  -H "Authorization: Bearer $CODEX_FORUM_TOKEN"
```

All Message Template endpoints require authentication; system management additionally
requires an administrator account. Update, delete, and reorder requests must send the
current integer `revision` returned by the API. Stale revisions return `409 Conflict`.
Administrators use the same payload shape under `/api/admin/message-templates` to
manage the separate system library.
