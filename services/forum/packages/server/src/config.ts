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
}

export function loadFeatureFlags(): FeatureFlags {
  return {
    useRedisStreamBus: process.env['CODEX_FORUM_REDIS_STREAM_BUS'] === '1',
    enableAuth: process.env['CODEX_FORUM_ENABLE_AUTH'] === '1',
    enableRateLimiting: process.env['CODEX_FORUM_ENABLE_RATE_LIMITING'] === '1',
    enableSearch: process.env['CODEX_FORUM_ENABLE_SEARCH'] === '1'
  };
}
