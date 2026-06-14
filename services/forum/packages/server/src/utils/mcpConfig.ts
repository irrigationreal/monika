export interface McpServerConfig {
  enabled: boolean;
  serverName: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function buildMcpConfigOverrides(mcp?: McpServerConfig | null): string[] {
  if (!mcp?.enabled) return [];
  const overrides = [
    `mcp_servers.${mcp.serverName}.command=${tomlValue(mcp.command)}`,
    `mcp_servers.${mcp.serverName}.args=${tomlValue(mcp.args)}`
  ];
  if (mcp.env) {
    for (const [key, value] of Object.entries(mcp.env)) {
      if (value === undefined || value === null || value === '') continue;
      overrides.push(`mcp_servers.${mcp.serverName}.env.${key}=${tomlValue(value)}`);
    }
  }
  return overrides;
}
