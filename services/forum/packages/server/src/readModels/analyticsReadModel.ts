import type {
  AnalyticsAudience,
  AnalyticsVocabularyGroup,
  ForumAnalyticsQuery,
  ForumAnalyticsReadModel,
  ForumAnalyticsScope,
} from '@irrigationreal/codex-forum-core';
import type { Database } from 'better-sqlite3';

const STOP_WORDS = new Set(
  `a an and are as at be been being but by can could did do does doing for from had has have having he her hers him his how i if in into is it its just may me might more most my no not of on one or our ours out over she should so some such than that the their theirs them then there these they this those through to too under up us was we were what when where which who why will with would you your yours
also all any about after again against am because before between both down during each few further here itself nor off once only other own same very s t don now really get got make made use used using thing things something anything maybe yeah yes like know think going want need good right well still even much many way time file files topic post forum turn user assistant tool call result said says say
um ahaha actually anyway`.split(/\s+/)
);

const audienceForKind = (kind: string): AnalyticsAudience | null => {
  if (kind === 'human' || kind === 'admin') return 'human';
  if (kind === 'robot' || kind === 'persona' || kind === 'system') return 'assistant';
  return null;
};

function normalizedText(body: string): string {
  return body
    .replace(/\[(?:FORUM TURN|CATCH-UP CONTEXT)\][\s\S]*?\[\/(?:FORUM TURN|CATCH-UP CONTEXT)\]/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/[#>*_~|]/g, ' ')
    .toLocaleLowerCase('en-US');
}

function tokenize(body: string): string[] {
  const matches = normalizedText(body).match(/[\p{L}][\p{L}\p{N}'’-]{2,31}/gu) ?? [];
  return matches
    .map((term) => term.replace(/[’]/g, "'").replace(/^[-']+|[-']+$/g, ''))
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
}

interface Corpus {
  forumId: string;
  forumName: string;
  audience: AnalyticsAudience;
  postCount: number;
  totalTerms: number;
  counts: Map<string, number>;
  documents: Map<string, number>;
}

function vocabularyGroups(
  rows: { forum_id: string; forum_name: string; identity_kind: string; body: string }[],
  selectedForumId: string | null
): AnalyticsVocabularyGroup[] {
  const corpora = new Map<string, Corpus>();
  for (const row of rows) {
    const audience = audienceForKind(row.identity_kind);
    if (!audience) continue;
    const key = `${row.forum_id}:${audience}`;
    const corpus = corpora.get(key) ?? {
      forumId: row.forum_id,
      forumName: row.forum_name,
      audience,
      postCount: 0,
      totalTerms: 0,
      counts: new Map<string, number>(),
      documents: new Map<string, number>(),
    };
    corpus.postCount += 1;
    const terms = tokenize(row.body);
    corpus.totalTerms += terms.length;
    for (const term of terms) corpus.counts.set(term, (corpus.counts.get(term) ?? 0) + 1);
    for (const term of new Set(terms)) corpus.documents.set(term, (corpus.documents.get(term) ?? 0) + 1);
    corpora.set(key, corpus);
  }

  const output: AnalyticsVocabularyGroup[] = [];
  for (const target of corpora.values()) {
    if (selectedForumId && target.forumId !== selectedForumId) continue;
    const others = [...corpora.values()].filter(
      (candidate) => candidate.audience === target.audience && candidate.forumId !== target.forumId
    );
    const otherTotal = others.reduce((sum, corpus) => sum + corpus.totalTerms, 0);
    const otherCounts = new Map<string, number>();
    for (const corpus of others) {
      for (const [term, count] of corpus.counts) otherCounts.set(term, (otherCounts.get(term) ?? 0) + count);
    }
    const vocabularySize = Math.max(1, new Set([...target.counts.keys(), ...otherCounts.keys()]).size);
    const terms = [...target.counts.entries()]
      .filter(([term, count]) => count >= 2 && (target.documents.get(term) ?? 0) >= 2)
      .map(([term, count]) => {
        const targetRate = (count + 1) / (target.totalTerms + vocabularySize);
        const otherRate = ((otherCounts.get(term) ?? 0) + 1) / (otherTotal + vocabularySize);
        return {
          term,
          score: Number((Math.log(targetRate / otherRate) * Math.log1p(count)).toFixed(4)),
          count,
          documentCount: target.documents.get(term) ?? 0,
        };
      })
      .filter((term) => term.score > 0)
      .sort((a, b) => b.score - a.score || b.count - a.count || a.term.localeCompare(b.term))
      .slice(0, 30);
    output.push({
      forumId: target.forumId,
      forumName: target.forumName,
      audience: target.audience,
      postCount: target.postCount,
      terms,
    });
  }
  return output.sort((a, b) => a.forumName.localeCompare(b.forumName) || a.audience.localeCompare(b.audience));
}

export class SqliteForumAnalyticsReadModel implements ForumAnalyticsReadModel {
  constructor(private readonly db: Database) {}

  getAnalyticsScope(query: ForumAnalyticsQuery): Promise<ForumAnalyticsScope> {
    const forums = this.db.prepare('select id, name from forums order by name asc').all() as {
      id: string;
      name: string;
    }[];
    if (query.forumId && !forums.some((forum) => forum.id === query.forumId)) throw new Error('forum not found');

    const piSessionIds = (
      this.db
        .prepare(
          `select distinct l.pi_session_id
       from pi_session_links l
       join topics t on t.id = l.topic_id
       where (? is null or t.forum_id = ?)
       order by l.pi_session_id`
        )
        .all(query.forumId ?? null, query.forumId ?? null) as { pi_session_id: string }[]
    ).map((row) => row.pi_session_id);

    const rows = this.db
      .prepare(
        `select t.forum_id, f.name as forum_name, i.kind as identity_kind, p.body
       from posts p
       join topics t on t.id = p.topic_id
       join forums f on f.id = t.forum_id
       join identities i on i.id = p.author_id
       where p.deleted_at is null and p.silent = 0
         and p.created_at >= ? and p.created_at < ?`
      )
      .all(query.window.from, query.window.to) as {
      forum_id: string;
      forum_name: string;
      identity_kind: string;
      body: string;
    }[];

    return Promise.resolve({
      forums,
      piSessionIds,
      vocabulary: vocabularyGroups(rows, query.forumId ?? null),
    });
  }
}

export const analyticsTokenizeForTest: (body: string) => string[] = tokenize;
