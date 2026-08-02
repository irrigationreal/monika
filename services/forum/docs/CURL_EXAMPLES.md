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
