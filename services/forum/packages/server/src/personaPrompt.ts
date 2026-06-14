export interface PersonaPromptEntry {
  key: string;
  displayName: string;
  description: string | null;
  soul: string | null;
}

export interface RenderPersonaIndexOptions {
  /**
   * Maximum characters of soul doc to inline per persona.
   * If the soul exceeds this, it is truncated and the agent is instructed to open the soul file.
   */
  maxSoulChars?: number;
  /**
   * Maximum total characters of soul docs to inline across all personas.
   * Once exceeded, remaining souls are truncated.
   */
  maxTotalSoulChars?: number;
}

export interface RenderPersonaGuideOptions {
  maxChars?: number;
  includeDescriptions?: boolean;
  includeSoulPaths?: boolean;
}

const DEFAULT_MAX_SOUL_CHARS = 12_000;
const DEFAULT_MAX_TOTAL_SOUL_CHARS = 36_000;
const DEFAULT_MAX_GUIDE_CHARS = 2_200;

export function safePersonaKey(key: string): string {
  // Persona keys are admin-defined; still, keep filenames simple.
  return key.replace(/[^a-z0-9_-]/gi, '_');
}

export function renderPersonaIndexMarkdown(personas: PersonaPromptEntry[], options?: RenderPersonaIndexOptions): string {
  if (personas.length === 0) {
    return 'No personas are configured for this forum.\n';
  }

  const maxSoulChars = Math.max(0, options?.maxSoulChars ?? DEFAULT_MAX_SOUL_CHARS);
  const maxTotalSoulChars = Math.max(0, options?.maxTotalSoulChars ?? DEFAULT_MAX_TOTAL_SOUL_CHARS);

  const lines: string[] = [];
  lines.push('Available personas (admin-defined):');
  lines.push('');
  lines.push('Rules:');
  lines.push('- Persona souls are authoritative style/behavior constraints for replies written in that persona.');
  lines.push('- If a soul is marked as truncated, open the referenced soul file before replying.');
  lines.push('');

  let totalUsed = 0;
  for (const persona of personas) {
    const desc = persona.description?.trim() ? ` — ${persona.description.trim()}` : '';
    lines.push(`- ${persona.key}: ${persona.displayName}${desc}`);

    const soul = persona.soul?.trim() ?? '';
    if (!soul) {
      continue;
    }

    const remainingTotal = Math.max(0, maxTotalSoulChars - totalUsed);
    const allowed = Math.min(maxSoulChars, remainingTotal);
    const truncated = allowed > 0 ? soul.length > allowed : soul.length > 0;
    const visible = allowed > 0 ? soul.slice(0, allowed) : '';
    totalUsed += visible.length;

    lines.push('  Soul (authoritative):');
    lines.push('  ```');
    for (const line of visible.split('\n')) {
      lines.push(`  ${line}`);
    }
    if (truncated) {
      lines.push('');
      lines.push('  [TRUNCATED]');
    }
    lines.push('  ```');
    lines.push(`  Soul file: open .codex-forum/personas/${safePersonaKey(persona.key)}.md`);
  }

  return `${lines.join('\n')}\n`;
}

export function renderPersonaGuideMarkdown(personas: PersonaPromptEntry[], options?: RenderPersonaGuideOptions): string {
  if (personas.length === 0) {
    return '';
  }

  const maxChars = Math.max(200, options?.maxChars ?? DEFAULT_MAX_GUIDE_CHARS);
  const includeDescriptions = options?.includeDescriptions ?? true;
  const includeSoulPaths = options?.includeSoulPaths ?? true;

  const lines: string[] = [];
  lines.push('[persona context]');
  lines.push('Personality (persona) files live under .codex-forum/personas/<key>.md.');
  lines.push('Persona souls are authoritative style/behavior constraints; embody them.');
  lines.push('Only use persona keys from the list below.');
  if (personas.length === 1) {
    lines.push(`Default persona: ${personas[0]!.key} (reply in this voice).`);
  } else {
    lines.push('If multiple personas are used, wrap each reply segment:');
    lines.push('[[persona:<persona_key>]] ... [[/persona]]');
  }
  lines.push('');
  lines.push('Available personas:');
  for (const persona of personas) {
    const desc = includeDescriptions && persona.description?.trim() ? ` - ${persona.description.trim()}` : '';
    lines.push(`- ${persona.key}: ${persona.displayName}${desc}`);
    if (includeSoulPaths) {
      lines.push(`  Soul file: open .codex-forum/personas/${safePersonaKey(persona.key)}.md`);
    }
  }

  return clampText(lines.join('\n'), maxChars);
}

function clampText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n…`;
}
