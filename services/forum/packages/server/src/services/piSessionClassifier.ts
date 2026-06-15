import { existsSync, readFileSync } from 'node:fs';

export type PiSessionClassifierEntry = {
  type: string;
  role?: string | null;
  text?: string;
};

export type PiSessionClassifierSummary = {
  path: string;
  cwd?: string | null;
  kind?: string | null;
};

export type ForumTarget = { parent?: string; name: string };

export type SessionClassification = {
  kind: 'normal' | 'sleep' | 'delegate' | 'fork';
  target: ForumTarget;
  forumCwd: string | null;
  reason: string;
};

type TaxonomyRule = {
  target: ForumTarget;
  cwd?: string | null;
  cwdPrefixes?: string[];
  homeKeywords?: string[];
};

type TaxonomyConfig = {
  version?: number;
  defaults?: {
    target?: ForumTarget;
    cwd?: string | null;
    homeCwds?: string[];
  };
  system?: {
    parent?: string;
    cwd?: string | null;
    sleep?: ForumTarget;
    delegate?: ForumTarget;
    fork?: ForumTarget;
  };
  rules?: TaxonomyRule[];
};

const BUILTIN_TAXONOMY: Required<Pick<TaxonomyConfig, 'defaults' | 'system' | 'rules'>> = {
  defaults: {
    target: { name: 'General' },
    cwd: process.env['MONIKA_FORUM_DEFAULT_CWD'] ?? '/workspace',
    homeCwds: ['/workspace'],
  },
  system: {
    parent: 'System',
    cwd: process.env['MONIKA_FORUM_SYSTEM_CWD'] ?? process.env['MONIKA_FORUM_DEFAULT_CWD'] ?? '/workspace',
    sleep: { name: 'Sleep' },
    delegate: { name: 'Delegates' },
    fork: { name: 'Forks' },
  },
  rules: [
    {
      target: { name: 'Monika Runtime' },
      cwd: process.env['MONIKA_FORUM_MONIKA_RUNTIME_CWD'] ?? '/workspace/monika',
      cwdPrefixes: ['/workspace/monika'],
      homeKeywords: [
        '.pi',
        'pi upgrade',
        'pi config',
        'pi system prompt',
        'model config',
        'models.json',
        'extension',
        'handoff',
        'stateful-memory',
        'memory system',
        'memory upgrade',
        'memstore',
        'wake.md',
        'facts.md',
        'sleep cycle',
        'agent browser',
        'monika container',
        'container runtime',
        'codex forum',
        'agentd',
      ],
    },
  ],
};

export type ResolvedTaxonomyConfig = {
  defaults: {
    target: ForumTarget;
    cwd: string | null;
    homeCwds: string[];
  };
  system: {
    parent: string;
    cwd: string | null;
    sleep: ForumTarget;
    delegate: ForumTarget;
    fork: ForumTarget;
  };
  rules: Array<{
    target: ForumTarget;
    cwd: string | null;
    cwdPrefixes: string[];
    homeKeywords: string[];
  }>;
};

let cachedConfig: ResolvedTaxonomyConfig | null = null;
let cachedConfigPath: string | null | undefined;

function firstUserText(entries: PiSessionClassifierEntry[]): string {
  return (
    entries.find((entry) => entry.type === 'message' && entry.role === 'user' && entry.text?.trim())?.text?.trim() ?? ''
  );
}

function isDelegateSession(entries: PiSessionClassifierEntry[]): boolean {
  return firstUserText(entries).includes('=== FOCUSED TASK MODE ===');
}

function isSleepSession(entries: PiSessionClassifierEntry[]): boolean {
  const first = firstUserText(entries);
  const sample = first.slice(0, 5000).toLowerCase();
  return (
    /^=== sleep phase:/i.test(first) ||
    sample.includes('you are running as a focused sleep fork') ||
    /(^|\n)\s*\/sleep(?:\s|$)/i.test(first) ||
    (sample.includes('sleep cycle') && (sample.includes('wake.md') || sample.includes('facts.md')))
  );
}

function classifyKind(
  session: PiSessionClassifierSummary,
  entries: PiSessionClassifierEntry[]
): SessionClassification['kind'] {
  if (isDelegateSession(entries)) return 'delegate';
  if (isSleepSession(entries)) return 'sleep';
  if (session.kind === 'fork' || session.path.includes('/forks/')) return 'fork';
  return 'normal';
}

function normalizePath(input: string | null | undefined): string {
  return (input ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function isWithinPath(cwd: string, prefix: string): boolean {
  return cwd === prefix || cwd.startsWith(`${prefix}/`);
}

function normalizeTarget(value: unknown, context: string): ForumTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} must be an object`);
  const record = value as Record<string, unknown>;
  if (typeof record['name'] !== 'string' || !record['name'].trim())
    throw new Error(`${context}.name must be a non-empty string`);
  if (record['parent'] !== undefined && record['parent'] !== null && typeof record['parent'] !== 'string') {
    throw new Error(`${context}.parent must be a string when set`);
  }
  return {
    ...(typeof record['parent'] === 'string' && record['parent'].trim() ? { parent: record['parent'].trim() } : {}),
    name: record['name'].trim(),
  };
}

function stringArray(value: unknown, context: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error(`${context} must be an array of strings`);
  return value.map((item) => item.trim()).filter(Boolean);
}

function nullableString(value: unknown, context: string, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${context} must be a string or null`);
  return value.trim() || null;
}

