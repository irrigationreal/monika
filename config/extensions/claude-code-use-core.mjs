export const CLAUDE_CODE_DEFAULT_VERSION = "2.1.280";
export const CLAUDE_CODE_ROUTE_BETAS = Object.freeze([
  "claude-code-20250219",
  "oauth-2025-04-20",
]);

export function parseClaudeCodeUseEnabled(value) {
  if (value === undefined || value === null || String(value).trim() === "") return true;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  throw new Error("PI_CLAUDE_CODE_USE_ENABLED must be one of: 1, true, 0, false");
}

export function claudeCodeCompatibilityMode(model, usingOAuth = false) {
  if (!model || model.api !== "anthropic-messages") return "off";
  const provider = String(model.provider ?? "").trim().toLowerCase();
  if (provider === "claude") return "pool-full";
  if (provider === "anthropic" && usingOAuth) return "native-oauth-tools";
  return "off";
}

export function mergeCommaHeader(headers, name, additions) {
  const matchingKeys = Object.keys(headers).filter((key) => key.toLowerCase() === name.toLowerCase());
  const key = matchingKeys[0] ?? name;
  const values = [];
  const seen = new Set();
  const append = (value) => {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    values.push(value.trim());
  };

  for (const matchingKey of matchingKeys) {
    const current = headers[matchingKey];
    if (typeof current === "string") {
      for (const value of current.split(",")) append(value);
    }
    if (matchingKey !== key) delete headers[matchingKey];
  }
  for (const value of additions) append(value);
  headers[key] = values.join(",");
  return headers[key];
}
