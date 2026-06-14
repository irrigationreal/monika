import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type {
  AdminSkillAvailabilityDto,
  AdminSkillDto,
  AdminSkillListResponseDto,
  AdminSkillRootDto
} from '@irrigationreal/codex-forum-contracts';
import type { ForumStore } from '../store';
import { PROMPT_ENHANCER_ENABLED } from '../runtimeConfig';
import { parseTamperConfigJson } from './tamper';
import type { TamperConfigRow } from '../db';

const PROMPT_ENHANCER_KEY = 'prompt.enhancer';
const DEFAULT_SKILLS_ROOT = '/root/work/skills';

function safeReadFirstHeading(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^#{1,3}\s+(.*)$/);
    if (match?.[1]?.trim()) return match[1].trim();
    // If the first non-empty line isn't a heading, stop trying.
    break;
  }
  return null;
}

function safeReadExcerpt(markdown: string, maxChars = 180): string | null {
  const lines = markdown.split(/\r?\n/);
  let seenHeading = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!seenHeading && /^#{1,6}\s+/.test(trimmed)) {
      seenHeading = true;
      continue;
    }
    // First paragraph-ish line after the heading.
    const excerpt = trimmed.replace(/\s+/g, ' ').slice(0, maxChars);
    return excerpt || null;
  }
  return null;
}

function listSkillFiles(root: string, opts?: { maxFiles?: number; maxDepth?: number }): string[] {
  const maxFiles = opts?.maxFiles ?? 500;
  const maxDepth = opts?.maxDepth ?? 12;
  const out: string[] = [];

  function walk(dir: string, depth: number): void {
    if (out.length >= maxFiles) return;
    if (depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as import('node:fs').Dirent[];
    } catch {
      return;
    }

    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      // Skip typical heavy directories.
      if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name === '.git')) continue;

      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;
      if (entry.name !== 'SKILL.md') continue;
      out.push(full);
    }
  }

  walk(root, 0);
  return out;
}

function isSystemSkill(relativePath: string): boolean {
  // The convention for built-in skills is usually: <root>/.system/<skill-name>/SKILL.md
  return relativePath.split('/').includes('.system');
}

function resolveSkillsRootFromConfig(config: TamperConfigRow): string {
  const parsed = parseTamperConfigJson(config.config_json);
  const candidate = typeof parsed?.['skillsRoot'] === 'string' ? parsed['skillsRoot'].trim() : '';
  return candidate || DEFAULT_SKILLS_ROOT;
}

export function buildAdminSkillsCatalog({ store }: { store: ForumStore }): AdminSkillListResponseDto {
  const generatedAt = new Date().toISOString();

  // We keep this implementation intentionally lightweight:
  // - Roots come from all prompt enhancer tamper configs (global + forum-level).
  // - Skills are discovered by scanning for SKILL.md under each unique root.
  const allConfigs = store.listTamperConfigs();
  const enhancerConfigs = allConfigs.filter((c) => c.plugin_key === PROMPT_ENHANCER_KEY);

  const roots = new Map<string, { usedByForumIds: Set<string> }>();
  for (const cfg of enhancerConfigs) {
    const root = resolveSkillsRootFromConfig(cfg);
    if (!roots.has(root)) roots.set(root, { usedByForumIds: new Set() });
    if (cfg.forum_id) roots.get(root)!.usedByForumIds.add(cfg.forum_id);
  }

  // If nothing configured, still show the default root for observability.
  if (roots.size === 0) {
    roots.set(DEFAULT_SKILLS_ROOT, { usedByForumIds: new Set() });
  }

  // Build availability map per root.
  const availabilityByRoot = new Map<string, AdminSkillAvailabilityDto[]>();
  for (const cfg of enhancerConfigs) {
    const root = resolveSkillsRootFromConfig(cfg);
    const list = availabilityByRoot.get(root) ?? [];
    if (!availabilityByRoot.has(root)) availabilityByRoot.set(root, list);

    if (cfg.forum_id) {
      const forum = store.getForum(cfg.forum_id);
      list.push({
        forumId: cfg.forum_id,
        forumName: forum?.name ?? cfg.forum_id,
        configScope: 'forum',
        promptEnhancerEnabled: Boolean(cfg.enabled),
        personas: []
      });
    } else {
      list.push({
        forumId: 'global',
        forumName: 'global',
        configScope: 'global',
        promptEnhancerEnabled: Boolean(cfg.enabled),
        personas: []
      });
    }
  }

  const rootDtos: AdminSkillRootDto[] = [];
  const items: AdminSkillDto[] = [];

  for (const [root, meta] of roots.entries()) {
    const exists = existsSync(root);
    const skillFiles = exists ? listSkillFiles(root) : [];
    rootDtos.push({
      root,
      exists,
      skillCount: skillFiles.length,
      usedByForumIds: Array.from(meta.usedByForumIds.values())
    });

    for (const filePath of skillFiles) {
      const rel = relative(root, filePath).replaceAll('\\', '/');
      const key = basename(dirname(filePath));
      let bytes = 0;
      let updatedAt: string | null = null;
      let title: string | null = null;
      let excerpt: string | null = null;
      try {
        const stat = statSync(filePath);
        bytes = stat.size;
        updatedAt = stat.mtime ? new Date(stat.mtime).toISOString() : null;
        const md = readFileSync(filePath, 'utf8');
        title = safeReadFirstHeading(md);
        excerpt = safeReadExcerpt(md);
      } catch {
        // Keep defaults; still include the file so admins can see it exists.
      }

      const scope: 'system' | 'user' = isSystemSkill(rel) ? 'system' : 'user';
      const availableIn = availabilityByRoot.get(root) ?? [];

      items.push({
        id: `${root}:${rel}`,
        key,
        title: title ?? key,
        scope,
        root,
        path: filePath,
        bytes,
        updatedAt,
        excerpt,
        availableIn
      });
    }
  }

  // Stable ordering for UI readability.
  rootDtos.sort((a, b) => a.root.localeCompare(b.root));
  items.sort((a, b) => {
    const byScope = a.scope.localeCompare(b.scope);
    if (byScope !== 0) return byScope;
    const byKey = a.key.localeCompare(b.key);
    if (byKey !== 0) return byKey;
    return a.path.localeCompare(b.path);
  });

  return {
    generatedAt,
    promptEnhancerEnabledByDefault: PROMPT_ENHANCER_ENABLED,
    defaultSkillsRoot: DEFAULT_SKILLS_ROOT,
    roots: rootDtos,
    items
  };
}
