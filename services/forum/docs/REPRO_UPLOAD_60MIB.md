# 60MiB Upload Repro

This repro uploads a 60MiB attachment through the API so you can confirm request/body limits.

## Prereqs

- Forum server running locally (defaults to `http://localhost:4310`).
- A valid auth token from `POST /auth/login` (set as `AUTH_TOKEN`).
- Python installed (used for tiny JSON parsing in the script).

## Run the script

```bash
AUTH_TOKEN="cforum_..." \
BASE_URL="http://localhost:4310" \
./scripts/repro-upload-60mib.sh
```

Optional environment variables:

- `FORUM_ID` – reuse an existing forum instead of creating a new one.
- `FILE_PATH` – path to a pre-generated 60MiB file (defaults to `/tmp/codex-forum-60mib.bin`).

## Expected result

The script creates a forum (if needed), creates a topic + first post, then uploads the 60MiB attachment.
On success you should see output like:

```
Uploaded attachment <attachment-id> sizeBytes= 62914560
```

If you hit a 413, check:

- `CODEX_FORUM_MAX_ATTACHMENT_BYTES` / `CODEX_FORUM_MAX_REQUEST_BODY_BYTES` in the server.
- Any reverse proxy `client_max_body_size` (nginx) or equivalent.
