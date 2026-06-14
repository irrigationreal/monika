import type { FastifyInstance } from 'fastify';
import { buildAuthorizationUrl, authorizationCodeGrant, calculatePKCECodeChallenge, randomPKCECodeVerifier } from 'openid-client';
import { generateToken, verifyPassword } from '../utils/auth';
import type { ForumStore } from '../store';
import type { AccessHelpers } from '../utils/access';
import { loadOidcRuntimeConfig } from './config';
import { getOidcClientConfig } from './client';
import { createInMemoryOidcStateStore } from './state';

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const oidcStateStore = createInMemoryOidcStateStore();

export function registerOidcRoutes({
  app,
  store,
  access
}: {
  app: FastifyInstance;
  store: ForumStore;
  access: AccessHelpers;
}): void {
  const { getCurrentUser } = access;

  app.get('/auth/oidc/enabled', async () => {
    const oidc = loadOidcRuntimeConfig();
    return { enabled: Boolean(oidc?.enabled), providerKey: oidc?.providerKey ?? null };
  });

  app.get('/auth/oidc/start', async (_request, reply) => {
    const oidc = loadOidcRuntimeConfig();
    if (!oidc) {
      throw app.httpErrors.notFound('OIDC not enabled');
    }
    const clientConfig = await getOidcClientConfig(oidc);
    const pkceCodeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(pkceCodeVerifier);
    const state = oidcStateStore.create({ pkceCodeVerifier });
    const authorizeUrl = buildAuthorizationUrl(clientConfig, {
      redirect_uri: oidc.redirectUrl,
      response_type: 'code',
      scope: oidc.scopes,
      state: state.state,
      nonce: state.nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      ...(oidc.prompt ? { prompt: oidc.prompt } : {})
    });

    return reply.redirect(authorizeUrl.toString());
  });

  app.get('/auth/oidc/start/link', async (request, reply) => {
    const oidc = loadOidcRuntimeConfig();
    if (!oidc) {
      throw app.httpErrors.notFound('OIDC not enabled');
    }

    const auth = getCurrentUser(request as any);
    if (!auth) {
      throw app.httpErrors.unauthorized('Authentication required');
    }

    const clientConfig = await getOidcClientConfig(oidc);
    const pkceCodeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(pkceCodeVerifier);
    const state = oidcStateStore.create({ pkceCodeVerifier, forumIdentityId: auth.identityId });

    const authorizeUrl = buildAuthorizationUrl(clientConfig, {
      redirect_uri: oidc.redirectUrl,
      response_type: 'code',
      scope: oidc.scopes,
      state: state.state,
      nonce: state.nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      ...(oidc.prompt ? { prompt: oidc.prompt } : {})
    });

    // Browser navigations cannot attach Authorization headers, so the SPA should
    // first fetch this endpoint with auth and then redirect client-side.
    // Support a JSON mode for that flow.
    const accept = String((request.headers as any)?.accept ?? '');
    const query = (request.query ?? {}) as Record<string, unknown>;
    const wantsJson = query['format'] === 'json' || query['json'] === '1' || accept.includes('application/json');
    if (wantsJson) {
      return { authorizeUrl: authorizeUrl.toString() };
    }

    return reply.redirect(authorizeUrl.toString());
  });

  app.get('/auth/oidc/callback', async (request, reply) => {
    const oidc = loadOidcRuntimeConfig();
    if (!oidc) {
      throw app.httpErrors.notFound('OIDC not enabled');
    }
    const clientConfig = await getOidcClientConfig(oidc);

    // IMPORTANT: the token exchange validates `redirect_uri` against what was used
    // in the authorize request. openid-client derives the redirect_uri by stripping
    // query params from `currentUrl`. If we base this on http://localhost (or any
    // internal host), Authelia will reject the code with `invalid_grant`.
    //
    // Use the externally configured redirect URL as the base so the derived
    // redirect_uri matches the one registered in Authelia and sent in /start.
    const currentUrl = new URL(String(request.url), oidc.redirectUrl);
    const stateFromQuery = currentUrl.searchParams.get('state');
    if (!stateFromQuery) {
      throw app.httpErrors.badRequest('Missing state');
    }

    const authState = oidcStateStore.consume(stateFromQuery);
    if (!authState) {
      throw app.httpErrors.badRequest('Invalid or expired state');
    }

    const tokens = await authorizationCodeGrant(
      clientConfig,
      currentUrl,
      {
        expectedState: stateFromQuery,
        expectedNonce: authState.nonce,
        pkceCodeVerifier: authState.pkceCodeVerifier
      }
    );

    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== 'string' || !claims.sub) {
      throw app.httpErrors.unauthorized('OIDC token missing subject');
    }

    const external = store.getExternalIdentityBySubject(oidc.providerKey, oidc.issuerUrl, claims.sub);
    if (external) {
      store.touchExternalIdentityLogin(external.id);
      const token = generateToken('cforum_access');
      const refreshToken = generateToken('cforum_refresh');
      store.createAuthSession(token, external.identity_id);
      store.createRefreshSession(refreshToken, external.identity_id);

      // Complete login by storing tokens in localStorage then redirecting back to the SPA.
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="cache-control" content="no-store" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Signing in…</title>
  </head>
  <body>
    <script>
      (function () {
        try {
          localStorage.setItem('cforum_auth_token', ${JSON.stringify(token)});
          localStorage.setItem('cforum_refresh_token', ${JSON.stringify(refreshToken)});
        } catch (e) {
          // ignore storage errors
        }
        window.location.replace('/');
      })();
    </script>
    <noscript>
      <p>Signed in. <a href="/">Continue</a></p>
    </noscript>
  </body>
</html>`);
    }

    // Not linked yet.
    // If we started the flow from an authenticated forum session, link to that identity.
    const linkingIdentityId = authState.forumIdentityId ?? null;
    const auth = linkingIdentityId ? { identityId: linkingIdentityId } : getCurrentUser(request as any);
    if (auth) {
      // Ensure identity exists.
      const identity = store.getIdentity(auth.identityId);
      if (!identity || !identity.username) {
        throw app.httpErrors.badRequest('Current account does not have a username; set one before linking OIDC');
      }
      store.createExternalIdentityLink({
        identityId: auth.identityId,
        providerKey: oidc.providerKey,
        issuer: oidc.issuerUrl,
        subject: claims.sub
      });

      // Linking was initiated from an authenticated session; send user back to profile.
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="cache-control" content="no-store" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Linked</title>
  </head>
  <body>
    <script>
      (function () {
        window.location.replace('/profile?linked=1');
      })();
    </script>
    <noscript>
      <p>Linked. <a href="/profile?linked=1">Continue</a></p>
    </noscript>
  </body>
</html>`);
    }

    // Otherwise require username+password to prove ownership and then link.
    // Return a one-time state key the UI can use to complete.
    // For now, we just return the subject so the UI can call complete endpoint.
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return reply.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="cache-control" content="no-store" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Link account</title>
  </head>
  <body>
    <script>
      (function () {
        var subject = ${JSON.stringify(claims.sub)};
        var issuer = ${JSON.stringify(oidc.issuerUrl)};
        var providerKey = ${JSON.stringify(oidc.providerKey)};
        var url = '/oidc/link?subject=' + encodeURIComponent(subject) + '&issuer=' + encodeURIComponent(issuer) + '&providerKey=' + encodeURIComponent(providerKey);
        window.location.replace(url);
      })();
    </script>
    <noscript>
      <p>Continue to link: <a href="/oidc/link?subject=${escapeHtml(encodeURIComponent(claims.sub))}&issuer=${escapeHtml(encodeURIComponent(oidc.issuerUrl))}&providerKey=${escapeHtml(encodeURIComponent(oidc.providerKey))}">Link account</a></p>
    </noscript>
  </body>
</html>`);
  });

  app.post('/auth/oidc/link', async (request) => {
    const oidc = loadOidcRuntimeConfig();
    if (!oidc) {
      throw app.httpErrors.notFound('OIDC not enabled');
    }

    const body = request.body as {
      username?: string;
      password?: string;
      issuer?: string;
      subject?: string;
      providerKey?: string;
    };

    if (!body.username || !body.password || !body.subject) {
      throw app.httpErrors.badRequest('username, password, and subject are required');
    }

    // Ownership proof via local password login.
    const identity = store.getIdentityByUsername(body.username);
    if (!identity || !identity.password_hash) {
      throw app.httpErrors.unauthorized('Invalid credentials');
    }
    const valid = await verifyPassword(body.password, identity.password_hash);
    if (!valid) {
      throw app.httpErrors.unauthorized('Invalid credentials');
    }

    const providerKey = body.providerKey ?? oidc.providerKey;
    const issuer = body.issuer ?? oidc.issuerUrl;

    const existing = store.getExternalIdentityBySubject(providerKey, issuer, body.subject);
    if (existing && existing.identity_id !== identity.id) {
      throw app.httpErrors.conflict('OIDC identity is already linked to another forum account');
    }
    if (!existing) {
      store.createExternalIdentityLink({ identityId: identity.id, providerKey, issuer, subject: body.subject });
    }

    const token = generateToken('cforum_access');
    const refreshToken = generateToken('cforum_refresh');
    store.createAuthSession(token, identity.id);
    store.createRefreshSession(refreshToken, identity.id);
    return { token, refreshToken, linked: true };
  });

  app.get('/auth/oidc/links', async (request) => {
    const oidc = loadOidcRuntimeConfig();
    if (!oidc) {
      throw app.httpErrors.notFound('OIDC not enabled');
    }
    const auth = getCurrentUser(request as any);
    if (!auth) {
      throw app.httpErrors.unauthorized('Authentication required');
    }

    const items = store.listExternalIdentitiesForIdentity(auth.identityId).map((row) => ({
      id: row.id,
      providerKey: row.provider_key,
      issuer: row.issuer,
      subject: row.subject,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at
    }));

    return { items };
  });

  app.post('/auth/oidc/unlink', async (request) => {
    const oidc = loadOidcRuntimeConfig();
    if (!oidc) {
      throw app.httpErrors.notFound('OIDC not enabled');
    }
    const auth = getCurrentUser(request as any);
    if (!auth) {
      throw app.httpErrors.unauthorized('Authentication required');
    }

    const body = request.body as { externalIdentityId?: string };
    if (!body.externalIdentityId) {
      throw app.httpErrors.badRequest('externalIdentityId is required');
    }

    return store.deleteExternalIdentityLink(body.externalIdentityId, auth.identityId);
  });
}
