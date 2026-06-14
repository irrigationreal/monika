import { discovery, Configuration, ClientSecretBasic } from 'openid-client';
import type { OidcRuntimeConfig } from './config';

let cached:
  | {
      issuerUrl: string;
      clientId: string;
      clientSecret: string;
      config: Configuration;
      fetchedAtMs: number;
    }
  | null = null;

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function getOidcClientConfig(
  oidc: OidcRuntimeConfig,
  options?: { ttlMs?: number }
): Promise<Configuration> {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();

  if (
    cached &&
    cached.issuerUrl === oidc.issuerUrl &&
    cached.clientId === oidc.clientId &&
    cached.clientSecret === oidc.clientSecret &&
    now - cached.fetchedAtMs < ttlMs
  ) {
    return cached.config;
  }

  const serverUrl = new URL(oidc.issuerUrl);
  const config = await discovery(
    serverUrl,
    oidc.clientId,
    { client_secret: oidc.clientSecret },
    // Authelia commonly uses client_secret_basic; explicitly use it so we don't
    // end up sending client_secret_post and getting invalid_client.
    // NOTE: ClientSecretBasic is a factory. We must call it to get a ClientAuth implementation.
    // Passing the factory itself results in oauth4webapi throwing: "clientSecret" must be a string.
    ClientSecretBasic()
  );

  cached = {
    issuerUrl: oidc.issuerUrl,
    clientId: oidc.clientId,
    clientSecret: oidc.clientSecret,
    config,
    fetchedAtMs: now
  };

  return config;
}
