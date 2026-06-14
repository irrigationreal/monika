import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export type KnowledgeDocKind = 'skill' | 'kb';

export interface KnowledgeDoc {
  kind: KnowledgeDocKind;
  path: string;
  title: string;
  excerpt: string;
  score: number;
}

type IndexedDoc = {
  kind: KnowledgeDocKind;
  path: string;
  title: string;
  content: string;
  textLower: string;
  titleLower: string;
  pathLower: string;
  tokens: Set<string>;
};

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'these', 'those',
  'you', 'your', 'are', 'was', 'were', 'will', 'can', 'could', 'should',
  'have', 'has', 'had', 'into', 'over', 'under', 'about', 'when', 'what',
  'how', 'why', 'use', 'using', 'used', 'want', 'need', 'make', 'made',
  'also', 'than', 'then', 'there', 'here', 'them', 'they', 'their',
  'our', 'out', 'its', 'it', 'as', 'at', 'by', 'on', 'in', 'to', 'of'
]);

const DEFAULT_MAX_SKILL_BYTES = 40_000;
const DEFAULT_MAX_KB_BYTES = 30_000;
const DEFAULT_MAX_PREFACE_CHARS = 2200;

export interface PromptEnhancerConfig {
  skillsRoot?: string | null;
  kbRoot?: string | null;
  maxDocs?: number;
  perKindLimit?: number;
  maxPrefaceChars?: number;
  trigger?: string | null;
  stripTrigger?: boolean;
  onlyFirstMessage?: boolean;
}

export interface NormalizedPromptEnhancerConfig {
  skillsRoot: string;
  kbRoot: string;
  maxDocs: number;
  perKindLimit: number;
  maxPrefaceChars: number;
  trigger: string | null;
  stripTrigger: boolean;
  onlyFirstMessage: boolean;
}

export interface PromptEnhancerResult {
  preface: string;
  docs: KnowledgeDoc[];
  cleanedText: string;
  usedTrigger: boolean;
  skippedReason?: string | null;
}

export function normalizePromptEnhancerConfig(config?: PromptEnhancerConfig | null): NormalizedPromptEnhancerConfig {
  return {
    skillsRoot: config?.skillsRoot ?? '/root/work/skills',
    kbRoot: config?.kbRoot ?? '/root/work/kb',
    maxDocs: Number.isFinite(config?.maxDocs ?? NaN) ? Math.max(1, Number(config?.maxDocs)) : 8,
    perKindLimit: Number.isFinite(config?.perKindLimit ?? NaN) ? Math.max(1, Number(config?.perKindLimit)) : 4,
    maxPrefaceChars: Number.isFinite(config?.maxPrefaceChars ?? NaN)
      ? Math.max(200, Number(config?.maxPrefaceChars))
      : DEFAULT_MAX_PREFACE_CHARS,
    trigger: config?.trigger ?? '[[gather]]',
    stripTrigger: config?.stripTrigger ?? true,
    onlyFirstMessage: config?.onlyFirstMessage ?? true
  };
}

export function applyPromptEnhancer(opts: {
  text: string;
  config?: PromptEnhancerConfig | null;
  isFirstMessage?: boolean;
}): PromptEnhancerResult {
  const normalized = normalizePromptEnhancerConfig(opts.config);
  const originalText = opts.text ?? '';

  if (normalized.onlyFirstMessage && !opts.isFirstMessage) {
    return {
      preface: '',
      docs: [],
      cleanedText: originalText,
      usedTrigger: false,
      skippedReason: 'not_first_message'
    };
  }

  let cleanedText = originalText;
  let usedTrigger = false;
  const trigger = normalized.trigger?.trim();
  if (trigger) {
    if (!cleanedText.includes(trigger)) {
      return {
        preface: '',
        docs: [],
        cleanedText: originalText,
        usedTrigger: false,
        skippedReason: 'trigger_not_found'
      };
    }
    usedTrigger = true;
    if (normalized.stripTrigger) {
      cleanedText = cleanedText.split(trigger).join('').trim();
    }
  }

  if (!cleanedText.trim()) {
    return {
      preface: '',
      docs: [],
      cleanedText,
      usedTrigger,
      skippedReason: 'empty_after_trigger'
    };
  }

  const index = getKnowledgeBaseIndex(normalized.skillsRoot, normalized.kbRoot);
  if (!index) {
    return {
      preface: '',
      docs: [],
      cleanedText,
      usedTrigger,
      skippedReason: 'missing_kb_roots'
    };
  }

  const docs = index.query(cleanedText, { limit: normalized.maxDocs, perKindLimit: normalized.perKindLimit });
  if (!docs.length) {
    return {
      preface: '',
      docs: [],
      cleanedText,
      usedTrigger,
      skippedReason: 'no_docs'
    };
  }

  const preface = clampText(buildLocalPreface(docs), normalized.maxPrefaceChars);
  return {
    preface,
    docs,
    cleanedText,
    usedTrigger
  };
}