function resolveConfig(raw: TaxonomyConfig): ResolvedTaxonomyConfig {
  const defaultsRaw = raw.defaults ?? {};
  const systemRaw = raw.system ?? {};
  const builtinDefaults = BUILTIN_TAXONOMY.defaults;
  const builtinSystem = BUILTIN_TAXONOMY.system;
  const builtinDefaultTarget = builtinDefaults.target ?? { name: 'General' };
  const builtinDefaultCwd = builtinDefaults.cwd ?? null;
  const builtinSystemParent = builtinSystem.parent ?? 'System';
  const builtinSystemCwd = builtinSystem.cwd ?? builtinDefaultCwd;
  const systemParent =
    typeof systemRaw.parent === 'string' && systemRaw.parent.trim() ? systemRaw.parent.trim() : builtinSystemParent;

  return {
    defaults: {
      target: defaultsRaw.target ? normalizeTarget(defaultsRaw.target, 'defaults.target') : builtinDefaultTarget,
      cwd: nullableString(defaultsRaw.cwd, 'defaults.cwd', builtinDefaultCwd),
      homeCwds: stringArray(defaultsRaw.homeCwds, 'defaults.homeCwds').map(normalizePath),
    },
    system: {
      parent: systemParent,
      cwd: nullableString(systemRaw.cwd, 'system.cwd', builtinSystemCwd),
      sleep: { parent: systemParent, ...normalizeTarget(systemRaw.sleep ?? builtinSystem.sleep, 'system.sleep') },
      delegate: {
        parent: systemParent,
        ...normalizeTarget(systemRaw.delegate ?? builtinSystem.delegate, 'system.delegate'),
      },
      fork: { parent: systemParent, ...normalizeTarget(systemRaw.fork ?? builtinSystem.fork, 'system.fork') },
    },
    rules: (raw.rules ?? BUILTIN_TAXONOMY.rules).map((rule, index) => ({
      target: normalizeTarget(rule.target, `rules[${index}].target`),
      cwd: nullableString(rule.cwd, `rules[${index}].cwd`, null),
      cwdPrefixes: stringArray(rule.cwdPrefixes, `rules[${index}].cwdPrefixes`).map(normalizePath),
      homeKeywords: stringArray(rule.homeKeywords, `rules[${index}].homeKeywords`).map((keyword) =>
        keyword.toLowerCase()
      ),
    })),
  };
}

export function loadPiSessionTaxonomyConfig(): ResolvedTaxonomyConfig {
  const configPath = process.env['MONIKA_PI_SESSION_TAXONOMY_CONFIG'];
  if (cachedConfig && cachedConfigPath === configPath) return cachedConfig;

  if (!configPath) {
    cachedConfig = resolveConfig({});
    cachedConfigPath = configPath;
    return cachedConfig;
  }

  if (!existsSync(configPath)) throw new Error(`MONIKA_PI_SESSION_TAXONOMY_CONFIG does not exist: ${configPath}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(
      `Failed to read MONIKA_PI_SESSION_TAXONOMY_CONFIG ${configPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`Taxonomy config must be a JSON object: ${configPath}`);
  cachedConfig = resolveConfig(parsed as TaxonomyConfig);
  cachedConfigPath = configPath;
  return cachedConfig;
}

function targetWithSystemParent(target: ForumTarget, systemParent: string): ForumTarget {
  return { parent: target.parent ?? systemParent, name: target.name };
}

export function classifyPiSession(
  session: PiSessionClassifierSummary,
  entries: PiSessionClassifierEntry[],
  config: ResolvedTaxonomyConfig = loadPiSessionTaxonomyConfig()
): SessionClassification {
  const kind = classifyKind(session, entries);
  if (kind === 'sleep')
    return {
      kind,
      target: targetWithSystemParent(config.system.sleep, config.system.parent),
      forumCwd: config.system.cwd,
      reason: 'sleep-marker',
    };
  if (kind === 'delegate')
    return {
      kind,
      target: targetWithSystemParent(config.system.delegate, config.system.parent),
      forumCwd: config.system.cwd,
      reason: 'delegate-marker',
    };
  if (kind === 'fork')
    return {
      kind,
      target: targetWithSystemParent(config.system.fork, config.system.parent),
      forumCwd: config.system.cwd,
      reason: 'fork-path',
    };

  const cwd = normalizePath(session.cwd);
  let best: { rule: ResolvedTaxonomyConfig['rules'][number]; prefix: string } | null = null;
  for (const rule of config.rules) {
    for (const prefix of rule.cwdPrefixes) {
      if (prefix && isWithinPath(cwd, prefix) && (!best || prefix.length > best.prefix.length)) best = { rule, prefix };
    }
  }
  if (best) return { kind, target: best.rule.target, forumCwd: best.rule.cwd, reason: `cwd:${best.prefix}` };

  const homeCwds = [config.defaults.cwd, ...config.defaults.homeCwds]
    .filter((value): value is string => Boolean(value))
    .map(normalizePath);
  if (cwd && homeCwds.includes(cwd)) {
    const sample = firstUserText(entries).slice(0, 5000).toLowerCase();
    for (const rule of config.rules) {
      const keyword = rule.homeKeywords.find((value) => sample.includes(value));
      if (keyword) return { kind, target: rule.target, forumCwd: rule.cwd, reason: `home-keyword:${keyword}` };
    }
  }

  return {
    kind,
    target: config.defaults.target,
    forumCwd: config.defaults.cwd,
    reason: cwd ? 'unmapped-cwd' : 'missing-cwd',
  };
}
