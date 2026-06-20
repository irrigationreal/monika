# API Keys and Impersonation Tokens

This forum supports first-class API keys for automation and impersonation tokens for managed personas. API key and
impersonation-token management is currently admin-only.

## Integration assets

- OpenAPI spec: `docs/openapi.json` (also served at `GET /api/openapi.json` with authenticated read access) — **manual
  reference only**; the contracts in `packages/contracts/src/schemas.ts` are the canonical API boundary.
- Postman collection: `docs/postman/codex-forum.postman_collection.json` (also served at
  `GET /api/postman/collection.json` with authenticated read access)
- cURL examples: `docs/CURL_EXAMPLES.md`

## Authentication

Send the key as either:

- `Authorization: Bearer <API_KEY>`
- `X-Api-Key: <API_KEY>`

### Scopes

Scopes control what the key can do:

- `read`: Read-only operations (list forums, topics, etc.).
- `write`: Create posts, topics, upload files, manage your profile.
- `admin`: Access admin endpoints (admin panel, automations, webhooks, etc.).

`write` implies `read`. `admin` implies all scopes.

## API Keys (Admin)

Only admins can list, create, or revoke API keys through the management endpoints.

### List API keys

`GET /api/api-keys`

Returns `items: ApiKeyDto[]`.

### Create API key

`POST /api/api-keys`

Body:

```json
{
  "label": "LLM ingestion",
  "scopes": ["read", "write"],
  "expiresAt": "2026-12-31T23:59:59.000Z"
}
```

Returns:

```json
{
  "apiKey": { "id": "...", "label": "...", "tokenPrefix": "cfk_...", "scopes": ["read"], ... },
  "token": "cfk_..." // shown only once
}
```

### Revoke API key

`DELETE /api/api-keys/{id}`

Revoked keys stop working immediately.

## Impersonation Tokens (Admin)

Impersonation tokens post as a managed persona identity. Only admins can create them.

### List impersonation tokens

`GET /api/impersonation-tokens`

### Create impersonation token

`POST /api/impersonation-tokens`

Body:

```json
{
  "label": "Partner bot",
  "displayName": "Atlas",
  "avatarUrl": "https://example.com/atlas.png",
  "scopes": ["read", "write"],
  "expiresAt": null
}
```

Returns:

```json
{
  "impersonationToken": { "id": "...", "impersonatedDisplayName": "Atlas", ... },
  "token": "cfi_..." // shown only once
}
```

### Revoke impersonation token

`DELETE /api/impersonation-tokens/{id}`

## Best Practices

- Store tokens in a secrets manager.
- Rotate keys after sharing or suspected leaks.
- Use short expiration windows for temporary integrations.
- Prefer impersonation tokens for partner systems that need consistent personas.
