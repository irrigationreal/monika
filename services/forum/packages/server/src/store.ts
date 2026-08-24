import { randomUUID } from 'node:crypto';

import { normalizedOriginKey } from '@irrigationreal/codex-forum-core';

import { nowIso } from './db';
import {
  mapCompactionOperationRowToDomain,
  mapForkOperationRowToDomain,
  mapTopicOperationalEventRowToDomain,
} from './mappers/db';
import { STORE_CACHE_MAX_ENTRIES, STORE_ENTITY_CACHE_TTL_MS, STORE_STATS_CACHE_TTL_MS } from './runtimeConfig';
import { hashToken } from './utils/auth';

import type {
  AccessRuleAction,
  AccessRuleEffect,
  AccessRulePrincipalKind,
  AccessRuleScopeKind,
  CompactionOperation,
  CreatePostInput,
  CreateTopicInput,
  ForkBoundary,
  ForkOperation,
  ForumListOptions,
  ForumStatus,
  ForumVisibility,
  TopicOperationalEvent,
  TopicStatus,
  UtteranceOrigin,
} from '@irrigationreal/codex-forum-core';
import type Database from 'better-sqlite3';

import type {
  AccessRuleRow,
  ActiveTurnOriginRow,
  ApiKeyRow,
  AssistantProjectionRow,
  AttachmentHandoffRow,
  AttachmentRow,
  AuthSessionRow,
  ChatCategoryRow,
  ChatMessageRow,
  ChatRoomRow,
  CompactionOperationRow,
  ExternalRefRow,
  FileBlobRow,
  ForkOperationRow,
  ForumRow,
  IdentityRoleRow,
  IdentityRow,
  ImpersonationTokenRow,
  InviteRow,
  MessageTamperRow,
  NotificationRow,
  PendingAttachmentRow,
  PlanRow,
  PostDispatchAttemptRow,
  PostDispatchRow,
  PostRow,
  ReactionRow,
  RobotAutomationRow,
  RobotAutomationRunRow,
  RobotPersonaRow,
  RobotStateRow,
  RoleRow,
  SessionMessageRow,
  SessionRow,
  TamperConfigRow,
  TenantRow,
  ToolRunRow,
  TopicAutoRunRow,
  TopicMoveRow,
  TopicOperationalEventRow,
  TopicReadRow,
  TopicRow,
  TopicSubscriptionRow,
  UserFileRow,
  WebAuthnChallengeRow,
  WebAuthnCredentialRow,
  WebhookRow,
} from './db';

const ACCESS_TOKEN_TTL_DAYS = 7;
const RECENT_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const robotWorkAdmissionGuards = new WeakMap<Database.Database, (() => () => void) | null>();

