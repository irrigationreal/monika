import {
  RegistrationModeValues,
  type RegistrationMode,
  type SearchAccess,
} from '@irrigationreal/codex-forum-contracts';

export interface ServerConfig {
  host: string;
  port: number;
  publicBaseUrl: string;
  oneTimeLinkTtlSeconds: number;
}

export interface FeatureFlags {
  useRedisStreamBus: boolean;
  enableAuth: boolean;
  enableRateLimiting: boolean;
  enableSearch: boolean;
  searchAccess: SearchAccess;
  registrationMode: RegistrationMode;
}

export function parseRegistrationMode(value: string | undefined): RegistrationMode {
  if (!value) return 'disabled';
  if ((RegistrationModeValues as readonly string[]).includes(value)) {
    return value as RegistrationMode;
  }
  throw new Error(
    `Invalid CODEX_FORUM_REGISTRATION_MODE: ${value}. Expected one of: ${RegistrationModeValues.join(', ')}`
  );
}

export function loadFeatureFlags(): FeatureFlags {
  const enableAuth = process.env['CODEX_FORUM_ENABLE_AUTH'] === '1';
  const searchAccess = process.env['CODEX_FORUM_SEARCH_ACCESS'] ?? 'public';
  if (searchAccess !== 'public' && searchAccess !== 'members') {
    throw new Error(`Invalid CODEX_FORUM_SEARCH_ACCESS: ${searchAccess}. Expected public or members`);
  }
  if (searchAccess === 'members' && !enableAuth) {
    throw new Error('CODEX_FORUM_SEARCH_ACCESS=members requires CODEX_FORUM_ENABLE_AUTH=1');
  }

  return {
    useRedisStreamBus: process.env['CODEX_FORUM_REDIS_STREAM_BUS'] === '1',
    enableAuth,
    enableRateLimiting: process.env['CODEX_FORUM_ENABLE_RATE_LIMITING'] === '1',
    enableSearch: process.env['CODEX_FORUM_ENABLE_SEARCH'] === '1',
    searchAccess,
    registrationMode: parseRegistrationMode(process.env['CODEX_FORUM_REGISTRATION_MODE'])
  };
}
