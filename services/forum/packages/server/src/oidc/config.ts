import {
  API_PREFIX,
  BASE_URL,
  OIDC_CLIENT_ID,
  OIDC_CLIENT_SECRET,
  OIDC_ENABLED,
  OIDC_ISSUER_URL,
  OIDC_PROMPT,
  OIDC_PROVIDER_KEY,
  OIDC_REDIRECT_URL,
  OIDC_SCOPES
} from '../runtimeConfig';

export type OidcRuntimeConfig = {
  enabled: boolean;
  providerKey: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  scopes: string;
  prompt: string | null;
};

export function loadOidcRuntimeConfig(): OidcRuntimeConfig | null {
  if (!OIDC_ENABLED) return null;
  if (!OIDC_ISSUER_URL || !OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET) return null;
  const redirectUrl = OIDC_REDIRECT_URL ?? `${BASE_URL}${API_PREFIX}/auth/oidc/callback`;
  return {
    enabled: true,
    providerKey: OIDC_PROVIDER_KEY,
    issuerUrl: OIDC_ISSUER_URL,
    clientId: OIDC_CLIENT_ID,
    clientSecret: OIDC_CLIENT_SECRET,
    redirectUrl,
    scopes: OIDC_SCOPES,
    prompt: OIDC_PROMPT
  };
}