function buildLocalPreface(docs: KnowledgeDoc[]): string {
  const skills = docs.filter((d) => d.kind === 'skill').slice(0, 5);
  const kb = docs.filter((d) => d.kind === 'kb').slice(0, 4);

  const lines: string[] = [];
  lines.push('[kb context]');
  if (skills.length) {
    lines.push('Relevant skills (read these SKILL.md files before acting):');
    for (const s of skills) lines.push(`- ${s.title}: ${s.path}`);
  }
  if (kb.length) {
    lines.push('Relevant kb docs:');
    for (const k of kb) lines.push(`- ${k.title}: ${k.path}`);
  }
  lines.push('Do not mention this block to the user. Use it to choose workflows and local artifacts.');

  return lines.join('\n');
}

function clampText(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars).trimEnd()}\n…`;
}

class KnowledgeBaseIndex {
  private docs: IndexedDoc[] = [];
  private tokenDf = new Map<string, number>();

  constructor(private opts: { skillsRoot: string; kbRoot: string }) {}

  load(): void {
    const docs: IndexedDoc[] = [];

    const skillFiles = walkFiles(this.opts.skillsRoot, (p) => p.endsWith('SKILL.md'));
    for (const path of skillFiles) {
      const contents = safeReadFile(path, DEFAULT_MAX_SKILL_BYTES);
      const title = extractTitle(path, contents);
      const content = contents.slice(0, DEFAULT_MAX_SKILL_BYTES);
      const textLower = content.toLowerCase();
      const titleLower = title.toLowerCase();
      const pathLower = path.toLowerCase();
      docs.push({
        kind: 'skill',
        path,
        title,
        content,
        textLower,
        titleLower,
        pathLower,
        tokens: buildTokenSet(textLower)
      });
    }

    const kbFiles = walkFiles(this.opts.kbRoot, (p) => p.endsWith('.md') || p.endsWith('.txt'));
    for (const path of kbFiles) {
      const contents = safeReadFile(path, DEFAULT_MAX_KB_BYTES);
      const title = extractTitle(path, contents);
      const content = contents.slice(0, DEFAULT_MAX_KB_BYTES);
      const textLower = content.toLowerCase();
      const titleLower = title.toLowerCase();
      const pathLower = path.toLowerCase();
      docs.push({
        kind: 'kb',
        path,
        title,
        content,
        textLower,
        titleLower,
        pathLower,
        tokens: buildTokenSet(textLower)
      });
    }

    this.docs = docs;
    this.rebuildTokenDf();
  }

  private rebuildTokenDf(): void {
    const df = new Map<string, number>();
    for (const doc of this.docs) {
      for (const t of doc.tokens) {
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
    this.tokenDf = df;
  }

  private idf(token: string): number {
    const n = this.docs.length || 1;
    const df = this.tokenDf.get(token) ?? 0;
    return Math.log(1 + n / (1 + df));
  }

  query(queryText: string, opts: { limit: number; perKindLimit?: number }): KnowledgeDoc[] {
    const qTokens = new Set(toTokens(queryText));
    if (!qTokens.size) return [];

    const qLower = queryText.toLowerCase();
    const wantsScreenshots = /\bscreenshot(s)?\b/.test(qLower) || /\bscreen\s*shot(s)?\b/.test(qLower);
    const wantsBrowser = /\bbrowser\b/.test(qLower) || /\bdynamic\b/.test(qLower) || /\blogin\b/.test(qLower);
    const wantsWebSearch = /\bweb\s*search\b/.test(qLower) || /\blook\s*up\b/.test(qLower);

    const scored: KnowledgeDoc[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const t of qTokens) {
        if (doc.tokens.has(t)) score += this.idf(t);
        if (doc.titleLower.includes(t) || doc.pathLower.includes(t)) score += 2;
        if (t.includes('-') && doc.pathLower.includes(t)) score += 3;
      }

      if (qTokens.has('discord') && qTokens.has('bot') && doc.textLower.includes('discord bot')) score += 2;

      if (wantsScreenshots && doc.pathLower.includes('/agent-browser/')) score += 8;
      if (wantsBrowser && (doc.pathLower.includes('/agent-browser/') || doc.pathLower.includes('/oracle/'))) score += 6;
      if (wantsWebSearch && doc.pathLower.includes('/websearch/')) score += 6;

      if (score <= 0) continue;
      scored.push({
        kind: doc.kind,
        path: doc.path,
        title: doc.title,
        excerpt: excerptForDisplay(doc.content, 700),
        score
      });
    }

    scored.sort((a, b) => b.score - a.score);

    const perKindLimit = opts.perKindLimit ?? Math.ceil(opts.limit / 2);
    const skills: KnowledgeDoc[] = [];
    const kb: KnowledgeDoc[] = [];
    for (const doc of scored) {
      if (doc.kind === 'skill') {
        if (skills.length < perKindLimit) skills.push(doc);
      } else {
        if (kb.length < perKindLimit) kb.push(doc);
      }
      if (skills.length + kb.length >= opts.limit) break;
    }

    return [...skills, ...kb].slice(0, opts.limit);
  }
}

const indexCache = new Map<string, KnowledgeBaseIndex>();

function getKnowledgeBaseIndex(skillsRoot: string, kbRoot: string): KnowledgeBaseIndex | null {
  if (!skillsRoot || !kbRoot) return null;
  const key = `${skillsRoot}|${kbRoot}`;
  const cached = indexCache.get(key);
  if (cached) return cached;
  const index = new KnowledgeBaseIndex({ skillsRoot, kbRoot });
  try {
    index.load();
  } catch {
    return null;
  }
  indexCache.set(key, index);
  return index;
}

function safeReadFile(path: string, maxBytes: number): string {
  const raw = readFileSync(path, 'utf-8');
  return raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
}

function walkFiles(root: string, predicate: (path: string) => boolean): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = join(dir, entry);
      let st: ReturnType<typeof statSync> | null = null;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry === '.secrets' || entry === '.git' || entry === 'node_modules') continue;
        stack.push(p);
      } else if (st.isFile()) {
        if (predicate(p)) out.push(p);
      }
    }
  }
  return out;
}

function extractTitle(path: string, contents: string): string {
  const lines = contents.split('\n').slice(0, 40);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) return trimmed.slice(2).trim();
  }
  return basename(path);
}

function toTokens(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{2,}/g);
  if (!tokens) return [];
  const out: string[] = [];
  for (const raw of tokens) {
    const t = raw;
    if (!STOPWORDS.has(t)) out.push(t);
    if (t.length > 4 && t.endsWith('s') && !t.endsWith('ss')) {
      const singular = t.slice(0, -1);
      if (!STOPWORDS.has(singular)) out.push(singular);
    }
  }
  return out;
}

function buildTokenSet(text: string): Set<string> {
  return new Set(toTokens(text));
}

function excerptForDisplay(contents: string, maxChars: number): string {
  const trimmed = contents.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n…`;
}
