# Public forum ingress

The production forum is published at `https://www.vmonika.com` through a
dedicated, remotely managed Cloudflare Tunnel. Stanza accepts no public inbound
HTTP traffic: `cloudflared` connects outbound to Cloudflare and reaches the forum
through the private Compose network.

```text
Internet -> Cloudflare -> vmonika-stanza tunnel -> cloudflared -> forum:4310
```

`agentd` remains loopback-only on the host and is never a tunnel origin. Compose
places Monika and the forum on a `backend` network while only the forum and
cloudflared share the separate `ingress` network. The connector therefore cannot
resolve or route to `monika:7724`, even if its remote ingress configuration is
mistakenly changed. The forum is published to the host only on `127.0.0.1:4310` for
health checks, deployment quiescence, and break-glass administration.

## Canonical host and redirects

`www.vmonika.com` is the only tunnel hostname. Cloudflare Single Redirect rules
perform permanent `308` redirects, preserving the complete path and query string:

- `vmonika.com` -> `www.vmonika.com`
- `vmonika.net` and `www.vmonika.net` -> `www.vmonika.com`
- `vmonika.org` and `www.vmonika.org` -> `www.vmonika.com`

The redirect-only names have proxied DNS records so Cloudflare can execute the
rules, but they are not tunnel ingress hostnames. Do not add a wildcard tunnel
route: `voice.vmonika.com` and `turn.vmonika.com` are intentionally unclaimed for
future realtime voice infrastructure.

Cloudflare caching is bypassed for the canonical host at launch. This prevents
authenticated API responses or attachment authorization decisions from becoming
shared edge cache entries. Cache only explicitly reviewed immutable assets later.

## Compose profile

Public ingress is an opt-in Compose profile so generic/local deployments do not
require a Cloudflare credential:

```bash
docker compose --profile public-ingress up -d --no-deps cloudflared
```

The connector is digest-pinned in `compose.yaml.example`, runs as the image's
unprivileged UID, has a read-only root filesystem and no Linux capabilities, and
reads only this credential:

```text
/persist/keys/cloudflared-vmonika.token
```

The connector token must stay outside `MONIKA_WORKSPACE`. The entire repository
parent is mounted at `/workspace` inside both application containers, so storing the
token anywhere below `/home/monika/repos` would expose it to agent tools. Install it
in Shadowsea's root-controlled key custody:

```bash
sudo install -o 65532 -g 65532 -m 0400 /path/to/connector-token \
  /persist/keys/cloudflared-vmonika.token
```

The remotely managed tunnel stores ingress configuration at Cloudflare. Its
connector token authorizes only that tunnel; it cannot edit DNS, redirect rules,
or other account resources.

Stanza sets `MONIKA_PUBLIC_INGRESS=1` for the quiescence-gated redeploy unit. Every
deploy attempt independently reconciles only `cloudflared` with `--no-deps`, even
when no application image changed. Application updates are then applied to exactly
the changed service with `--no-deps`, so a forum-only deploy cannot recreate
Monika because of unrelated Compose drift. The autodeployer still pulls only the
coordinated Monika and forum images. Cloudflared image/config updates are deliberate
checkout changes rather than an unattended `latest` pull.

## Forum production settings

The live deployment stores non-secret Compose interpolation in the ignored,
backup-included repository `.env` file:

```env
CODEX_FORUM_BASE_URL=https://www.vmonika.com
CODEX_FORUM_TRUST_PROXY=1
CODEX_FORUM_ENABLE_RATE_LIMITING=1
MONIKA_FORUM_BIND=127.0.0.1:4310:4310
```

Trusting one proxy hop is safe only because direct non-loopback origin access is
removed. Do not restore an all-interface forum binding while forwarded client IPs
are trusted; callers could spoof proxy headers and evade anonymous rate limits.

Authentication stays enabled, self-registration stays disabled, and route-specific
rate limiting stays enabled. Before exposing a restored database, inspect public
forum/topic visibility and test anonymous attachment access from outside the
tailnet.

## Provisioning credentials

One-time automation should use a short-lived Cloudflare API token restricted to the
Cloudflare account and the three vMonika zones, with:

- Account: `Cloudflare Tunnel: Edit`
- Zone: `Zone: Read`
- Zone: `DNS: Edit`
- Zone: `Single Redirect: Edit`
- Zone: `Cache Rules: Edit`

After creating the tunnel, DNS records, redirect rules, cache-bypass rule, and
connector token, delete the local API token and revoke it in Cloudflare. Only the
connector token remains at runtime.

## Verification

```bash
# Origin is loopback-only.
sudo ss -lntp | grep ':4310'

# Local health remains available to host automation.
curl -fsS http://127.0.0.1:4310/healthz

# Tunnel state and canonical response.
docker compose --profile public-ingress ps forum cloudflared
curl -fsS https://www.vmonika.com/healthz

# Every alias must preserve path and query in a 308 Location header.
for host in vmonika.com vmonika.net www.vmonika.net vmonika.org www.vmonika.org; do
  curl -fsSI "https://$host/test/path?source=redirect-check" | sed -n '1p;/^location:/Ip'
done
```

Also verify login, public/private visibility, attachment upload/download, SSE turn
streaming, anonymous rate-limit client identity, minimal public health output, and
that `127.0.0.1:7724` has no external route.

## Recovery

The ignored `.env` deployment settings are part of the runtime capsule and off-host
Monika backups. The connector token deliberately is not: it lives outside the
application-visible workspace under `/persist/keys` and must come from separate
root credential custody or be rotated in Cloudflare. On a recovered Stanza host,
verify `.env`, restore or rotate the connector token, start Monika/forum normally,
then start ingress explicitly:

```bash
docker compose up -d monika forum
docker compose --profile public-ingress up -d --no-deps cloudflared
```

If the connector credential may have escaped custody, rotate the tunnel token in
Cloudflare before restoring service. DNS and redirect rules are Cloudflare-owned
state and must be checked separately during disaster recovery.