function normalizePostBodyForDuplicateCheck(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type CacheEntry<V> = {
  value: V;
  expiresAt: number;
};

class TimedCache<K, V> {
  private readonly store = new Map<K, CacheEntry<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number
  ) {}

  get(key: K): V | undefined {
    if (this.ttlMs <= 0) return undefined;
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.ttlMs <= 0) return;
    const expiresAt = Date.now() + this.ttlMs;
    this.store.set(key, { value, expiresAt });
    if (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value as K | undefined;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
  }

  delete(key: K): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

export interface UpdatePostInput {
  body: string;
}

export interface RecentPostRow {
  post_id: string;
  topic_id: string;
  forum_id: string;
  forum_name: string;
  forum_visibility: ForumVisibility;
  forum_tenant_id: string | null;
  topic_title: string;
  author_id: string;
  author_name: string;
  body: string;
  created_at: string;
}

export interface ProfilePostHistoryRow {
  post_id: string;
  topic_id: string;
  topic_title: string;
  forum_id: string;
  forum_name: string;
  forum_visibility: ForumVisibility;
  forum_tenant_id: string | null;
  body: string;
  created_at: string;
}

export interface ChatCategorySummaryRow extends ChatCategoryRow {
  room_count: number;
}

export interface ApiKeyRecord {
  id: string;
  identityId: string;
  label: string;
  tokenPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface ImpersonationTokenRecord {
  id: string;
  ownerIdentityId: string;
  impersonatedIdentityId: string;
  label: string;
  tokenPrefix: string;
  scopes: string[];
  impersonatedDisplayName: string;
  impersonatedAvatarUrl: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface CreateSessionInput {
  topicId: string;
}

export interface CreateRobotPersonaInput {
  forumId: string;
  key: string;
  displayName: string;
  description?: string | null;
  accentColor?: string | null;
  avatarUrl?: string | null;
  signature?: string | null;
  soul?: string | null;
}

export interface UpdateRobotPersonaInput {
  displayName?: string;
  description?: string | null;
  accentColor?: string | null;
  avatarUrl?: string | null;
  signature?: string | null;
  soul?: string | null;
}

export interface RobotPersonaRecord {
  key: string;
  forumId: string;
  identityId: string;
  displayName: string;
  description: string | null;
  accentColor: string | null;
  avatarUrl: string | null;
  signature: string | null;
  soul: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePlanInput {
  topicId: string;
  sessionId: string;
  content: string;
  summary?: string | null;
  parentPostId?: string | null;
  visibility: 'public' | 'internal' | 'private';
}

export interface CreateMessageTamperInput {
  topicId: string;
  sessionId: string;
  postId?: string | null;
  sessionMessageId?: string | null;
  direction: string;
  stage: string;
  pluginKey: string;
  pluginPriority: number;
  inputText: string;
  outputText: string;
  changed: boolean;
  error?: string | null;
  durationMs?: number | null;
}

export interface CreateTamperConfigInput {
  forumId?: string | null;
  pluginKey: string;
  enabled?: boolean;
  priority?: number;
  direction?: string | null;
  onlyFirstMessage?: boolean | null;
  config?: Record<string, unknown> | null;
}

export interface UpdateTamperConfigInput {
  forumId?: string | null;
  enabled?: boolean;
  priority?: number;
  direction?: string | null;
  onlyFirstMessage?: boolean | null;
  config?: Record<string, unknown> | null;
}

export interface CreateToolRunInput {
  topicId: string;
  sessionId: string;
  tool: string;
  parentPostId?: string | null;
  outputSummary?: string | null;
  command?: string | null;
  visibility: 'public' | 'internal' | 'private';
}

export interface MoveTopicInput {
  topicId: string;
  toForumId: string;
  movedBy: string;
  markerBody?: string | null;
  silent?: boolean;
}

export interface TopicMoveRecord {
  id: string;
  topicId: string;
  fromForumId: string;
  toForumId: string;
  movedBy: string;
  movedAt: string;
  markerPostId: string | null;
  needsReprompt: boolean;
  silent: boolean;
}

export interface UpdateRobotStateInput {
  topicId: string;
  sessionId: string;
  activity: string;
  model?: string | null;
  reasoningEffort?: string | null;
  currentPlanId?: string | null;
}

export interface CreateTopicOperationalEventInput {
  topicId: string;
  anchorPostId?: string | null;
  type: TopicOperationalEvent['type'];
  category: TopicOperationalEvent['category'];
  status: TopicOperationalEvent['status'];
  summary: string;
  detail?: Record<string, unknown> | null;
  sourceKind: TopicOperationalEvent['sourceKind'];
  sourceId: string;
}

export interface CreateCompactionOperationInput {
  id: string;
  topicId: string;
  sessionId: string;
  initiatedBy: string;
  expectedLeafId: string;
  customInstructions?: string | null;
  recoveryPrompt: string;
}

export interface EnqueueForkOperationInput {
  id: string;
  sourceTopicId: string;
  sourceSessionId: string;
  sourcePiSessionId: string;
  sourcePiSessionPath: string;
  boundaryPostId: string;
  boundaryPiMessageId: string;
  boundaryEntryId: string;
  expectedLeafId: string;
  initiatedBy: string;
  title: string;
  openingBody: string;
  prestagedAttachments: Array<{
    sourcePostId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    storagePath: string;
    sha256: string | null;
  }>;
}

export interface CreatePostDispatchInput {
  topicId: string;
  postId: string;
  sessionId: string;
  mode?: string;
  model?: string | null;
  reasoningEffort?: string | null;
}

export type AttachmentHandoffInput = {
  refEntryId: string;
  sourceKind: AttachmentHandoffRow['source_kind'];
  sourceRef: Record<string, unknown>;
  expectedSha256?: string | null;
  expectedSizeBytes?: number | null;
};

function pendingAttachmentId(handoff: AttachmentHandoffInput): string | null {
  const value =
    handoff.sourceRef['pendingAttachmentId'] ?? handoff.sourceRef['pending_attachment_id'] ?? handoff.sourceRef['id'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Structured v2 references supersede legacy text markers for the same staged file. */
function dedupeAttachmentHandoffs(handoffs: AttachmentHandoffInput[]): AttachmentHandoffInput[] {
  const structuredPendingIds = new Set(
    handoffs
      .filter((handoff) => handoff.sourceKind === 'structured-pending')
      .map(pendingAttachmentId)
      .filter((id): id is string => Boolean(id))
  );
  const seenRefs = new Set<string>();
  const seenPending = new Set<string>();
  return handoffs.filter((handoff) => {
    if (seenRefs.has(handoff.refEntryId)) return false;
    const pendingId = pendingAttachmentId(handoff);
    if (pendingId && handoff.sourceKind !== 'structured-pending' && structuredPendingIds.has(pendingId)) return false;
    if (pendingId && seenPending.has(pendingId)) return false;
    seenRefs.add(handoff.refEntryId);
    if (pendingId) seenPending.add(pendingId);
    return true;
  });
}

export type BeginAssistantProjectionInput = {
  piSessionId: string;
  piMessageId: string;
  utteranceId: string;
  topicId: string;
  sessionId: string;
  body: string;
  authorId: string;
  parentPostId?: string | null;
  origin?: unknown;
  metadata?: unknown;
  /** Durable payload consumed by the forum-only completion delivery path. */
  completionPayload?: unknown;
  handoffs?: AttachmentHandoffInput[];
};

export interface CreateExternalRefInput {
  surfaceId: string;
  surfaceKind: string;
  externalId: string;
  kind: string;
  scope?: string | null;
  scopeKind?: string | null;
  mappedForumId?: string | null;
  mappedTopicId?: string | null;
  mappedPostId?: string | null;
  mappedIdentityId?: string | null;
}

export interface PiSessionLinkRow {
  id: string;
  pi_session_id: string;
  pi_session_path: string;
  topic_id: string;
  session_id: string;
  cwd: string | null;
  kind: string;
  pi_timestamp: string | null;
  imported_at: string;
  last_import_run_id: string | null;
  metadata_json: string | null;
  parent_pi_session_id: string | null;
  parent_pi_session_path: string | null;
  lineage_kind: string | null;
  lineage_source: string | null;
}

export interface PiMessageLinkRow {
  id: string;
  pi_session_id: string;
  pi_message_id: string;
  post_id: string | null;
  session_message_id: string | null;
  role: string | null;
  imported_at: string;
  metadata_json: string | null;
}

export interface CreatePendingAttachmentInput {
  topicId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  sha256?: string | null;
  createdBy?: string | null;
  expiresAt: string;
}

export interface CreateAttachmentInput {
  postId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  sha256?: string | null;
  ownerIdentityId?: string | null;
  dedupeSystemByPath?: boolean;
  maxOwnerBytes?: number;
}

export interface CreateUserFileInput {
  identityId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  sha256?: string | null;
  visibility?: 'private' | 'members' | 'public';
  expiresAt?: string | null;
  maxOwnerBytes?: number;
}

export interface ReactionCount {
  emoji: string;
  count: number;
}

export class ForumStore {
  private readonly forumCache = new TimedCache<string, ForumRow>(STORE_ENTITY_CACHE_TTL_MS, STORE_CACHE_MAX_ENTRIES);
  private readonly topicCache = new TimedCache<string, TopicRow>(STORE_ENTITY_CACHE_TTL_MS, STORE_CACHE_MAX_ENTRIES);
  private readonly identityCache = new TimedCache<string, IdentityRow>(
    STORE_ENTITY_CACHE_TTL_MS,
    STORE_CACHE_MAX_ENTRIES
  );
  private readonly forumStatsCache = new TimedCache<
    string,
    {
      threadCount: number;
      postCount: number;
      lastPost: {
        postId: string;
        topicId: string;
        topicTitle: string;
        authorId: string;
        authorName: string;
        createdAt: string;
      } | null;
    }
  >(STORE_STATS_CACHE_TTL_MS, STORE_CACHE_MAX_ENTRIES);
  private readonly topicStatsCache = new TimedCache<
    string,
    {
      postCount: number;
      lastPostAuthorId: string | null;
      lastPostAuthorName: string | null;
      lastPostAt: string | null;
    }
  >(STORE_STATS_CACHE_TTL_MS, STORE_CACHE_MAX_ENTRIES);

  constructor(private readonly db: Database.Database) {}

  setRobotWorkAdmissionGuard(guard: (() => () => void) | null): void {
    robotWorkAdmissionGuards.set(this.db, guard);
  }

  beginRobotWork(): () => void {
    return robotWorkAdmissionGuards.get(this.db)?.() ?? (() => undefined);
  }

  assertRobotWorkAdmission(): void {
    this.beginRobotWork()();
  }

  runInTransaction<T>(operation: () => T): T {
    try {
      return this.db.transaction(operation)();
    } catch (error) {
      // Nested store calls may have populated entity caches before an outer transaction
      // rolled back. Clear all caches so a failed publication cannot leave ghost rows.
      this.forumCache.clear();
      this.topicCache.clear();
      this.identityCache.clear();
      this.forumStatsCache.clear();
      this.topicStatsCache.clear();
      throw error;
    }
  }

  private invalidateForumCache(forumId?: string | null): void {
    if (!forumId) return;
    this.forumCache.delete(forumId);
  }

  private invalidateForumStatsCache(forumId?: string | null): void {
    if (!forumId) return;
    this.forumStatsCache.delete(forumId);
  }

  private invalidateTopicCache(topicId?: string | null): void {
    if (!topicId) return;
    this.topicCache.delete(topicId);
  }

  private invalidateTopicStatsCache(topicId?: string | null): void {
    if (!topicId) return;
    this.topicStatsCache.delete(topicId);
  }

  private invalidateIdentityCache(identityId?: string | null): void {
    if (!identityId) return;
    this.identityCache.delete(identityId);
  }

  listForums(options?: ForumListOptions): ForumRow[] {
    const clauses: string[] = [];
    const params: Array<string | null> = [];
    const includeArchived = options?.includeArchived ?? false;

    if (!includeArchived) {
      clauses.push('status = ?');
      params.push(options?.status ?? 'active');
    } else if (options?.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }

    if (options?.parentForumId !== undefined) {
      if (options.parentForumId === null) {
        clauses.push('parent_forum_id is null');
      } else {
        clauses.push('parent_forum_id = ?');
        params.push(options.parentForumId);
      }
    }

    const where = clauses.length > 0 ? `where ${clauses.join(' and ')}` : '';
    const stmt = this.db.prepare(`select * from forums ${where} order by created_at asc`);
    return stmt.all(...params) as ForumRow[];
  }

  getForum(forumId: string): ForumRow | null {
    const cached = this.forumCache.get(forumId);
    if (cached) return cached;
    const row = this.db.prepare('select * from forums where id = ?').get(forumId) as ForumRow | undefined;
    if (row) {
      this.forumCache.set(forumId, row);
    }
    return row ?? null;
  }

  createForum(
    name: string,
    description?: string | null,
    cwd?: string | null,
    parentForumId?: string | null,
    category?: string | null,
    status: ForumStatus = 'active',
    visibility: ForumVisibility = 'public',
    prePrompt?: string | null
  ): ForumRow {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'insert into forums (id, tenant_id, parent_forum_id, category, name, description, cwd, pre_prompt, status, visibility, archived_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        null,
        parentForumId ?? null,
        category ?? null,
        name,
        description ?? null,
        cwd ?? null,
        prePrompt ?? null,
        status,
        visibility,
        status === 'archived' ? now : null,
        now,
        now
      );
    return this.getForum(id) as ForumRow;
  }

  updateForum(
    forumId: string,
    updates: {
      name?: string;
      description?: string | null;
      cwd?: string | null;
      prePrompt?: string | null;
      parentForumId?: string | null;
      category?: string | null;
      status?: ForumStatus;
      visibility?: ForumVisibility;
      archivedAt?: string | null;
    }
  ): ForumRow | null {
    const forum = this.getForum(forumId);
    if (!forum) {
      return null;
    }
    const now = nowIso();
    const nextStatus = updates.status ?? forum.status;
    const nextArchivedAt =
      updates.archivedAt !== undefined
        ? updates.archivedAt
        : nextStatus === 'archived'
          ? (forum.archived_at ?? now)
          : null;
    this.db
      .prepare(
        'update forums set parent_forum_id = ?, category = ?, name = ?, description = ?, cwd = ?, pre_prompt = ?, status = ?, visibility = ?, archived_at = ?, updated_at = ? where id = ?'
      )
      .run(
        updates.parentForumId !== undefined ? updates.parentForumId : forum.parent_forum_id,
        updates.category !== undefined ? updates.category : forum.category,
        updates.name ?? forum.name,
        updates.description !== undefined ? updates.description : forum.description,
        updates.cwd !== undefined ? updates.cwd : forum.cwd,
        updates.prePrompt !== undefined ? updates.prePrompt : forum.pre_prompt,
        nextStatus,
        updates.visibility ?? forum.visibility,
        nextArchivedAt,
        now,
        forumId
      );
    this.invalidateForumCache(forumId);
    this.invalidateForumStatsCache(forumId);
    return this.getForum(forumId);
  }

  deleteForum(forumId: string): boolean {
    // Check if forum has topics
    const topicCount = this.db.prepare('select count(*) as count from topics where forum_id = ?').get(forumId) as {
      count: number;
    };
    if (topicCount.count > 0) {
      return false; // Can't delete forum with topics
    }
    this.db.prepare('delete from access_rules where scope_kind = ? and scope_id = ?').run('forum', forumId);
    const result = this.db.prepare('delete from forums where id = ?').run(forumId);
    if (result.changes > 0) {
      this.invalidateForumCache(forumId);
      this.invalidateForumStatsCache(forumId);
    }
    return result.changes > 0;
  }

  getForumTopicCount(forumId: string): number {
    const result = this.db.prepare('select count(*) as count from topics where forum_id = ?').get(forumId) as {
      count: number;
    };
    return result.count;
  }

  getForumPostCount(forumId: string): number {
    const result = this.db
      .prepare(
        `
      select count(*) as count from posts p
      join topics t on p.topic_id = t.id
      where t.forum_id = ?
    `
      )
      .get(forumId) as { count: number };
    return result.count;
  }

  getForumLastPost(
    forumId: string
  ): { postId: string; topicId: string; topicTitle: string; authorId: string; createdAt: string } | null {
    const result = this.db
      .prepare(
        `
      select p.id as post_id, p.topic_id, t.title as topic_title, p.author_id, p.created_at
      from posts p
      join topics t on p.topic_id = t.id
      where t.forum_id = ? and p.deleted_at is null
      order by p.created_at desc
      limit 1
    `
      )
      .get(forumId) as
      { post_id: string; topic_id: string; topic_title: string; author_id: string; created_at: string } | undefined;

    if (!result) return null;
    return {
      postId: result.post_id,
      topicId: result.topic_id,
      topicTitle: result.topic_title,
      authorId: result.author_id,
      createdAt: result.created_at,
    };
  }

  getForumStatsForForums(forumIds: string[]): Map<
    string,
    {
      threadCount: number;
      postCount: number;
      lastPost: {
        postId: string;
        topicId: string;
        topicTitle: string;
        authorId: string;
        authorName: string;
        createdAt: string;
      } | null;
    }
  > {
    const result = new Map<
      string,
      {
        threadCount: number;
        postCount: number;
        lastPost: {
          postId: string;
          topicId: string;
          topicTitle: string;
          authorId: string;
          authorName: string;
          createdAt: string;
        } | null;
      }
    >();
    if (!forumIds.length) return result;
    const uniqueIds = Array.from(new Set(forumIds));
    const missing: string[] = [];
    for (const id of uniqueIds) {
      const cached = this.forumStatsCache.get(id);
      if (cached) {
        result.set(id, cached);
      } else {
        missing.push(id);
      }
    }
    if (!missing.length) return result;

    const placeholders = missing.map(() => '?').join(', ');
    const threadRows = this.db
      .prepare(
        `select forum_id, count(*) as thread_count from topics where forum_id in (${placeholders}) group by forum_id`
      )
      .all(...missing) as Array<{ forum_id: string; thread_count: number }>;
    const postRows = this.db
      .prepare(
        `select t.forum_id as forum_id, count(*) as post_count
         from posts p
         join topics t on p.topic_id = t.id
         where p.deleted_at is null and t.forum_id in (${placeholders})
         group by t.forum_id`
      )
      .all(...missing) as Array<{ forum_id: string; post_count: number }>;
    const lastPostRows = this.db
      .prepare(
        `select forum_id, post_id, topic_id, topic_title, author_id, author_name, created_at
         from (
           select
             t.forum_id as forum_id,
             p.id as post_id,
             p.topic_id as topic_id,
             t.title as topic_title,
             p.author_id as author_id,
             i.display_name as author_name,
             p.created_at as created_at,
             row_number() over (partition by t.forum_id order by p.created_at desc, p.rowid desc) as rn
           from posts p
           join topics t on p.topic_id = t.id
           join identities i on p.author_id = i.id
           where p.deleted_at is null and t.forum_id in (${placeholders})
         )
         where rn = 1`
      )
      .all(...missing) as Array<{
      forum_id: string;
      post_id: string;
      topic_id: string;
      topic_title: string;
      author_id: string;
      author_name: string;
      created_at: string;
    }>;

    const threadCountByForum = new Map(threadRows.map((row) => [row.forum_id, row.thread_count]));
    const postCountByForum = new Map(postRows.map((row) => [row.forum_id, row.post_count]));
    const lastPostByForum = new Map(
      lastPostRows.map((row) => [
        row.forum_id,
        {
          postId: row.post_id,
          topicId: row.topic_id,
          topicTitle: row.topic_title,
          authorId: row.author_id,
          authorName: row.author_name,
          createdAt: row.created_at,
        },
      ])
    );

    for (const forumId of missing) {
      const stats = {
        threadCount: threadCountByForum.get(forumId) ?? 0,
        postCount: postCountByForum.get(forumId) ?? 0,
        lastPost: lastPostByForum.get(forumId) ?? null,
      };
      this.forumStatsCache.set(forumId, stats);
      result.set(forumId, stats);
    }

    return result;
  }

  getForumStats(forumId: string): {
    threadCount: number;
    postCount: number;
    lastPost: {
      postId: string;
      topicId: string;
      topicTitle: string;
      authorId: string;
      authorName: string;
      createdAt: string;
    } | null;
  } {
    const stats = this.getForumStatsForForums([forumId]).get(forumId);
    if (stats) return stats;
    return { threadCount: 0, postCount: 0, lastPost: null };
  }

  listRecentPosts(limit = 3): RecentPostRow[] {
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    return this.db
      .prepare(
        `
      select
        p.id as post_id,
        p.topic_id,
        p.author_id,
        p.body,
        p.created_at,
        t.title as topic_title,
        t.forum_id,
        f.name as forum_name,
        f.visibility as forum_visibility,
        f.tenant_id as forum_tenant_id,
        i.display_name as author_name
      from posts p
      join topics t on p.topic_id = t.id
      join forums f on t.forum_id = f.id
      join identities i on p.author_id = i.id
      where p.deleted_at is null
      order by p.created_at desc
      limit ?
    `
      )
      .all(safeLimit) as RecentPostRow[];
  }

  countPostsByAuthor(authorId: string, opts?: { includeAdminForums?: boolean }): number {
    const includeAdmin = opts?.includeAdminForums ?? true;
    const row = includeAdmin
      ? (this.db
          .prepare(
            `select count(*) as count
             from posts p
             join topics t on p.topic_id = t.id
             join forums f on t.forum_id = f.id
             where p.author_id = ? and p.deleted_at is null`
          )
          .get(authorId) as { count: number })
      : (this.db
          .prepare(
            `select count(*) as count
             from posts p
             join topics t on p.topic_id = t.id
             join forums f on t.forum_id = f.id
             where p.author_id = ? and p.deleted_at is null and f.visibility != 'admin'`
          )
          .get(authorId) as { count: number });
    return row.count;
  }

  listPostsByAuthor(
    authorId: string,
    page = 1,
    pageSize = 25,
    opts?: { includeAdminForums?: boolean }
  ): ProfilePostHistoryRow[] {
    const offset = (page - 1) * pageSize;
    const includeAdmin = opts?.includeAdminForums ?? true;
    const query = includeAdmin
      ? `
        select
          p.id as post_id,
          p.topic_id,
          t.title as topic_title,
          t.forum_id,
          f.name as forum_name,
          f.visibility as forum_visibility,
          f.tenant_id as forum_tenant_id,
          p.body,
          p.created_at
        from posts p
        join topics t on p.topic_id = t.id
        join forums f on t.forum_id = f.id
        where p.author_id = ? and p.deleted_at is null
        order by p.created_at desc
        limit ? offset ?
      `
      : `
        select
          p.id as post_id,
          p.topic_id,
          t.title as topic_title,
          t.forum_id,
          f.name as forum_name,
          f.visibility as forum_visibility,
          f.tenant_id as forum_tenant_id,
          p.body,
          p.created_at
        from posts p
        join topics t on p.topic_id = t.id
        join forums f on t.forum_id = f.id
        where p.author_id = ? and p.deleted_at is null and f.visibility != 'admin'
        order by p.created_at desc
        limit ? offset ?
      `;
    return this.db.prepare(query).all(authorId, pageSize, offset) as ProfilePostHistoryRow[];
  }

  listTopics(forumId: string, page = 1, pageSize = 50): TopicRow[] {
    const offset = (page - 1) * pageSize;
    return this.db
      .prepare('select * from topics where forum_id = ? order by created_at desc limit ? offset ?')
      .all(forumId, pageSize, offset) as TopicRow[];
  }

  getTopicStatsForTopics(
    topicIds: string[]
  ): Map<
    string,
    { postCount: number; lastPostAuthorId: string | null; lastPostAuthorName: string | null; lastPostAt: string | null }
  > {
    const result = new Map<
      string,
      {
        postCount: number;
        lastPostAuthorId: string | null;
        lastPostAuthorName: string | null;
        lastPostAt: string | null;
      }
    >();
    if (!topicIds.length) return result;
    const uniqueIds = Array.from(new Set(topicIds));
    const missing: string[] = [];
    for (const id of uniqueIds) {
      const cached = this.topicStatsCache.get(id);
      if (cached) {
        result.set(id, cached);
      } else {
        missing.push(id);
      }
    }
    if (!missing.length) return result;

    const placeholders = missing.map(() => '?').join(', ');
    const countRows = this.db
      .prepare(
        `select topic_id, count(*) as post_count
         from posts
         where deleted_at is null and topic_id in (${placeholders})
         group by topic_id`
      )
      .all(...missing) as Array<{ topic_id: string; post_count: number }>;
    const lastPostRows = this.db
      .prepare(
        `select topic_id, author_id, author_name, created_at
         from (
           select
             p.topic_id as topic_id,
             p.author_id as author_id,
             i.display_name as author_name,
             p.created_at as created_at,
             row_number() over (partition by p.topic_id order by p.created_at desc, p.rowid desc) as rn
           from posts p
           join identities i on p.author_id = i.id
           where p.deleted_at is null and p.topic_id in (${placeholders})
         )
         where rn = 1`
      )
      .all(...missing) as Array<{
      topic_id: string;
      author_id: string;
      author_name: string;
      created_at: string;
    }>;

    const postCountByTopic = new Map(countRows.map((row) => [row.topic_id, row.post_count]));
    const lastPostByTopic = new Map(
      lastPostRows.map((row) => [
        row.topic_id,
        {
          lastPostAuthorId: row.author_id ?? null,
          lastPostAuthorName: row.author_name ?? null,
          lastPostAt: row.created_at ?? null,
        },
      ])
    );

    for (const topicId of missing) {
      const stats = {
        postCount: postCountByTopic.get(topicId) ?? 0,
        lastPostAuthorId: lastPostByTopic.get(topicId)?.lastPostAuthorId ?? null,
        lastPostAuthorName: lastPostByTopic.get(topicId)?.lastPostAuthorName ?? null,
        lastPostAt: lastPostByTopic.get(topicId)?.lastPostAt ?? null,
      };
      this.topicStatsCache.set(topicId, stats);
      result.set(topicId, stats);
    }

    return result;
  }

  getTopicStats(topicId: string): {
    postCount: number;
    lastPostAuthorId: string | null;
    lastPostAuthorName: string | null;
    lastPostAt: string | null;
  } {
    const stats = this.getTopicStatsForTopics([topicId]).get(topicId);
    if (stats) return stats;
    return { postCount: 0, lastPostAuthorId: null, lastPostAuthorName: null, lastPostAt: null };
  }

  getTopic(topicId: string): TopicRow | null {
    const cached = this.topicCache.get(topicId);
    if (cached) return cached;
    const row = this.db.prepare('select * from topics where id = ?').get(topicId) as TopicRow | undefined;
    if (row) {
      this.topicCache.set(topicId, row);
    }
    return row ?? null;
  }

  updateTopicStatus(topicId: string, status: TopicStatus): TopicRow {
    const existing = this.getTopic(topicId);
    if (!existing) {
      throw new Error('topic not found');
    }
    const now = nowIso();
    this.db.prepare('update topics set status = ?, updated_at = ? where id = ?').run(status, now, topicId);
    this.invalidateTopicCache(topicId);
    return this.getTopic(topicId) as TopicRow;
  }

  updateTopicTitle(topicId: string, title: string): TopicRow {
    const existing = this.getTopic(topicId);
    if (!existing) {
      throw new Error('topic not found');
    }
    const now = nowIso();
    this.db.prepare('update topics set title = ?, updated_at = ? where id = ?').run(title, now, topicId);
    this.invalidateTopicCache(topicId);
    this.invalidateForumStatsCache(existing.forum_id);
    return this.getTopic(topicId) as TopicRow;
  }

  updateTopicTags(topicId: string, tags: string[]): TopicRow {
    const existing = this.getTopic(topicId);
    if (!existing) {
      throw new Error('topic not found');
    }
    const now = nowIso();
    this.db
      .prepare('update topics set tags_json = ?, updated_at = ? where id = ?')
      .run(JSON.stringify(tags), now, topicId);
    this.invalidateTopicCache(topicId);
    return this.getTopic(topicId) as TopicRow;
  }

  deleteTopic(topicId: string): void {
    const existing = this.getTopic(topicId);
    if (!existing) {
      throw new Error('topic not found');
    }

    // Deleting a topic is a multi-step operation; wrap in a transaction so we don't
    // end up with partially-deleted state if any statement fails.
    this.db.transaction(() => {
      /**
       * message_tampers has foreign keys to:
       * - topics(topic_id)
       * - sessions(session_id)
       * - posts(post_id)
       * - session_messages(session_message_id)
       *
       * So it must be deleted *before* deleting any of those rows, otherwise we
       * will hit "FOREIGN KEY constraint failed".
       */
      this.db.prepare('delete from message_tampers where topic_id = ?').run(topicId);

      // Get all post IDs for this topic to delete their attachments and reactions
      const postIds = this.db.prepare('select id from posts where topic_id = ?').all(topicId) as { id: string }[];
      for (const { id: postId } of postIds) {
        this.db.prepare('delete from reactions where post_id = ?').run(postId);
        this.db
          .prepare(
            "update attachments set deleted_at = coalesce(deleted_at, ?), delete_reason = 'topic_deleted' where post_id = ?"
          )
          .run(nowIso(), postId);
      }

      // Projection handoffs own pending attachment custody and cascade from the
      // projection. Queue their bytes before removing rows so filesystem cleanup
      // remains retryable if the unlink cannot complete immediately.
      this.db
        .prepare(
          `insert into file_deletion_queue (storage_path, reason, created_at)
         select storage_path, 'topic_deleted_pending_attachment', ? from pending_attachments where topic_id = ?
         on conflict(storage_path) do nothing`
        )
        .run(nowIso(), topicId);
      this.db.prepare('delete from assistant_projections where topic_id = ?').run(topicId);
      this.db.prepare('delete from pending_attachments where topic_id = ?').run(topicId);

      // Canonical-session projection state references both sessions and posts.
      const piSessionIds = this.db
        .prepare('select pi_session_id from pi_session_links where topic_id = ?')
        .all(topicId) as Array<{ pi_session_id: string }>;
      for (const { pi_session_id: piSessionId } of piSessionIds) {
        this.db.prepare('delete from pi_message_links where pi_session_id = ?').run(piSessionId);
      }
      this.db.prepare('delete from pi_sync_anomalies where topic_id = ?').run(topicId);
      this.db.prepare('delete from post_dispatches where topic_id = ?').run(topicId);
      this.db.prepare('delete from pi_session_links where topic_id = ?').run(topicId);

      // Get all session IDs for this topic to delete session messages
      const sessionIds = this.db.prepare('select id from sessions where topic_id = ?').all(topicId) as { id: string }[];
      for (const { id: sessionId } of sessionIds) {
        this.db.prepare('delete from session_messages where session_id = ?').run(sessionId);
      }

      // Delete in order respecting foreign key constraints
      this.db.prepare('delete from robot_state where topic_id = ?').run(topicId);
      this.db.prepare('delete from topic_auto_runs where topic_id = ?').run(topicId);
      this.db.prepare('delete from tool_runs where topic_id = ?').run(topicId);
      this.db.prepare('delete from plans where topic_id = ?').run(topicId);
      this.db.prepare('delete from sessions where topic_id = ?').run(topicId);
      this.markUnreferencedBlobsForGc();
      this.db.prepare('delete from posts where topic_id = ?').run(topicId);
      this.db.prepare('delete from topic_moves where topic_id = ?').run(topicId);
      this.db.prepare('delete from notifications where topic_id = ?').run(topicId);
      this.db.prepare('delete from topic_reads where topic_id = ?').run(topicId);
      this.db.prepare('delete from topic_subscriptions where topic_id = ?').run(topicId);
      this.db.prepare('delete from external_refs where mapped_topic_id = ?').run(topicId);
      this.db.prepare('delete from access_rules where scope_kind = ? and scope_id = ?').run('topic', topicId);
      this.db.prepare('delete from topics where id = ?').run(topicId);
    })();
    this.invalidateTopicCache(topicId);
    this.invalidateTopicStatsCache(topicId);
    this.invalidateForumStatsCache(existing.forum_id);
  }

  createTopic(input: CreateTopicInput): { topic: TopicRow; post: PostRow } {
    const topicId = randomUUID();
    const postId = randomUUID();
    const now = nowIso();
    this.db.transaction(() => {
      if (input.draft) {
        const draft = this.db
          .prepare(
            "select id from message_drafts where id = ? and owner_identity_id = ? and context = 'new_thread' and forum_id = ? and revision = ? and expires_at > ?"
          )
          .get(input.draft.id, input.authorId, input.forumId, input.draft.revision, now);
        if (!draft) throw new Error('draft changed in another session');
      }
      this.db
        .prepare(
          'insert into topics (id, forum_id, tenant_id, title, status, tags_json, robot_mode, created_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          topicId,
          input.forumId,
          null,
          input.title,
          'open',
          JSON.stringify([]),
          input.robotMode ?? 'auto',
          input.authorId,
          now,
          now
        );
      if (input.autoCompactEnabled) {
        const supportsAutoCompact = this.db
          .prepare("select 1 from pragma_table_info('topics') where name = 'auto_compact_enabled'")
          .get();
        if (supportsAutoCompact)
          this.db.prepare('update topics set auto_compact_enabled = 1 where id = ?').run(topicId);
      }
      this.db
        .prepare(
          'insert into posts (id, topic_id, tenant_id, parent_post_id, author_id, body, source_message_id, silent, created_at, edited_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(postId, topicId, null, null, input.authorId, input.body, null, input.silent ? 1 : 0, now, null, null);
      if (input.draft)
        this.db
          .prepare('delete from message_drafts where id = ? and owner_identity_id = ? and revision = ?')
          .run(input.draft.id, input.authorId, input.draft.revision);
    })();
    this.invalidateForumStatsCache(input.forumId);
    this.invalidateTopicStatsCache(topicId);
    return { topic: this.getTopic(topicId) as TopicRow, post: this.getPost(postId) as PostRow };
  }

  moveTopic(input: MoveTopicInput): { topic: TopicRow; move: TopicMoveRecord; markerPost: PostRow | null } {
    const now = nowIso();
    const moveId = randomUUID();
    const silent = Boolean(input.silent);
    const markerPostId = silent ? null : randomUUID();
    let moveRecord: TopicMoveRecord | null = null;
    let updatedTopic: TopicRow | null = null;
    let markerPost: PostRow | null = null;
    let fromForumId: string | null = null;

    this.db.transaction(() => {
      const topic = this.getTopic(input.topicId);
      if (!topic) {
        throw new Error('topic not found');
      }
      fromForumId = topic.forum_id;
      if (topic.forum_id === input.toForumId) {
        throw new Error('topic already in target forum');
      }
      const toForum = this.getForum(input.toForumId);
      if (!toForum) {
        throw new Error('destination forum not found');
      }

      this.db
        .prepare('update topics set forum_id = ?, updated_at = ? where id = ?')
        .run(input.toForumId, now, input.topicId);
      if (!silent) {
        this.db
          .prepare(
            'update sessions set personas_synced_at = ?, context_synced_forum_id = ?, updated_at = ? where topic_id = ?'
          )
          .run(null, null, now, input.topicId);
      }
      this.db
        .prepare('update external_refs set mapped_forum_id = ? where mapped_topic_id = ?')
        .run(input.toForumId, input.topicId);
      this.db.prepare('update topic_moves set needs_reprompt = 0 where topic_id = ?').run(input.topicId);

      if (markerPostId) {
        this.db
          .prepare(
            'insert into posts (id, topic_id, tenant_id, parent_post_id, author_id, body, source_message_id, silent, created_at, edited_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .run(
            markerPostId,
            input.topicId,
            null,
            null,
            input.movedBy,
            input.markerBody ?? '',
            null,
            0,
            now,
            null,
            null
          );
      }

      this.db
        .prepare(
          'insert into topic_moves (id, topic_id, from_forum_id, to_forum_id, moved_by, moved_at, marker_post_id, needs_reprompt, silent) values (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          moveId,
          input.topicId,
          topic.forum_id,
          input.toForumId,
          input.movedBy,
          now,
          markerPostId,
          silent ? 0 : 1,
          silent ? 1 : 0
        );

      this.invalidateTopicCache(input.topicId);
      updatedTopic = this.getTopic(input.topicId) as TopicRow;
      const row = this.getTopicMove(moveId);
      moveRecord = row;
      markerPost = markerPostId ? (this.getPost(markerPostId) as PostRow) : null;
    })();

    this.invalidateTopicCache(input.topicId);
    this.invalidateTopicStatsCache(input.topicId);
    if (fromForumId) {
      this.invalidateForumStatsCache(fromForumId);
    }
    this.invalidateForumStatsCache(input.toForumId);

    if (!updatedTopic || !moveRecord) {
      throw new Error('moveTopic: transaction did not produce expected results');
    }
    return {
      topic: updatedTopic,
      move: moveRecord,
      markerPost: markerPost,
    };
  }

  getTopicMove(moveId: string): TopicMoveRecord | null {
    const row = this.db.prepare('select * from topic_moves where id = ?').get(moveId) as TopicMoveRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      topicId: row.topic_id,
      fromForumId: row.from_forum_id,
      toForumId: row.to_forum_id,
      movedBy: row.moved_by,
      movedAt: row.moved_at,
      markerPostId: row.marker_post_id,
      needsReprompt: Boolean(row.needs_reprompt),
      silent: Boolean(row.silent),
    };
  }

  listTopicMoves(topicId: string): TopicMoveRecord[] {
    const rows = this.db
      // moved_at can collide when multiple moves happen within the same timestamp resolution.
      // Add a stable secondary sort to keep ordering deterministic.
      .prepare('select rowid, * from topic_moves where topic_id = ? order by moved_at desc, rowid desc')
      .all(topicId) as TopicMoveRow[];
    return rows.map((row) => ({
      id: row.id,
      topicId: row.topic_id,
      fromForumId: row.from_forum_id,
      toForumId: row.to_forum_id,
      movedBy: row.moved_by,
      movedAt: row.moved_at,
      markerPostId: row.marker_post_id,
      needsReprompt: Boolean(row.needs_reprompt),
      silent: Boolean(row.silent),
    }));
  }

  getPendingTopicMove(topicId: string): TopicMoveRecord | null {
    const row = this.db
      // Keep selection deterministic for the same reason as listTopicMoves.
      .prepare(
        'select rowid, * from topic_moves where topic_id = ? and needs_reprompt = 1 order by moved_at desc, rowid desc limit 1'
      )
      .get(topicId) as TopicMoveRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      topicId: row.topic_id,
      fromForumId: row.from_forum_id,
      toForumId: row.to_forum_id,
      movedBy: row.moved_by,
      movedAt: row.moved_at,
      markerPostId: row.marker_post_id,
      needsReprompt: true,
      silent: Boolean(row.silent),
    };
  }

  clearTopicMovePrompt(moveId: string): TopicMoveRecord | null {
    const existing = this.getTopicMove(moveId);
    if (!existing) return null;
    this.db.prepare('update topic_moves set needs_reprompt = 0 where id = ?').run(moveId);
    return { ...existing, needsReprompt: false };
  }

  listPosts(topicId: string, page = 1, pageSize = 200): PostRow[] {
    const offset = (page - 1) * pageSize;
    return this.db
      .prepare(
        `select p.* from posts p where p.topic_id = ?
        and not exists (select 1 from assistant_projections ap where ap.post_id = p.id and ap.status <> 'projected')
        order by p.created_at asc limit ? offset ?`
      )
      .all(topicId, pageSize, offset) as PostRow[];
  }

  countPostsByTopic(topicId: string): number {
    const row = this.db
      .prepare(
        `select count(*) as count from posts p where p.topic_id = ? and p.deleted_at is null
        and not exists (select 1 from assistant_projections ap where ap.post_id = p.id and ap.status <> 'projected')`
      )
      .get(topicId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  listAllPosts(topicId: string): PostRow[] {
    return this.db
      .prepare(
        `select p.* from posts p where p.topic_id = ?
      and not exists (select 1 from assistant_projections ap where ap.post_id = p.id and ap.status <> 'projected')
      order by p.created_at asc`
      )
      .all(topicId) as PostRow[];
  }

  /**
   * Returns posts strictly between (afterPostId, beforePostId) in stable insertion order.
   * Used to build deterministic "catch-up context" for the robot when some posts were created
   * without dispatching a robot turn (silent posts).
   */
  listPostsBetween(
    topicId: string,
    opts: {
      afterPostId?: string | null;
      beforePostId: string;
      excludePiSessionId?: string | null;
      excludePendingDispatches?: boolean;
    }
  ): PostRow[] {
    const before = this.db
      .prepare('select rowid as rowid from posts where id = ? and topic_id = ?')
      .get(opts.beforePostId, topicId) as { rowid: number } | undefined;
    if (!before) return [];

    let afterRowid = 0;
    if (opts.afterPostId) {
      const after = this.db
        .prepare('select rowid as rowid from posts where id = ? and topic_id = ?')
        .get(opts.afterPostId, topicId) as { rowid: number } | undefined;
      if (after) afterRowid = after.rowid;
    }

    return this.db
      .prepare(
        `select p.* from posts p
         where p.topic_id = ? and p.rowid > ? and p.rowid < ?
           and (? is null or not exists (
             select 1 from pi_message_links l where l.post_id = p.id and l.pi_session_id = ?
           ))
           and (? = 0 or not exists (
             select 1 from post_dispatches d
             join post_dispatch_generations g on g.topic_id = d.topic_id and g.generation = d.generation
             where d.post_id = p.id
               and (d.status in ('pending', 'dispatching') or (d.status = 'failed' and d.next_attempt_at is not null))
           ))
         order by p.rowid asc`
      )
      .all(
        topicId,
        afterRowid,
        before.rowid,
        opts.excludePiSessionId ?? null,
        opts.excludePiSessionId ?? null,
        opts.excludePendingDispatches ? 1 : 0
      ) as PostRow[];
  }

  getTopicRead(identityId: string, topicId: string): TopicReadRow | null {
    const row = this.db
      .prepare('select * from topic_reads where identity_id = ? and topic_id = ?')
      .get(identityId, topicId) as TopicReadRow | undefined;
    return row ?? null;
  }

  upsertTopicRead(input: {
    identityId: string;
    topicId: string;
    lastReadPostId?: string | null;
    lastReadAt?: string | null;
  }): TopicReadRow {
    const now = nowIso();
    const existing = this.getTopicRead(input.identityId, input.topicId);
    const lastReadPostId = input.lastReadPostId ?? existing?.last_read_post_id ?? null;
    const lastReadAt = input.lastReadAt ?? existing?.last_read_at ?? now;
    this.db
      .prepare(
        `insert into topic_reads (identity_id, topic_id, last_read_post_id, last_read_at, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(identity_id, topic_id) do update set
           last_read_post_id = excluded.last_read_post_id,
           last_read_at = excluded.last_read_at,
           updated_at = excluded.updated_at`
      )
      .run(input.identityId, input.topicId, lastReadPostId, lastReadAt, existing?.created_at ?? now, now);
    return this.getTopicRead(input.identityId, input.topicId) as TopicReadRow;
  }

  getTopicUnread(
    identityId: string,
    topicId: string
  ): {
    topicId: string;
    identityId: string;
    lastReadPostId: string | null;
    lastReadAt: string | null;
    lastPostId: string | null;
    lastPostAt: string | null;
    unreadCount: number;
  } {
    const readState = this.getTopicRead(identityId, topicId);
    const lastReadAt = readState?.last_read_at ?? null;
    const lastReadPostId = readState?.last_read_post_id ?? null;
    const lastPostRow = this.db
      .prepare(
        'select id, created_at from posts where topic_id = ? and deleted_at is null order by created_at desc limit 1'
      )
      .get(topicId) as { id: string; created_at: string } | undefined;
    const lastPostAt = lastPostRow?.created_at ?? null;
    const lastPostId = lastPostRow?.id ?? null;
    const unreadRow = lastReadAt
      ? (this.db
          .prepare('select count(*) as count from posts where topic_id = ? and deleted_at is null and created_at > ?')
          .get(topicId, lastReadAt) as { count: number })
      : (this.db
          .prepare('select count(*) as count from posts where topic_id = ? and deleted_at is null')
          .get(topicId) as { count: number });
    return {
      topicId,
      identityId,
      lastReadPostId,
      lastReadAt,
      lastPostId,
      lastPostAt,
      unreadCount: unreadRow?.count ?? 0,
    };
  }

  getTopicSubscription(identityId: string, topicId: string): TopicSubscriptionRow | null {
    const row = this.db
      .prepare('select * from topic_subscriptions where identity_id = ? and topic_id = ?')
      .get(identityId, topicId) as TopicSubscriptionRow | undefined;
    return row ?? null;
  }

  upsertTopicSubscription(input: {
    identityId: string;
    topicId: string;
    mode: 'watching' | 'muted' | 'off';
  }): TopicSubscriptionRow {
    const now = nowIso();
    const existing = this.getTopicSubscription(input.identityId, input.topicId);
    const createdAt = existing?.created_at ?? now;
    this.db
      .prepare(
        `insert into topic_subscriptions (identity_id, topic_id, mode, created_at, updated_at)
         values (?, ?, ?, ?, ?)
         on conflict(identity_id, topic_id) do update set
           mode = excluded.mode,
           updated_at = excluded.updated_at`
      )
      .run(input.identityId, input.topicId, input.mode, createdAt, now);
    return this.getTopicSubscription(input.identityId, input.topicId) as TopicSubscriptionRow;
  }

  listTopicSubscriptions(topicId: string, mode?: 'watching' | 'muted' | 'off'): TopicSubscriptionRow[] {
    if (mode) {
      return this.db
        .prepare('select * from topic_subscriptions where topic_id = ? and mode = ?')
        .all(topicId, mode) as TopicSubscriptionRow[];
    }
    return this.db
      .prepare('select * from topic_subscriptions where topic_id = ?')
      .all(topicId) as TopicSubscriptionRow[];
  }

  listSubscriptionsByIdentity(identityId: string): TopicSubscriptionRow[] {
    return this.db
      .prepare('select * from topic_subscriptions where identity_id = ? order by updated_at desc')
      .all(identityId) as TopicSubscriptionRow[];
  }

  createNotification(input: {
    identityId: string;
    type: string;
    actorId?: string | null;
    topicId?: string | null;
    postId?: string | null;
    payload?: Record<string, unknown> | null;
  }): NotificationRow {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'insert into notifications (id, identity_id, type, actor_id, topic_id, post_id, payload_json, created_at, read_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        input.identityId,
        input.type,
        input.actorId ?? null,
        input.topicId ?? null,
        input.postId ?? null,
        input.payload ? JSON.stringify(input.payload) : null,
        now,
        null
      );
    return this.getNotification(id) as NotificationRow;
  }

  getNotification(id: string): NotificationRow | null {
    const row = this.db.prepare('select * from notifications where id = ?').get(id) as NotificationRow | undefined;
    return row ?? null;
  }

  listNotifications(
    identityId: string,
    opts?: { page?: number; pageSize?: number; unreadOnly?: boolean }
  ): NotificationRow[] {
    const page = Math.max(1, Math.trunc(opts?.page ?? 1));
    const pageSize = Math.max(1, Math.min(100, Math.trunc(opts?.pageSize ?? 50)));
    const offset = (page - 1) * pageSize;
    if (opts?.unreadOnly) {
      return this.db
        .prepare(
          'select * from notifications where identity_id = ? and read_at is null order by created_at desc limit ? offset ?'
        )
        .all(identityId, pageSize, offset) as NotificationRow[];
    }
    return this.db
      .prepare('select * from notifications where identity_id = ? order by created_at desc limit ? offset ?')
      .all(identityId, pageSize, offset) as NotificationRow[];
  }

  countNotifications(identityId: string, unreadOnly?: boolean): number {
    const row = unreadOnly
      ? (this.db
          .prepare('select count(*) as count from notifications where identity_id = ? and read_at is null')
          .get(identityId) as { count: number })
      : (this.db.prepare('select count(*) as count from notifications where identity_id = ?').get(identityId) as {
          count: number;
        });
    return row?.count ?? 0;
  }

  markNotificationRead(id: string, readAt: string | null): NotificationRow | null {
    const existing = this.getNotification(id);
    if (!existing) return null;
    this.db.prepare('update notifications set read_at = ? where id = ?').run(readAt, id);
    return this.getNotification(id);
  }

  markAllNotificationsRead(identityId: string): number {
    const now = nowIso();
    const result = this.db
      .prepare('update notifications set read_at = ? where identity_id = ? and read_at is null')
      .run(now, identityId);
    return result.changes ?? 0;
  }

  getLatestHumanPostId(topicId: string): string | null {
    const row = this.db
      .prepare(
        `
      select p.id
      from posts p
      join identities i on p.author_id = i.id
      where p.topic_id = ? and p.deleted_at is null and i.kind not in ('robot','persona','system','webhook')
      order by p.created_at desc
      limit 1
    `
      )
      .get(topicId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  getLatestPostId(topicId: string): string | null {
    const row = this.db
      .prepare(
        `
      select id
      from posts
      where topic_id = ? and deleted_at is null
      order by created_at desc
      limit 1
    `
      )
      .get(topicId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  getPost(postId: string): PostRow | null {
    const row = this.db.prepare('select * from posts where id = ?').get(postId) as PostRow | undefined;
    return row ?? null;
  }

  findRecentDuplicatePost(input: {
    topicId: string;
    authorId: string;
    body: string;
    createdNear?: string | null;
  }): PostRow | null {
    const center = input.createdNear ? Date.parse(input.createdNear) : Date.now();
    const effectiveCenter = Number.isFinite(center) ? center : Date.now();
    const start = new Date(effectiveCenter - RECENT_DUPLICATE_WINDOW_MS).toISOString();
    const end = new Date(effectiveCenter + RECENT_DUPLICATE_WINDOW_MS).toISOString();
    const normalizedBody = normalizePostBodyForDuplicateCheck(input.body);
    const rows = this.db
      .prepare(
        `select * from posts
         where topic_id = ?
           and author_id = ?
           and deleted_at is null
           and created_at between ? and ?
         order by created_at desc
         limit 20`
      )
      .all(input.topicId, input.authorId, start, end) as PostRow[];
    return rows.find((row) => normalizePostBodyForDuplicateCheck(row.body) === normalizedBody) ?? null;
  }

  createPost(input: CreatePostInput): PostRow {
    const postId = randomUUID();
    const now = nowIso();
    let autoCompactChanged = false;
    this.db.transaction(() => {
      if (input.draft) {
        const draft = this.db
          .prepare(
            "select id from message_drafts where id = ? and owner_identity_id = ? and context = 'reply' and topic_id = ? and revision = ? and expires_at > ?"
          )
          .get(input.draft.id, input.authorId, input.topicId, input.draft.revision, now);
        if (!draft) throw new Error('draft changed in another session');
      }
      if (input.autoCompactEnabled !== undefined || input.autoCompactRevision !== undefined) {
        if (input.autoCompactEnabled === undefined || input.autoCompactRevision === undefined) {
          throw new Error('auto-compaction setting and revision must be provided together');
        }
        const topic = this.getTopic(input.topicId);
        if (!topic) throw new Error('topic not found');
        if (topic.auto_compact_revision !== input.autoCompactRevision) {
          throw new Error('auto-compaction setting changed in another request');
        }
        if (Boolean(topic.auto_compact_enabled) !== input.autoCompactEnabled) {
          const result = this.db
            .prepare(
              `update topics
             set auto_compact_enabled = ?, auto_compact_revision = auto_compact_revision + 1, updated_at = ?
             where id = ? and auto_compact_revision = ?`
            )
            .run(input.autoCompactEnabled ? 1 : 0, now, input.topicId, input.autoCompactRevision);
          if (result.changes !== 1) throw new Error('auto-compaction setting changed in another request');
          autoCompactChanged = true;
        }
      }
      this.db
        .prepare(
          'insert into posts (id, topic_id, tenant_id, parent_post_id, author_id, body, source_message_id, silent, created_at, edited_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          postId,
          input.topicId,
          null,
          input.parentPostId ?? null,
          input.authorId,
          input.body,
          input.sourceMessageId ?? null,
          input.silent ? 1 : 0,
          now,
          null,
          null
        );
      if (input.draft)
        this.db
          .prepare('delete from message_drafts where id = ? and owner_identity_id = ? and revision = ?')
          .run(input.draft.id, input.authorId, input.draft.revision);
    })();
    if (autoCompactChanged) this.invalidateTopicCache(input.topicId);
    this.invalidateTopicStatsCache(input.topicId);
    const topic = this.getTopic(input.topicId);
    if (topic) this.invalidateForumStatsCache(topic.forum_id);
    return this.getPost(postId) as PostRow;
  }

  updatePost(postId: string, input: UpdatePostInput): PostRow {
    const existing = this.getPost(postId);
    if (!existing) {
      throw new Error('post not found');
    }
    if (existing.deleted_at) {
      throw new Error('cannot edit deleted post');
    }
    const now = nowIso();
    this.db.prepare('update posts set body = ?, edited_at = ? where id = ?').run(input.body, now, postId);
    return this.getPost(postId) as PostRow;
  }

  setPostSilent(postId: string, silent: boolean): PostRow {
    const existing = this.getPost(postId);
    if (!existing) {
      throw new Error('post not found');
    }
    if (existing.deleted_at) {
      throw new Error('cannot update deleted post');
    }
    this.db.prepare('update posts set silent = ? where id = ?').run(silent ? 1 : 0, postId);
    return this.getPost(postId) as PostRow;
  }

  softDeletePost(postId: string): PostRow {
    const existing = this.getPost(postId);
    if (!existing) {
      throw new Error('post not found');
    }
    if (existing.deleted_at) {
      throw new Error('post already deleted');
    }
    const now = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare('update posts set deleted_at = ?, body = ? where id = ?')
        .run(now, '[This post has been deleted]', postId);
      this.detachPostAttachments(postId, 'post_deleted');
    })();
    this.invalidateTopicStatsCache(existing.topic_id);
    const topic = this.getTopic(existing.topic_id);
    if (topic) {
      this.invalidateForumStatsCache(topic.forum_id);
    }
    return this.getPost(postId) as PostRow;
  }

  listIdentities(topicId: string, page = 1, pageSize = 100): IdentityRow[] {
    const offset = (page - 1) * pageSize;
    return this.db
      .prepare(
        `select distinct i.* from identities i
         join posts p on p.author_id = i.id
         where p.topic_id = ?
         order by i.display_name asc
         limit ? offset ?`
      )
      .all(topicId, pageSize, offset) as IdentityRow[];
  }

  getIdentity(identityId: string): IdentityRow | null {
    const cached = this.identityCache.get(identityId);
    if (cached) return cached;
    const row = this.db.prepare('select * from identities where id = ?').get(identityId) as IdentityRow | undefined;
    if (row) {
      this.identityCache.set(identityId, row);
    }
    return row ?? null;
  }

  getIdentitiesByIds(identityIds: string[]): Map<string, IdentityRow> {
    const result = new Map<string, IdentityRow>();
    if (!identityIds.length) return result;
    const uniqueIds = Array.from(new Set(identityIds));
    const missing: string[] = [];
    for (const id of uniqueIds) {
      const cached = this.identityCache.get(id);
      if (cached) {
        result.set(id, cached);
      } else {
        missing.push(id);
      }
    }
    if (!missing.length) return result;
    const placeholders = missing.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`select * from identities where id in (${placeholders})`)
      .all(...missing) as IdentityRow[];
    for (const row of rows) {
      this.identityCache.set(row.id, row);
      result.set(row.id, row);
    }
    return result;
  }

  getIdentityByKind(kind: string): IdentityRow | null {
    const row = this.db.prepare('select * from identities where kind = ? limit 1').get(kind) as IdentityRow | undefined;
    return row ?? null;
  }

  ensureSession(input: CreateSessionInput): SessionRow {
    const existing = this.db.prepare('select * from sessions where topic_id = ?').get(input.topicId) as
      SessionRow | undefined;
    if (existing) {
      return this.normalizeSessionAgentFields(existing) ?? existing;
    }

    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'insert into sessions (id, topic_id, codex_thread_id, created_at, updated_at, status) values (?, ?, ?, ?, ?, ?)'
      )
      .run(id, input.topicId, null, now, now, 'active');
    return this.getSession(id) as SessionRow;
  }

  getSession(sessionId: string): SessionRow | null {
    const row = this.db.prepare('select * from sessions where id = ?').get(sessionId) as SessionRow | undefined;
    return this.normalizeSessionAgentFields(row ?? null);
  }

  getSessionByTopic(topicId: string): SessionRow | null {
    const row = this.db.prepare('select * from sessions where topic_id = ?').get(topicId) as SessionRow | undefined;
    return this.normalizeSessionAgentFields(row ?? null);
  }

  getSessionByAgentThreadId(threadId: string): SessionRow | null {
    const row = this.db.prepare('select * from sessions where agent_thread_id = ?').get(threadId) as
      SessionRow | undefined;
    return this.normalizeSessionAgentFields(row ?? null);
  }

  listSessionsWithThreads(opts?: { sinceMs?: number; backend?: string | null }): SessionRow[] {
    const sinceMs = opts?.sinceMs;
    const backend = opts?.backend ?? null;
    const params: Array<string> = [];
    if (sinceMs !== undefined && sinceMs > 0) {
      const cutoff = new Date(Date.now() - sinceMs).toISOString();
      if (backend) {
        params.push(backend, cutoff);
        const rows = this.db
          .prepare(
            'select * from sessions where agent_thread_id is not null and agent_backend = ? and updated_at >= ? order by updated_at desc'
          )
          .all(...params) as SessionRow[];
        return rows.map((row) => this.normalizeSessionAgentFields(row) ?? row);
      }
      const rows = this.db
        .prepare(
          'select * from sessions where (agent_thread_id is not null or codex_thread_id is not null) and updated_at >= ? order by updated_at desc'
        )
        .all(cutoff) as SessionRow[];
      return rows.map((row) => this.normalizeSessionAgentFields(row) ?? row);
    }
    if (backend) {
      params.push(backend);
      const rows = this.db
        .prepare(
          'select * from sessions where agent_thread_id is not null and agent_backend = ? order by updated_at desc'
        )
        .all(...params) as SessionRow[];
      return rows.map((row) => this.normalizeSessionAgentFields(row) ?? row);
    }
    const rows = this.db
      .prepare(
        'select * from sessions where agent_thread_id is not null or codex_thread_id is not null order by updated_at desc'
      )
      .all() as SessionRow[];
    return rows.map((row) => this.normalizeSessionAgentFields(row) ?? row);
  }

  listRobotStates(activity?: string | null): RobotStateRow[] {
    if (activity === undefined || activity === null) {
      return this.db.prepare('select * from robot_state order by last_updated_at desc').all() as RobotStateRow[];
    }
    return this.db
      .prepare('select * from robot_state where activity = ? order by last_updated_at desc')
      .all(activity) as RobotStateRow[];
  }

  setSessionAgentThread(sessionId: string, backend: string, threadId: string): SessionRow {
    const now = nowIso();
    this.db
      .prepare('update sessions set agent_thread_id = ?, agent_backend = ?, updated_at = ? where id = ?')
      .run(threadId, backend, now, sessionId);
    return this.getSession(sessionId) as SessionRow;
  }

  clearSessionAgentThread(sessionId: string): void {
    const now = nowIso();
    this.db
      .prepare('update sessions set agent_thread_id = null, agent_backend = null, updated_at = ? where id = ?')
      .run(now, sessionId);
  }

  setSessionAgentBackend(sessionId: string, backend: string): SessionRow {
    const now = nowIso();
    this.db.prepare('update sessions set agent_backend = ?, updated_at = ? where id = ?').run(backend, now, sessionId);
    return this.getSession(sessionId) as SessionRow;
  }

  setSessionPersonasSyncedAt(
    sessionId: string,
    syncedAtIso: string | null,
    contextForumId?: string | null
  ): SessionRow {
    const now = nowIso();
    if (contextForumId !== undefined) {
      this.db
        .prepare('update sessions set personas_synced_at = ?, context_synced_forum_id = ?, updated_at = ? where id = ?')
        .run(syncedAtIso, contextForumId, now, sessionId);
    } else {
      this.db
        .prepare('update sessions set personas_synced_at = ?, updated_at = ? where id = ?')
        .run(syncedAtIso, now, sessionId);
    }
    return this.getSession(sessionId) as SessionRow;
  }

  setSessionLastDispatchedPostId(sessionId: string, postId: string | null): SessionRow {
    const now = nowIso();
    this.db
      .prepare('update sessions set last_dispatched_post_id = ?, updated_at = ? where id = ?')
      .run(postId, now, sessionId);
    return this.getSession(sessionId) as SessionRow;
  }

  private normalizeSessionAgentFields(session: SessionRow | null): SessionRow | null {
    if (!session) return null;
    if (session.agent_thread_id) {
      if (!session.agent_backend) {
        const now = nowIso();
        this.db
          .prepare('update sessions set agent_backend = ?, updated_at = ? where id = ?')
          .run('echs', now, session.id);
        return { ...session, agent_backend: 'echs', updated_at: now };
      }
      return session;
    }
    return session;
  }

  createSessionMessage(sessionId: string, role: string, content: string, visibility: string): SessionMessageRow {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'insert into session_messages (id, session_id, role, content, created_at, visibility) values (?, ?, ?, ?, ?, ?)'
      )
      .run(id, sessionId, role, content, now, visibility);
    return this.getSessionMessage(id) as SessionMessageRow;
  }

  createMessageTamper(input: CreateMessageTamperInput): MessageTamperRow {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'insert into message_tampers (id, topic_id, session_id, post_id, session_message_id, direction, stage, plugin_key, plugin_priority, input_text, output_text, changed, error, duration_ms, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        input.topicId,
        input.sessionId,
        input.postId ?? null,
        input.sessionMessageId ?? null,
        input.direction,
        input.stage,
        input.pluginKey,
        input.pluginPriority,
        input.inputText,
        input.outputText,
        input.changed ? 1 : 0,
        input.error ?? null,
        input.durationMs ?? null,
        now
      );
    return this.getMessageTamper(id) as MessageTamperRow;
  }

  getMessageTamper(id: string): MessageTamperRow | null {
    const row = this.db.prepare('select * from message_tampers where id = ?').get(id) as MessageTamperRow | undefined;
    return row ?? null;
  }

  listMessageTampersForPost(postId: string): MessageTamperRow[] {
    return this.db
      .prepare('select * from message_tampers where post_id = ? order by created_at asc')
      .all(postId) as MessageTamperRow[];
  }

  listMessageTampersForSessionMessage(sessionMessageId: string): MessageTamperRow[] {
    return this.db
      .prepare('select * from message_tampers where session_message_id = ? order by created_at asc')
      .all(sessionMessageId) as MessageTamperRow[];
  }

  listSessionMessages(sessionId: string): SessionMessageRow[] {
    return this.db
      .prepare('select * from session_messages where session_id = ? order by created_at asc')
      .all(sessionId) as SessionMessageRow[];
  }

  listTamperConfigs(forumId?: string | null): TamperConfigRow[] {
    if (forumId === undefined) {
      return this.db.prepare('select * from tamper_configs order by created_at desc').all() as TamperConfigRow[];
    }
    if (forumId === null) {
      return this.db
        .prepare('select * from tamper_configs where forum_id is null order by created_at desc')
        .all() as TamperConfigRow[];
    }
    return this.db
      .prepare('select * from tamper_configs where forum_id = ? order by created_at desc')
      .all(forumId) as TamperConfigRow[];
  }

  getTamperConfig(configId: string): TamperConfigRow | null {
    const row = this.db.prepare('select * from tamper_configs where id = ?').get(configId) as
      TamperConfigRow | undefined;
    return row ?? null;
  }

  listTamperConfigsForForumByPlugin(forumId: string, pluginKey: string): TamperConfigRow[] {
    return this.db
      .prepare('select * from tamper_configs where forum_id = ? and plugin_key = ?')
      .all(forumId, pluginKey) as TamperConfigRow[];
  }

  listGlobalTamperConfigsByPlugin(pluginKey: string): TamperConfigRow[] {
    return this.db
      .prepare('select * from tamper_configs where forum_id is null and plugin_key = ?')
      .all(pluginKey) as TamperConfigRow[];
  }

  getTamperConfigForForum(forumId: string, pluginKey: string, direction: string): TamperConfigRow | null {
    const candidates = this.listTamperConfigsForForumByPlugin(forumId, pluginKey);
    return pickTamperConfigByDirection(candidates, direction);
  }

  getGlobalTamperConfig(pluginKey: string, direction: string): TamperConfigRow | null {
    const candidates = this.listGlobalTamperConfigsByPlugin(pluginKey);
    return pickTamperConfigByDirection(candidates, direction);
  }

  resolveTamperConfig(forumId: string | null, pluginKey: string, direction: string): TamperConfigRow | null {
    if (forumId) {
      const forumConfig = this.getTamperConfigForForum(forumId, pluginKey, direction);
      if (forumConfig) return forumConfig;
    }
    return this.getGlobalTamperConfig(pluginKey, direction);
  }

  createTamperConfig(input: CreateTamperConfigInput): TamperConfigRow {
    const id = randomUUID();
    const now = nowIso();
    const enabled = input.enabled ?? true;
    const priority = input.priority ?? 0;
    const direction = input.direction ?? null;
    const onlyFirst = input.onlyFirstMessage ?? null;
    const configJson = input.config ? JSON.stringify(input.config) : null;
    this.db
      .prepare(
        'insert into tamper_configs (id, forum_id, plugin_key, enabled, priority, direction, only_first_message, config_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        input.forumId ?? null,
        input.pluginKey,
        enabled ? 1 : 0,
        priority,
        direction,
        onlyFirst === null ? null : onlyFirst ? 1 : 0,
        configJson,
        now,
        now
      );
    return this.getTamperConfig(id) as TamperConfigRow;
  }

  updateTamperConfig(configId: string, input: UpdateTamperConfigInput): TamperConfigRow | null {
    const existing = this.getTamperConfig(configId);
    if (!existing) return null;

    const now = nowIso();
    const forumId = input.forumId !== undefined ? input.forumId : existing.forum_id;
    const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled;
    const priority = input.priority !== undefined ? input.priority : existing.priority;
    const direction = input.direction !== undefined ? input.direction : existing.direction;
    const onlyFirst =
      input.onlyFirstMessage !== undefined
        ? input.onlyFirstMessage === null
          ? null
          : input.onlyFirstMessage
            ? 1
            : 0
        : existing.only_first_message;
    const configJson =
      input.config !== undefined ? (input.config ? JSON.stringify(input.config) : null) : existing.config_json;

    this.db
      .prepare(
        'update tamper_configs set forum_id = ?, enabled = ?, priority = ?, direction = ?, only_first_message = ?, config_json = ?, updated_at = ? where id = ?'
      )
      .run(forumId, enabled, priority, direction, onlyFirst, configJson, now, configId);
    return this.getTamperConfig(configId) as TamperConfigRow;
  }

  deleteTamperConfig(configId: string): boolean {
    const info = this.db.prepare('delete from tamper_configs where id = ?').run(configId);
    return info.changes > 0;
  }

  getSessionMessage(messageId: string): SessionMessageRow | null {
    const row = this.db.prepare('select * from session_messages where id = ?').get(messageId) as
      SessionMessageRow | undefined;
    return row ?? null;
  }

  createPlan(input: CreatePlanInput): PlanRow {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'insert into plans (id, topic_id, session_id, content, summary, parent_post_id, visibility, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        input.topicId,
        input.sessionId,
        input.content,
        input.summary ?? null,
        input.parentPostId ?? null,
        input.visibility,
        now,
        now
      );
    return this.getPlan(id) as PlanRow;
  }

  updatePlan(
    planId: string,
    content: string,
    summary?: string | null,
    reasoningCheckpoints?: number[] | null
  ): PlanRow {
    const now = nowIso();
    const checkpointsJson = reasoningCheckpoints ? JSON.stringify(reasoningCheckpoints) : undefined;
    if (checkpointsJson !== undefined) {
      this.db
        .prepare(
          'update plans set content = ?, summary = ?, reasoning_checkpoints_json = ?, updated_at = ? where id = ?'
        )
        .run(content, summary ?? null, checkpointsJson, now, planId);
    } else {
      this.db
        .prepare('update plans set content = ?, summary = ?, updated_at = ? where id = ?')
        .run(content, summary ?? null, now, planId);
    }
    return this.getPlan(planId) as PlanRow;
  }

  getPlan(planId: string): PlanRow | null {
    const row = this.db.prepare('select * from plans where id = ?').get(planId) as PlanRow | undefined;
    return row ?? null;
  }

  listPlansBySession(sessionId: string, limit = 50): PlanRow[] {
    return this.db
      .prepare('select * from plans where session_id = ? order by created_at desc, rowid desc limit ?')
      .all(sessionId, limit) as PlanRow[];
  }

  listAllPlansBySession(sessionId: string): PlanRow[] {
    return this.db
      .prepare('select * from plans where session_id = ? order by created_at desc, rowid desc')
      .all(sessionId) as PlanRow[];
  }

  createToolRun(input: CreateToolRunInput): ToolRunRow {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'insert into tool_runs (id, topic_id, session_id, tool, parent_post_id, started_at, finished_at, exit_code, command, files_touched_json, output_summary, redactions_applied, visibility) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        input.topicId,
        input.sessionId,
        input.tool,
        input.parentPostId ?? null,
        now,
        null,
        null,
        input.command ?? null,
        null,
        input.outputSummary ?? null,
        1,
        input.visibility
      );
    return this.getToolRun(id) as ToolRunRow;
  }

  updateToolRun(toolRunId: string, updates: Partial<Omit<ToolRunRow, 'id' | 'topic_id' | 'session_id'>>): ToolRunRow {
    const existing = this.getToolRun(toolRunId);
    if (!existing) {
      throw new Error('tool run not found');
    }
    const merged = { ...existing, ...updates } as ToolRunRow;
    this.db
      .prepare(
        'update tool_runs set tool = ?, parent_post_id = ?, started_at = ?, finished_at = ?, exit_code = ?, command = ?, files_touched_json = ?, output_summary = ?, redactions_applied = ?, visibility = ? where id = ?'
      )
      .run(
        merged.tool,
        merged.parent_post_id,
        merged.started_at,
        merged.finished_at,
        merged.exit_code,
        merged.command,
        merged.files_touched_json,
        merged.output_summary,
        merged.redactions_applied,
        merged.visibility,
        toolRunId
      );
    return this.getToolRun(toolRunId) as ToolRunRow;
  }

  listToolRuns(topicId: string, limit = 20): ToolRunRow[] {
    return this.db
      .prepare('select * from tool_runs where topic_id = ? order by started_at desc, rowid desc limit ?')
      .all(topicId, limit) as ToolRunRow[];
  }

  listToolRunsBySession(sessionId: string, limit = 50): ToolRunRow[] {
    return this.db
      .prepare('select * from tool_runs where session_id = ? order by started_at desc, rowid desc limit ?')
      .all(sessionId, limit) as ToolRunRow[];
  }

  listAllToolRunsBySession(sessionId: string): ToolRunRow[] {
    return this.db
      .prepare('select * from tool_runs where session_id = ? order by started_at desc, rowid desc')
      .all(sessionId) as ToolRunRow[];
  }

  getToolRun(toolRunId: string): ToolRunRow | null {
    const row = this.db.prepare('select * from tool_runs where id = ?').get(toolRunId) as ToolRunRow | undefined;
    return row ?? null;
  }

  createTopicOperationalEvent(input: CreateTopicOperationalEventInput): TopicOperationalEvent {
    const existing = this.db
      .prepare('select * from topic_operational_events where source_kind = ? and source_id = ?')
      .get(input.sourceKind, input.sourceId) as TopicOperationalEventRow | undefined;
    if (existing) return mapTopicOperationalEventRowToDomain(existing);
    const id = randomUUID();
    this.db
      .prepare(
        `insert into topic_operational_events
       (id, topic_id, anchor_post_id, event_type, category, status, summary, detail_json, source_kind, source_id, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.topicId,
        input.anchorPostId ?? null,
        input.type,
        input.category,
        input.status,
        input.summary,
        input.detail ? JSON.stringify(input.detail) : null,
        input.sourceKind,
        input.sourceId,
        nowIso()
      );
    return mapTopicOperationalEventRowToDomain(
      this.db.prepare('select * from topic_operational_events where id = ?').get(id) as TopicOperationalEventRow
    );
  }

  listTopicOperationalEvents(topicId: string): TopicOperationalEvent[] {
    return (
      this.db
        .prepare('select * from topic_operational_events where topic_id = ? order by created_at asc, id asc')
        .all(topicId) as TopicOperationalEventRow[]
    ).map(mapTopicOperationalEventRowToDomain);
  }

  listEligibleForkBoundaries(topicId: string): ForkBoundary[] {
    const link = this.getPiSessionLinkByTopic(topicId);
    if (!link) return [];
    const head = this.db
      .prepare('select active_entry_ids_json from pi_session_heads where pi_session_id = ?')
      .get(link.pi_session_id) as { active_entry_ids_json: string } | undefined;
    if (!head) return [];
    let activeIds: string[];
    let active: Set<string>;
    try {
      activeIds = JSON.parse(head.active_entry_ids_json) as string[];
      active = new Set(activeIds);
    } catch {
      return [];
    }
    const posts = this.db
      .prepare('select * from posts where topic_id = ? order by rowid asc')
      .all(topicId) as PostRow[];
    const projected = posts.map((post) => {
      const message = this.db
        .prepare('select * from pi_message_links where pi_session_id = ? and post_id = ? limit 1')
        .get(link.pi_session_id, post.id) as PiMessageLinkRow | undefined;
      const entry = message
        ? (this.db
            .prepare('select role, has_visible_text from pi_entry_index where pi_session_id = ? and entry_id = ?')
            .get(link.pi_session_id, message.pi_message_id) as
            { role: string | null; has_visible_text: number } | undefined)
        : undefined;
      let singleton = false;
      try {
        const metadata = JSON.parse(message?.metadata_json ?? 'null') as { contributorPostIds?: unknown } | null;
        singleton =
          Array.isArray(metadata?.contributorPostIds) &&
          metadata.contributorPostIds.length === 1 &&
          metadata.contributorPostIds[0] === post.id;
      } catch {
        singleton = false;
      }
      return { post, message, entry, singleton };
    });

    const boundaries: ForkBoundary[] = [];
    let prefixComplete = true;
    for (let index = 0; index < projected.length; index += 1) {
      const current = projected[index]!;
      prefixComplete =
        prefixComplete &&
        !current.post.deleted_at &&
        Boolean(current.message && current.entry?.has_visible_text && active.has(current.message.pi_message_id));
      const inheritedHasAssistant = projected
        .slice(0, index)
        .some(
          (candidate) =>
            !candidate.post.deleted_at &&
            candidate.entry?.role === 'assistant' &&
            Boolean(
              candidate.entry.has_visible_text && candidate.message && active.has(candidate.message.pi_message_id)
            )
        );
      // V1 materialization requires an inherited forum prefix and at least one
      // inherited assistant response. Never advertise a before-first-user
      // boundary that the durable worker must later reject.
      if (
        !prefixComplete ||
        index === 0 ||
        !inheritedHasAssistant ||
        current.entry?.role !== 'user' ||
        !current.singleton
      )
        continue;
      const response = projected[index + 1];
      const activeIndex = current.message ? activeIds.indexOf(current.message.pi_message_id) : -1;
      let nextCanonicalMessageId: string | null = null;
      for (const entryId of activeIds.slice(activeIndex + 1)) {
        const entry = this.db
          .prepare('select role, has_visible_text from pi_entry_index where pi_session_id = ? and entry_id = ?')
          .get(link.pi_session_id, entryId) as { role: string | null; has_visible_text: number } | undefined;
        if (entry?.has_visible_text && (entry.role === 'user' || entry.role === 'assistant')) {
          nextCanonicalMessageId = entryId;
          break;
        }
      }
      const responseActiveIndex = nextCanonicalMessageId ? activeIds.indexOf(nextCanonicalMessageId) : -1;
      const canonicalPrefixComplete =
        responseActiveIndex >= 0 &&
        activeIds.slice(0, responseActiveIndex + 1).every((entryId) => {
          const entry = this.db
            .prepare('select role, has_visible_text from pi_entry_index where pi_session_id = ? and entry_id = ?')
            .get(link.pi_session_id, entryId) as { role: string | null; has_visible_text: number } | undefined;
          if (!entry?.has_visible_text || (entry.role !== 'user' && entry.role !== 'assistant')) return true;
          const projectedPost = this.db
            .prepare(
              `select p.deleted_at from pi_message_links l
               join posts p on p.id = l.post_id
               where l.pi_session_id = ? and l.pi_message_id = ? and p.topic_id = ? limit 1`
            )
            .get(link.pi_session_id, entryId, topicId) as { deleted_at: string | null } | undefined;
          return Boolean(projectedPost && !projectedPost.deleted_at);
        });
      if (
        activeIndex < 0 ||
        !canonicalPrefixComplete ||
        !response ||
        response.post.deleted_at ||
        response.entry?.role !== 'assistant' ||
        !response.entry.has_visible_text ||
        !response.message ||
        nextCanonicalMessageId !== response.message.pi_message_id ||
        !active.has(response.message.pi_message_id)
      )
        continue;
      boundaries.push({
        postId: current.post.id,
        postNumber: index + 1,
        piMessageId: current.message!.pi_message_id,
        entryId: current.message!.pi_message_id,
        excerpt: current.post.body.trim().slice(0, 180),
        body: current.post.body,
      });
    }
    return boundaries;
  }

  getForkOperation(id: string): ForkOperation | null {
    const row = this.db.prepare('select * from fork_operations where id = ?').get(id) as ForkOperationRow | undefined;
    return row ? mapForkOperationRowToDomain(row) : null;
  }

  hasForkFence(topicId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "select 1 from fork_operations where source_topic_id = ? and status in ('pending', 'running', 'needs_manual_review') limit 1"
        )
        .get(topicId)
    );
  }

  countPendingOrRunningForkOperations(): number {
    const row = this.db
      .prepare("select count(*) as count from fork_operations where status in ('pending', 'running')")
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  getActiveForkOperation(topicId: string): ForkOperation | null {
    const row = this.db
      .prepare(
        "select * from fork_operations where source_topic_id = ? and status in ('pending', 'running', 'needs_manual_review') order by created_at desc limit 1"
      )
      .get(topicId) as ForkOperationRow | undefined;
    return row ? mapForkOperationRowToDomain(row) : null;
  }

  getLatestForkOperation(topicId: string): ForkOperation | null {
    const row = this.db
      .prepare('select * from fork_operations where source_topic_id = ? order by created_at desc limit 1')
      .get(topicId) as ForkOperationRow | undefined;
    return row ? mapForkOperationRowToDomain(row) : null;
  }

  finalizeForkAttachmentPaths(id: string, fromRoot: string, toRoot: string): void {
    this.db.transaction(() => {
      const row = this.db.prepare('select prestaged_attachments_json from fork_operations where id = ?').get(id) as
        { prestaged_attachments_json: string } | undefined;
      if (!row) throw new Error('fork operation not found');
      const prestaged = JSON.parse(row.prestaged_attachments_json) as EnqueueForkOperationInput['prestagedAttachments'];
      const normalizedFrom = `${fromRoot.replace(/\/$/, '')}/`;
      const normalizedTo = `${toRoot.replace(/\/$/, '')}/`;
      const finalized = prestaged.map((attachment) => ({
        ...attachment,
        storagePath: attachment.storagePath.startsWith(normalizedFrom)
          ? `${normalizedTo}${attachment.storagePath.slice(normalizedFrom.length)}`
          : attachment.storagePath,
      }));
      for (let index = 0; index < prestaged.length; index += 1) {
        const before = prestaged[index]!;
        const after = finalized[index]!;
        if (before.storagePath !== after.storagePath) {
          this.db
            .prepare('update attachments set storage_path = ? where storage_path = ?')
            .run(after.storagePath, before.storagePath);
          this.db
            .prepare('update file_blobs set storage_path = ?, updated_at = ? where storage_path = ?')
            .run(after.storagePath, nowIso(), before.storagePath);
        }
      }
      this.db
        .prepare('update fork_operations set prestaged_attachments_json = ? where id = ?')
        .run(JSON.stringify(finalized), id);
    })();
  }

  enqueueForkOperation(input: EnqueueForkOperationInput): ForkOperation {
    return this.db.transaction(() => {
      const existing = this.getForkOperation(input.id);
      if (existing) return existing;
      this.assertRobotWorkAdmission();
      const topic = this.getTopic(input.sourceTopicId);
      const robotState = this.getRobotState(input.sourceTopicId);
      const autoRun = this.getTopicAutoRun(input.sourceTopicId);
      if (
        !topic ||
        topic.status !== 'open' ||
        (robotState?.activity !== 'idle' && robotState?.activity !== 'stopped') ||
        autoRun?.status === 'running' ||
        this.countActionablePostDispatches(input.sourceTopicId) > 0 ||
        this.hasCompactionFence(input.sourceTopicId)
      )
        throw new Error('fork_conflict');
      const now = nowIso();
      this.db
        .prepare(
          `insert into fork_operations
           (id, source_topic_id, source_session_id, source_pi_session_id, source_pi_session_path,
            boundary_post_id, boundary_pi_message_id, boundary_entry_id, expected_leaf_id, initiated_by,
            title, opening_body, status, prestaged_attachments_json, attempt_count, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?)`
        )
        .run(
          input.id,
          input.sourceTopicId,
          input.sourceSessionId,
          input.sourcePiSessionId,
          input.sourcePiSessionPath,
          input.boundaryPostId,
          input.boundaryPiMessageId,
          input.boundaryEntryId,
          input.expectedLeafId,
          input.initiatedBy,
          input.title,
          input.openingBody,
          JSON.stringify(input.prestagedAttachments),
          now
        );
      return this.getForkOperation(input.id) as ForkOperation;
    })();
  }

  listPendingForkOperationRows(limit = 10): ForkOperationRow[] {
    return this.db
      .prepare(
        "select * from fork_operations where status = 'pending' and (next_attempt_at is null or next_attempt_at <= ?) order by created_at asc limit ?"
      )
      .all(nowIso(), Math.max(1, Math.trunc(limit))) as ForkOperationRow[];
  }

  requeueRunningForkOperations(): number {
    return this.db
      .prepare("update fork_operations set status = 'pending', next_attempt_at = null where status = 'running'")
      .run().changes;
  }

  claimForkOperation(id: string): ForkOperationRow | null {
    const now = nowIso();
    const result = this.db
      .prepare(
        "update fork_operations set status = 'running', started_at = coalesce(started_at, ?), attempt_count = attempt_count + 1, next_attempt_at = null where id = ? and status = 'pending' and (next_attempt_at is null or next_attempt_at <= ?)"
      )
      .run(now, id, now);
    return result.changes === 1
      ? (this.db.prepare('select * from fork_operations where id = ?').get(id) as ForkOperationRow)
      : null;
  }

  requeueForkOperation(id: string, message: string, retryAt: string): void {
    this.db
      .prepare(
        "update fork_operations set status = 'pending', error_message = ?, next_attempt_at = ? where id = ? and status = 'running'"
      )
      .run(message.slice(0, 1000), retryAt, id);
  }

  failForkOperation(id: string, message: string): void {
    this.db
      .prepare(
        "update fork_operations set status = 'failed', error_message = ?, next_attempt_at = null, finished_at = ? where id = ? and status = 'running'"
      )
      .run(message.slice(0, 1000), nowIso(), id);
  }

  markForkNeedsManualReview(id: string, message: string): void {
    this.db
      .prepare(
        "update fork_operations set status = 'needs_manual_review', error_message = ?, next_attempt_at = null, finished_at = null where id = ? and status = 'running'"
      )
      .run(message.slice(0, 1000), id);
  }

  materializeForkOperation(
    id: string,
    result: {
      child_session_id: string;
      child_session_path: string;
      inherited_generation: number;
      active_entry_ids: string[];
    }
  ): ForkOperation {
    return this.db.transaction(() => {
      const row = this.db.prepare('select * from fork_operations where id = ?').get(id) as ForkOperationRow | undefined;
      if (!row) throw new Error('fork operation not found');
      if (row.child_topic_id) return this.getForkOperation(id) as ForkOperation;
      if (row.status !== 'running') throw new Error('fork operation is not running');
      const sourceTopic = this.getTopic(row.source_topic_id);
      if (!sourceTopic) throw new Error('source topic not found');
      const sourcePosts = this.db
        .prepare('select * from posts where topic_id = ? order by rowid asc')
        .all(row.source_topic_id) as PostRow[];
      const boundaryIndex = sourcePosts.findIndex((post) => post.id === row.boundary_post_id);
      if (boundaryIndex < 1) throw new Error('fork boundary has no inherited forum history');
      const inherited = sourcePosts.slice(0, boundaryIndex);
      const first = inherited[0]!;
      const created = this.createTopic({
        forumId: sourceTopic.forum_id,
        title: row.title,
        body: first.body,
        authorId: first.author_id,
        robotMode: sourceTopic.robot_mode as 'auto' | 'mention' | 'off',
        autoCompactEnabled: Boolean(sourceTopic.auto_compact_enabled),
        silent: Boolean(first.silent),
      });
      if (first.follow_up) this.db.prepare('update posts set follow_up = 1 where id = ?').run(created.post.id);
      const childSession = this.ensureSession({ topicId: created.topic.id });
      const postMap = new Map<string, string>([[first.id, created.post.id]]);
      for (const source of inherited.slice(1)) {
        const copied = this.createPost({
          topicId: created.topic.id,
          authorId: source.author_id,
          body: source.body,
          parentPostId: source.parent_post_id ? (postMap.get(source.parent_post_id) ?? null) : null,
          silent: Boolean(source.silent),
        });
        if (source.follow_up) this.db.prepare('update posts set follow_up = 1 where id = ?').run(copied.id);
        postMap.set(source.id, copied.id);
      }
      const activeIds = new Set(result.active_entry_ids);
      for (const source of inherited) {
        const sourceLink = this.db
          .prepare('select * from pi_message_links where pi_session_id = ? and post_id = ? limit 1')
          .get(row.source_pi_session_id, source.id) as PiMessageLinkRow | undefined;
        if (!sourceLink || !activeIds.has(sourceLink.pi_message_id))
          throw new Error('child canonical branch does not contain inherited projected message');
        const sourceMetadata = JSON.parse(sourceLink.metadata_json ?? 'null') as Record<string, unknown> | null;
        const metadata = sourceMetadata
          ? {
              ...sourceMetadata,
              contributorPostIds: Array.isArray(sourceMetadata['contributorPostIds'])
                ? sourceMetadata['contributorPostIds'].map((postId) =>
                    typeof postId === 'string' ? (postMap.get(postId) ?? postId) : postId
                  )
                : [postMap.get(source.id)!],
            }
          : { contributorPostIds: [postMap.get(source.id)!] };
        this.createPiMessageLink({
          piSessionId: result.child_session_id,
          piMessageId: sourceLink.pi_message_id,
          postId: postMap.get(source.id)!,
          role: sourceLink.role,
          metadata,
        });
      }
      const prestaged = JSON.parse(row.prestaged_attachments_json) as EnqueueForkOperationInput['prestagedAttachments'];
      for (const attachment of prestaged.filter((item) => item.sourcePostId !== row.boundary_post_id)) {
        const postId = postMap.get(attachment.sourcePostId);
        if (postId)
          this.createAttachment({
            postId,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            storagePath: attachment.storagePath,
            sha256: attachment.sha256,
          });
      }
      this.upsertPiSessionLink({
        piSessionId: result.child_session_id,
        piSessionPath: result.child_session_path,
        topicId: created.topic.id,
        sessionId: childSession.id,
        cwd: this.getForum(sourceTopic.forum_id)?.cwd ?? null,
        kind: 'normal',
        metadata: { source: 'forum-fork', operationId: id },
        parentPiSessionId: row.source_pi_session_id,
        parentPiSessionPath: row.source_pi_session_path,
        lineageKind: 'fork',
        lineageSource: 'forum',
      });
      const now = nowIso();
      this.db
        .prepare(
          `insert into post_dispatch_generations(topic_id, generation, updated_at) values (?, ?, ?)
           on conflict(topic_id) do update set generation = excluded.generation, updated_at = excluded.updated_at`
        )
        .run(created.topic.id, Math.max(0, Math.trunc(result.inherited_generation)), now);
      this.setSessionLastDispatchedPostId(childSession.id, postMap.get(inherited.at(-1)!.id) ?? null);
      const boundary = sourcePosts[boundaryIndex]!;
      const opening = this.createPost({
        topicId: created.topic.id,
        authorId: row.initiated_by,
        body: row.opening_body,
        parentPostId: boundary.parent_post_id ? (postMap.get(boundary.parent_post_id) ?? null) : null,
      });
      if (boundary.follow_up) this.db.prepare('update posts set follow_up = 1 where id = ?').run(opening.id);
      for (const attachment of prestaged.filter((item) => item.sourcePostId === row.boundary_post_id)) {
        this.createAttachment({
          postId: opening.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          storagePath: attachment.storagePath,
          sha256: attachment.sha256,
        });
      }
      this.createSessionMessage(childSession.id, 'user', row.opening_body, 'public');
      const openingDispatch = this.createPostDispatch({
        topicId: created.topic.id,
        postId: opening.id,
        sessionId: childSession.id,
        mode: 'auto',
      });
      // Do not let the already-running dispatcher open the quarantined child.
      // completeForkOperation releases this only after agentd acknowledgement.
      this.db
        .prepare("update post_dispatches set next_attempt_at = '9999-12-31T23:59:59.999Z' where id = ?")
        .run(openingDispatch.id);
      this.upsertRobotState({
        topicId: created.topic.id,
        sessionId: childSession.id,
        activity: 'idle',
        currentPlanId: null,
      });
      this.db
        .prepare(
          'update fork_operations set agent_result_json = ?, child_topic_id = ?, child_session_id = ?, child_session_path = ?, error_message = null where id = ?'
        )
        .run(JSON.stringify(result), created.topic.id, result.child_session_id, result.child_session_path, id);
      return this.getForkOperation(id) as ForkOperation;
    })();
  }

  completeForkOperation(id: string): void {
    this.db.transaction(() => {
      const now = nowIso();
      this.db
        .prepare(
          "update fork_operations set status = 'succeeded', error_message = null, next_attempt_at = null, finished_at = ? where id = ? and status = 'running'"
        )
        .run(now, id);
      this.db
        .prepare(
          `update post_dispatches set next_attempt_at = ?, updated_at = ?
           where topic_id = (select child_topic_id from fork_operations where id = ?)
             and status = 'pending'`
        )
        .run(now, now, id);
    })();
  }

  createCompactionOperation(input: CreateCompactionOperationInput): CompactionOperation {
    const existing = this.getCompactionOperation(input.id);
    if (existing) return existing;
    const now = nowIso();
    this.db
      .prepare(
        `insert into compaction_operations
       (id, topic_id, session_id, initiated_by, expected_leaf_id, custom_instructions, recovery_prompt,
        status, event_id, recovery_post_id, error_message, created_at, started_at, finished_at)
       values (?, ?, ?, ?, ?, ?, ?, 'pending', null, null, null, ?, null, null)`
      )
      .run(
        input.id,
        input.topicId,
        input.sessionId,
        input.initiatedBy,
        input.expectedLeafId,
        input.customInstructions ?? null,
        input.recoveryPrompt,
        now
      );
    return this.getCompactionOperation(input.id) as CompactionOperation;
  }

  getCompactionOperation(id: string): CompactionOperation | null {
    const row = this.db.prepare('select * from compaction_operations where id = ?').get(id) as
      CompactionOperationRow | undefined;
    return row ? mapCompactionOperationRowToDomain(row) : null;
  }

  hasActiveCompactionOperation(topicId: string): boolean {
    const row = this.db
      .prepare("select 1 from compaction_operations where topic_id = ? and status in ('pending', 'running') limit 1")
      .get(topicId) as unknown | undefined;
    return Boolean(row);
  }

  hasCompactionFence(topicId: string): boolean {
    // Topic mutation routes use this shared fence. A forum-native fork must
    // freeze the source just as strictly as compaction until materialization is acknowledged.
    if (this.hasActiveCompactionOperation(topicId) || this.hasForkFence(topicId)) return true;
    const row = this.db
      .prepare(
        `select 1 from compaction_operations c
         join post_dispatches d on d.post_id = c.recovery_post_id
         join post_dispatch_generations g on g.topic_id = d.topic_id and g.generation = d.generation
         where c.topic_id = ? and c.status = 'succeeded'
           and (d.status in ('pending', 'dispatching') or (d.status = 'failed' and d.next_attempt_at is not null))
         limit 1`
      )
      .get(topicId) as unknown | undefined;
    return Boolean(row);
  }

  countActiveCompactionOperations(): number {
    const row = this.db
      .prepare("select count(*) as count from compaction_operations where status in ('pending', 'running')")
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /** @deprecated Prefer hasActiveCompactionOperation so queued work is also fenced. */
  hasRunningCompactionOperation(topicId: string): boolean {
    return this.hasActiveCompactionOperation(topicId);
  }

  getActiveCompactionOperation(topicId: string): CompactionOperation | null {
    const row = this.db
      .prepare(
        "select * from compaction_operations where topic_id = ? and status in ('pending', 'running') order by created_at desc limit 1"
      )
      .get(topicId) as CompactionOperationRow | undefined;
    return row ? mapCompactionOperationRowToDomain(row) : null;
  }

  getLatestCompactionOperation(topicId: string): CompactionOperation | null {
    const row = this.db
      .prepare('select * from compaction_operations where topic_id = ? order by created_at desc limit 1')
      .get(topicId) as CompactionOperationRow | undefined;
    return row ? mapCompactionOperationRowToDomain(row) : null;
  }

  listPendingCompactionOperations(limit = 10): CompactionOperation[] {
    return (
      this.db
        .prepare(
          "select * from compaction_operations where status = 'pending' and (next_attempt_at is null or next_attempt_at <= ?) order by created_at asc limit ?"
        )
        .all(nowIso(), Math.max(1, Math.trunc(limit))) as CompactionOperationRow[]
    ).map(mapCompactionOperationRowToDomain);
  }

  requeueRunningCompactionOperations(): number {
    const result = this.db
      .prepare(
        "update compaction_operations set status = 'pending', started_at = null, next_attempt_at = null where status = 'running'"
      )
      .run();
    return result.changes;
  }

  requeueCompactionOperation(id: string): boolean {
    const result = this.db
      .prepare(
        "update compaction_operations set status = 'pending', started_at = null, next_attempt_at = null where id = ? and status = 'running'"
      )
      .run(id);
    return result.changes === 1;
  }

  enqueueCompactionOperationIfIdle(input: CreateCompactionOperationInput): CompactionOperation | null {
    return this.db.transaction(() => {
      const existing = this.getCompactionOperation(input.id);
      if (existing) return null;
      this.assertRobotWorkAdmission();
      const topic = this.getTopic(input.topicId);
      const robotState = this.getRobotState(input.topicId);
      const autoRun = this.getTopicAutoRun(input.topicId);
      if (
        topic?.status !== 'open' ||
        (robotState?.activity !== 'idle' && robotState?.activity !== 'stopped') ||
        autoRun?.status === 'running' ||
        this.countActionablePostDispatches(input.topicId) > 0 ||
        this.hasCompactionFence(input.topicId)
      ) {
        return null;
      }
      return this.createCompactionOperation(input);
    })();
  }

  startCompactionOperation(input: CreateCompactionOperationInput): CompactionOperation | null {
    return this.db.transaction(() => {
      const existing = this.getCompactionOperation(input.id);
      if (existing) return null;
      if (this.hasActiveCompactionOperation(input.topicId)) return null;
      const now = nowIso();
      this.db
        .prepare(
          `insert into compaction_operations
         (id, topic_id, session_id, initiated_by, expected_leaf_id, custom_instructions, recovery_prompt,
          status, event_id, recovery_post_id, error_message, created_at, started_at, finished_at)
         values (?, ?, ?, ?, ?, ?, ?, 'running', null, null, null, ?, ?, null)`
        )
        .run(
          input.id,
          input.topicId,
          input.sessionId,
          input.initiatedBy,
          input.expectedLeafId,
          input.customInstructions ?? null,
          input.recoveryPrompt,
          now,
          now
        );
      return this.getCompactionOperation(input.id) as CompactionOperation;
    })();
  }

  claimCompactionOperation(id: string): CompactionOperation | null {
    const now = nowIso();
    const result = this.db
      .prepare(
        `update compaction_operations set status = 'running', started_at = ?, attempt_count = attempt_count + 1,
         next_attempt_at = null, error_message = null where id = ? and status = 'pending'
         and (next_attempt_at is null or next_attempt_at <= ?)`
      )
      .run(now, id, now);
    return result.changes === 1 ? this.getCompactionOperation(id) : null;
  }

  getPiSessionHead(piSessionId: string): string | null {
    const row = this.db
      .prepare('select leaf_entry_id from pi_session_heads where pi_session_id = ?')
      .get(piSessionId) as { leaf_entry_id: string | null } | undefined;
    return row?.leaf_entry_id ?? null;
  }

  requeueUncertainCompaction(id: string, message: string, retryAt: string): CompactionOperation {
    const result = this.db
      .prepare(
        `update compaction_operations set status = 'pending', started_at = null, next_attempt_at = ?,
         error_message = ? where id = ? and status = 'running'`
      )
      .run(retryAt, message.slice(0, 1000), id);
    const operation = this.getCompactionOperation(id);
    if (result.changes !== 1 || !operation) throw new Error('compaction operation could not be requeued');
    return operation;
  }

  finishCompactionFailure(id: string, message: string): CompactionOperation {
    return this.db.transaction(() => {
      const operation = this.getCompactionOperation(id);
      if (operation?.status !== 'running') throw new Error('compaction operation is not running');
      const event = this.createTopicOperationalEvent({
        topicId: operation.topicId,
        anchorPostId: this.getLatestPostId(operation.topicId),
        type: 'compaction',
        category: 'maintenance',
        status: 'failed',
        summary: 'Conversation compaction failed.',
        detail: { error: message.slice(0, 4000) },
        sourceKind: 'compaction_operation',
        sourceId: operation.id,
      });
      const now = nowIso();
      this.db
        .prepare(
          `update compaction_operations set status = 'failed', event_id = ?, error_message = ?, finished_at = ? where id = ? and status = 'running'`
        )
        .run(event.id, message.slice(0, 1000), now, id);
      const completed = this.getCompactionOperation(id);
      if (!completed) throw new Error('compaction operation disappeared after failure');
      return completed;
    })();
  }

  finishCompactionSuccess(id: string): CompactionOperation {
    return this.db.transaction(() => {
      const operation = this.getCompactionOperation(id);
      if (operation?.status !== 'running') throw new Error('compaction operation is not running');
      const anchorPostId = this.getLatestPostId(operation.topicId);
      const now = nowIso();
      const recoveryPost = this.createPost({
        topicId: operation.topicId,
        authorId: operation.initiatedBy,
        body: operation.recoveryPrompt,
        silent: false,
      });
      const postId = recoveryPost.id;
      this.createPostDispatch({
        topicId: operation.topicId,
        postId,
        sessionId: operation.sessionId,
        mode: 'auto',
      });
      const event = this.createTopicOperationalEvent({
        topicId: operation.topicId,
        anchorPostId,
        type: 'compaction',
        category: 'maintenance',
        status: 'succeeded',
        summary: 'Conversation context was compacted.',
        detail: { expectedLeafId: operation.expectedLeafId, recoveryPostId: postId },
        sourceKind: 'compaction_operation',
        sourceId: operation.id,
      });
      this.db
        .prepare(
          `update compaction_operations set status = 'succeeded', event_id = ?, recovery_post_id = ?, finished_at = ?
         where id = ? and status = 'running'`
        )
        .run(event.id, postId, now, id);
      this.invalidateTopicStatsCache(operation.topicId);
      const topic = this.getTopic(operation.topicId);
      if (topic) this.invalidateForumStatsCache(topic.forum_id);
      const completed = this.getCompactionOperation(id);
      if (!completed) throw new Error('compaction operation disappeared after success');
      return completed;
    })();
  }

  private ensurePostDispatchGeneration(topicId: string, now = nowIso()): void {
    this.db
      .prepare(`insert or ignore into post_dispatch_generations (topic_id, generation, updated_at) values (?, 0, ?)`)
      .run(topicId, now);
  }

  resolveUtteranceOrigin(postId: string): UtteranceOrigin {
    const post = this.getPost(postId);
    if (!post) throw new Error('post not found for origin resolution');
    let ref = this.db
      .prepare("select * from external_refs where mapped_post_id = ? and kind = 'post' order by rowid asc limit 1")
      .get(postId) as ExternalRefRow | undefined;
    if (!ref) {
      const first = this.db
        .prepare('select id from posts where topic_id = ? order by rowid asc limit 1')
        .get(post.topic_id) as { id: string } | undefined;
      if (first?.id === post.id) {
        ref = this.db
          .prepare(
            "select * from external_refs where mapped_topic_id = ? and kind = 'topic' order by rowid asc limit 1"
          )
          .get(post.topic_id) as ExternalRefRow | undefined;
      }
    }
    if (!ref) {
      return {
        utteranceId: post.id,
        originKind: 'forum',
        channelKind: 'web',
        topicId: post.topic_id,
        postId: post.id,
        surfaceId: null,
        externalEventId: null,
        scope: null,
        scopeKind: null,
      };
    }
    return {
      utteranceId: post.id,
      originKind: 'external',
      channelKind: ref.surface_kind,
      topicId: post.topic_id,
      postId: post.id,
      surfaceId: ref.surface_id,
      externalEventId: ref.external_id,
      scope: ref.kind === 'topic' ? ref.external_id : ref.scope,
      scopeKind: ref.kind === 'topic' ? 'thread' : ref.scope_kind,
    };
  }

  createPostDispatch(input: CreatePostDispatchInput): PostDispatchRow {
    const existing = this.getPostDispatchByPost(input.postId);
    if (existing) return existing;
    this.assertRobotWorkAdmission();
    const id = randomUUID();
    const now = nowIso();
    const origin = this.resolveUtteranceOrigin(input.postId);
    this.db.transaction(() => {
      this.ensurePostDispatchGeneration(input.topicId, now);
      this.db
        .prepare(
          `insert into post_dispatches
            (id, topic_id, post_id, session_id, status, mode, generation, model, reasoning_effort, attempt_count,
             last_attempt_at, next_attempt_at, dispatched_at, error_message, created_at, updated_at,
             origin_key, origin_json, contributor_post_ids_json)
            values (?, ?, ?, ?, 'pending', ?,
              (select generation from post_dispatch_generations where topic_id = ?),
              ?, ?, 0, null, ?, null, null, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.topicId,
          input.postId,
          input.sessionId,
          input.mode ?? 'auto',
          input.topicId,
          input.model ?? null,
          input.reasoningEffort ?? null,
          now,
          now,
          now,
          normalizedOriginKey(origin),
          JSON.stringify(origin),
          JSON.stringify([input.postId])
        );
    })();
    return this.getPostDispatch(id) as PostDispatchRow;
  }

  createExternalTopicWithDispatch(input: {
    topic: CreateTopicInput;
    externalRef: CreateExternalRefInput;
    additionalPostRefs?: CreateExternalRefInput[];
    dispatch: boolean;
  }): { topic: TopicRow; post: PostRow } {
    return this.runInTransaction(() => {
      const created = this.createTopic(input.topic);
      this.createExternalRef({
        ...input.externalRef,
        mappedTopicId: created.topic.id,
        mappedPostId: input.externalRef.mappedPostId ?? null,
      });
      for (const ref of input.additionalPostRefs ?? []) {
        this.createExternalRef({ ...ref, mappedTopicId: created.topic.id, mappedPostId: created.post.id });
      }
      if (input.dispatch) {
        const session = this.ensureSession({ topicId: created.topic.id });
        this.createSessionMessage(session.id, 'user', input.topic.body, 'public');
        this.createPostDispatch({
          topicId: created.topic.id,
          postId: created.post.id,
          sessionId: session.id,
          mode: 'auto',
        });
      }
      return created;
    });
  }

  createExternalPostWithDispatch(input: {
    post: CreatePostInput;
    externalRef?: CreateExternalRefInput | null;
    sessionId?: string | null;
  }): PostRow {
    return this.db.transaction(() => {
      if (input.sessionId) this.createSessionMessage(input.sessionId, 'user', input.post.body, 'public');
      const post = this.createPost(input.post);
      if (input.externalRef) this.createExternalRef({ ...input.externalRef, mappedPostId: post.id });
      if (input.sessionId) {
        this.createPostDispatch({
          topicId: post.topic_id,
          postId: post.id,
          sessionId: input.sessionId,
          mode: 'auto',
        });
      }
      return post;
    })();
  }

  getPostDispatch(id: string): PostDispatchRow | null {
    const row = this.db.prepare('select * from post_dispatches where id = ?').get(id) as PostDispatchRow | undefined;
    return row ?? null;
  }

  getPostDispatchByPost(postId: string): PostDispatchRow | null {
    const row = this.db.prepare('select * from post_dispatches where post_id = ?').get(postId) as
      PostDispatchRow | undefined;
    return row ?? null;
  }

  listPostDispatchesForTopic(topicId: string): PostDispatchRow[] {
    return this.db.prepare('select * from post_dispatches where topic_id = ? order by created_at asc, rowid asc')
      .all(topicId) as PostDispatchRow[];
  }

  listPostDispatchAttempts(dispatchIds: string[], limit = 100): PostDispatchAttemptRow[] {
    if (dispatchIds.length === 0) return [];
    return this.db.prepare(
      `select * from post_dispatch_attempts where dispatch_id in (select value from json_each(?))
       order by created_at desc, rowid desc limit ?`
    ).all(JSON.stringify(dispatchIds), Math.max(1, Math.min(200, Math.trunc(limit)))) as PostDispatchAttemptRow[];
  }

  private nextPostDispatchAuditAttemptNumber(dispatchId: string): number {
    const row = this.db.prepare(
      "select coalesce(max(attempt_number), 0) + 1 as attempt_number from post_dispatch_attempts where dispatch_id = ? and event = 'claimed'"
    ).get(dispatchId) as { attempt_number: number };
    return row.attempt_number;
  }

  private claimedPostDispatchAuditAttemptNumber(dispatchId: string, claimToken: string, fallback: number): number {
    const row = this.db.prepare(
      "select attempt_number from post_dispatch_attempts where dispatch_id = ? and event = 'claimed' and claim_token = ? order by rowid desc limit 1"
    ).get(dispatchId, claimToken) as { attempt_number: number } | undefined;
    return row?.attempt_number ?? fallback;
  }

  private insertPostDispatchAttempt(input: {
    dispatchId: string;
    attemptNumber: number;
    event: PostDispatchAttemptRow['event'];
    classification?: PostDispatchAttemptRow['classification'];
    retryAt?: string | null;
    errorMessage?: string | null;
    claimToken?: string | null;
    createdAt: string;
  }): void {
    const sanitizedError = input.errorMessage
      ?.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500) || null;
    this.db.prepare(
      `insert into post_dispatch_attempts
       (id, dispatch_id, attempt_number, event, classification, retry_at, error_message, claim_token, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), input.dispatchId, input.attemptNumber, input.event, input.classification ?? null,
      input.retryAt ?? null, sanitizedError, input.claimToken ?? null, input.createdAt);
  }

  getActiveTurnOrigin(topicId: string): ActiveTurnOriginRow | null {
    return (
      (this.db.prepare('select * from active_turn_origins where topic_id = ?').get(topicId) as
        ActiveTurnOriginRow | undefined) ?? null
    );
  }

  recordActiveTurnOrigin(input: {
    topicId: string;
    dispatchId: string;
    generation: number;
    origin: UtteranceOrigin;
  }): ActiveTurnOriginRow | null {
    const now = nowIso();
    const result = this.db
      .prepare(
        `insert into active_turn_origins
       (topic_id, dispatch_id, generation, origin_key, origin_json, accepted_at, updated_at)
       select ?, ?, ?, ?, ?, ?, ?
       where ? = (select generation from post_dispatch_generations where topic_id = ?)
       on conflict(topic_id) do update set
         dispatch_id = excluded.dispatch_id, generation = excluded.generation,
         origin_key = excluded.origin_key, origin_json = excluded.origin_json,
         accepted_at = excluded.accepted_at, updated_at = excluded.updated_at
       where excluded.generation = (select generation from post_dispatch_generations where topic_id = excluded.topic_id)`
      )
      .run(
        input.topicId,
        input.dispatchId,
        input.generation,
        normalizedOriginKey(input.origin),
        JSON.stringify(input.origin),
        now,
        now,
        input.generation,
        input.topicId
      );
    return result.changes === 1 ? this.getActiveTurnOrigin(input.topicId) : null;
  }

  recordActiveTurnOriginFromDispatch(topicId: string, dispatchId: string): ActiveTurnOriginRow | null {
    const dispatch = this.getPostDispatch(dispatchId);
    if (!dispatch || dispatch.topic_id !== topicId) return null;
    let origin: UtteranceOrigin;
    try {
      origin = JSON.parse(dispatch.origin_json) as UtteranceOrigin;
    } catch {
      return null;
    }
    return this.recordActiveTurnOrigin({
      topicId,
      dispatchId,
      generation: dispatch.generation,
      origin,
    });
  }

  clearActiveTurnOrigin(topicId: string, generation?: number): boolean {
    const result =
      generation === undefined
        ? this.db.prepare('delete from active_turn_origins where topic_id = ?').run(topicId)
        : this.db
            .prepare('delete from active_turn_origins where topic_id = ? and generation = ?')
            .run(topicId, generation);
    return result.changes === 1;
  }

  isCompactionRecoveryPost(postId: string): boolean {
    const row = this.db
      .prepare("select 1 from compaction_operations where recovery_post_id = ? and status = 'succeeded' limit 1")
      .get(postId) as unknown | undefined;
    return Boolean(row);
  }

  listDuePostDispatches(limit: number): PostDispatchRow[] {
    const now = nowIso();
    return this.db
      .prepare(
        `select d.* from post_dispatches d
         join post_dispatch_generations g on g.topic_id = d.topic_id and g.generation = d.generation
         where d.status in ('pending', 'dispatching')
           and (d.next_attempt_at is null or d.next_attempt_at <= ?)
           and (
             exists (
               select 1 from compaction_operations priority
               where priority.recovery_post_id = d.post_id and priority.status = 'succeeded'
             )
             or not exists (
               select 1 from post_dispatches earlier
               where earlier.topic_id = d.topic_id and earlier.generation = d.generation
                 and earlier.status in ('pending', 'dispatching')
                 and (earlier.created_at < d.created_at or (earlier.created_at = d.created_at and earlier.rowid < d.rowid))
             )
           )
           and (
             exists (
               select 1 from compaction_operations own
               where own.recovery_post_id = d.post_id and own.status = 'succeeded'
             )
             or (
               not exists (
                 select 1 from compaction_operations active
                 where active.topic_id = d.topic_id and active.status in ('pending', 'running')
               )
               and not exists (
                 select 1 from compaction_operations completed
                 join post_dispatches checkpoint on checkpoint.post_id = completed.recovery_post_id
                 join post_dispatch_generations checkpoint_generation
                   on checkpoint_generation.topic_id = checkpoint.topic_id
                  and checkpoint_generation.generation = checkpoint.generation
                 where completed.topic_id = d.topic_id and completed.status = 'succeeded'
                   and (checkpoint.status in ('pending', 'dispatching')
                     or (checkpoint.status = 'failed' and checkpoint.next_attempt_at is not null))
               )
             )
           )
         order by d.created_at asc
         limit ?`
      )
      .all(now, Math.max(1, Math.trunc(limit))) as PostDispatchRow[];
  }

  listPendingPostDispatchesForTopic(topicId: string): PostDispatchRow[] {
    return this.db
      .prepare(
        `select d.* from post_dispatches d
        join post_dispatch_generations g on g.topic_id = d.topic_id and g.generation = d.generation
        where d.topic_id = ? and d.status in ('pending', 'dispatching') order by d.created_at asc`
      )
      .all(topicId) as PostDispatchRow[];
  }

  countActionablePostDispatches(topicId: string): number {
    const row = this.db
      .prepare(
        `select count(*) as count from post_dispatches d
         join post_dispatch_generations g on g.topic_id = d.topic_id and g.generation = d.generation
         where d.topic_id = ?
           and (d.status in ('pending', 'dispatching') or (d.status = 'failed' and d.next_attempt_at is not null))`
      )
      .get(topicId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  countGlobalActionablePostDispatches(): number {
    const row = this.db
      .prepare(
        `select count(*) as count from post_dispatches d
         join post_dispatch_generations g on g.topic_id = d.topic_id and g.generation = d.generation
         where (d.status in ('pending', 'dispatching')
            or (d.status = 'failed' and d.next_attempt_at is not null))`
      )
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  claimPostDispatchGroup(rows: PostDispatchRow[]): PostDispatchRow | null {
    if (rows.length === 0) return null;
    const trigger = rows.at(-1) as PostDispatchRow;
    if (rows.some((row) => row.topic_id !== trigger.topic_id || row.origin_key !== trigger.origin_key)) {
      throw new Error('cross-origin dispatch group rejected');
    }
    return this.db.transaction(() => {
      let durableContributors: string[] = [];
      try {
        const parsed = JSON.parse(trigger.contributor_post_ids_json) as unknown;
        if (Array.isArray(parsed)) durableContributors = parsed.filter((id): id is string => typeof id === 'string');
      } catch {
        /* malformed legacy state is safely rebuilt from the claimed rows */
      }
      const hasPriorGroup =
        durableContributors.length > 1 ||
        (durableContributors.length === 1 && durableContributors[0] !== trigger.post_id);
      const contributorPostIds = hasPriorGroup
        ? [...new Set([...durableContributors, ...rows.map((row) => row.post_id)])]
        : rows.map((row) => row.post_id);
      const now = nowIso();
      if (trigger.status === 'pending') {
        const current = this.db
          .prepare(
            "select id from post_dispatches where id in (select value from json_each(?)) and status in ('pending', 'dispatching')"
          )
          .all(JSON.stringify(rows.map((row) => row.id))) as Array<{ id: string }>;
        if (current.length !== rows.length) return null;
        for (const row of rows.slice(0, -1)) {
          const reason = 'Included in same-origin dispatch group.';
          const result = this.db
            .prepare(
              "update post_dispatches set status = 'superseded', next_attempt_at = null, error_message = ?, updated_at = ? where id = ? and status in ('pending', 'dispatching')"
            )
            .run(reason, now, row.id);
          if (result.changes === 1) this.insertPostDispatchAttempt({ dispatchId: row.id,
            attemptNumber: row.attempt_count, event: 'superseded', classification: 'lifecycle', errorMessage: reason, createdAt: now });
        }
        this.db
          .prepare(
            'update post_dispatches set contributor_post_ids_json = ?, updated_at = ? where id = ? and status = ?'
          )
          .run(JSON.stringify(contributorPostIds), now, trigger.id, trigger.status);
      }
      return this.claimPostDispatch(trigger.id, trigger);
    })();
  }

  claimPostDispatch(id: string, observed: Pick<PostDispatchRow, 'status' | 'last_attempt_at'>): PostDispatchRow | null {
    if (observed.status !== 'pending' && observed.status !== 'dispatching') return null;
    const now = nowIso();
    const claimToken = randomUUID();
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `update post_dispatches set status = 'dispatching', claim_token = ?, attempt_count = attempt_count + 1, last_attempt_at = ?, next_attempt_at = null, error_message = null, updated_at = ?
          where id = ? and status = ? and last_attempt_at is ? and generation =
            (select generation from post_dispatch_generations where topic_id = post_dispatches.topic_id)`
        )
        .run(claimToken, now, now, id, observed.status, observed.last_attempt_at);
      if (result.changes !== 1) return null;
      const claimed = this.getPostDispatch(id);
      if (!claimed || claimed.claim_token !== claimToken) return null;
      this.insertPostDispatchAttempt({ dispatchId: id, attemptNumber: this.nextPostDispatchAuditAttemptNumber(id),
        event: 'claimed', claimToken, createdAt: now });
      return claimed;
    })();
  }

  isPostDispatchClaimCurrent(id: string, claimToken: string): boolean {
    const row = this.db
      .prepare(
        `select 1 as current from post_dispatches d
      join post_dispatch_generations g on g.topic_id = d.topic_id and g.generation = d.generation
      where d.id = ? and d.status = 'dispatching' and d.claim_token = ?`
      )
      .get(id, claimToken) as { current: number } | undefined;
    return Boolean(row);
  }

  getTopicDispatchGeneration(topicId: string): number {
    this.ensurePostDispatchGeneration(topicId);
    const row = this.db.prepare('select generation from post_dispatch_generations where topic_id = ?').get(topicId) as {
      generation: number;
    };
    return row.generation;
  }

  isTopicDispatchGenerationCurrent(topicId: string, generation: number): boolean {
    return this.getTopicDispatchGeneration(topicId) === generation;
  }

  markPostDispatchDispatched(id: string, claimToken: string): PostDispatchRow | null {
    const now = nowIso();
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `update post_dispatches set status = 'dispatched', claim_token = null, dispatched_at = ?, next_attempt_at = null, error_message = null, updated_at = ?
          where id = ? and status = 'dispatching' and claim_token = ? and generation =
            (select generation from post_dispatch_generations where topic_id = post_dispatches.topic_id)`
        )
        .run(now, now, id, claimToken);
      const row = this.getPostDispatch(id);
      if (result.changes === 1 && row) this.insertPostDispatchAttempt({ dispatchId: id,
        attemptNumber: this.claimedPostDispatchAuditAttemptNumber(id, claimToken, row.attempt_count),
        event: 'dispatched', claimToken, createdAt: now });
      return row;
    })();
  }

  markPostDispatchSuperseded(
    id: string,
    reason = 'Included as catch-up context in a newer dispatch.'
  ): PostDispatchRow | null {
    const now = nowIso();
    return this.db.transaction(() => {
      const result = this.db.prepare(
        `update post_dispatches set status = 'superseded', next_attempt_at = null, error_message = ?, updated_at = ? where id = ? and status in ('pending', 'dispatching')`
      ).run(reason, now, id);
      const row = this.getPostDispatch(id);
      if (result.changes === 1 && row) this.insertPostDispatchAttempt({ dispatchId: id,
        attemptNumber: row.attempt_count, event: 'superseded', classification: 'lifecycle', errorMessage: reason, createdAt: now });
      return row;
    })();
  }

  markPostDispatchAbandoned(id: string, reason: string): PostDispatchRow | null {
    const now = nowIso();
    return this.db.transaction(() => {
      const result = this.db.prepare(
        `update post_dispatches set status = 'abandoned', next_attempt_at = null, error_message = ?, updated_at = ?
         where id = ? and status in ('pending', 'dispatching') and generation =
           (select generation from post_dispatch_generations where topic_id = post_dispatches.topic_id)`
      ).run(reason, now, id);
      const row = this.getPostDispatch(id);
      if (result.changes === 1 && row) this.insertPostDispatchAttempt({ dispatchId: id,
        attemptNumber: row.attempt_count, event: 'abandoned', classification: 'lifecycle', errorMessage: reason, createdAt: now });
      return row;
    })();
  }

  markPostDispatchFailed(
    id: string,
    claimToken: string,
    message: string,
    opts?: { retryAt?: string | null; classification?: 'transport' | 'application' }
  ): PostDispatchRow | null {
    const existing = this.getPostDispatch(id);
    if (!existing) return null;
    const now = nowIso();
    const status = opts?.retryAt ? 'pending' : 'failed';
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `update post_dispatches set status = ?, claim_token = null, next_attempt_at = ?, error_message = ?, updated_at = ?
          where id = ? and status = 'dispatching' and claim_token = ? and generation =
            (select generation from post_dispatch_generations where topic_id = post_dispatches.topic_id)`
        )
        .run(status, opts?.retryAt ?? null, message.slice(0, 1000), now, id, claimToken);
      const row = this.getPostDispatch(id);
      if (result.changes === 1 && row) this.insertPostDispatchAttempt({ dispatchId: id,
        attemptNumber: this.claimedPostDispatchAuditAttemptNumber(id, claimToken, row.attempt_count),
        event: opts?.retryAt ? 'retry_scheduled' : 'terminal_failure',
        classification: opts?.classification ?? 'application', retryAt: opts?.retryAt ?? null,
        errorMessage: message, claimToken, createdAt: now });
      return row;
    })();
  }

  retryTerminalPostDispatch(id: string): PostDispatchRow | null {
    const now = nowIso();
    const result = this.db
      .prepare(
        `update post_dispatches set status = 'pending', claim_token = null, attempt_count = 0,
         last_attempt_at = null, next_attempt_at = ?, error_message = null, updated_at = ?
         where id = ? and status = 'failed' and generation =
           (select generation from post_dispatch_generations where topic_id = post_dispatches.topic_id)`
      )
      .run(now, now, id);
    return result.changes === 1 ? this.getPostDispatch(id) : null;
  }

  reconcilePostDispatchGenerations(): number {
    const now = nowIso();
    const reason = 'Cancelled by a newer topic dispatch generation.';
    return this.db.transaction(() => {
      const rows = this.db.prepare(
        `select * from post_dispatches where status in ('pending', 'dispatching') and generation <> coalesce(
          (select generation from post_dispatch_generations where topic_id = post_dispatches.topic_id), 0)`
      ).all() as PostDispatchRow[];
      const result = this.db.prepare(
        `update post_dispatches set status = 'superseded', next_attempt_at = null,
        error_message = ?, updated_at = ? where status in ('pending', 'dispatching') and generation <> coalesce(
          (select generation from post_dispatch_generations where topic_id = post_dispatches.topic_id), 0)`
      ).run(reason, now);
      for (const row of rows) this.insertPostDispatchAttempt({ dispatchId: row.id, attemptNumber: row.attempt_count,
        event: 'superseded', classification: 'lifecycle', errorMessage: reason, createdAt: now });
      return result.changes;
    })();
  }

  advanceTopicDispatchGeneration(
    topicId: string,
    reason = 'Cancelled by operator interrupt.'
  ): { generation: number; cancelled: number } {
    const now = nowIso();
    return this.db.transaction(() => {
      this.ensurePostDispatchGeneration(topicId, now);
      const pending = this.db.prepare(
        "select * from post_dispatches where topic_id = ? and status in ('pending', 'dispatching')"
      ).all(topicId) as PostDispatchRow[];
      this.db
        .prepare(`update post_dispatch_generations set generation = generation + 1, updated_at = ? where topic_id = ?`)
        .run(now, topicId);
      const cancelled = this.db
        .prepare(
          `update post_dispatches set status = 'superseded', next_attempt_at = null,
        error_message = ?, updated_at = ? where topic_id = ? and status in ('pending', 'dispatching')`
        )
        .run(reason.slice(0, 1000), now, topicId).changes;
      for (const row of pending) this.insertPostDispatchAttempt({ dispatchId: row.id,
        attemptNumber: row.attempt_count, event: 'superseded', classification: 'lifecycle', errorMessage: reason, createdAt: now });
      this.db.prepare('delete from active_turn_origins where topic_id = ?').run(topicId);
      this.db
        .prepare(
          `update robot_state set activity = 'idle', current_plan_id = null, last_updated_at = ? where topic_id = ?`
        )
        .run(now, topicId);
      const row = this.db
        .prepare('select generation from post_dispatch_generations where topic_id = ?')
        .get(topicId) as { generation: number };
      return { generation: row.generation, cancelled };
    })();
  }

  clearRobotTurnError(topicId: string): RobotStateRow | null {
    const existing = this.getRobotState(topicId);
    if (!existing) return null;
    const now = nowIso();
    this.db
      .prepare(
        `update robot_state set last_error_message = null, last_error_at = null, last_error_post_id = null, last_error_turn_id = null, last_updated_at = ? where topic_id = ?`
      )
      .run(now, topicId);
    return this.getRobotState(topicId);
  }

  setRobotTurnError(
    topicId: string,
    input: { message: string; postId?: string | null; turnId?: string | null }
  ): RobotStateRow | null {
    const existing = this.getRobotState(topicId);
    if (!existing) return null;
    const now = nowIso();
    this.db
      .prepare(
        `update robot_state set activity = 'idle', current_plan_id = null, last_error_message = ?, last_error_at = ?, last_error_post_id = ?, last_error_turn_id = ?, last_updated_at = ? where topic_id = ?`
      )
      .run(input.message.slice(0, 1000), now, input.postId ?? null, input.turnId ?? null, now, topicId);
    return this.getRobotState(topicId);
  }

  getRobotState(topicId: string): RobotStateRow | null {
    const row = this.db.prepare('select * from robot_state where topic_id = ?').get(topicId) as
      RobotStateRow | undefined;
    return row ?? null;
  }

  setRobotActivity(topicId: string, activity: string): RobotStateRow | null {
    const existing = this.getRobotState(topicId);
    if (!existing) {
      return null;
    }
    const currentPlanIdExpr = activity === 'idle' || activity === 'stopped' ? 'null' : 'current_plan_id';
    this.db
      .prepare(
        `update robot_state set activity = ?, current_plan_id = ${currentPlanIdExpr}, last_updated_at = ? where topic_id = ?`
      )
      .run(activity, nowIso(), topicId);
    return this.getRobotState(topicId) as RobotStateRow;
  }

  resetRobotActivities(activity = 'idle'): number {
    const now = nowIso();
    const currentPlanIdExpr = activity === 'idle' || activity === 'stopped' ? 'null' : 'current_plan_id';
    const whereClause =
      activity === 'idle'
        ? "(activity != ? or current_plan_id is not null) and activity not in ('stopping', 'stopped', 'uncertain')"
        : 'activity != ?';
    const result = this.db
      .prepare(
        `update robot_state set activity = ?, current_plan_id = ${currentPlanIdExpr}, last_updated_at = ? where ${whereClause}`
      )
      .run(activity, now, activity);
    return result.changes;
  }

  listRobotAutomations(): RobotAutomationRow[] {
    return this.db.prepare('select * from robot_automations order by created_at desc').all() as RobotAutomationRow[];
  }

  getRobotAutomation(automationId: string): RobotAutomationRow | null {
    const row = this.db.prepare('select * from robot_automations where id = ?').get(automationId) as
      RobotAutomationRow | undefined;
    return row ?? null;
  }

  createRobotAutomation(input: {
    name: string;
    forumId?: string | null;
    prompt: string;
    enabled?: boolean;
    worker: string;
    model?: string | null;
    reasoningEffort?: string | null;
    runMode?: string;
    intervalMinutes?: number | null;
  }): RobotAutomationRow {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `insert into robot_automations
          (id, name, forum_id, prompt, enabled, worker, model, reasoning_effort, worker_thread_id, run_mode, interval_minutes, last_run_at, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.forumId ?? null,
        input.prompt,
        input.enabled === false ? 0 : 1,
        input.worker,
        input.model ?? null,
        input.reasoningEffort ?? null,
        null,
        input.runMode ?? 'manual',
        input.intervalMinutes ?? null,
        null,
        now,
        now
      );
    return this.getRobotAutomation(id) as RobotAutomationRow;
  }

  updateRobotAutomation(
    automationId: string,
    updates: {
      name?: string;
      forumId?: string | null;
      prompt?: string;
      enabled?: boolean;
      worker?: string;
      model?: string | null;
      reasoningEffort?: string | null;
      workerThreadId?: string | null;
      runMode?: string;
      intervalMinutes?: number | null;
      lastRunAt?: string | null;
    }
  ): RobotAutomationRow {
    const existing = this.getRobotAutomation(automationId);
    if (!existing) {
      throw new Error('automation not found');
    }
    const workerChanged = updates.worker !== undefined && updates.worker !== existing.worker;
    const promptChanged = updates.prompt !== undefined && updates.prompt !== existing.prompt;
    const forumChanged = updates.forumId !== undefined && updates.forumId !== existing.forum_id;
    const shouldResetThread = workerChanged || promptChanged || forumChanged;
    const workerThreadId =
      updates.workerThreadId !== undefined
        ? updates.workerThreadId
        : shouldResetThread
          ? null
          : existing.worker_thread_id;
    const nextModel = updates.model === undefined ? (workerChanged ? null : existing.model) : updates.model;
    const nextReasoning =
      updates.reasoningEffort === undefined
        ? workerChanged
          ? null
          : existing.reasoning_effort
        : updates.reasoningEffort;

    const merged = {
      name: updates.name ?? existing.name,
      forum_id: updates.forumId ?? existing.forum_id,
      prompt: updates.prompt ?? existing.prompt,
      enabled: updates.enabled === undefined ? existing.enabled : updates.enabled ? 1 : 0,
      worker: updates.worker ?? existing.worker,
      model: nextModel,
      reasoning_effort: nextReasoning,
      worker_thread_id: workerThreadId,
      run_mode: updates.runMode ?? existing.run_mode,
      interval_minutes: updates.intervalMinutes === undefined ? existing.interval_minutes : updates.intervalMinutes,
      last_run_at: updates.lastRunAt === undefined ? existing.last_run_at : updates.lastRunAt,
      updated_at: nowIso(),
    };

    this.db
      .prepare(
        `update robot_automations
          set name = ?, forum_id = ?, prompt = ?, enabled = ?, worker = ?, model = ?, reasoning_effort = ?, worker_thread_id = ?, run_mode = ?, interval_minutes = ?, last_run_at = ?, updated_at = ?
          where id = ?`
      )
      .run(
        merged.name,
        merged.forum_id,
        merged.prompt,
        merged.enabled,
        merged.worker,
        merged.model,
        merged.reasoning_effort,
        merged.worker_thread_id,
        merged.run_mode,
        merged.interval_minutes,
        merged.last_run_at,
        merged.updated_at,
        automationId
      );

    return this.getRobotAutomation(automationId) as RobotAutomationRow;
  }

  deleteRobotAutomation(automationId: string): void {
    this.db.prepare('delete from robot_automations where id = ?').run(automationId);
  }

  listRobotAutomationRuns(automationId: string, limit = 20): RobotAutomationRunRow[] {
    return this.db
      .prepare('select * from robot_automation_runs where automation_id = ? order by started_at desc limit ?')
      .all(automationId, limit) as RobotAutomationRunRow[];
  }

  createRobotAutomationRun(input: {
    automationId: string;
    worker: string;
    model?: string | null;
    reasoningEffort?: string | null;
    status: string;
    startedAt?: string;
    logPath?: string | null;
  }): RobotAutomationRunRow {
    const id = randomUUID();
    const startedAt = input.startedAt ?? nowIso();
    this.db
      .prepare(
        `insert into robot_automation_runs
          (id, automation_id, worker, model, reasoning_effort, status, started_at, finished_at, exit_code, output_summary, last_message, log_path)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.automationId,
        input.worker,
        input.model ?? null,
        input.reasoningEffort ?? null,
        input.status,
        startedAt,
        null,
        null,
        null,
        null,
        input.logPath ?? null
      );
    return this.getRobotAutomationRun(id) as RobotAutomationRunRow;
  }

  getRobotAutomationRun(runId: string): RobotAutomationRunRow | null {
    const row = this.db.prepare('select * from robot_automation_runs where id = ?').get(runId) as
      RobotAutomationRunRow | undefined;
    return row ?? null;
  }

  updateRobotAutomationRun(
    runId: string,
    updates: Partial<
      Omit<RobotAutomationRunRow, 'id' | 'automation_id' | 'worker' | 'model' | 'reasoning_effort' | 'started_at'>
    >
  ): RobotAutomationRunRow {
    const existing = this.getRobotAutomationRun(runId);
    if (!existing) {
      throw new Error('automation run not found');
    }
    const merged = { ...existing, ...updates } as RobotAutomationRunRow;
    this.db
      .prepare(
        `update robot_automation_runs
          set status = ?, finished_at = ?, exit_code = ?, output_summary = ?, last_message = ?, log_path = ?
          where id = ?`
      )
      .run(
        merged.status,
        merged.finished_at,
        merged.exit_code,
        merged.output_summary,
        merged.last_message,
        merged.log_path,
        runId
      );
    return this.getRobotAutomationRun(runId) as RobotAutomationRunRow;
  }

  getTopicAutoRun(topicId: string): TopicAutoRunRow | null {
    const row = this.db.prepare('select * from topic_auto_runs where topic_id = ?').get(topicId) as
      TopicAutoRunRow | undefined;
    return row ?? null;
  }

  upsertTopicAutoRun(input: {
    topicId: string;
    enabled?: boolean;
    context?: string | null;
    worker?: string;
    model?: string | null;
    reasoningEffort?: string | null;
    directorThreadId?: string | null;
    resetDirectorThread?: boolean;
    maxReplies?: number;
    replyCount?: number;
    status?: string;
    lastRunAt?: string | null;
    lastReplyAt?: string | null;
    lastSummary?: string | null;
    lastNotes?: string | null;
    lastError?: string | null;
    lastTriggerPostId?: string | null;
    steerMessage?: string | null;
  }): TopicAutoRunRow {
    const existing = this.getTopicAutoRun(input.topicId);
    const now = nowIso();
    const base: TopicAutoRunRow =
      existing ??
      ({
        topic_id: input.topicId,
        enabled: 0,
        context: null,
        worker: 'echs',
        model: null,
        reasoning_effort: null,
        director_thread_id: null,
        max_replies: 20,
        reply_count: 0,
        status: 'idle',
        last_run_at: null,
        last_reply_at: null,
        last_summary: null,
        last_notes: null,
        last_error: null,
        last_trigger_post_id: null,
        steer_message: null,
        created_at: now,
        updated_at: now,
      } as TopicAutoRunRow);

    const workerChanged = input.worker !== undefined && input.worker !== base.worker;
    const shouldResetDirector = workerChanged || Boolean(input.resetDirectorThread);
    let directorThreadId = shouldResetDirector ? null : base.director_thread_id;
    if (input.directorThreadId !== undefined) {
      directorThreadId = input.directorThreadId;
    }

    const nextModel = input.model === undefined ? (workerChanged ? null : base.model) : input.model;
    const nextReasoning =
      input.reasoningEffort === undefined ? (workerChanged ? null : base.reasoning_effort) : input.reasoningEffort;

    const merged: TopicAutoRunRow = {
      ...base,
      enabled: input.enabled === undefined ? base.enabled : input.enabled ? 1 : 0,
      context: input.context === undefined ? base.context : input.context,
      worker: input.worker ?? base.worker,
      model: nextModel,
      reasoning_effort: nextReasoning,
      director_thread_id: directorThreadId,
      max_replies: input.maxReplies === undefined ? base.max_replies : input.maxReplies,
      reply_count: input.replyCount === undefined ? base.reply_count : input.replyCount,
      status: input.status ?? base.status,
      last_run_at: input.lastRunAt === undefined ? base.last_run_at : input.lastRunAt,
      last_reply_at: input.lastReplyAt === undefined ? base.last_reply_at : input.lastReplyAt,
      last_summary: input.lastSummary === undefined ? base.last_summary : input.lastSummary,
      last_notes: input.lastNotes === undefined ? base.last_notes : input.lastNotes,
      last_error: input.lastError === undefined ? base.last_error : input.lastError,
      last_trigger_post_id: input.lastTriggerPostId === undefined ? base.last_trigger_post_id : input.lastTriggerPostId,
      steer_message: input.steerMessage === undefined ? base.steer_message : input.steerMessage,
      updated_at: now,
    };

    if (!existing) {
      this.db
        .prepare(
          `insert into topic_auto_runs
          (topic_id, enabled, context, worker, model, reasoning_effort, director_thread_id, max_replies, reply_count, status, last_run_at, last_reply_at, last_summary, last_notes, last_error, last_trigger_post_id, steer_message, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          merged.topic_id,
          merged.enabled,
          merged.context,
          merged.worker,
          merged.model,
          merged.reasoning_effort,
          merged.director_thread_id,
          merged.max_replies,
          merged.reply_count,
          merged.status,
          merged.last_run_at,
          merged.last_reply_at,
          merged.last_summary,
          merged.last_notes,
          merged.last_error,
          merged.last_trigger_post_id,
          merged.steer_message,
          merged.created_at,
          merged.updated_at
        );
      return this.getTopicAutoRun(input.topicId) as TopicAutoRunRow;
    }

    this.db
      .prepare(
        `update topic_auto_runs
          set enabled = ?, context = ?, worker = ?, model = ?, reasoning_effort = ?, director_thread_id = ?, max_replies = ?, reply_count = ?, status = ?, last_run_at = ?, last_reply_at = ?, last_summary = ?, last_notes = ?, last_error = ?, last_trigger_post_id = ?, steer_message = ?, updated_at = ?
          where topic_id = ?`
      )
      .run(
        merged.enabled,
        merged.context,
        merged.worker,
        merged.model,
        merged.reasoning_effort,
        merged.director_thread_id,
        merged.max_replies,
        merged.reply_count,
        merged.status,
        merged.last_run_at,
        merged.last_reply_at,
        merged.last_summary,
        merged.last_notes,
        merged.last_error,
        merged.last_trigger_post_id,
        merged.steer_message,
        merged.updated_at,
        merged.topic_id
      );

    return this.getTopicAutoRun(input.topicId) as TopicAutoRunRow;
  }

  search(
    query: string,
    scope: 'all' | 'topics' | 'posts' = 'all',
    limit = 50,
    options?: { forumIds?: string[] }
  ): { topics: TopicRow[]; posts: PostRow[] } {
    const searchTerm = `%${query}%`;
    const forumIds = options?.forumIds;
    if (forumIds && forumIds.length === 0) {
      return { topics: [], posts: [] };
    }
    const forumFilter = forumIds ? ` and t.forum_id in (${forumIds.map(() => '?').join(', ')})` : '';
    const forumParams = forumIds ?? [];
    let topics: TopicRow[] = [];
    let posts: PostRow[] = [];

    if (scope === 'all' || scope === 'topics') {
      topics = this.db
        .prepare(`select t.* from topics t where t.title like ?${forumFilter} order by t.created_at desc limit ?`)
        .all(searchTerm, ...forumParams, limit) as TopicRow[];
    }

    if (scope === 'all' || scope === 'posts') {
      posts = this.db
        .prepare(
          `select p.* from posts p join topics t on t.id = p.topic_id where p.body like ? and p.deleted_at is null${forumFilter} order by p.created_at desc limit ?`
        )
        .all(searchTerm, ...forumParams, limit) as PostRow[];
    }

    return { topics, posts };
  }

  upsertRobotState(input: UpdateRobotStateInput): RobotStateRow {
    const now = nowIso();
    const currentPlanId =
      input.activity === 'idle' || input.activity === 'stopped' ? null : (input.currentPlanId ?? null);
    const existing = this.getRobotState(input.topicId);
    if (existing) {
      this.db
        .prepare(
          `update robot_state
             set session_id = ?, activity = ?, model = ?, reasoning_effort = ?, last_updated_at = ?, current_plan_id = ?,
                 last_error_message = case when ? != 'idle' then null else last_error_message end,
                 last_error_at = case when ? != 'idle' then null else last_error_at end,
                 last_error_post_id = case when ? != 'idle' then null else last_error_post_id end,
                 last_error_turn_id = case when ? != 'idle' then null else last_error_turn_id end
             where topic_id = ?`
        )
        .run(
          input.sessionId,
          input.activity,
          input.model ?? null,
          input.reasoningEffort ?? null,
          now,
          currentPlanId,
          input.activity,
          input.activity,
          input.activity,
          input.activity,
          input.topicId
        );
    } else {
      this.db
        .prepare(
          `insert into robot_state
            (topic_id, session_id, activity, model, reasoning_effort, last_updated_at, current_plan_id, last_error_message, last_error_at, last_error_post_id, last_error_turn_id)
            values (?, ?, ?, ?, ?, ?, ?, null, null, null, null)`
        )
        .run(
          input.topicId,
          input.sessionId,
          input.activity,
          input.model ?? null,
          input.reasoningEffort ?? null,
          now,
          currentPlanId
        );
    }
    return this.getRobotState(input.topicId) as RobotStateRow;
  }

  getPiSessionLinkByTopic(topicId: string): PiSessionLinkRow | null {
    const row = this.db.prepare('select * from pi_session_links where topic_id = ? limit 1').get(topicId) as
      PiSessionLinkRow | undefined;
    return row ?? null;
  }

  isPristineConversationCreation(topicId: string, creationDispatchId: string): boolean {
    const session = this.getSessionByTopic(topicId);
    if (!session || session.agent_thread_id || session.last_dispatched_post_id) return false;
    const canonicalMessage = this.db
      .prepare(
        `select 1 from pi_message_links m
         join posts p on p.id = m.post_id
         where p.topic_id = ? limit 1`
      )
      .get(topicId);
    if (canonicalMessage) return false;
    const otherDispatch = this.db
      .prepare(
        `select 1 from post_dispatches
         where topic_id = ? and id <> ?
         limit 1`
      )
      .get(topicId, creationDispatchId);
    return !otherDispatch;
  }

  listPiSessionLinksWithUnresolvedCancellation(): PiSessionLinkRow[] {
    return this.db
      .prepare(
        "select l.* from pi_session_links l join robot_state r on r.topic_id = l.topic_id where r.activity in ('stopping', 'uncertain')"
      )
      .all() as PiSessionLinkRow[];
  }

  getPiSessionLinkByPiSessionId(piSessionId: string): PiSessionLinkRow | null {
    const row = this.db.prepare('select * from pi_session_links where pi_session_id = ? limit 1').get(piSessionId) as
      PiSessionLinkRow | undefined;
    return row ?? null;
  }

  getPiSessionLinkByPiSessionPath(piSessionPath: string): PiSessionLinkRow | null {
    const row = this.db
      .prepare('select * from pi_session_links where pi_session_path = ? limit 1')
      .get(piSessionPath) as PiSessionLinkRow | undefined;
    return row ?? null;
  }

  upsertPiSessionLink(input: {
    piSessionId: string;
    piSessionPath: string;
    topicId: string;
    sessionId: string;
    cwd?: string | null;
    kind?: string | null;
    piTimestamp?: string | null;
    metadata?: unknown;
    parentPiSessionId?: string | null;
    parentPiSessionPath?: string | null;
    lineageKind?: string | null;
    lineageSource?: string | null;
  }): PiSessionLinkRow {
    const now = nowIso();
    const metadataJson = JSON.stringify(input.metadata ?? null);
    const existing =
      this.getPiSessionLinkByPiSessionId(input.piSessionId) ?? this.getPiSessionLinkByTopic(input.topicId);
    if (existing) {
      this.db
        .prepare(
          'update pi_session_links set pi_session_id = ?, pi_session_path = ?, topic_id = ?, session_id = ?, cwd = ?, kind = ?, pi_timestamp = ?, imported_at = ?, metadata_json = ?, parent_pi_session_id = ?, parent_pi_session_path = ?, lineage_kind = ?, lineage_source = ? where id = ?'
        )
        .run(
          input.piSessionId,
          input.piSessionPath,
          input.topicId,
          input.sessionId,
          input.cwd ?? existing.cwd,
          input.kind ?? existing.kind,
          input.piTimestamp ?? existing.pi_timestamp,
          now,
          metadataJson,
          input.parentPiSessionId ?? existing.parent_pi_session_id ?? null,
          input.parentPiSessionPath ?? existing.parent_pi_session_path ?? null,
          input.lineageKind ?? existing.lineage_kind ?? null,
          input.lineageSource ?? existing.lineage_source ?? null,
          existing.id
        );
      return this.db.prepare('select * from pi_session_links where id = ?').get(existing.id) as PiSessionLinkRow;
    }
    const id = randomUUID();
    this.db
      .prepare(
        'insert into pi_session_links (id, pi_session_id, pi_session_path, topic_id, session_id, cwd, kind, pi_timestamp, imported_at, last_import_run_id, metadata_json, parent_pi_session_id, parent_pi_session_path, lineage_kind, lineage_source) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        input.piSessionId,
        input.piSessionPath,
        input.topicId,
        input.sessionId,
        input.cwd ?? null,
        input.kind ?? 'normal',
        input.piTimestamp ?? null,
        now,
        null,
        metadataJson,
        input.parentPiSessionId ?? null,
        input.parentPiSessionPath ?? null,
        input.lineageKind ?? null,
        input.lineageSource ?? null
      );
    return this.db.prepare('select * from pi_session_links where id = ?').get(id) as PiSessionLinkRow;
  }

  getPiMessageLink(piSessionId: string, piMessageId: string): PiMessageLinkRow | null {
    const row = this.db
      .prepare('select * from pi_message_links where pi_session_id = ? and pi_message_id = ? limit 1')
      .get(piSessionId, piMessageId) as PiMessageLinkRow | undefined;
    return row ?? null;
  }

  findPiMessageLinkBySubagentRun(piSessionId: string, runIds: string[]): PiMessageLinkRow | null {
    const ids = [...new Set(runIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))].slice(
      0,
      100
    );
    if (ids.length === 0) return null;
    const row = this.db
      .prepare(
        `select * from pi_message_links
       where pi_session_id = ? and post_id is not null
         and (json_extract(metadata_json, '$.runId') in (select value from json_each(?))
           or exists (select 1 from json_each(metadata_json, '$.runIds') where value in (select value from json_each(?))))
       order by imported_at asc limit 1`
      )
      .get(piSessionId, JSON.stringify(ids), JSON.stringify(ids)) as PiMessageLinkRow | undefined;
    return row ?? null;
  }

  createPiMessageLink(input: {
    piSessionId: string;
    piMessageId: string;
    postId?: string | null;
    sessionMessageId?: string | null;
    role?: string | null;
    metadata?: unknown;
  }): PiMessageLinkRow {
    const existing = this.getPiMessageLink(input.piSessionId, input.piMessageId);
    if (existing) {
      this.db
        .prepare(
          `update pi_message_links
           set post_id = coalesce(post_id, ?), session_message_id = coalesce(session_message_id, ?),
               role = coalesce(role, ?),
               metadata_json = case when post_id is null and ? is not null then ? else metadata_json end
           where id = ?`
        )
        .run(
          input.postId ?? null,
          input.sessionMessageId ?? null,
          input.role ?? null,
          input.postId ?? null,
          JSON.stringify(input.metadata ?? null),
          existing.id
        );
      return this.db.prepare('select * from pi_message_links where id = ?').get(existing.id) as PiMessageLinkRow;
    }
    const id = randomUUID();
    this.db
      .prepare(
        'insert into pi_message_links (id, pi_session_id, pi_message_id, post_id, session_message_id, role, imported_at, metadata_json) values (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        input.piSessionId,
        input.piMessageId,
        input.postId ?? null,
        input.sessionMessageId ?? null,
        input.role ?? null,
        nowIso(),
        JSON.stringify(input.metadata ?? null)
      );
    return this.db.prepare('select * from pi_message_links where id = ?').get(id) as PiMessageLinkRow;
  }

  findUnlinkedPostBySourceMessageId(topicId: string, sourceMessageId: string): PostRow | null {
    const row = this.db
      .prepare(
        'select p.* from posts p left join pi_message_links l on l.post_id = p.id where p.topic_id = ? and p.source_message_id = ? and l.id is null limit 1'
      )
      .get(topicId, sourceMessageId) as PostRow | undefined;
    return row ?? null;
  }

  findUnlinkedPostByBody(topicId: string, authorId: string, body: string): PostRow | null {
    const row = this.db
      .prepare(
        'select p.* from posts p left join pi_message_links l on l.post_id = p.id where p.topic_id = ? and p.author_id = ? and p.body = ? and l.id is null order by p.created_at desc limit 1'
      )
      .get(topicId, authorId, body) as PostRow | undefined;
    return row ?? null;
  }

  listExternalRefs(topicId: string): ExternalRefRow[] {
    return this.db.prepare('select * from external_refs where mapped_topic_id = ?').all(topicId) as ExternalRefRow[];
  }

  getExternalRef(refId: string): ExternalRefRow | null {
    const row = this.db.prepare('select * from external_refs where id = ?').get(refId) as ExternalRefRow | undefined;
    return row ?? null;
  }

  getExternalRefByExternal(surfaceId: string, surfaceKind: string, externalId: string): ExternalRefRow | null {
    const row = this.db
      .prepare('select * from external_refs where surface_id = ? and surface_kind = ? and external_id = ?')
      .get(surfaceId, surfaceKind, externalId) as ExternalRefRow | undefined;
    return row ?? null;
  }

  createExternalRef(input: CreateExternalRefInput): ExternalRefRow {
    const id = randomUUID();
    this.db
      .prepare(
        'insert into external_refs (id, surface_id, surface_kind, external_id, kind, scope, scope_kind, mapped_forum_id, mapped_topic_id, mapped_post_id, mapped_identity_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        input.surfaceId,
        input.surfaceKind,
        input.externalId,
        input.kind,
        input.scope ?? null,
        input.scopeKind ?? null,
        input.mappedForumId ?? null,
        input.mappedTopicId ?? null,
        input.mappedPostId ?? null,
        input.mappedIdentityId ?? null
      );
    return this.getExternalRef(id) as ExternalRefRow;
  }

  deleteExternalRef(refId: string): void {
    this.db.prepare('delete from external_refs where id = ?').run(refId);
  }

  // Identity management

  createIdentity(
    displayName: string,
    kind: string = 'human',
    avatarUrl?: string | null,
    parentIdentityId?: string | null
  ): IdentityRow {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'insert into identities (id, tenant_id, display_name, kind, parent_identity_id, avatar_url, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, null, displayName, kind, parentIdentityId ?? null, avatarUrl ?? null, now, now);
    return this.getIdentity(id) as IdentityRow;
  }

  updateIdentity(
    identityId: string,
    updates: {
      displayName?: string;
      avatarUrl?: string | null;
      location?: string | null;
      signature?: string | null;
      theme?: string | null;
    }
  ): IdentityRow {
    const existing = this.getIdentity(identityId);
    if (!existing) {
      throw new Error('identity not found');
    }
    const now = nowIso();
    const displayName = updates.displayName ?? existing.display_name;
    const avatarUrl = updates.avatarUrl !== undefined ? updates.avatarUrl : existing.avatar_url;
    const location = updates.location !== undefined ? updates.location : existing.location;
    const signature = updates.signature !== undefined ? updates.signature : existing.signature;
    const theme = updates.theme !== undefined ? updates.theme : existing.theme;

    this.db
      .prepare(
        'update identities set display_name = ?, avatar_url = ?, location = ?, signature = ?, theme = ?, updated_at = ? where id = ?'
      )
      .run(displayName, avatarUrl, location, signature, theme, now, identityId);
    this.invalidateIdentityCache(identityId);
    return this.getIdentity(identityId) as IdentityRow;
  }

  /**
   * Robot-only user contact email.
   *
   * This field is intentionally NOT part of the public IdentityDto mapping.
   * The web UI should only ever see a boolean "has email set" (if anything).
   */
  getIdentityPrivateEmail(identityId: string): string | null {
    const row = this.db
      .prepare('select private_email as private_email from identities where id = ? limit 1')
      .get(identityId) as { private_email: string | null } | undefined;
    return row?.private_email ?? null;
  }

  hasIdentityPrivateEmail(identityId: string): boolean {
    return Boolean(this.getIdentityPrivateEmail(identityId));
  }

  setIdentityPrivateEmail(identityId: string, emailAddress: string | null): void {
    const existing = this.getIdentity(identityId);
    if (!existing) {
      throw new Error('identity not found');
    }
    const now = nowIso();
    this.db
      .prepare('update identities set private_email = ?, updated_at = ? where id = ?')
      .run(emailAddress ?? null, now, identityId);
  }

  setIdentityQuickReplyPreferences(
    identityId: string,
    preferences: { desktopMode: 'inline' | 'docked'; mobileMode: 'inline' | 'docked' }
  ): void {
    const existing = this.getIdentity(identityId);
    if (!existing) throw new Error('identity not found');
    this.db
      .prepare(
        'update identities set quick_reply_desktop_mode = ?, quick_reply_mobile_mode = ?, updated_at = ? where id = ?'
      )
      .run(preferences.desktopMode, preferences.mobileMode, nowIso(), identityId);
    this.invalidateIdentityCache(identityId);
  }

  getIdentityPostCount(identityId: string): number {
    const result = this.db
      .prepare('select count(*) as count from posts where author_id = ? and deleted_at is null')
      .get(identityId) as { count: number };
    return result.count;
  }

  listForumLeaders(options?: {
    limit?: number;
    includeMembersForums?: boolean;
    includeAdminForums?: boolean;
  }): Array<{ identity: IdentityRow; postCount: number }> {
    const limit = Math.max(1, Math.min(50, Math.trunc(options?.limit ?? 5)));
    const includeMembersForums = Boolean(options?.includeMembersForums);
    const includeAdminForums = Boolean(options?.includeAdminForums);

    const visibilities: string[] = ['public'];
    if (includeMembersForums) visibilities.push('members');
    if (includeAdminForums) visibilities.push('admin');

    const placeholders = visibilities.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `
        select
          i.id as identity_id,
          i.tenant_id as tenant_id,
          i.display_name as display_name,
          i.kind as kind,
          i.parent_identity_id as parent_identity_id,
          i.avatar_url as avatar_url,
          i.username as username,
          i.password_hash as password_hash,
          i.location as location,
          i.signature as signature,
          i.theme as theme,
          i.private_email as private_email,
          i.created_at as created_at,
          i.updated_at as updated_at,
          count(p.id) as post_count
        from posts p
        join topics t on t.id = p.topic_id
        join forums f on f.id = t.forum_id
        join identities i on i.id = p.author_id
        where p.deleted_at is null
          and f.visibility in (${placeholders})
        group by i.id
        order by post_count desc, lower(i.display_name) asc
        limit ?
        `
      )
      .all(...visibilities, limit) as Array<{
      identity_id: string;
      tenant_id: string | null;
      display_name: string;
      kind: string;
      parent_identity_id: string | null;
      avatar_url: string | null;
      username: string | null;
      password_hash: string | null;
      location: string | null;
      signature: string | null;
      theme: string | null;
      private_email: string | null;
      created_at: string;
      updated_at: string;
      post_count: number;
    }>;

    return rows.map((row) => ({
      identity: {
        id: row.identity_id,
        tenant_id: row.tenant_id,
        display_name: row.display_name,
        kind: row.kind,
        parent_identity_id: row.parent_identity_id,
        avatar_url: row.avatar_url,
        username: row.username,
        password_hash: row.password_hash,
        location: row.location,
        signature: row.signature,
        theme: row.theme,
        private_email: row.private_email,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      postCount: row.post_count,
    }));
  }

  getUserRank(postCount: number): string {
    // Robot-themed ranks (vBulletin-style), based purely on post count.
    // Keep the thresholds stable so a rank feels "earned" over time.
    if (postCount >= 5000) return 'Singularity Supervisor';
    if (postCount >= 2000) return 'Mainframe Marshal';
    if (postCount >= 1000) return 'Protocol Veteran';
    if (postCount >= 500) return 'Circuit Sergeant';
    if (postCount >= 100) return 'Wrench Wrangler';
    if (postCount >= 10) return 'Servo Squire';
    return 'Freshly Assembled';
  }

  getIdentityByDisplayName(displayName: string): IdentityRow | null {
    const row = this.db.prepare('select * from identities where display_name = ? limit 1').get(displayName) as
      IdentityRow | undefined;
    return row ?? null;
  }

  isDisplayNameTakenByOther(displayName: string, excludeIdentityId: string): boolean {
    const row = this.db
      .prepare('select id from identities where lower(display_name) = lower(?) and id != ? limit 1')
      .get(displayName, excludeIdentityId) as { id: string } | undefined;
    return row !== undefined;
  }

  getPersonaByDisplayName(displayName: string): IdentityRow | null {
    const row = this.db
      .prepare('select * from identities where display_name = ? and kind = ? limit 1')
      .get(displayName, 'persona') as IdentityRow | undefined;
    return row ?? null;
  }

  getOrCreatePersona(displayName: string, parentIdentityId: string): IdentityRow {
    const trimmed = displayName.trim();
    const existing = this.getPersonaByDisplayName(trimmed);
    if (existing) {
      if (!existing.parent_identity_id) {
        this.db
          .prepare('update identities set parent_identity_id = ?, updated_at = ? where id = ?')
          .run(parentIdentityId, nowIso(), existing.id);
      }
      return this.getIdentity(existing.id) as IdentityRow;
    }
    return this.createIdentity(trimmed, 'persona', null, parentIdentityId);
  }

  // Robot persona management (admin-defined personas used for robot multipost rendering)

  getRobotPersona(forumId: string, key: string): RobotPersonaRecord | null {
    const row = this.db
      .prepare(
        `select
           rp.*,
           i.display_name as identity_display_name,
           i.avatar_url as identity_avatar_url,
           i.signature as identity_signature
         from robot_personas rp
         join identities i on i.id = rp.identity_id
         where rp.forum_id = ? and rp.id = ?
         limit 1`
      )
      .get(forumId, key) as
      | (RobotPersonaRow & {
          identity_display_name: string;
          identity_avatar_url: string | null;
          identity_signature: string | null;
        })
      | undefined;

    if (!row) return null;
    return {
      key: row.id,
      forumId: row.forum_id,
      identityId: row.identity_id,
      displayName: row.identity_display_name,
      description: row.description,
      accentColor: row.accent_color,
      avatarUrl: row.identity_avatar_url,
      signature: row.identity_signature,
      soul: row.soul,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listRobotPersonas(forumId: string): RobotPersonaRecord[] {
    const rows = this.db
      .prepare(
        `select
           rp.*,
           i.display_name as identity_display_name,
           i.avatar_url as identity_avatar_url,
           i.signature as identity_signature
         from robot_personas rp
         join identities i on i.id = rp.identity_id
         where rp.forum_id = ?
         order by rp.id asc`
      )
      .all(forumId) as Array<
      RobotPersonaRow & {
        identity_display_name: string;
        identity_avatar_url: string | null;
        identity_signature: string | null;
      }
    >;

    return rows.map((row) => ({
      key: row.id,
      forumId: row.forum_id,
      identityId: row.identity_id,
      displayName: row.identity_display_name,
      description: row.description,
      accentColor: row.accent_color,
      avatarUrl: row.identity_avatar_url,
      signature: row.identity_signature,
      soul: row.soul,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  listRobotPersonasUpdatedSince(forumId: string, sinceIso: string): RobotPersonaRecord[] {
    const rows = this.db
      .prepare(
        `select
           rp.*,
           i.display_name as identity_display_name,
           i.avatar_url as identity_avatar_url,
           i.signature as identity_signature
         from robot_personas rp
         join identities i on i.id = rp.identity_id
         where rp.forum_id = ? and rp.updated_at > ?
         order by rp.updated_at asc`
      )
      .all(forumId, sinceIso) as Array<
      RobotPersonaRow & {
        identity_display_name: string;
        identity_avatar_url: string | null;
        identity_signature: string | null;
      }
    >;

    return rows.map((row) => ({
      key: row.id,
      forumId: row.forum_id,
      identityId: row.identity_id,
      displayName: row.identity_display_name,
      description: row.description,
      accentColor: row.accent_color,
      avatarUrl: row.identity_avatar_url,
      signature: row.identity_signature,
      soul: row.soul,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  createRobotPersona(input: CreateRobotPersonaInput): RobotPersonaRecord {
    const trimmedKey = input.key.trim();
    if (!trimmedKey) {
      throw new Error('persona key is required');
    }

    const existing = this.getRobotPersona(input.forumId, trimmedKey);
    if (existing) {
      throw new Error('persona key already exists');
    }

    const robotIdentity = this.getIdentityByKind('robot');
    const identity = this.createIdentity(
      input.displayName.trim(),
      'persona',
      input.avatarUrl ?? null,
      robotIdentity?.id ?? null
    );
    if (input.signature !== undefined) {
      this.updateIdentity(identity.id, { signature: input.signature ?? null });
    }

    const now = nowIso();
    this.db
      .prepare(
        `insert into robot_personas
          (id, forum_id, identity_id, description, accent_color, soul, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        trimmedKey,
        input.forumId,
        identity.id,
        input.description ?? null,
        input.accentColor ?? null,
        input.soul ?? null,
        now,
        now
      );

    // Re-fetch to include identity fields with any updates applied
    return this.getRobotPersona(input.forumId, trimmedKey) as RobotPersonaRecord;
  }

  updateRobotPersona(forumId: string, key: string, updates: UpdateRobotPersonaInput): RobotPersonaRecord {
    const existing = this.getRobotPersona(forumId, key);
    if (!existing) {
      throw new Error('persona not found');
    }

    const identityUpdates: { displayName?: string; avatarUrl?: string | null; signature?: string | null } = {};
    if (updates.displayName !== undefined) identityUpdates.displayName = updates.displayName;
    if (updates.avatarUrl !== undefined) identityUpdates.avatarUrl = updates.avatarUrl;
    if (updates.signature !== undefined) identityUpdates.signature = updates.signature;
    if (Object.keys(identityUpdates).length > 0) {
      this.updateIdentity(existing.identityId, identityUpdates);
    }

    const now = nowIso();
    const nextDescription = updates.description !== undefined ? updates.description : existing.description;
    const nextAccentColor = updates.accentColor !== undefined ? updates.accentColor : existing.accentColor;
    const nextSoul = updates.soul !== undefined ? updates.soul : existing.soul;

    this.db
      .prepare(
        'update robot_personas set description = ?, accent_color = ?, soul = ?, updated_at = ? where forum_id = ? and id = ?'
      )
      .run(nextDescription ?? null, nextAccentColor ?? null, nextSoul ?? null, now, forumId, key);

    return this.getRobotPersona(forumId, key) as RobotPersonaRecord;
  }

  deleteRobotPersona(forumId: string, key: string): void {
    this.db.prepare('delete from robot_personas where forum_id = ? and id = ?').run(forumId, key);
  }

  getIdentityByUsername(username: string): IdentityRow | null {
    const row = this.db.prepare('select * from identities where username = ? collate nocase limit 1').get(username) as
      IdentityRow | undefined;
    return row ?? null;
  }

  createIdentityWithPassword(
    displayName: string,
    username: string,
    passwordHash: string,
    kind: string = 'human',
    avatarUrl?: string | null
  ): IdentityRow {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'insert into identities (id, tenant_id, display_name, kind, parent_identity_id, avatar_url, username, password_hash, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, null, displayName, kind, null, avatarUrl ?? null, username, passwordHash, now, now);
    return this.getIdentity(id) as IdentityRow;
  }

  setIdentityPassword(identityId: string, username: string, passwordHash: string | null): void {
    const now = nowIso();
    this.db
      .prepare('update identities set username = ?, password_hash = ?, updated_at = ? where id = ?')
      .run(username, passwordHash, now, identityId);
    this.invalidateIdentityCache(identityId);
  }

  listAllIdentities(page = 1, pageSize = 100): IdentityRow[] {
    const offset = (page - 1) * pageSize;
    return this.db
      .prepare('select * from identities order by created_at desc limit ? offset ?')
      .all(pageSize, offset) as IdentityRow[];
  }

  // Invite management

  createInvite(createdBy: string, maxUses: number = 1, expiresAt?: string | null): InviteRow {
    const id = randomUUID();
    const code = randomUUID().replace(/-/g, '').slice(0, 16);
    const now = nowIso();
    this.db
      .prepare(
        'insert into invites (id, code, created_by, max_uses, uses, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, code, createdBy, maxUses, 0, expiresAt ?? null, now);
    return this.getInvite(id) as InviteRow;
  }

  getInvite(inviteId: string): InviteRow | null {
    const row = this.db.prepare('select * from invites where id = ?').get(inviteId) as InviteRow | undefined;
    return row ?? null;
  }

  getInviteByCode(code: string): InviteRow | null {
    const row = this.db.prepare('select * from invites where code = ?').get(code) as InviteRow | undefined;
    return row ?? null;
  }

  listInvites(page = 1, pageSize = 50): InviteRow[] {
    const offset = (page - 1) * pageSize;
    return this.db
      .prepare('select * from invites order by created_at desc limit ? offset ?')
      .all(pageSize, offset) as InviteRow[];
  }

  useInvite(code: string): { ok: boolean; invite?: InviteRow; error?: string } {
    const invite = this.getInviteByCode(code);
    if (!invite) {
      return { ok: false, error: 'invite not found' };
    }

    // Check if expired
    if (invite.expires_at) {
      const expiresAt = new Date(invite.expires_at);
      if (new Date() > expiresAt) {
        return { ok: false, error: 'invite expired' };
      }
    }

    // Check if max uses reached
    if (invite.uses >= invite.max_uses) {
      return { ok: false, error: 'invite exhausted' };
    }

    // Increment uses
    this.db.prepare('update invites set uses = uses + 1 where id = ?').run(invite.id);

    return { ok: true, invite: this.getInvite(invite.id) ?? invite };
  }

  deleteInvite(inviteId: string): void {
    this.db.prepare('delete from invites where id = ?').run(inviteId);
  }

  // Canonical assistant projection and attachment handoff management

  getAssistantProjection(piSessionId: string, piMessageId: string): AssistantProjectionRow | null {
    return (
      (this.db
        .prepare('select * from assistant_projections where pi_session_id = ? and pi_message_id = ?')
        .get(piSessionId, piMessageId) as AssistantProjectionRow | undefined) ?? null
    );
  }

  beginAssistantProjection(input: BeginAssistantProjectionInput): AssistantProjectionRow {
    const handoffs = dedupeAttachmentHandoffs(input.handoffs ?? []);
    const projection = this.db.transaction(() => {
      const existing = this.getAssistantProjection(input.piSessionId, input.piMessageId);
      if (existing) {
        if (input.completionPayload != null && existing.completion_payload_json == null) {
          this.db
            .prepare(
              "update assistant_projections set completion_payload_json = ?, completion_state = case when status = 'projected' then 1 else completion_state end, updated_at = ? where id = ?"
            )
            .run(JSON.stringify(input.completionPayload), nowIso(), existing.id);
        }
        return this.getAssistantProjection(input.piSessionId, input.piMessageId) as AssistantProjectionRow;
      }
      const now = nowIso();
      const projectionId = randomUUID();
      const existingLink = this.getPiMessageLink(input.piSessionId, input.piMessageId);
      const linkedPost = existingLink?.post_id
        ? (this.db
            .prepare('select * from posts where id = ? and topic_id = ?')
            .get(existingLink.post_id, input.topicId) as PostRow | undefined)
        : undefined;
      const linkedSessionMessage = existingLink?.session_message_id
        ? (this.db.prepare('select id from session_messages where id = ?').get(existingLink.session_message_id) as
            { id: string } | undefined)
        : undefined;
      const sessionMessageId = linkedSessionMessage?.id ?? randomUUID();
      if (!linkedSessionMessage) {
        this.db
          .prepare(
            `insert into session_messages (id, session_id, role, content, created_at, visibility)
           values (?, ?, 'assistant', ?, ?, 'public')`
          )
          .run(sessionMessageId, input.sessionId, input.body, now);
      }
      const followUp = Boolean(
        (input.metadata as Record<string, unknown> | null)?.['sourceKind'] === 'subagent-completion'
      );
      this.db
        .prepare(
          `insert into assistant_projections
         (id, pi_session_id, pi_message_id, utterance_id, topic_id, post_id, session_message_id, status,
          origin_json, projection_json, completion_payload_json, completion_state, attempt_count, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
        )
        .run(
          projectionId,
          input.piSessionId,
          input.piMessageId,
          input.utteranceId,
          input.topicId,
          linkedPost?.id ?? null,
          sessionMessageId,
          handoffs.length > 0 ? 'linking' : 'pending',
          JSON.stringify(input.origin ?? null),
          JSON.stringify({
            sessionId: input.sessionId,
            body: input.body,
            authorId: input.authorId,
            parentPostId: input.parentPostId ?? null,
            metadata: input.metadata ?? null,
            followUp,
          }),
          input.completionPayload == null ? null : JSON.stringify(input.completionPayload),
          now,
          now
        );
      for (const handoff of handoffs) {
        this.db
          .prepare(
            `insert or ignore into attachment_handoffs
           (id, projection_id, ref_entry_id, source_kind, source_ref_json, expected_sha256,
            expected_size_bytes, status, attempt_count, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
          )
          .run(
            randomUUID(),
            projectionId,
            handoff.refEntryId,
            handoff.sourceKind,
            JSON.stringify(handoff.sourceRef),
            handoff.expectedSha256 ?? null,
            handoff.expectedSizeBytes ?? null,
            now,
            now
          );
      }
      return this.getAssistantProjection(input.piSessionId, input.piMessageId) as AssistantProjectionRow;
    })();
    if (handoffs.length === 0) return this.finalizeAssistantProjection(projection.id) ?? projection;
    return projection;
  }

  listAttachmentHandoffsForProjection(projectionId: string): AttachmentHandoffRow[] {
    return this.db
      .prepare('select * from attachment_handoffs where projection_id = ? order by rowid asc')
      .all(projectionId) as AttachmentHandoffRow[];
  }

  listDueAttachmentHandoffs(limit = 20): AttachmentHandoffRow[] {
    return this.db
      .prepare(
        `select h.* from attachment_handoffs h
       join assistant_projections p on p.id = h.projection_id
       where h.status in ('pending', 'failed') and (h.next_attempt_at is null or h.next_attempt_at <= ?)
       order by p.rowid asc, h.rowid asc limit ?`
      )
      .all(nowIso(), limit) as AttachmentHandoffRow[];
  }

  reclaimStaleAttachmentHandoffs(staleBefore: string, excludedClaimTokens: readonly string[] = []): number {
    const exclusion =
      excludedClaimTokens.length > 0
        ? ` and (claim_token is null or claim_token not in (${excludedClaimTokens.map(() => '?').join(', ')}))`
        : '';
    return this.db
      .prepare(
        `update attachment_handoffs set status = 'failed', claim_token = null, next_attempt_at = null,
       error_message = coalesce(error_message, 'Recovered stale linking lease.'), updated_at = ?
       where status = 'linking' and updated_at <= ?${exclusion}`
      )
      .run(nowIso(), staleBefore, ...excludedClaimTokens).changes;
  }

  claimAttachmentHandoff(id: string): AttachmentHandoffRow | null {
    return this.db.transaction(() => {
      const token = randomUUID();
      const now = nowIso();
      const changed = this.db
        .prepare(
          `update attachment_handoffs set status = 'linking', claim_token = ?, attempt_count = attempt_count + 1,
         next_attempt_at = null, error_message = null, updated_at = ?
         where id = ? and status in ('pending', 'failed') and (next_attempt_at is null or next_attempt_at <= ?)`
        )
        .run(token, now, id, now).changes;
      if (changed !== 1) return null;
      const handoff = this.db.prepare('select * from attachment_handoffs where id = ?').get(id) as AttachmentHandoffRow;
      if (handoff.source_kind !== 'legacy-artifact') {
        const ref = JSON.parse(handoff.source_ref_json) as Record<string, unknown>;
        const pendingId = pendingAttachmentId({
          refEntryId: handoff.ref_entry_id,
          sourceKind: handoff.source_kind,
          sourceRef: ref,
        });
        if (pendingId) {
          const pending = this.getPendingAttachment(pendingId);
          const existingReservation = this.db
            .prepare('select projection_id from pending_attachment_reservations where pending_attachment_id = ?')
            .get(pendingId) as { projection_id: string } | undefined;
          const owner = pending
            ? this.reservePendingAttachment(handoff, pending)
            : (existingReservation?.projection_id ?? null);
          if (owner && owner !== handoff.projection_id) {
            return this.markAttachmentReservationConflict(handoff, owner);
          }
        }
      }
      return handoff;
    })();
  }

  private reservePendingAttachment(handoff: AttachmentHandoffRow, pending: PendingAttachmentRow): string {
    const projection = this.getAssistantProjectionById(handoff.projection_id);
    if (!projection || projection.topic_id !== pending.topic_id) return '';
    const now = nowIso();
    this.db
      .prepare(
        `insert or ignore into pending_attachment_reservations
       (pending_attachment_id, topic_id, projection_id, handoff_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?)`
      )
      .run(pending.id, pending.topic_id, handoff.projection_id, handoff.id, now, now);
    const reservation = this.db
      .prepare('select projection_id from pending_attachment_reservations where pending_attachment_id = ?')
      .get(pending.id) as { projection_id: string } | undefined;
    return reservation?.projection_id ?? '';
  }

  private markAttachmentReservationConflict(
    handoff: AttachmentHandoffRow,
    ownerProjectionId: string
  ): AttachmentHandoffRow {
    const projection = this.getAssistantProjectionById(handoff.projection_id);
    if (!projection) return handoff;
    const now = nowIso();
    const message = `Pending attachment is already reserved by assistant projection ${ownerProjectionId}.`;
    this.db
      .prepare(
        `update attachment_handoffs set status = 'needs_manual_review', claim_token = null, next_attempt_at = null,
       error_message = ?, updated_at = ? where id = ?`
      )
      .run(message.slice(0, 1000), now, handoff.id);
    this.db
      .prepare(
        "update assistant_projections set status = 'needs_manual_review', error_message = ?, updated_at = ? where id = ?"
      )
      .run(message.slice(0, 1000), now, projection.id);
    this.db
      .prepare(
        `insert into pi_sync_anomalies
       (id, pi_session_id, pi_message_id, topic_id, session_id, role, status, reason, preview,
        first_seen_at, last_seen_at, last_checked_at, next_retry_at, retry_count, post_id, metadata_json)
       values (?, ?, ?, ?, (select id from sessions where topic_id = ? limit 1), 'assistant',
        'needs_manual_review', 'attachment-handoff-conflict', ?, ?, ?, ?, null, 0, ?, ?)
       on conflict(pi_session_id, pi_message_id, reason) do update set
         status = 'needs_manual_review', last_seen_at = excluded.last_seen_at,
         preview = excluded.preview, post_id = excluded.post_id, metadata_json = excluded.metadata_json`
      )
      .run(
        randomUUID(),
        projection.pi_session_id,
        projection.pi_message_id,
        projection.topic_id,
        projection.topic_id,
        message.slice(0, 500),
        now,
        now,
        now,
        projection.post_id,
        JSON.stringify({ handoffId: handoff.id, ownerProjectionId, error: message.slice(0, 1000) })
      );
    return this.db.prepare('select * from attachment_handoffs where id = ?').get(handoff.id) as AttachmentHandoffRow;
  }

  completeAttachmentHandoff(
    id: string,
    claimToken: string,
    pending: PendingAttachmentRow
  ): AttachmentHandoffRow | null {
    return this.db.transaction(() => {
      const handoff = this.db
        .prepare("select * from attachment_handoffs where id = ? and status = 'linking' and claim_token = ?")
        .get(id, claimToken) as AttachmentHandoffRow | undefined;
      if (!handoff) return null;
      const owner = this.reservePendingAttachment(handoff, pending);
      if (owner !== handoff.projection_id) return this.markAttachmentReservationConflict(handoff, owner || 'unknown');
      const now = nowIso();
      const sourceRef = JSON.parse(handoff.source_ref_json) as Record<string, unknown>;
      this.db
        .prepare(
          `update attachment_handoffs set status = 'linked', claim_token = null, next_attempt_at = null,
         error_message = null, source_ref_json = ?, updated_at = ? where id = ?`
        )
        .run(JSON.stringify({ ...sourceRef, pendingAttachmentId: pending.id }), now, id);
      return this.db.prepare('select * from attachment_handoffs where id = ?').get(id) as AttachmentHandoffRow;
    })();
  }

  failAttachmentHandoff(
    id: string,
    claimToken: string,
    message: string,
    opts: { retryAt?: string | null; terminal?: boolean } = {}
  ): AttachmentHandoffRow | null {
    return this.db.transaction(() => {
      const handoff = this.db
        .prepare("select * from attachment_handoffs where id = ? and status = 'linking' and claim_token = ?")
        .get(id, claimToken) as AttachmentHandoffRow | undefined;
      if (!handoff) return null;
      const projection = this.db
        .prepare('select * from assistant_projections where id = ?')
        .get(handoff.projection_id) as AssistantProjectionRow;
      const now = nowIso();
      const status = opts.terminal ? 'needs_manual_review' : 'failed';
      this.db
        .prepare(
          'update attachment_handoffs set status = ?, claim_token = null, next_attempt_at = ?, error_message = ?, updated_at = ? where id = ?'
        )
        .run(status, opts.retryAt ?? null, message.slice(0, 1000), now, id);
      this.db
        .prepare('update assistant_projections set status = ?, error_message = ?, updated_at = ? where id = ?')
        .run(opts.terminal ? 'needs_manual_review' : 'failed', message.slice(0, 1000), now, projection.id);
      if (opts.terminal) {
        this.db
          .prepare(
            `insert into pi_sync_anomalies
           (id, pi_session_id, pi_message_id, topic_id, session_id, role, status, reason, preview,
            first_seen_at, last_seen_at, last_checked_at, next_retry_at, retry_count, post_id, metadata_json)
           values (?, ?, ?, ?, (select id from sessions where topic_id = ? limit 1), 'assistant',
            'needs_manual_review', 'attachment-handoff-terminal', ?, ?, ?, ?, null, 0, ?, ?)
           on conflict(pi_session_id, pi_message_id, reason) do update set
             status = 'needs_manual_review', last_seen_at = excluded.last_seen_at,
             preview = excluded.preview, post_id = excluded.post_id, metadata_json = excluded.metadata_json`
          )
          .run(
            randomUUID(),
            projection.pi_session_id,
            projection.pi_message_id,
            projection.topic_id,
            projection.topic_id,
            message.slice(0, 500),
            now,
            now,
            now,
            projection.post_id,
            JSON.stringify({ handoffId: id, error: message.slice(0, 1000) })
          );
      }
      return this.db.prepare('select * from attachment_handoffs where id = ?').get(id) as AttachmentHandoffRow;
    })();
  }

  finalizeAssistantProjection(projectionId: string): AssistantProjectionRow | null {
    const finalized = this.db.transaction(() => {
      let projection = this.db.prepare('select * from assistant_projections where id = ?').get(projectionId) as
        AssistantProjectionRow | undefined;
      if (!projection) return null;
      if (projection.status === 'projected') return projection;
      const earlierIncomplete = this.db
        .prepare(
          `select 1 from assistant_projections earlier
         where earlier.pi_session_id = ? and earlier.topic_id = ?
           and earlier.rowid < (select rowid from assistant_projections where id = ?)
           and earlier.status in ('pending', 'linking', 'failed')
         limit 1`
        )
        .get(projection.pi_session_id, projection.topic_id, projectionId);
      // rowid is the durable canonical arrival order. Terminal manual-review
      // anomalies are intentionally gaps: they remain visible to operators but
      // cannot deadlock every later canonical outward item in the session.
      if (earlierIncomplete) return projection;
      const remaining = this.db
        .prepare("select count(*) as count from attachment_handoffs where projection_id = ? and status <> 'linked'")
        .get(projectionId) as { count: number };
      if (remaining.count > 0) return projection;
      const payload = JSON.parse(projection.projection_json) as {
        sessionId: string;
        body: string;
        authorId: string;
        parentPostId: string | null;
        metadata: unknown;
        followUp?: boolean;
      };
      const now = nowIso();
      let postId = projection.post_id;
      if (!postId) {
        postId = randomUUID();
        this.db
          .prepare(
            `insert into posts
           (id, topic_id, tenant_id, parent_post_id, author_id, body, source_message_id, silent, follow_up, created_at, edited_at, deleted_at)
           values (?, ?, null, ?, ?, ?, ?, 0, ?, ?, null, null)`
          )
          .run(
            postId,
            projection.topic_id,
            payload.parentPostId,
            payload.authorId,
            payload.body,
            projection.session_message_id,
            payload.followUp ? 1 : 0,
            now
          );
      } else if (payload.followUp) {
        this.db.prepare('update posts set follow_up = 1 where id = ?').run(postId);
      }
      const handoffs = this.listAttachmentHandoffsForProjection(projectionId);
      const pendingIds: string[] = [];
      for (const handoff of handoffs) {
        const ref = JSON.parse(handoff.source_ref_json) as Record<string, unknown>;
        const pendingId = typeof ref['pendingAttachmentId'] === 'string' ? ref['pendingAttachmentId'] : null;
        const pending = pendingId ? this.getPendingAttachment(pendingId) : null;
        if (!pending) throw new Error(`linked attachment handoff ${handoff.id} lost source custody`);
        const reservation = this.db
          .prepare('select projection_id from pending_attachment_reservations where pending_attachment_id = ?')
          .get(pending.id) as { projection_id: string } | undefined;
        if (reservation?.projection_id !== projectionId) {
          throw new Error(`linked attachment handoff ${handoff.id} does not own source custody`);
        }
        this.createAttachment({
          postId,
          filename: pending.filename,
          mimeType: pending.mime_type,
          sizeBytes: pending.size_bytes,
          storagePath: pending.storage_path,
          sha256: pending.sha256,
          ownerIdentityId: null,
        });
        pendingIds.push(pending.id);
      }
      for (const pendingId of new Set(pendingIds))
        this.db.prepare('delete from pending_attachments where id = ?').run(pendingId);
      this.createPiMessageLink({
        piSessionId: projection.pi_session_id,
        piMessageId: projection.pi_message_id,
        postId,
        sessionMessageId: projection.session_message_id,
        role: 'assistant',
        metadata: payload.metadata,
      });
      this.db
        .prepare(
          `update assistant_projections set post_id = ?, status = 'projected', claim_token = null,
         next_attempt_at = null, error_message = null,
         completion_state = case when completion_payload_json is null then 0 else 1 end,
         completion_claim_token = null, updated_at = ? where id = ?`
        )
        .run(postId, now, projectionId);
      projection = this.db
        .prepare('select * from assistant_projections where id = ?')
        .get(projectionId) as AssistantProjectionRow;
      return projection;
    })();
    if (finalized?.status === 'projected') this.invalidateTopicStatsCache(finalized.topic_id);
    return finalized;
  }

  listIncompleteAssistantProjections(): AssistantProjectionRow[] {
    return this.db
      .prepare(
        "select * from assistant_projections where status in ('pending', 'linking', 'failed') order by rowid asc"
      )
      .all() as AssistantProjectionRow[];
  }

  reclaimStaleAssistantProjectionCompletions(staleBefore: string, excludedClaimTokens: readonly string[] = []): number {
    const exclusion =
      excludedClaimTokens.length > 0
        ? ` and (completion_claim_token is null or completion_claim_token not in (${excludedClaimTokens.map(() => '?').join(', ')}))`
        : '';
    return this.db
      .prepare(
        `update assistant_projections set completion_state = 1, completion_claim_token = null, updated_at = ?
       where completion_state = 2 and updated_at <= ?${exclusion}`
      )
      .run(nowIso(), staleBefore, ...excludedClaimTokens).changes;
  }

  claimAssistantProjectionCompletion(id: string): AssistantProjectionRow | null {
    const token = randomUUID();
    const changed = this.db
      .prepare(
        `update assistant_projections set completion_state = 2, completion_claim_token = ?, updated_at = ?
       where id = ? and status = 'projected' and completion_state = 1
         and not exists (
           select 1 from assistant_projections earlier
           where earlier.pi_session_id = assistant_projections.pi_session_id
             and earlier.topic_id = assistant_projections.topic_id
             and earlier.rowid < assistant_projections.rowid
             and earlier.status = 'projected' and earlier.completion_state in (1, 2)
         )`
      )
      .run(token, nowIso(), id).changes;
    if (changed !== 1) return null;
    return this.getAssistantProjectionById(id);
  }

  completeAssistantProjectionCompletion(id: string, claimToken: string): boolean {
    return (
      this.db
        .prepare(
          `update assistant_projections set completion_state = 0, completion_claim_token = null, updated_at = ?
       where id = ? and completion_state = 2 and completion_claim_token = ?`
        )
        .run(nowIso(), id, claimToken).changes === 1
    );
  }

  releaseAssistantProjectionCompletion(id: string, claimToken: string): void {
    this.db
      .prepare(
        `update assistant_projections set completion_state = 1, completion_claim_token = null, updated_at = ?
       where id = ? and completion_state = 2 and completion_claim_token = ?`
      )
      .run(nowIso(), id, claimToken);
  }

  listPendingAssistantProjectionCompletions(): AssistantProjectionRow[] {
    return this.db
      .prepare(
        "select * from assistant_projections where status = 'projected' and completion_state = 1 order by rowid asc"
      )
      .all() as AssistantProjectionRow[];
  }

  getAssistantProjectionById(id: string): AssistantProjectionRow | null {
    return (
      (this.db.prepare('select * from assistant_projections where id = ?').get(id) as
        AssistantProjectionRow | undefined) ?? null
    );
  }

  // Attachment management

  createPendingAttachment(input: CreatePendingAttachmentInput): PendingAttachmentRow {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'insert into pending_attachments (id, topic_id, filename, mime_type, size_bytes, storage_path, sha256, created_by, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        input.topicId,
        input.filename,
        input.mimeType,
        input.sizeBytes,
        input.storagePath,
        input.sha256 ?? null,
        input.createdBy ?? null,
        now,
        input.expiresAt
      );
    return this.getPendingAttachment(id) as PendingAttachmentRow;
  }

  getPendingAttachment(id: string): PendingAttachmentRow | null {
    const row = this.db.prepare('select * from pending_attachments where id = ?').get(id) as
      PendingAttachmentRow | undefined;
    return row ?? null;
  }

  deletePendingAttachment(id: string): void {
    const reservation = this.db
      .prepare('select 1 from pending_attachment_reservations where pending_attachment_id = ?')
      .get(id);
    if (reservation) return;
    this.db.prepare('delete from pending_attachments where id = ?').run(id);
  }

  deleteExpiredPendingAttachments(now: string = nowIso()): PendingAttachmentRow[] {
    const protectedPredicate = `not exists (
      select 1 from attachment_handoffs h
      where h.status in ('pending', 'linking', 'failed', 'needs_manual_review')
        and json_extract(h.source_ref_json, '$.pendingAttachmentId') = pending_attachments.id
    ) and not exists (
      select 1 from pending_attachment_reservations r
      where r.pending_attachment_id = pending_attachments.id
    )`;
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(`select * from pending_attachments where expires_at <= ? and ${protectedPredicate}`)
        .all(now) as PendingAttachmentRow[];
      const enqueue = this.db.prepare(
        `insert into file_deletion_queue (storage_path, reason, created_at) values (?, 'expired_pending_attachment', ?)
         on conflict(storage_path) do nothing`
      );
      for (const row of rows) enqueue.run(row.storage_path, now);
      this.db.prepare(`delete from pending_attachments where expires_at <= ? and ${protectedPredicate}`).run(now);
      return rows;
    })();
  }

  createAttachment(input: CreateAttachmentInput): AttachmentRow {
    const id = randomUUID();
    const now = nowIso();
    return this.db.transaction(() => {
      let file =
        input.ownerIdentityId && input.sha256
          ? this.findUserFileByHash(input.ownerIdentityId, input.sha256, input.sizeBytes, [
              'ready',
              'missing',
              'gc_pending',
            ])
          : null;
      if (file?.blob_id) {
        const blob = this.db.prepare('select * from file_blobs where id = ?').get(file.blob_id) as
          FileBlobRow | undefined;
        if (blob?.state === 'gc_pending') {
          this.db.prepare("update file_blobs set state = 'ready', updated_at = ? where id = ?").run(now, blob.id);
        } else if (blob?.state === 'missing') {
          const replacementBlobId = randomUUID();
          this.db
            .prepare(
              `insert into file_blobs (id, owner_identity_id, sha256, size_bytes, storage_path, state, created_at, updated_at)
               values (?, ?, ?, ?, ?, 'ready', ?, ?)`
            )
            .run(
              replacementBlobId,
              input.ownerIdentityId,
              input.sha256 ?? null,
              input.sizeBytes,
              input.storagePath,
              now,
              now
            );
          this.db.prepare('update user_files set blob_id = ? where blob_id = ?').run(replacementBlobId, blob.id);
          this.db.prepare("update file_blobs set state = 'gc_pending', updated_at = ? where id = ?").run(now, blob.id);
          file = this.getUserFile(file.id);
        }
      }
      if (!file && input.ownerIdentityId == null && input.dedupeSystemByPath) {
        file =
          (this.db
            .prepare(
              `select uf.* from user_files uf join file_blobs b on b.id = uf.blob_id
               where uf.identity_id is null and b.storage_path = ? and b.state in ('ready', 'gc_pending') limit 1`
            )
            .get(input.storagePath) as UserFileRow | undefined) ?? null;
        if (file?.blob_id) {
          this.db
            .prepare("update file_blobs set state = 'ready', updated_at = ? where id = ? and state = 'gc_pending'")
            .run(now, file.blob_id);
        }
      }
      if (!file) {
        if (
          input.ownerIdentityId &&
          input.maxOwnerBytes !== undefined &&
          this.getIdentityBlobBytes(input.ownerIdentityId) + input.sizeBytes > input.maxOwnerBytes
        ) {
          throw new Error('file quota exceeded');
        }
        const blobId = randomUUID();
        const fileId = randomUUID();
        this.db
          .prepare(
            `insert into file_blobs (id, owner_identity_id, sha256, size_bytes, storage_path, state, created_at, updated_at)
           values (?, ?, ?, ?, ?, 'ready', ?, ?)`
          )
          .run(
            blobId,
            input.ownerIdentityId ?? null,
            input.sha256 ?? null,
            input.sizeBytes,
            input.storagePath,
            now,
            now
          );
        this.db
          .prepare(
            `insert into user_files
           (id, identity_id, blob_id, filename, mime_type, size_bytes, standalone, visibility, expires_at, revision, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, 0, null, null, 1, ?, ?)`
          )
          .run(
            fileId,
            input.ownerIdentityId ?? null,
            blobId,
            input.filename,
            input.mimeType,
            input.sizeBytes,
            now,
            now
          );
        file = this.getUserFile(fileId);
      }
      const existingAssociation = this.db
        .prepare('select id from attachments where file_id = ? and post_id = ? and deleted_at is null limit 1')
        .get(file!.id, input.postId) as { id: string } | undefined;
      if (existingAssociation) return this.getAttachment(existingAssociation.id)!;
      this.db
        .prepare(
          `insert into attachments
         (id, file_id, post_id, filename, mime_type, size_bytes, storage_path, sha256, created_at, deleted_at, delete_reason)
         values (?, ?, ?, ?, ?, ?, null, null, ?, null, null)`
        )
        .run(id, file!.id, input.postId, input.filename, input.mimeType, input.sizeBytes, now);
      return this.getAttachment(id)!;
    })();
  }

  getAttachment(attachmentId: string): AttachmentRow | null {
    return (
      (this.db
        .prepare(
          `select a.id, a.file_id, a.post_id, a.filename, a.mime_type, a.size_bytes,
        coalesce(b.storage_path, a.storage_path) as storage_path, coalesce(b.sha256, a.sha256) as sha256,
        a.created_at, a.deleted_at, a.delete_reason
       from attachments a left join user_files f on f.id = a.file_id left join file_blobs b on b.id = f.blob_id
       where a.id = ?`
        )
        .get(attachmentId) as AttachmentRow | undefined) ?? null
    );
  }

  getAttachmentBlob(attachmentId: string): FileBlobRow | null {
    return (
      (this.db
        .prepare(
          'select b.* from attachments a join user_files f on f.id = a.file_id join file_blobs b on b.id = f.blob_id where a.id = ?'
        )
        .get(attachmentId) as FileBlobRow | undefined) ?? null
    );
  }

  listAttachmentsByPost(postId: string): AttachmentRow[] {
    return this.db
      .prepare(
        `select a.id, a.file_id, a.post_id, a.filename, a.mime_type, a.size_bytes,
        coalesce(b.storage_path, a.storage_path) as storage_path, coalesce(b.sha256, a.sha256) as sha256,
        a.created_at, a.deleted_at, a.delete_reason
       from attachments a left join user_files f on f.id = a.file_id left join file_blobs b on b.id = f.blob_id
       where a.post_id = ? order by a.created_at asc`
      )
      .all(postId) as AttachmentRow[];
  }

  listAttachmentsByPostIds(postIds: string[]): Map<string, AttachmentRow[]> {
    const result = new Map<string, AttachmentRow[]>();
    if (!postIds.length) return result;
    const rows = this.db
      .prepare(
        `select a.id, a.file_id, a.post_id, a.filename, a.mime_type, a.size_bytes,
        coalesce(b.storage_path, a.storage_path) as storage_path, coalesce(b.sha256, a.sha256) as sha256,
        a.created_at, a.deleted_at, a.delete_reason
       from attachments a left join user_files f on f.id = a.file_id left join file_blobs b on b.id = f.blob_id
       where a.post_id in (${postIds.map(() => '?').join(', ')}) order by a.created_at asc`
      )
      .all(...postIds) as AttachmentRow[];
    for (const row of rows) result.set(row.post_id, [...(result.get(row.post_id) ?? []), row]);
    return result;
  }

  deleteAttachment(attachmentId: string, reason = 'removed'): void {
    this.db
      .prepare(
        'update attachments set deleted_at = coalesce(deleted_at, ?), delete_reason = coalesce(delete_reason, ?) where id = ?'
      )
      .run(nowIso(), reason, attachmentId);
    this.markUnreferencedBlobsForGc();
  }

  detachPostAttachments(postId: string, reason: string): void {
    this.db
      .prepare(
        'update attachments set deleted_at = coalesce(deleted_at, ?), delete_reason = coalesce(delete_reason, ?) where post_id = ?'
      )
      .run(nowIso(), reason, postId);
    this.markUnreferencedBlobsForGc();
  }

  getAttachmentByStoragePath(storagePath: string): AttachmentRow | null {
    return (
      (this.db
        .prepare(
          `select a.* from attachments a join user_files f on f.id = a.file_id join file_blobs b on b.id = f.blob_id
       where b.storage_path = ? limit 1`
        )
        .get(storagePath) as AttachmentRow | undefined) ?? null
    );
  }

  // User file management

  findUserFileByHash(
    identityId: string,
    sha256: string,
    sizeBytes: number,
    states: readonly ('ready' | 'missing' | 'gc_pending')[] = ['ready']
  ): UserFileRow | null {
    const placeholders = states.map(() => '?').join(', ');
    return (
      (this.db
        .prepare(
          `select f.* from user_files f join file_blobs b on b.id = f.blob_id
       where f.identity_id = ? and b.sha256 = ? and b.size_bytes = ? and b.state in (${placeholders})
       order by f.created_at asc, f.id asc limit 1`
        )
        .get(identityId, sha256, sizeBytes, ...states) as UserFileRow | undefined) ?? null
    );
  }

  createUserFile(input: CreateUserFileInput): UserFileRow {
    const now = nowIso();
    return this.db.transaction(() => {
      const existing = input.sha256
        ? this.findUserFileByHash(input.identityId, input.sha256, input.sizeBytes, ['ready', 'missing', 'gc_pending'])
        : null;
      if (existing) {
        const existingBlob = existing.blob_id
          ? (this.db.prepare('select * from file_blobs where id = ?').get(existing.blob_id) as FileBlobRow | undefined)
          : undefined;
        if (existingBlob?.state === 'gc_pending') {
          this.db
            .prepare("update file_blobs set state = 'ready', updated_at = ? where id = ?")
            .run(now, existingBlob.id);
        } else if (existingBlob?.state === 'missing') {
          const replacementBlobId = randomUUID();
          this.db
            .prepare(
              `insert into file_blobs (id, owner_identity_id, sha256, size_bytes, storage_path, state, created_at, updated_at)
               values (?, ?, ?, ?, ?, 'ready', ?, ?)`
            )
            .run(
              replacementBlobId,
              input.identityId,
              input.sha256 ?? null,
              input.sizeBytes,
              input.storagePath,
              now,
              now
            );
          this.db
            .prepare('update user_files set blob_id = ? where blob_id = ?')
            .run(replacementBlobId, existingBlob.id);
          this.db
            .prepare("update file_blobs set state = 'gc_pending', updated_at = ? where id = ?")
            .run(now, existingBlob.id);
        }
        this.db
          .prepare(
            `update user_files set standalone = 1, visibility = ?, expires_at = ?,
             revision = revision + 1, updated_at = ? where id = ?`
          )
          .run(input.visibility ?? 'private', input.expiresAt ?? null, now, existing.id);
        return this.getUserFile(existing.id)!;
      }
      if (
        input.maxOwnerBytes !== undefined &&
        this.getIdentityBlobBytes(input.identityId) + input.sizeBytes > input.maxOwnerBytes
      ) {
        throw new Error('file quota exceeded');
      }
      const id = randomUUID();
      const blobId = randomUUID();
      this.db
        .prepare(
          `insert into file_blobs (id, owner_identity_id, sha256, size_bytes, storage_path, state, created_at, updated_at)
         values (?, ?, ?, ?, ?, 'ready', ?, ?)`
        )
        .run(blobId, input.identityId, input.sha256 ?? null, input.sizeBytes, input.storagePath, now, now);
      this.db
        .prepare(
          `insert into user_files
         (id, identity_id, blob_id, filename, mime_type, size_bytes, standalone, visibility, expires_at, revision, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?)`
        )
        .run(
          id,
          input.identityId,
          blobId,
          input.filename,
          input.mimeType,
          input.sizeBytes,
          input.visibility ?? 'private',
          input.expiresAt ?? null,
          now,
          now
        );
      return this.getUserFile(id)!;
    })();
  }

  getUserFile(fileId: string): UserFileRow | null {
    return (
      (this.db.prepare('select * from user_files where id = ?').get(fileId) as UserFileRow | undefined) ??
      (this.db
        .prepare('select f.* from user_file_aliases a join user_files f on f.id = a.file_id where a.alias_id = ?')
        .get(fileId) as UserFileRow | undefined) ??
      null
    );
  }

  getUserFileBlob(fileId: string): FileBlobRow | null {
    const file = this.getUserFile(fileId);
    if (!file?.blob_id) return null;
    return (
      (this.db.prepare('select * from file_blobs where id = ?').get(file.blob_id) as FileBlobRow | undefined) ?? null
    );
  }

  hasBlobAtStoragePath(storagePath: string): boolean {
    return Boolean(this.db.prepare('select 1 from file_blobs where storage_path = ? limit 1').get(storagePath));
  }

  hasPendingAttachmentAtStoragePath(storagePath: string): boolean {
    return Boolean(
      this.db.prepare('select 1 from pending_attachments where storage_path = ? limit 1').get(storagePath)
    );
  }

  getIdentityBlobBytes(identityId: string): number {
    const row = this.db
      .prepare(
        "select coalesce(sum(size_bytes), 0) as total from file_blobs where owner_identity_id = ? and state in ('ready','staging')"
      )
      .get(identityId) as { total: number };
    return row.total;
  }

  listUserFilesByIdentity(
    identityId: string,
    filter: 'standalone' | 'all' | 'post_attachments' = 'all',
    page?: { beforeCreatedAt: string; beforeId: string; limit: number }
  ): UserFileRow[] {
    const predicate =
      filter === 'standalone'
        ? 'and f.standalone = 1'
        : filter === 'post_attachments'
          ? 'and exists (select 1 from attachments a where a.file_id = f.id and a.deleted_at is null)'
          : 'and (f.standalone = 1 or exists (select 1 from attachments a where a.file_id = f.id and a.deleted_at is null))';
    const cursor = page ? 'and (f.created_at < ? or (f.created_at = ? and f.id < ?))' : '';
    const limit = page?.limit ?? -1;
    const args: Array<string | number> = [identityId];
    if (page) args.push(page.beforeCreatedAt, page.beforeCreatedAt, page.beforeId);
    args.push(limit);
    return this.db
      .prepare(
        `select f.* from user_files f where f.identity_id = ? ${predicate} ${cursor}
         order by f.created_at desc, f.id desc limit ?`
      )
      .all(...args) as UserFileRow[];
  }

  listFileAssociations(
    fileId: string
  ): Array<AttachmentRow & { topic_id: string; topic_title: string; post_number: number }> {
    const resolved = this.getUserFile(fileId);
    if (!resolved) return [];
    return this.db
      .prepare(
        `select a.*, p.topic_id, t.title as topic_title,
        (select count(*) from posts p2 where p2.topic_id = p.topic_id and p2.rowid <= p.rowid) as post_number
       from attachments a join posts p on p.id = a.post_id join topics t on t.id = p.topic_id
       where a.file_id = ? order by a.created_at asc`
      )
      .all(resolved.id) as Array<AttachmentRow & { topic_id: string; topic_title: string; post_number: number }>;
  }

  updateUserFile(
    fileId: string,
    identityId: string,
    expectedRevision: number,
    visibility: 'private' | 'members' | 'public',
    expiresAt: string | null | undefined
  ): UserFileRow | 'missing' | 'conflict' {
    const file = this.getUserFile(fileId);
    if (!file || file.identity_id !== identityId || !file.standalone) return 'missing';
    if (file.revision !== expectedRevision) return 'conflict';
    this.db
      .prepare(
        `update user_files set visibility = ?, expires_at = case when ? then expires_at else ? end,
         revision = revision + 1, updated_at = ? where id = ?`
      )
      .run(visibility, expiresAt === undefined ? 1 : 0, expiresAt ?? null, nowIso(), file.id);
    return this.getUserFile(file.id)!;
  }

  deleteUserFile(fileId: string, identityId?: string): void {
    const file = this.getUserFile(fileId);
    if (!file) return;
    const suffix = identityId ? ' and identity_id = ?' : '';
    this.db
      .prepare(
        `update user_files set standalone = 0, visibility = null, expires_at = null,
      revision = revision + 1, updated_at = ? where id = ?${suffix}`
      )
      .run(nowIso(), file.id, ...(identityId ? [identityId] : []));
    this.markUnreferencedBlobsForGc();
  }

  expireUserFiles(now: string = nowIso()): number {
    const changed = this.db
      .prepare(
        `update user_files set standalone = 0, visibility = null, expires_at = null, revision = revision + 1, updated_at = ?
       where standalone = 1 and expires_at is not null and expires_at <= ?`
      )
      .run(now, now).changes;
    this.markUnreferencedBlobsForGc();
    return changed;
  }

  markUnreferencedBlobsForGc(): number {
    return this.db
      .prepare(
        `update file_blobs set state = 'gc_pending', updated_at = ? where state in ('ready','missing') and not exists (
        select 1 from user_files f where f.blob_id = file_blobs.id and (f.standalone = 1 or exists (
          select 1 from attachments a where a.file_id = f.id and a.deleted_at is null
        ))
      )`
      )
      .run(nowIso()).changes;
  }

  listReadyBlobs(limit = 50): FileBlobRow[] {
    return this.db
      .prepare("select * from file_blobs where state = 'ready' order by updated_at limit ?")
      .all(limit) as FileBlobRow[];
  }

  touchReadyBlob(blobId: string, now: string = nowIso()): void {
    this.db.prepare("update file_blobs set updated_at = ? where id = ? and state = 'ready'").run(now, blobId);
  }

  listQueuedFileDeletions(limit = 50): Array<{ storage_path: string; reason: string; attempt_count: number }> {
    return this.db
      .prepare('select storage_path, reason, attempt_count from file_deletion_queue order by created_at limit ?')
      .all(limit) as Array<{ storage_path: string; reason: string; attempt_count: number }>;
  }

  completeQueuedFileDeletion(storagePath: string): void {
    this.db.prepare('delete from file_deletion_queue where storage_path = ?').run(storagePath);
  }

  failQueuedFileDeletion(storagePath: string, error: string): void {
    this.db
      .prepare(
        'update file_deletion_queue set attempt_count = attempt_count + 1, last_error = ? where storage_path = ?'
      )
      .run(error.slice(0, 1000), storagePath);
  }

  listUnverifiedBlobs(limit = 10): FileBlobRow[] {
    return this.db
      .prepare("select * from file_blobs where state = 'ready' and sha256 is null order by updated_at limit ?")
      .all(limit) as FileBlobRow[];
  }

  verifyBlob(blobId: string, sha256: string, actualSize: number): void {
    this.db.transaction(() => {
      const blob = this.db.prepare('select * from file_blobs where id = ?').get(blobId) as FileBlobRow | undefined;
      if (!blob || blob.state !== 'ready') return;
      if (blob.size_bytes !== actualSize) {
        this.markBlobMissing(blobId);
        return;
      }
      const duplicate = blob.owner_identity_id
        ? (this.db
            .prepare(
              "select * from file_blobs where id <> ? and owner_identity_id = ? and sha256 = ? and size_bytes = ? and state = 'ready' limit 1"
            )
            .get(blobId, blob.owner_identity_id, sha256, actualSize) as FileBlobRow | undefined)
        : undefined;
      if (duplicate) {
        const files = this.db
          .prepare('select * from user_files where blob_id in (?, ?) order by standalone desc, created_at asc, id asc')
          .all(duplicate.id, blobId) as UserFileRow[];
        const canonical = files[0];
        if (!canonical) return;
        const standaloneFiles = files.filter((file) => Boolean(file.standalone));
        const rank = (visibility: string | null): number =>
          visibility === 'public' ? 3 : visibility === 'members' ? 2 : 1;
        const effectiveVisibility =
          standaloneFiles.map((file) => file.visibility).sort((a, b) => rank(b) - rank(a))[0] ?? null;
        const effectiveExpiry = standaloneFiles.some((file) => file.expires_at === null)
          ? null
          : (standaloneFiles
              .map((file) => file.expires_at)
              .filter((value): value is string => Boolean(value))
              .sort()
              .at(-1) ?? null);
        this.db
          .prepare(
            `update user_files set blob_id = ?, standalone = ?, visibility = ?, expires_at = ?,
             revision = revision + 1, updated_at = ? where id = ?`
          )
          .run(
            duplicate.id,
            standaloneFiles.length > 0 ? 1 : 0,
            standaloneFiles.length > 0 ? effectiveVisibility : null,
            standaloneFiles.length > 0 ? effectiveExpiry : null,
            nowIso(),
            canonical.id
          );
        for (const loser of files.slice(1)) {
          this.db.prepare('update attachments set file_id = ? where file_id = ?').run(canonical.id, loser.id);
          this.db.prepare('update user_file_aliases set file_id = ? where file_id = ?').run(canonical.id, loser.id);
          this.db
            .prepare(
              'insert into user_file_aliases (alias_id, file_id, created_at) values (?, ?, ?) on conflict(alias_id) do update set file_id = excluded.file_id'
            )
            .run(loser.id, canonical.id, nowIso());
          this.db.prepare('delete from user_files where id = ?').run(loser.id);
        }
        this.db
          .prepare("update file_blobs set state = 'gc_pending', updated_at = ? where id = ?")
          .run(nowIso(), blobId);
      } else {
        this.db.prepare('update file_blobs set sha256 = ?, updated_at = ? where id = ?').run(sha256, nowIso(), blobId);
      }
    })();
  }

  listGcPendingBlobs(limit = 50): FileBlobRow[] {
    return this.db
      .prepare("select * from file_blobs where state = 'gc_pending' order by updated_at limit ?")
      .all(limit) as FileBlobRow[];
  }

  claimBlobForGc(blobId: string): string | null {
    return this.db.transaction(() => {
      const blob = this.db.prepare("select * from file_blobs where id = ? and state = 'gc_pending'").get(blobId) as
        FileBlobRow | undefined;
      if (!blob) return null;
      const referenced = this.db
        .prepare(
          `select 1 from user_files f where f.blob_id = ? and (f.standalone = 1 or exists (
             select 1 from attachments a where a.file_id = f.id and a.deleted_at is null
           )) limit 1`
        )
        .get(blobId);
      if (referenced) {
        this.db.prepare("update file_blobs set state = 'ready', updated_at = ? where id = ?").run(nowIso(), blobId);
        return null;
      }
      this.db
        .prepare(
          `insert into file_deletion_queue (storage_path, reason, created_at)
           values (?, 'unreferenced_blob', ?)
           on conflict(storage_path) do nothing`
        )
        .run(blob.storage_path, nowIso());
      this.db.prepare('update user_files set blob_id = null where blob_id = ?').run(blobId);
      this.db.prepare('delete from file_blobs where id = ?').run(blobId);
      return blob.storage_path;
    })();
  }

  restoreBlob(input: { blobId: string; storagePath: string; sha256: string | null; sizeBytes: number }): void {
    this.db.transaction(() => {
      const existing = this.db.prepare('select storage_path from file_blobs where id = ?').get(input.blobId) as
        { storage_path: string } | undefined;
      if (!existing) return;
      this.db
        .prepare(
          `update file_blobs set storage_path = ?, sha256 = ?, size_bytes = ?, state = 'ready', updated_at = ?
           where id = ?`
        )
        .run(input.storagePath, input.sha256, input.sizeBytes, nowIso(), input.blobId);
      // A repaired shared path must not remain eligible for an older queued
      // deletion from an interrupted cleanup cycle.
      this.db
        .prepare('delete from file_deletion_queue where storage_path in (?, ?)')
        .run(existing.storage_path, input.storagePath);
    })();
  }

  markBlobMissing(blobId: string): void {
    this.db.prepare("update file_blobs set state = 'missing', updated_at = ? where id = ?").run(nowIso(), blobId);
  }

  // Reaction management

  addReaction(postId: string, identityId: string, emoji: string): ReactionRow {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare('insert or ignore into reactions (id, post_id, identity_id, emoji, created_at) values (?, ?, ?, ?, ?)')
      .run(id, postId, identityId, emoji, now);
    // Fetch the actual row (may be existing or newly created)
    const row = this.db
      .prepare('select * from reactions where post_id = ? and identity_id = ? and emoji = ?')
      .get(postId, identityId, emoji) as ReactionRow;
    return row;
  }

  removeReaction(postId: string, identityId: string, emoji: string): void {
    this.db
      .prepare('delete from reactions where post_id = ? and identity_id = ? and emoji = ?')
      .run(postId, identityId, emoji);
  }

  listReactionsByPost(postId: string): ReactionRow[] {
    return this.db
      .prepare('select * from reactions where post_id = ? order by created_at asc')
      .all(postId) as ReactionRow[];
  }

  getReactionCounts(postId: string): ReactionCount[] {
    return this.db
      .prepare('select emoji, count(*) as count from reactions where post_id = ? group by emoji')
      .all(postId) as ReactionCount[];
  }

  getReactionCountsForPosts(postIds: string[]): Map<string, ReactionCount[]> {
    if (postIds.length === 0) {
      return new Map();
    }
    const placeholders = postIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `select post_id, emoji, count(*) as count from reactions where post_id in (${placeholders}) group by post_id, emoji`
      )
      .all(...postIds) as Array<{ post_id: string; emoji: string; count: number }>;

    const result = new Map<string, ReactionCount[]>();
    for (const row of rows) {
      const counts = result.get(row.post_id) ?? [];
      counts.push({ emoji: row.emoji, count: row.count });
      result.set(row.post_id, counts);
    }
    return result;
  }

  // Tenant management

  createTenant(name: string, slug: string, settings: Record<string, unknown> = {}): TenantRow {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare('insert into tenants (id, name, slug, settings_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?)')
      .run(id, name, slug, JSON.stringify(settings), now, now);
    return this.getTenant(id) as TenantRow;
  }

  getTenant(tenantId: string): TenantRow | null {
    const row = this.db.prepare('select * from tenants where id = ?').get(tenantId) as TenantRow | undefined;
    return row ?? null;
  }

  getTenantBySlug(slug: string): TenantRow | null {
    const row = this.db.prepare('select * from tenants where slug = ?').get(slug) as TenantRow | undefined;
    return row ?? null;
  }

  listTenants(): TenantRow[] {
    return this.db.prepare('select * from tenants order by created_at asc').all() as TenantRow[];
  }

  updateTenant(tenantId: string, updates: { name?: string; settings?: Record<string, unknown> }): TenantRow {
    const existing = this.getTenant(tenantId);
    if (!existing) {
      throw new Error('tenant not found');
    }
    const now = nowIso();
    const name = updates.name ?? existing.name;
    const settings = updates.settings ? JSON.stringify(updates.settings) : existing.settings_json;
    this.db
      .prepare('update tenants set name = ?, settings_json = ?, updated_at = ? where id = ?')
      .run(name, settings, now, tenantId);
    return this.getTenant(tenantId) as TenantRow;
  }

  deleteTenant(tenantId: string): void {
    this.db.prepare('delete from identity_roles where tenant_id = ?').run(tenantId);
    this.db.prepare('delete from roles where tenant_id = ?').run(tenantId);
    this.db.prepare('delete from tenants where id = ?').run(tenantId);
  }

  // Role management

  createRole(name: string, permissions: string[], tenantId?: string | null): RoleRow {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare('insert into roles (id, tenant_id, name, permissions_json, created_at) values (?, ?, ?, ?, ?)')
      .run(id, tenantId ?? null, name, JSON.stringify(permissions), now);
    return this.getRole(id) as RoleRow;
  }

  getRole(roleId: string): RoleRow | null {
    const row = this.db.prepare('select * from roles where id = ?').get(roleId) as RoleRow | undefined;
    return row ?? null;
  }

  getRoleByName(name: string, tenantId?: string | null): RoleRow | null {
    const row = this.db
      .prepare('select * from roles where name = ? and (tenant_id = ? or (tenant_id is null and ? is null))')
      .get(name, tenantId ?? null, tenantId ?? null) as RoleRow | undefined;
    return row ?? null;
  }

  listRoles(tenantId?: string | null): RoleRow[] {
    if (tenantId) {
      return this.db
        .prepare('select * from roles where tenant_id = ? or tenant_id is null order by created_at asc')
        .all(tenantId) as RoleRow[];
    }
    return this.db.prepare('select * from roles order by created_at asc').all() as RoleRow[];
  }

  updateRole(roleId: string, updates: { name?: string; permissions?: string[] }): RoleRow {
    const existing = this.getRole(roleId);
    if (!existing) {
      throw new Error('role not found');
    }
    const name = updates.name ?? existing.name;
    const permissions = updates.permissions ? JSON.stringify(updates.permissions) : existing.permissions_json;
    this.db.prepare('update roles set name = ?, permissions_json = ? where id = ?').run(name, permissions, roleId);
    return this.getRole(roleId) as RoleRow;
  }

  deleteRole(roleId: string): void {
    this.db.prepare('delete from identity_roles where role_id = ?').run(roleId);
    this.db.prepare('delete from roles where id = ?').run(roleId);
  }

  // Identity-Role assignment

  assignRole(identityId: string, roleId: string, tenantId?: string | null): IdentityRoleRow {
    const now = nowIso();
    this.db
      .prepare('insert or ignore into identity_roles (identity_id, role_id, tenant_id, created_at) values (?, ?, ?, ?)')
      .run(identityId, roleId, tenantId ?? null, now);
    return this.getIdentityRole(identityId, roleId, tenantId) as IdentityRoleRow;
  }

  revokeRole(identityId: string, roleId: string, tenantId?: string | null): void {
    this.db
      .prepare(
        'delete from identity_roles where identity_id = ? and role_id = ? and (tenant_id = ? or (tenant_id is null and ? is null))'
      )
      .run(identityId, roleId, tenantId ?? null, tenantId ?? null);
  }

  getIdentityRole(identityId: string, roleId: string, tenantId?: string | null): IdentityRoleRow | null {
    const row = this.db
      .prepare(
        'select * from identity_roles where identity_id = ? and role_id = ? and (tenant_id = ? or (tenant_id is null and ? is null))'
      )
      .get(identityId, roleId, tenantId ?? null, tenantId ?? null) as IdentityRoleRow | undefined;
    return row ?? null;
  }

  listIdentityRoles(identityId: string, tenantId?: string | null): RoleRow[] {
    if (tenantId) {
      return this.db
        .prepare(
          `select r.* from roles r
           join identity_roles ir on ir.role_id = r.id
           where ir.identity_id = ? and (ir.tenant_id = ? or ir.tenant_id is null)`
        )
        .all(identityId, tenantId) as RoleRow[];
    }
    return this.db
      .prepare(
        `select r.* from roles r
         join identity_roles ir on ir.role_id = r.id
         where ir.identity_id = ?`
      )
      .all(identityId) as RoleRow[];
  }

  getIdentityPermissions(identityId: string, tenantId?: string | null): string[] {
    const roles = this.listIdentityRoles(identityId, tenantId);
    const permissionSet = new Set<string>();
    for (const role of roles) {
      const permissions = JSON.parse(role.permissions_json) as string[];
      for (const perm of permissions) {
        permissionSet.add(perm);
      }
    }
    return Array.from(permissionSet);
  }

  hasPermission(identityId: string, permission: string, tenantId?: string | null): boolean {
    const permissions = this.getIdentityPermissions(identityId, tenantId);
    return permissions.includes(permission) || permissions.includes('*');
  }

  // Access rules (forum/topic ACLs)

  listAccessRules(scopeKind: AccessRuleScopeKind, scopeId: string): AccessRuleRow[] {
    return this.db
      .prepare('select * from access_rules where scope_kind = ? and scope_id = ? order by created_at asc')
      .all(scopeKind, scopeId) as AccessRuleRow[];
  }

  createAccessRule(input: {
    scopeKind: AccessRuleScopeKind;
    scopeId: string;
    principalKind: AccessRulePrincipalKind;
    principalId?: string | null;
    action: AccessRuleAction;
    effect: AccessRuleEffect;
  }): AccessRuleRow {
    const id = randomUUID();
    const now = nowIso();
    const principalId = input.principalId ?? null;
    this.db
      .prepare(
        `insert into access_rules (id, scope_kind, scope_id, principal_kind, principal_id, action, effect, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(scope_kind, scope_id, principal_kind, principal_id, action)
       do update set effect = excluded.effect, created_at = excluded.created_at`
      )
      .run(id, input.scopeKind, input.scopeId, input.principalKind, principalId, input.action, input.effect, now);
    const row = this.db
      .prepare(
        `select * from access_rules
       where scope_kind = ?
         and scope_id = ?
         and principal_kind = ?
         and (principal_id = ? or (principal_id is null and ? is null))
         and action = ?`
      )
      .get(input.scopeKind, input.scopeId, input.principalKind, principalId, principalId, input.action) as
      AccessRuleRow | undefined;
    if (!row) {
      throw new Error('access rule not found');
    }
    return row;
  }

  deleteAccessRule(ruleId: string): boolean {
    const result = this.db.prepare('delete from access_rules where id = ?').run(ruleId);
    return result.changes > 0;
  }

  // Chat management

  listChatCategories(): ChatCategoryRow[] {
    return this.db.prepare('select * from chat_categories order by created_at asc').all() as ChatCategoryRow[];
  }

  listChatCategoriesWithCounts(): ChatCategorySummaryRow[] {
    return this.db
      .prepare(
        `select c.*, count(r.id) as room_count
         from chat_categories c
         left join chat_rooms r on r.category_id = c.id
         group by c.id
         order by c.created_at asc`
      )
      .all() as ChatCategorySummaryRow[];
  }

  getChatCategory(categoryId: string): ChatCategoryRow | null {
    const row = this.db.prepare('select * from chat_categories where id = ?').get(categoryId) as
      ChatCategoryRow | undefined;
    return row ?? null;
  }

  createChatCategory(input: {
    name: string;
    description?: string | null;
    visibility?: ForumVisibility;
  }): ChatCategoryRow {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'insert into chat_categories (id, name, description, visibility, created_at, updated_at) values (?, ?, ?, ?, ?, ?)'
      )
      .run(id, input.name, input.description ?? null, input.visibility ?? 'members', now, now);
    return this.getChatCategory(id) as ChatCategoryRow;
  }

  listChatRooms(categoryId: string): ChatRoomRow[] {
    return this.db
      .prepare('select * from chat_rooms where category_id = ? order by name asc')
      .all(categoryId) as ChatRoomRow[];
  }

  getChatRoom(roomId: string): ChatRoomRow | null {
    const row = this.db.prepare('select * from chat_rooms where id = ?').get(roomId) as ChatRoomRow | undefined;
    return row ?? null;
  }

  getChatRoomByName(categoryId: string, name: string): ChatRoomRow | null {
    const row = this.db
      .prepare('select * from chat_rooms where category_id = ? and lower(name) = lower(?) limit 1')
      .get(categoryId, name) as ChatRoomRow | undefined;
    return row ?? null;
  }

  createChatRoom(input: {
    categoryId: string;
    name: string;
    topic?: string | null;
    visibility?: ForumVisibility;
  }): ChatRoomRow {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `insert into chat_rooms
         (id, category_id, name, topic, status, visibility, message_count, last_message_at, last_message_author_name, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.categoryId,
        input.name,
        input.topic ?? null,
        'open',
        input.visibility ?? 'members',
        0,
        null,
        null,
        now,
        now
      );
    return this.getChatRoom(id) as ChatRoomRow;
  }

  listChatMessages(roomId: string, limit: number, beforeMessageId?: string | null): ChatMessageRow[] {
    const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    let beforeRowId = Number.MAX_SAFE_INTEGER;
    if (beforeMessageId) {
      const row = this.db
        .prepare('select rowid as rowid from chat_messages where id = ? and room_id = ?')
        .get(beforeMessageId, roomId) as { rowid: number } | undefined;
      if (row?.rowid) {
        beforeRowId = row.rowid;
      }
    }
    const now = nowIso();
    return this.db
      .prepare(
        `select
          id,
          room_id,
          author_id,
          author_name,
          author_avatar_url,
          body,
          created_at,
          edited_at,
          expires_at
        from chat_messages
        where room_id = ? and rowid < ? and (expires_at is null or expires_at > ?)
        order by rowid desc
        limit ?`
      )
      .all(roomId, beforeRowId, now, safeLimit) as ChatMessageRow[];
  }

  listChatMessagesAfter(roomId: string, limit: number, afterMessageId: string): ChatMessageRow[] | null {
    const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const row = this.db
      .prepare('select rowid as rowid from chat_messages where id = ? and room_id = ?')
      .get(afterMessageId, roomId) as { rowid: number } | undefined;
    if (!row?.rowid) {
      return null;
    }
    const afterRowId = row.rowid;
    const now = nowIso();
    return this.db
      .prepare(
        `select
          id,
          room_id,
          author_id,
          author_name,
          author_avatar_url,
          body,
          created_at,
          edited_at,
          expires_at
        from chat_messages
        where room_id = ? and rowid > ? and (expires_at is null or expires_at > ?)
        order by rowid asc
        limit ?`
      )
      .all(roomId, afterRowId, now, safeLimit) as ChatMessageRow[];
  }

  createChatMessage(input: {
    roomId: string;
    authorId: string;
    authorName: string;
    authorAvatarUrl?: string | null;
    body: string;
    expiresAt?: string | null;
  }): ChatMessageRow {
    const id = randomUUID();
    const now = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          'insert into chat_messages (id, room_id, author_id, author_name, author_avatar_url, body, created_at, edited_at, expires_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          id,
          input.roomId,
          input.authorId,
          input.authorName,
          input.authorAvatarUrl ?? null,
          input.body,
          now,
          null,
          input.expiresAt ?? null
        );
      this.db
        .prepare(
          'update chat_rooms set message_count = message_count + 1, last_message_at = ?, last_message_author_name = ?, updated_at = ? where id = ?'
        )
        .run(now, input.authorName, now, input.roomId);
    })();
    const row = this.db.prepare('select * from chat_messages where id = ?').get(id) as ChatMessageRow | undefined;
    if (!row) {
      throw new Error('chat message not found');
    }
    return row;
  }

  cleanupExpiredChatMessages(): { deleted: number; expiredMessages: Array<{ id: string; roomId: string }> } {
    const now = nowIso();
    const expired = this.db
      .prepare('select id, room_id from chat_messages where expires_at is not null and expires_at <= ?')
      .all(now) as Array<{ id: string; room_id: string }>;
    if (!expired.length) {
      return { deleted: 0, expiredMessages: [] };
    }
    this.db.transaction(() => {
      this.db.prepare('delete from chat_messages where expires_at is not null and expires_at <= ?').run(now);

      const affectedRooms = Array.from(new Set(expired.map((row) => row.room_id)));
      const updateRoom = this.db.prepare(
        'update chat_rooms set message_count = ?, last_message_at = ?, last_message_author_name = ?, updated_at = ? where id = ?'
      );
      const countQuery = this.db.prepare('select count(*) as count from chat_messages where room_id = ?');
      const lastQuery = this.db.prepare(
        'select author_name, created_at from chat_messages where room_id = ? order by rowid desc limit 1'
      );
      for (const roomId of affectedRooms) {
        const countRow = countQuery.get(roomId) as { count: number } | undefined;
        const lastRow = lastQuery.get(roomId) as { author_name: string; created_at: string } | undefined;
        updateRoom.run(countRow?.count ?? 0, lastRow?.created_at ?? null, lastRow?.author_name ?? null, now, roomId);
      }
    })();

    return {
      deleted: expired.length,
      expiredMessages: expired.map((row) => ({ id: row.id, roomId: row.room_id })),
    };
  }

  // Tenant-scoped queries (for multi-tenancy enforcement)

  listForumsByTenant(tenantId: string | null): ForumRow[] {
    if (tenantId === null) {
      return this.db
        .prepare('select * from forums where tenant_id is null order by created_at asc')
        .all() as ForumRow[];
    }
    return this.db
      .prepare('select * from forums where tenant_id = ? order by created_at asc')
      .all(tenantId) as ForumRow[];
  }

  listTopicsByTenant(forumId: string, tenantId: string | null, page = 1, pageSize = 50): TopicRow[] {
    const offset = (page - 1) * pageSize;
    if (tenantId === null) {
      return this.db
        .prepare(
          'select * from topics where forum_id = ? and tenant_id is null order by created_at desc limit ? offset ?'
        )
        .all(forumId, pageSize, offset) as TopicRow[];
    }
    return this.db
      .prepare('select * from topics where forum_id = ? and tenant_id = ? order by created_at desc limit ? offset ?')
      .all(forumId, tenantId, pageSize, offset) as TopicRow[];
  }

  listPostsByTenant(topicId: string, tenantId: string | null, page = 1, pageSize = 200): PostRow[] {
    const offset = (page - 1) * pageSize;
    if (tenantId === null) {
      return this.db
        .prepare(
          'select * from posts where topic_id = ? and tenant_id is null order by created_at asc limit ? offset ?'
        )
        .all(topicId, pageSize, offset) as PostRow[];
    }
    return this.db
      .prepare('select * from posts where topic_id = ? and tenant_id = ? order by created_at asc limit ? offset ?')
      .all(topicId, tenantId, pageSize, offset) as PostRow[];
  }

  // Webhook management

  createWebhook(url: string, secret: string, events: string[]): WebhookRow {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'insert into webhooks (id, url, secret, events, enabled, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, url, secret, JSON.stringify(events), 1, now, now);
    return this.getWebhook(id) as WebhookRow;
  }

  getWebhook(id: string): WebhookRow | null {
    const row = this.db.prepare('select * from webhooks where id = ?').get(id) as WebhookRow | undefined;
    return row ?? null;
  }

  listWebhooks(): WebhookRow[] {
    return this.db.prepare('select * from webhooks order by created_at desc').all() as WebhookRow[];
  }

  updateWebhook(
    id: string,
    updates: { url?: string; secret?: string; events?: string[]; enabled?: boolean }
  ): WebhookRow {
    const existing = this.getWebhook(id);
    if (!existing) {
      throw new Error('webhook not found');
    }
    const now = nowIso();
    const url = updates.url ?? existing.url;
    const secret = updates.secret ?? existing.secret;
    const events = updates.events ? JSON.stringify(updates.events) : existing.events;
    const enabled = updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : existing.enabled;

    this.db
      .prepare('update webhooks set url = ?, secret = ?, events = ?, enabled = ?, updated_at = ? where id = ?')
      .run(url, secret, events, enabled, now, id);
    return this.getWebhook(id) as WebhookRow;
  }

  deleteWebhook(id: string): void {
    this.db.prepare('delete from webhooks where id = ?').run(id);
  }

  listWebhooksForEvent(eventType: string): WebhookRow[] {
    const allWebhooks = this.db.prepare('select * from webhooks where enabled = 1').all() as WebhookRow[];

    return allWebhooks.filter((webhook) => {
      const events = JSON.parse(webhook.events) as string[];
      return events.includes(eventType) || events.includes('*');
    });
  }

  // Auth session management (persistent sessions)

  createAuthSession(
    token: string,
    identityId: string,
    ttlDays: number = ACCESS_TOKEN_TTL_DAYS,
    authMethod: AuthSessionRow['auth_method'] = 'internal'
  ): AuthSessionRow {
    const now = nowIso();
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
    const tokenHash = hashToken(token);
    this.db
      .prepare(
        'insert into auth_sessions (token_hash, identity_id, auth_method, authenticated_at, created_at, expires_at) values (?, ?, ?, ?, ?, ?)'
      )
      .run(tokenHash, identityId, authMethod, now, now, expiresAt);
    return {
      token_hash: tokenHash,
      identity_id: identityId,
      auth_method: authMethod,
      authenticated_at: now,
      created_at: now,
      expires_at: expiresAt,
    };
  }

  getAuthSession(token: string): AuthSessionRow | null {
    const row = this.db
      .prepare('select * from auth_sessions where token_hash = ? and expires_at > ?')
      .get(hashToken(token), nowIso()) as AuthSessionRow | undefined;
    return row ?? null;
  }

  deleteAuthSession(token: string): void {
    this.db.prepare('delete from auth_sessions where token_hash = ?').run(hashToken(token));
  }

  deleteAuthSessionByHash(tokenHash: string): void {
    this.db.prepare('delete from auth_sessions where token_hash = ?').run(tokenHash);
  }

  deleteAuthSessionsForIdentity(identityId: string, exceptTokenHash?: string | null): void {
    if (exceptTokenHash) {
      this.db
        .prepare('delete from auth_sessions where identity_id = ? and token_hash <> ?')
        .run(identityId, exceptTokenHash);
      return;
    }
    this.db.prepare('delete from auth_sessions where identity_id = ?').run(identityId);
  }

  cleanupExpiredAuthSessions(): number {
    const result = this.db.prepare('delete from auth_sessions where expires_at <= ?').run(nowIso());
    return result.changes;
  }

  createWebAuthnChallenge(input: {
    challenge: string;
    ceremony: WebAuthnChallengeRow['ceremony'];
    identityId: string | null;
    ttlMs?: number;
  }): WebAuthnChallengeRow {
    const id = randomUUID();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + (input.ttlMs ?? 5 * 60_000)).toISOString();
    const row = {
      id,
      challenge: input.challenge,
      ceremony: input.ceremony,
      identity_id: input.identityId,
      expires_at: expiresAt,
      created_at: createdAt,
    };
    this.db.transaction(() => {
      this.db.prepare('delete from webauthn_challenges where expires_at <= ?').run(createdAt);
      if (input.identityId) {
        const maxIdentityChallenges = 20;
        const identityCount = (
          this.db
            .prepare('select count(*) as count from webauthn_challenges where identity_id = ? and ceremony = ?')
            .get(input.identityId, input.ceremony) as { count: number }
        ).count;
        if (identityCount >= maxIdentityChallenges) {
          this.db
            .prepare(
              `delete from webauthn_challenges where id in (
                 select id from webauthn_challenges
                 where identity_id = ? and ceremony = ?
                 order by created_at asc, id asc limit ?
               )`
            )
            .run(input.identityId, input.ceremony, identityCount - maxIdentityChallenges + 1);
        }
      }
      const maxChallenges = 10_000;
      const count = (this.db.prepare('select count(*) as count from webauthn_challenges').get() as { count: number })
        .count;
      if (count >= maxChallenges) {
        this.db
          .prepare(
            `delete from webauthn_challenges where id in (
               select id from webauthn_challenges order by created_at asc, id asc limit ?
             )`
          )
          .run(count - maxChallenges + 1);
      }
      this.db
        .prepare(
          'insert into webauthn_challenges (id, challenge, ceremony, identity_id, expires_at, created_at) values (?, ?, ?, ?, ?, ?)'
        )
        .run(id, input.challenge, input.ceremony, input.identityId, expiresAt, createdAt);
    })();
    return row;
  }

  consumeWebAuthnChallenge(
    id: string,
    ceremony: WebAuthnChallengeRow['ceremony'],
    identityId: string | null
  ): WebAuthnChallengeRow | null {
    return this.db.transaction(() => {
      const row = this.db.prepare('select * from webauthn_challenges where id = ?').get(id) as
        WebAuthnChallengeRow | undefined;
      if (!row) return null;
      this.db.prepare('delete from webauthn_challenges where id = ?').run(id);
      if (row.ceremony !== ceremony || row.identity_id !== identityId || row.expires_at <= nowIso()) return null;
      return row;
    })();
  }

  cleanupExpiredWebAuthnChallenges(): number {
    return this.db.prepare('delete from webauthn_challenges where expires_at <= ?').run(nowIso()).changes;
  }

  createWebAuthnCredential(input: {
    credentialId: string;
    identityId: string;
    name: string;
    publicKey: Uint8Array;
    counter: number;
    transports: string[];
    deviceType: string;
    backedUp: boolean;
  }): WebAuthnCredentialRow {
    const now = nowIso();
    this.db
      .prepare(
        `insert into webauthn_credentials
       (credential_id, identity_id, name, public_key, counter, transports_json, device_type, backed_up, created_at, last_used_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?)`
      )
      .run(
        input.credentialId,
        input.identityId,
        input.name,
        Buffer.from(input.publicKey),
        input.counter,
        JSON.stringify(input.transports),
        input.deviceType,
        input.backedUp ? 1 : 0,
        now,
        now
      );
    return this.getWebAuthnCredential(input.credentialId) as WebAuthnCredentialRow;
  }

  getWebAuthnCredential(credentialId: string): WebAuthnCredentialRow | null {
    return (
      (this.db.prepare('select * from webauthn_credentials where credential_id = ?').get(credentialId) as
        WebAuthnCredentialRow | undefined) ?? null
    );
  }

  listWebAuthnCredentials(identityId: string): WebAuthnCredentialRow[] {
    return this.db
      .prepare('select * from webauthn_credentials where identity_id = ? order by created_at')
      .all(identityId) as WebAuthnCredentialRow[];
  }

  updateWebAuthnCredentialUsage(credentialId: string, counter: number, deviceType: string, backedUp: boolean): void {
    const now = nowIso();
    this.db
      .prepare(
        'update webauthn_credentials set counter = ?, device_type = ?, backed_up = ?, last_used_at = ?, updated_at = ? where credential_id = ?'
      )
      .run(counter, deviceType, backedUp ? 1 : 0, now, now, credentialId);
  }

  deleteWebAuthnCredential(identityId: string, credentialId: string): boolean {
    return (
      this.db
        .prepare('delete from webauthn_credentials where identity_id = ? and credential_id = ?')
        .run(identityId, credentialId).changes > 0
    );
  }

  countWebAuthnCredentials(identityId: string): number {
    return (
      this.db.prepare('select count(*) as count from webauthn_credentials where identity_id = ?').get(identityId) as {
        count: number;
      }
    ).count;
  }

  hasWebAuthnAdmin(): boolean {
    return Boolean(
      this.db
        .prepare(
          `select 1 from webauthn_credentials c join identities i on i.id = c.identity_id where i.kind = 'admin' limit 1`
        )
        .get()
    );
  }

  // API key management

  createApiKey(input: {
    identityId: string;
    label: string;
    tokenHash: string;
    tokenPrefix: string;
    scopes: string[];
    expiresAt?: string | null;
  }): ApiKeyRecord {
    const id = randomUUID();
    const now = nowIso();
    const scopesJson = JSON.stringify(input.scopes);
    this.db
      .prepare(
        'insert into api_keys (id, identity_id, label, token_hash, token_prefix, scopes_json, last_used_at, expires_at, created_at, revoked_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        input.identityId,
        input.label,
        input.tokenHash,
        input.tokenPrefix,
        scopesJson,
        null,
        input.expiresAt ?? null,
        now,
        null
      );
    return {
      id,
      identityId: input.identityId,
      label: input.label,
      tokenPrefix: input.tokenPrefix,
      scopes: input.scopes,
      lastUsedAt: null,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      revokedAt: null,
    };
  }

  listApiKeys(identityId: string): ApiKeyRecord[] {
    const rows = this.db
      .prepare('select * from api_keys where identity_id = ? order by created_at desc')
      .all(identityId) as ApiKeyRow[];
    return rows.map((row) => ({
      id: row.id,
      identityId: row.identity_id,
      label: row.label,
      tokenPrefix: row.token_prefix,
      scopes: JSON.parse(row.scopes_json) as string[],
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    }));
  }

  getApiKeyByHash(tokenHash: string): ApiKeyRow | null {
    const row = this.db.prepare('select * from api_keys where token_hash = ?').get(tokenHash) as ApiKeyRow | undefined;
    return row ?? null;
  }

  touchApiKeyLastUsed(id: string): void {
    this.db.prepare('update api_keys set last_used_at = ? where id = ?').run(nowIso(), id);
  }

  revokeApiKey(identityId: string, id: string): boolean {
    const now = nowIso();
    const result = this.db
      .prepare('update api_keys set revoked_at = ? where id = ? and identity_id = ? and revoked_at is null')
      .run(now, id, identityId);
    return result.changes > 0;
  }

  // Impersonation token management

  createImpersonatedIdentity(ownerIdentityId: string, displayName: string, avatarUrl?: string | null): IdentityRow {
    return this.createIdentity(displayName.trim(), 'persona', avatarUrl ?? null, ownerIdentityId);
  }

  createImpersonationToken(input: {
    ownerIdentityId: string;
    impersonatedIdentityId: string;
    label: string;
    tokenHash: string;
    tokenPrefix: string;
    scopes: string[];
    expiresAt?: string | null;
  }): ImpersonationTokenRecord {
    const id = randomUUID();
    const now = nowIso();
    const scopesJson = JSON.stringify(input.scopes);
    this.db
      .prepare(
        'insert into impersonation_tokens (id, owner_identity_id, impersonated_identity_id, label, token_hash, token_prefix, scopes_json, last_used_at, expires_at, created_at, revoked_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        input.ownerIdentityId,
        input.impersonatedIdentityId,
        input.label,
        input.tokenHash,
        input.tokenPrefix,
        scopesJson,
        null,
        input.expiresAt ?? null,
        now,
        null
      );
    const identity = this.getIdentity(input.impersonatedIdentityId);
    return {
      id,
      ownerIdentityId: input.ownerIdentityId,
      impersonatedIdentityId: input.impersonatedIdentityId,
      label: input.label,
      tokenPrefix: input.tokenPrefix,
      scopes: input.scopes,
      impersonatedDisplayName: identity?.display_name ?? 'Unknown',
      impersonatedAvatarUrl: identity?.avatar_url ?? null,
      lastUsedAt: null,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      revokedAt: null,
    };
  }

  listImpersonationTokens(ownerIdentityId: string): ImpersonationTokenRecord[] {
    const rows = this.db
      .prepare(
        `select it.*, i.display_name as impersonated_display_name, i.avatar_url as impersonated_avatar_url
         from impersonation_tokens it
         join identities i on i.id = it.impersonated_identity_id
         where it.owner_identity_id = ?
         order by it.created_at desc`
      )
      .all(ownerIdentityId) as Array<
      ImpersonationTokenRow & { impersonated_display_name: string; impersonated_avatar_url: string | null }
    >;
    return rows.map((row) => ({
      id: row.id,
      ownerIdentityId: row.owner_identity_id,
      impersonatedIdentityId: row.impersonated_identity_id,
      label: row.label,
      tokenPrefix: row.token_prefix,
      scopes: JSON.parse(row.scopes_json) as string[],
      impersonatedDisplayName: row.impersonated_display_name,
      impersonatedAvatarUrl: row.impersonated_avatar_url,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    }));
  }

  getImpersonationTokenByHash(tokenHash: string): ImpersonationTokenRow | null {
    const row = this.db.prepare('select * from impersonation_tokens where token_hash = ?').get(tokenHash) as
      ImpersonationTokenRow | undefined;
    return row ?? null;
  }

  touchImpersonationTokenLastUsed(id: string): void {
    this.db.prepare('update impersonation_tokens set last_used_at = ? where id = ?').run(nowIso(), id);
  }

  revokeImpersonationToken(ownerIdentityId: string, id: string): boolean {
    const now = nowIso();
    const result = this.db
      .prepare(
        'update impersonation_tokens set revoked_at = ? where id = ? and owner_identity_id = ? and revoked_at is null'
      )
      .run(now, id, ownerIdentityId);
    return result.changes > 0;
  }

  // System Settings

  getSystemSetting(key: string): string | null {
    const row = this.db.prepare('select value from system_settings where key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  setSystemSetting(key: string, value: string): void {
    const now = nowIso();
    this.db
      .prepare(
        'insert into system_settings (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at'
      )
      .run(key, value, now);
  }
}

function normalizeTamperDirection(value: string | null | undefined): 'inbound' | 'outbound' | 'both' | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'inbound' || normalized === 'outbound' || normalized === 'both') {
    return normalized;
  }
  return null;
}

function pickTamperConfigByDirection(candidates: TamperConfigRow[], direction: string): TamperConfigRow | null {
  if (candidates.length === 0) return null;
  const desired = normalizeTamperDirection(direction);
  if (!desired) return candidates[0] ?? null;
  const exact = candidates.find((row) => normalizeTamperDirection(row.direction) === desired);
  if (exact) return exact;
  const both = candidates.find((row) => normalizeTamperDirection(row.direction) === 'both');
  if (both) return both;
  const fallback = candidates.find((row) => normalizeTamperDirection(row.direction) === null);
  return fallback ?? null;
}
