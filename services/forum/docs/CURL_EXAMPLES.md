# cURL Examples

All examples assume the API is under `/api`.

```bash
export CODEX_FORUM_BASE_URL="https://forum.example.com"
export FORUM_ORIGIN="https://forum.example.com"
```

## Browser-style password login (opaque cookie)

Login does not return a bearer or refresh token. It creates an independent opaque server-side session and sets an
HttpOnly cookie. `-c`/`-b` model browser cookie handling; unsafe cookie-authenticated requests must send the exact
configured base origin.

```bash
curl -sS -c forum.cookies -H 'content-type: application/json' \
  -d '{"username":"admin","password":"correct horse battery staple"}' \
  "$CODEX_FORUM_BASE_URL/api/auth/login"
curl -sS -b forum.cookies "$CODEX_FORUM_BASE_URL/api/auth/me"
```

Begin a passkey ceremony with an explicit empty JSON object. These POSTs create one-time server challenges, so the empty
object and JSON content type are part of the wire contract rather than an omitted body. The browser must complete the
returned WebAuthn options; cURL cannot perform the authenticator operation itself.

```bash
curl -sS -H 'content-type: application/json' -d '{}' \
  "$CODEX_FORUM_BASE_URL/api/auth/webauthn/login/options"
curl -sS -b forum.cookies -H "Origin: $FORUM_ORIGIN" -H 'content-type: application/json' -d '{}' \
  "$CODEX_FORUM_BASE_URL/api/me/webauthn/register/options"
```

Create an API key as the signed-in admin (the key is shown once):

```bash
curl -sS -b forum.cookies -H "Origin: $FORUM_ORIGIN" -H 'content-type: application/json' \
  -d '{"label":"curl key","scopes":["read","write"]}' \
  "$CODEX_FORUM_BASE_URL/api/api-keys"
export CODEX_FORUM_API_KEY="cfk_..."
```

API keys and impersonation tokens remain explicit automation credentials and may use either `Authorization: Bearer` or
`X-Api-Key`; they are not subject to browser CSRF origin checks.

```bash
curl -sS -H "Authorization: Bearer $CODEX_FORUM_API_KEY" "$CODEX_FORUM_BASE_URL/api/forums"

export FORUM_ID="..."
curl -sS -H "Authorization: Bearer $CODEX_FORUM_API_KEY" -H 'content-type: application/json' \
  -d '{"title":"API topic","body":"Created via curl."}' \
  "$CODEX_FORUM_BASE_URL/api/forums/$FORUM_ID/topics"

export TOPIC_ID="..."
curl -sS -H "Authorization: Bearer $CODEX_FORUM_API_KEY" -H 'content-type: application/json' \
  -d '{"body":"Reply via curl."}' "$CODEX_FORUM_BASE_URL/api/topics/$TOPIC_ID/posts"
```

## Documentation assets

```bash
curl -sS -H "Authorization: Bearer $CODEX_FORUM_API_KEY" "$CODEX_FORUM_BASE_URL/api/openapi.json"
curl -sS -H "Authorization: Bearer $CODEX_FORUM_API_KEY" "$CODEX_FORUM_BASE_URL/api/postman/collection.json"
```

The contracts in `packages/contracts/src/schemas.ts` are canonical; the generated OpenAPI file is a reference artifact.
Requests with an unsupported content type return HTTP 415 with API error code `unsupported_media_type`.

## Message templates

```bash
curl -sS -X POST "$CODEX_FORUM_BASE_URL/api/message-templates" \
  -H "Authorization: Bearer $CODEX_FORUM_API_KEY" -H 'content-type: application/json' \
  -d '{"name":"Approval","category":"Review","body":"Approved after review.","threadTitle":null,"forumScope":"all","forumIds":[],"contexts":["reply"],"enabled":true}'
```

Update, delete, and reorder requests must send the current integer `revision`.

## Quick Reply account preference

The dock default is private account state and requires the signed-in browser session:

```bash
curl -sS -X PATCH -b forum.cookies \
  -H 'Content-Type: application/json' \
  -H "Origin: $CODEX_FORUM_BASE_URL" \
  -d '{"quickReplyDockedByDefault":true}' \
  "$CODEX_FORUM_BASE_URL/api/me/preferences/quick-reply"
```

The preference defaults to `false`, is returned by `/api/auth/me`, and is intentionally omitted from public profile
responses. When enabled, eligible topic views start with the dock collapsed on desktop and mobile. Temporary dock
expansion, collapse, or undock actions do not update it.

## Private autosaved drafts

Draft APIs intentionally reject API keys and impersonation tokens. They are private browser-session endpoints; the
examples below assume an opaque session cookie captured from a same-origin browser login and the exact configured forum
origin required by CSRF protection.

```bash
curl -sS "$CODEX_FORUM_BASE_URL/api/drafts" \
  -H "Cookie: cforum_session=$CODEX_FORUM_SESSION" -H "Origin: $CODEX_FORUM_BASE_URL"

curl -sS -X PUT "$CODEX_FORUM_BASE_URL/api/topics/$TOPIC_ID/draft" \
  -H "Cookie: cforum_session=$CODEX_FORUM_SESSION" -H "Origin: $CODEX_FORUM_BASE_URL" \
  -H 'content-type: application/json' -d '{"expectedRevision":0,"body":"Unpublished reply"}'
```

Draft writes use optimistic revisions. New-thread creation is `POST /api/forums/{forumId}/drafts`; subsequent saves use
`PUT /api/drafts/{id}`. Drafts expire 30 days after their last material edit, and posting can include
`"draft":{"id":"...","revision":1}` to consume that exact revision atomically. Expect `401` without a browser session,
`403` for API-key/impersonation credentials or unavailable destinations, `404` for missing or foreign draft IDs, and
`409` when an optimistic revision is stale.
