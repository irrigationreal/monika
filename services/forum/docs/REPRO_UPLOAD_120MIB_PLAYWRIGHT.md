# 120MiB Upload Repro (Playwright)

This repro uses the Playwright UI test runner to upload a 120MiB attachment via the New Thread flow.
It exercises the chunked upload path (threshold is 90MiB) and confirms the attachment renders on the topic view.

## Prereqs

- Forum server running locally (defaults to `http://localhost:4310`).
- UI dev server running via Playwright (`pnpm dev` is started automatically by the Playwright config).
- A user account that can log in and post in at least one forum.
- At least one forum exists to post into.

## Run the repro

```bash
cd apps/codex-forum
E2E_USERNAME="your-user" \
E2E_PASSWORD="your-pass" \
pnpm e2e -- --grep "120MiB upload repro"
```

Optional environment variables:

- `E2E_FORUM_ID` – forum id to target directly (skips clicking the first forum row).
- `PW_UPLOAD_FILE` – pre-generated 120MiB file path (defaults to `/tmp/codex-forum-120mib.bin`).

## Expected result

The test should:

1. Log in with the provided credentials.
2. Navigate to a forum and open the New Thread form.
3. Upload a 120MiB attachment and submit the thread.
4. Land on the topic page with the attachment link visible.

If you see failures:

- Verify server limits such as `CODEX_FORUM_MAX_ATTACHMENT_BYTES` and `CODEX_FORUM_MAX_REQUEST_BODY_BYTES`.
- Confirm any reverse proxy `client_max_body_size` or equivalent allows 120MiB uploads.
- Check server logs for chunked upload failures.
