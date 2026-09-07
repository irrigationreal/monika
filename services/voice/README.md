# Realtime Voice Lab frontend

This service is the small authenticated browser-facing BFF for the Gate 1
Realtime Voice Lab. It uses Node's HTTP server and a vanilla browser UI; it has
no runtime npm dependencies.

The BFF exposes only the lab's login/session, Realtime call/preview connect/disconnect and
diagnostics, bounded recall, and experimental-record routes. It is not an
agentd pass-through. The browser never receives a pool credential or ephemeral
Realtime credential: agentd mints the latter, exchanges browser SDP with the
configured media endpoint, and retains it for the sideband control connection.
Audio then flows directly between WebRTC peers. Before a call, the browser offers all ten
current Realtime voices, a microphone-free fixed-text preview (which uses API credits),
and locally persisted spoken-style/VAD/length/playback/reasoning preferences. The optional
spoken-style field tunes phrasing and vocal delivery; the deployment-level `SPOKEN.md`
remains authoritative. Voice context deliberately omits written `STYLE.md`, `REGISTER.md`,
and the topic-routing matrix; topic addenda are selected separately.
Agentd validates all settings and locks provider destinations and tool capabilities. The UI
locks call settings until disconnect.

## Authentication

Startup requires all of:

- `VOICE_PUBLIC_ORIGIN`: exact external HTTPS origin (scheme, host, and port),
  used for mutation/login Origin checks;
- `VOICE_PASSPHRASE_FILE`: absolute path to a one-line shared passphrase;
- `VOICE_AGENTD_TOKEN_FILE`: absolute path to the one-line internal token also
  configured in agentd.

A successful login creates an in-memory expiring server session and sets an
opaque `HttpOnly; Secure; SameSite=Strict` cookie. Mutation routes additionally
require the session's CSRF token and an exact Origin match. Login attempts are
bounded per directly connected address. Restarting the BFF logs everyone out.
`VOICE_SESSION_TTL_MS` defaults to eight hours.

## Experimental records

`VOICE_STATE_DIR` (default `/data/voice`) contains POC-only JSONL. The files are
outside Pi's agent/session roots and are explicitly marked `experimental` and
`canonical: false`. The browser records captions, status, interruption, usage, effective call settings,
snapshot timestamp, selected topic IDs, and bounded errors. Users can export or delete each record.

Retention defaults to 7 days, 50 files, and 20 MiB total and can be tightened
with `VOICE_RECORD_MAX_AGE_MS`, `VOICE_RECORD_MAX_FILES`, and
`VOICE_RECORD_MAX_TOTAL_BYTES`. Serialized create and append mutations enforce
count and aggregate-byte limits immediately; events above 16 KiB or events that
would make one file exceed the aggregate ceiling are rejected. Retention also
runs at startup and listing. These records never enter canonical Pi discovery
or memstore.

## Development

```bash
npm test
node src/server.mjs
```

The server deliberately fails startup without an HTTPS public origin and valid
secret files. Use [`../../tests/compose.voice-poc.yaml`](../../tests/compose.voice-poc.yaml)
for the isolated two-service stack; full operator instructions are in
[`../../docs/voice.md`](../../docs/voice.md).
