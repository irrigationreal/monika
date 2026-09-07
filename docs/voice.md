# Realtime Voice Lab (Gate 1)

The Realtime Voice Lab is an isolated proof of concept, not a new canonical
conversation interface. It tests low-latency browser speech while preserving a
small, explicit trust boundary around model credentials, persona context, and
read-only recall.

## Scope and data flow

```text
Browser -- HTTPS --> voice BFF -- internal token --> agentd voice adapter
   |                                               |       |
   +<==== direct WebRTC audio =====================+       +--> isolated memstore (read only)
                                                   |
                                        provider credential mint
                                                   |
                                OpenAI Realtime SDP + sideband WebSocket
```

1. The authenticated browser creates an SDP offer and sends it to the same-origin
   voice BFF.
2. The BFF calls the exact agentd `/v1/voice/connect` route with its internal
   token. It cannot proxy arbitrary agentd paths.
3. Agentd reads a pool credential from an external secret file, requests a
   short-lived Realtime credential from the configured provider origin, and uses
   that credential server-side to exchange SDP with the configured media URL.
   No pool or ephemeral credential is returned to the browser.
4. Agentd extracts the provider call ID and attaches a server-side WebSocket with
   the same ephemeral credential. It sends `session.update` and waits for
   `session.updated` before returning the SDP answer. Tool calls and tool results
   remain on this sideband channel.
5. Browser and provider then exchange WebRTC media directly. Browser data-channel
   events drive safe-text captions and diagnostics.

The provider origin, media URL, and sideband URL are deployment configuration,
not request inputs. Media and sideband must use exact fixed paths on the same host,
so an ephemeral credential cannot be split across destinations. Provider errors are replaced with bounded generic errors.
The pool requires a browser-like User-Agent; `Mozilla/5.0` is the default.

## Gate 1 boundaries

The adapter is disabled unless `MONIKA_VOICE_ENABLED=1`. Its only model tool is
`recall_past_context`, which performs bounded `memstore_search`: queries are at
most 240 characters, results at most five, snippets at most 1,200 characters,
and combined snippets at most 4,000 characters. The POC stack gives memstore a
new named volume, so it starts empty and never opens the live database. It
remains empty at first startup even when a read-only `FACTS.md` snapshot is
mounted: snapshot prompt context is not memstore content. The compose template
includes slots for the default persona set (`SOUL`, `STYLE`, `REGISTER`, and
`PERSONALITY_MATRIX`) and the selected `FACTS`, `WAKE`, and `OBSERVATIONS`
snapshot. These are selected POC context, not live canonical history.

The voice-specific delivery preamble does not replace that core identity. It
asks for low reasoning effort and concise, natural spoken delivery without
speaking Markdown syntax, headings, bullet markers, or long structured lists.

Gate 1 deliberately has:

- no Pi session creation or dispatch;
- no Pi, shell, browser, SSH, subagent, memory-write, or action tools;
- no observation or transcript writes to memstore;
- no canonical JSONL creation, projection, or archive ingestion;
- no browser-side execution of function calls;
- no forum integration.

Sideband sessions are held only in memory, use unguessable local IDs, and close
on explicit disconnect, browser media/data-channel loss, provider sideband
loss, process shutdown, or the 60-minute Realtime lifetime. Agentd allows at
most 32 seconds for connection setup and then up to 3 seconds for independent,
best-effort cleanup; the BFF allows 40 seconds. Closing the browser response is
propagated through the BFF and agentd into setup cancellation. Once a provider
call ID exists, every failed, cancelled, expired, or explicitly closed setup
attempts `POST /v1/realtime/calls/{call_id}/hangup` with the same ephemeral
credential. Hangup is bounded, provider errors stay redacted, and cleanup
failure cannot become an unhandled rejection.

Active or connecting voice sessions appear as fail-closed agentd quiescence
blockers. Agentd rejects new voice connects while draining and rechecks drain
state after authentication and request-body awaits, before provider setup.

## Authentication and local records

The public BFF fails startup unless it has an exact external HTTPS origin, a
passphrase file, and an internal-agentd-token file. Login creates an expiring
server-side session. The browser receives only an opaque `HttpOnly; Secure;
SameSite=Strict` cookie and a CSRF token; every mutation checks both the token and
an exact `Origin` value. Logout destroys the server session.

Captions and diagnostics can be retained only as bounded experimental JSONL in
the voice container's `/data/voice`. Files are marked noncanonical, live outside
Pi discovery, default to 7-day/50-file/20-MiB retention, and can be exported or
deleted in the UI. Record creates, appends, deletes, and pruning are serialized.
Every create and append enforces file count and aggregate bytes immediately,
preferentially retaining the file just created or appended by evicting older
records when possible. An event is rejected above 16 KiB or when it would make
its own file exceed the configured aggregate ceiling (20 MiB by default);
retained aggregate size never exceeds that ceiling. These records are not
memory origins.

## Isolated startup

[`../tests/compose.voice-poc.yaml`](../tests/compose.voice-poc.yaml) defines exactly
two services and two new named state volumes. It mounts no workspace, live state,
live memstore, Pi sessions, or secrets. Its `/dev/null` secret defaults make the
stack fail closed until explicit files are selected.

Create separate one-line files for the provider credential, passphrase, and
shared internal token in an externally custodied directory (directory mode
`0700`). Do not place them in the repository or a workspace visible to tools,
and never make them world-readable to work around container permissions. The
voice frontend runs as UID 1000, so its passphrase and internal-token files must
be owned by UID 1000 and mode `0600` (or otherwise be narrowly readable by that
UID). The runtime reads the provider key and persona snapshot as root; those
files may remain root-owned and mode `0600`. Select read-only persona and
`FACTS` snapshot files rather than the live mutable persona directory:

```bash
export VOICE_PUBLIC_ORIGIN='https://stanza.tawny-stork.ts.net:8443'
export VOICE_PROVIDER_KEY_HOST_FILE=/outside/workspace/voice/provider-key
export VOICE_PASSPHRASE_HOST_FILE=/outside/workspace/voice/passphrase
export VOICE_INTERNAL_TOKEN_HOST_FILE=/outside/workspace/voice/internal-token
export VOICE_PERSONA_SOUL_HOST_FILE=/outside/workspace/voice/persona/SOUL.md
export VOICE_PERSONA_STYLE_HOST_FILE=/outside/workspace/voice/persona/STYLE.md
export VOICE_PERSONA_REGISTER_HOST_FILE=/outside/workspace/voice/persona/REGISTER.md
export VOICE_PERSONA_MATRIX_HOST_FILE=/outside/workspace/voice/persona/PERSONALITY_MATRIX.md
export VOICE_CONTEXT_FACTS_HOST_FILE=/outside/workspace/voice/persona/FACTS.md
export VOICE_CONTEXT_WAKE_HOST_FILE=/outside/workspace/voice/persona/WAKE.md
export VOICE_CONTEXT_OBSERVATIONS_HOST_FILE=/outside/workspace/voice/persona/OBSERVATIONS.md
export MONIKA_VOICE_ENABLED=1

docker compose -f tests/compose.voice-poc.yaml up -d --build
curl -fsS http://127.0.0.1:4320/healthz
```

The runtime derivative starts from the pinned coordinated Monika image and copies
only agentd's manifest, lock, and source so its explicit `ws` dependency is
present. The proper release path is a normal root `Containerfile` build, which
also installs/tests the same frozen agentd dependency set. A source-only read-only
bind is not sufficient after adding `ws` unless the selected base image already
contains that exact declared dependency.

To publish on the planned tailnet port without changing the existing HTTPS 443
root or `/pi` handlers, inspect the current Serve configuration, then add only
the separate listener:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:4320
```

The exact browser origin must remain the configured 8443 URL. Teardown only that
listener with `tailscale serve --https=8443 off`; never use a reset command,
which would also remove unrelated handlers.

Stop and remove only the POC stack when finished:

```bash
docker compose -f tests/compose.voice-poc.yaml down
docker compose -f tests/compose.voice-poc.yaml down -v # also deletes POC records and isolated memstore
```

## Configuration reference

### agentd

| Variable | Purpose |
|---|---|
| `MONIKA_VOICE_ENABLED` | Exact `1` enables all voice routes; disabled by default |
| `MONIKA_VOICE_INTERNAL_TOKEN_FILE` | Absolute one-line BFF token file |
| `MONIKA_VOICE_PROVIDER_API_BASE_URL` | HTTPS origin used only for fixed `/v1/realtime/client_secrets` |
| `MONIKA_VOICE_PROVIDER_API_KEY_FILE` | Absolute one-line pool/API credential file |
| `MONIKA_VOICE_PROVIDER_USER_AGENT` | Credential mint User-Agent; default `Mozilla/5.0` |
| `MONIKA_VOICE_MEDIA_URL` | Fixed HTTPS `/v1/realtime/calls` URL |
| `MONIKA_VOICE_SIDEBAND_URL` | Fixed WSS `/v1/realtime` URL |
| `MONIKA_VOICE_MODEL` | Realtime model; default `gpt-realtime-2.1` |
| `MONIKA_VOICE_VOICE` | Output voice; default `marin` |
| `MONIKA_VOICE_PERSONA_FILES` | Colon-separated bounded, read-only persona files |
| `MONIKA_VOICE_CONTEXT_FILES` | Colon-separated selected POC snapshot files, labeled non-live/incomplete in context |

### voice BFF

| Variable | Purpose |
|---|---|
| `VOICE_PUBLIC_ORIGIN` | Exact external HTTPS origin used for CSRF checks |
| `VOICE_PASSPHRASE_FILE` | Absolute one-line shared passphrase file |
| `VOICE_AGENTD_TOKEN_FILE` | Absolute one-line internal agentd token file |
| `MONIKA_AGENTD_BASE_URL` | Internal HTTP origin, never exposed as a generic proxy |
| `VOICE_STATE_DIR` | Experimental record directory |
| `VOICE_SESSION_TTL_MS` | Server login lifetime; default 8 hours |
| `VOICE_RECORD_MAX_AGE_MS` | Record age bound; default 7 days |
| `VOICE_RECORD_MAX_FILES` | Record count bound; default 50 |
| `VOICE_RECORD_MAX_TOTAL_BYTES` | Aggregate/read bound; default 20 MiB |

## Validation and known gaps

All automated tests use fake HTTP/WebSocket/memstore boundaries and no provider
credential. They cover disabled behavior, internal and browser authentication,
CSRF and exact-route boundaries, provider failure redaction, recall bounds,
sideband tool execution/close, record lifecycle, and retention.

Gate 1 does not provide canonical continuity, live memory, durable sideband
recovery, multi-user identity, TURN configuration, or guaranteed caption
completeness. Browser/provider compatibility and tailnet proxy behavior remain a
manual canary. Provider usage and errors shown by the UI are diagnostics, not a
billing ledger.
