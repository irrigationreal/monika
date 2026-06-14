# Playwright Upload Repro

This repro drives the UI with Playwright to upload a large attachment via the Quick Reply box. Use it when you want to validate the browser flow or confirm UI + API limits in one pass.

## Prereqs

- Node + pnpm installed.
- Forum API server running locally (defaults to `http://localhost:4310`).
- Auth enabled so the login modal can authenticate.

## Start the API server

```bash
CODEX_FORUM_ENABLE_AUTH=1 \
CODEX_FORUM_BOOTSTRAP_ADMIN_USERNAME=pp \
CODEX_FORUM_BOOTSTRAP_ADMIN_PASSWORD='Propane123!' \
CODEX_FORUM_BOOTSTRAP_ADMIN_DISPLAY_NAME=pp \
pnpm --filter @irrigationreal/codex-forum-server dev
```

The server bootstraps an admin account from the env vars above:

- **Username:** `pp`
- **Password:** `Propane123!`

## Run the Playwright repro

From the repo root:

```bash
UPLOAD_REPRO=1 \
UPLOAD_REPRO_USERNAME=pp \
UPLOAD_REPRO_PASSWORD='Propane123!' \
pnpm --filter @irrigationreal/codex-forum e2e -- --grep "Upload repro"
```

### Optional environment overrides

- `UPLOAD_REPRO_SIZE_MIB` – file size to upload (default: `60`).
- `UPLOAD_REPRO_FORUM_TITLE` – forum to open (default: `Codex Forum`).
- `UPLOAD_REPRO_TOPIC_TITLE` – topic to reply to (default: `UI upload repro`).

## Expected result

The test logs in, opens the seeded **UI upload repro** topic, posts a reply with the attachment, and waits for the uploaded filename to render in the post.

If the upload fails with a 413, check:

- `CODEX_FORUM_MAX_ATTACHMENT_BYTES` / `CODEX_FORUM_MAX_REQUEST_BODY_BYTES` on the server.
- Any reverse proxy `client_max_body_size` (nginx) or equivalent.
