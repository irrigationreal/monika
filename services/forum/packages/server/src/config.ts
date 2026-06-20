import { RegistrationModeValues, type RegistrationMode } from '@irrigationreal/codex-forum-contracts';

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
  return {
    useRedisStreamBus: process.env['CODEX_FORUM_REDIS_STREAM_BUS'] === '1',
    enableAuth: process.env['CODEX_FORUM_ENABLE_AUTH'] === '1',
    enableRateLimiting: process.env['CODEX_FORUM_ENABLE_RATE_LIMITING'] === '1',
    enableSearch: process.env['CODEX_FORUM_ENABLE_SEARCH'] === '1',
    registrationMode: parseRegistrationMode(process.env['CODEX_FORUM_REGISTRATION_MODE'])
  };
}
