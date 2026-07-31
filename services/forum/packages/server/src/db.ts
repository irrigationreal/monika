import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from './migrations';

import type {
  AccessRuleAction,
  AccessRuleEffect,
  AccessRulePrincipalKind,
  AccessRuleScopeKind,
} from '@irrigationreal/codex-forum-core';

export interface DbConfig {
  path: string;
}

export interface DbContext {
  db: Database.Database;
}

export interface ForumRow {
  id: string;
  tenant_id: string | null;
  parent_forum_id: string | null;
  category: string | null;
  name: string;
  description: string | null;
  cwd: string | null;
  pre_prompt: string | null;
  status: string;
  visibility: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TopicRow {
  id: string;
  forum_id: string;
  tenant_id: string | null;
  title: string;
  status: string;
  tags_json: string;
  robot_mode: string;
  auto_compact_enabled: number;
  auto_compact_revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface TopicMoveRow {
  id: string;
  topic_id: string;
  from_forum_id: string;
  to_forum_id: string;
  moved_by: string;
  moved_at: string;
  marker_post_id: string | null;
  needs_reprompt: number;
  silent: number;
}

export interface PostRow {
  id: string;
  topic_id: string;
  tenant_id: string | null;
  parent_post_id: string | null;
  author_id: string;
  body: string;
  source_message_id: string | null;
  silent: number;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

export interface ChatCategoryRow {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  created_at: string;
  updated_at: string;
}

export interface ChatRoomRow {
  id: string;
  category_id: string;
  name: string;
  topic: string | null;
  status: string;
  visibility: string;
  message_count: number;
  last_message_at: string | null;
  last_message_author_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageRow {
  id: string;
  room_id: string;
  author_id: string;
  author_name: string;
  author_avatar_url: string | null;
  body: string;
  created_at: string;
  edited_at: string | null;
  expires_at: string | null;
}

export interface RecentPostRow {
  post_id: string;
  topic_id: string;
  forum_id: string;
  forum_name: string;
  forum_visibility: string;
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
  forum_visibility: string;
  forum_tenant_id: string | null;
  body: string;
  created_at: string;
}

export interface IdentityRow {
  id: string;
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
  /**
   * Private email address used for robot-only workflows (ex: attribution/metadata).
   * This field must never be exposed in public DTOs.
   */
  private_email: string | null;
  created_at: string;
  updated_at: string;
}

export interface TopicReadRow {
  identity_id: string;
  topic_id: string;
  last_read_post_id: string | null;
  last_read_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TopicSubscriptionRow {
  identity_id: string;
  topic_id: string;
  mode: string;
  created_at: string;
  updated_at: string;
}

export interface NotificationRow {
  id: string;
  identity_id: string;
  type: string;
  actor_id: string | null;
  topic_id: string | null;
  post_id: string | null;
  payload_json: string | null;
  created_at: string;
  read_at: string | null;
}

export interface ApiKeyRow {
  id: string;
  identity_id: string;
  label: string;
  token_hash: string;
  token_prefix: string;
  scopes_json: string;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface ImpersonationTokenRow {
  id: string;
  owner_identity_id: string;
  impersonated_identity_id: string;
  label: string;
  token_hash: string;
  token_prefix: string;
  scopes_json: string;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface ExternalIdentityRow {
  id: string;
  identity_id: string;
  provider_key: string;
  issuer: string;
  subject: string;
  created_at: string;
  last_login_at: string | null;
}

export interface SessionRow {
  id: string;
  topic_id: string;
  codex_thread_id: string | null;
  agent_thread_id: string | null;
  agent_backend: string | null;
  personas_synced_at: string | null;
  context_synced_forum_id: string | null;
  last_dispatched_post_id: string | null;
  created_at: string;
  updated_at: string;
  status: string;
}

export interface PlanRow {
  id: string;
  topic_id: string;
  session_id: string;
  content: string;
  summary: string | null;
  parent_post_id: string | null;
  reasoning_checkpoints_json: string | null;
  visibility: string;
  created_at: string;
  updated_at: string;
}

export interface ToolRunRow {
  id: string;
  topic_id: string;
  session_id: string;
  tool: string;
  parent_post_id: string | null;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  command: string | null;
  files_touched_json: string | null;
  output_summary: string | null;
  redactions_applied: number;
  visibility: string;
}

export interface RobotStateRow {
  topic_id: string;
  session_id: string;
  activity: string;
  model: string | null;
  reasoning_effort: string | null;
  last_updated_at: string;
  current_plan_id: string | null;
  last_error_message?: string | null;
  last_error_at?: string | null;
  last_error_post_id?: string | null;
  last_error_turn_id?: string | null;
}

export interface PostDispatchRow {
  id: string;
  topic_id: string;
  post_id: string;
  session_id: string;
  status: string;
  mode: string;
  generation: number;
  claim_token: string | null;
  model: string | null;
  reasoning_effort: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  dispatched_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface TopicOperationalEventRow {
  id: string;
  topic_id: string;
  anchor_post_id: string | null;
  event_type: string;
  category: string;
  status: string;
  summary: string;
  detail_json: string | null;
  source_kind: string;
  source_id: string;
  created_at: string;
}

export interface CompactionOperationRow {
  id: string;
  topic_id: string;
  session_id: string;
  initiated_by: string;
  expected_leaf_id: string;
  custom_instructions: string | null;
  recovery_prompt: string;
  status: string;
  event_id: string | null;
  recovery_post_id: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface RobotAutomationRow {
  id: string;
  name: string;
  forum_id: string | null;
  prompt: string;
  enabled: number;
  worker: string;
  model: string | null;
  reasoning_effort: string | null;
  worker_thread_id: string | null;
  run_mode: string;
  interval_minutes: number | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RobotAutomationRunRow {
  id: string;
  automation_id: string;
  worker: string;
  model: string | null;
  reasoning_effort: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  output_summary: string | null;
  last_message: string | null;
  log_path: string | null;
}

export interface TopicAutoRunRow {
  topic_id: string;
  enabled: number;
  context: string | null;
  worker: string;
  model: string | null;
  reasoning_effort: string | null;
  director_thread_id: string | null;
  max_replies: number;
  reply_count: number;
  status: string;
  last_run_at: string | null;
  last_reply_at: string | null;
  last_summary: string | null;
  last_notes: string | null;
  last_error: string | null;
  last_trigger_post_id: string | null;
  steer_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface RobotPersonaRow {
  id: string;
  forum_id: string;
  identity_id: string;
  description: string | null;
  accent_color: string | null;
  soul: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
  visibility: string;
}

export interface TamperConfigRow {
  id: string;
  forum_id: string | null;
  plugin_key: string;
  enabled: number;
  priority: number;
  direction: string | null;
  only_first_message: number | null;
  config_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageTamperRow {
  id: string;
  topic_id: string;
  session_id: string;
  post_id: string | null;
  session_message_id: string | null;
  direction: string;
  stage: string;
  plugin_key: string;
  plugin_priority: number;
  input_text: string;
  output_text: string;
  changed: number;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface ExternalRefRow {
  id: string;
  surface_id: string;
  surface_kind: string;
  external_id: string;
  kind: string;
  scope: string | null;
  scope_kind: string | null;
  mapped_forum_id: string | null;
  mapped_topic_id: string | null;
  mapped_post_id: string | null;
  mapped_identity_id: string | null;
}

export interface OneTimeLinkRow {
  token: string;
  identity_id: string | null;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface InviteRow {
  id: string;
  code: string;
  created_by: string;
  max_uses: number;
  uses: number;
  expires_at: string | null;
  created_at: string;
}

export interface PendingAttachmentRow {
  id: string;
  topic_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  sha256: string | null;
  created_by: string | null;
  created_at: string;
  expires_at: string;
}

export interface AttachmentRow {
  id: string;
  post_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  sha256: string | null;
  created_at: string;
}

export interface MessageTemplateRow {
  id: string;
  scope: string;
  owner_identity_id: string | null;
  name: string;
  category: string | null;
  body: string;
  thread_title: string | null;
  forum_scope: string;
  enabled: number;
  sort_order: number;
  revision: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserFileRow {
  id: string;
  identity_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  created_at: string;
}

export interface ReactionRow {
  id: string;
  post_id: string;
  identity_id: string;
  emoji: string;
  created_at: string;
}

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

export interface RoleRow {
  id: string;
  tenant_id: string | null;
  name: string;
  permissions_json: string;
  created_at: string;
}

export interface IdentityRoleRow {
  identity_id: string;
  role_id: string;
  tenant_id: string | null;
  created_at: string;
}

export interface AccessRuleRow {
  id: string;
  scope_kind: AccessRuleScopeKind;
  scope_id: string;
  principal_kind: AccessRulePrincipalKind;
  principal_id: string | null;
  action: AccessRuleAction;
  effect: AccessRuleEffect;
  created_at: string;
}

export interface WebhookRow {
  id: string;
  url: string;
  secret: string;
  events: string; // JSON array of event types
  enabled: number; // 0 or 1
  created_at: string;
  updated_at: string;
}

export interface AuthSessionRow {
  token: string;
  identity_id: string;
  created_at: string;
  expires_at: string;
}

export interface RefreshSessionRow {
  token: string;
  identity_id: string;
  created_at: string;
  expires_at: string;
}

export interface DbBootstrapResult {
  forumId: string;
  robotIdentityId: string;
  webIdentityId: string;
  chatRootForumId: string;
}

export interface DbBootstrapOptions {
  defaultWebIdentityId?: string | null;
  defaultWebIdentityDisplayName?: string | null;
  defaultWebIdentityUsername?: string | null;
  defaultWebIdentityAvatarUrl?: string | null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function openDb(config: DbConfig): DbContext {
  const dir = dirname(config.path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(config.path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return { db };
}

export function migrate(db: Database.Database): void {
  runMigrations(db);
}

export function bootstrap(db: Database.Database, options: DbBootstrapOptions = {}): DbBootstrapResult {
  const bootstrapForumKey = 'bootstrapForumId';
  const chatRootForumKey = 'chatRootForumId';
  const storedBootstrap = db.prepare('select value from system_settings where key = ?').get(bootstrapForumKey) as
    { value: string } | undefined;
  let forumId: string | null = storedBootstrap?.value ?? null;
  if (forumId) {
    const existingForum = db.prepare('select id from forums where id = ? limit 1').get(forumId) as
      { id: string } | undefined;
    if (!existingForum) {
      forumId = null;
    }
  }

  if (!forumId) {
    const codexForum = db
      .prepare('select id from forums where name = ? order by created_at asc limit 1')
      .get('Codex Forum') as { id: string } | undefined;
    forumId = codexForum?.id ?? null;
  }

  if (!forumId) {
    const forumRow = db.prepare('select id from forums order by created_at asc limit 1').get() as
      { id: string } | undefined;
    forumId = forumRow?.id ?? null;
  }

  if (!forumId) {
    forumId = randomUUID();
    const now = nowIso();
    db.prepare(
      'insert into forums (id, tenant_id, parent_forum_id, category, name, description, pre_prompt, status, archived_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(forumId, null, null, null, 'Codex Forum', 'Forum-native robot sessions', null, 'active', null, now, now);
  }
  if (forumId) {
    const now = nowIso();
    db.prepare(
      'insert into system_settings (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at'
    ).run(bootstrapForumKey, forumId, now);
  }

  let chatRootForumId: string | null = null;
  const storedChatRoot = db.prepare('select value from system_settings where key = ?').get(chatRootForumKey) as
    { value: string } | undefined;
  chatRootForumId = storedChatRoot?.value ?? null;
  if (chatRootForumId) {
    const existingChatRoot = db.prepare('select id from forums where id = ? limit 1').get(chatRootForumId) as
      { id: string } | undefined;
    if (!existingChatRoot) {
      chatRootForumId = null;
    }
  }
  if (!chatRootForumId) {
    const existingByName = db
      .prepare('select id from forums where name = ? and parent_forum_id is null order by created_at asc limit 1')
      .get('Chat') as { id: string } | undefined;
    chatRootForumId = existingByName?.id ?? null;
  }
  if (!chatRootForumId) {
    chatRootForumId = randomUUID();
    const now = nowIso();
    db.prepare(
      'insert into forums (id, tenant_id, parent_forum_id, category, name, description, pre_prompt, status, archived_at, created_at, updated_at, visibility) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      chatRootForumId,
      null,
      null,
      null,
      'Chat',
      'Live IRC-style chatrooms',
      null,
      'active',
      null,
      now,
      now,
      'members'
    );
  }
  if (chatRootForumId) {
    const now = nowIso();
    db.prepare(
      'insert into system_settings (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at'
    ).run(chatRootForumKey, chatRootForumId, now);
  }

  const chatCategoryCount = db.prepare('select count(*) as count from chat_categories').get() as
    { count: number } | undefined;
  let defaultChatCategoryId: string | null = null;
  if (!chatCategoryCount || chatCategoryCount.count === 0) {
    defaultChatCategoryId = randomUUID();
    const now = nowIso();
    db.prepare(
      'insert into chat_categories (id, name, description, visibility, created_at, updated_at) values (?, ?, ?, ?, ?, ?)'
    ).run(defaultChatCategoryId, 'General', 'IRC-style chat channels', 'members', now, now);
  } else {
    const firstCategory = db.prepare('select id from chat_categories order by created_at asc limit 1').get() as
      { id: string } | undefined;
    defaultChatCategoryId = firstCategory?.id ?? null;
  }

  if (defaultChatCategoryId) {
    const roomCount = db
      .prepare('select count(*) as count from chat_rooms where category_id = ?')
      .get(defaultChatCategoryId) as { count: number } | undefined;
    if (!roomCount || roomCount.count === 0) {
      const roomId = randomUUID();
      const now = nowIso();
      db.prepare(
        `insert into chat_rooms
         (id, category_id, name, topic, status, visibility, message_count, last_message_at, last_message_author_name, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(roomId, defaultChatCategoryId, '#lobby', null, 'open', 'members', 0, null, null, now, now);
    }
  }

  const robotIdentity = db.prepare('select id from identities where kind = ? limit 1').get('robot') as
    { id: string } | undefined;
  let robotIdentityId = robotIdentity?.id;

  if (!robotIdentityId) {
    robotIdentityId = randomUUID();
    const now = nowIso();
    db.prepare(
      'insert into identities (id, tenant_id, display_name, kind, parent_identity_id, avatar_url, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(robotIdentityId, null, 'Monika', 'robot', null, '/avatars/monika.png', now, now);
  } else {
    db.prepare('update identities set avatar_url = ? where id = ? and avatar_url is null').run(
      '/avatars/monika.png',
      robotIdentityId
    );
  }

  const directorIdentity = db
    .prepare("select id from identities where lower(display_name) in ('director', 'the director') limit 1")
    .get() as { id: string } | undefined;
  let directorIdentityId = directorIdentity?.id ?? null;

  if (!directorIdentityId) {
    directorIdentityId = randomUUID();
    const now = nowIso();
    db.prepare(
      'insert into identities (id, tenant_id, display_name, kind, parent_identity_id, avatar_url, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(directorIdentityId, null, 'Director', 'robot', null, '/avatars/director.webp', now, now);
  } else {
    db.prepare('update identities set avatar_url = ? where id = ? and avatar_url is null').run(
      '/avatars/director.webp',
      directorIdentityId
    );
  }

  const defaultWebIdentityId = options.defaultWebIdentityId?.trim() || null;
  const defaultWebIdentityUsername = options.defaultWebIdentityUsername?.trim() || null;
  const defaultWebIdentityDisplayName = options.defaultWebIdentityDisplayName?.trim() || 'Web User';
  const defaultWebIdentityAvatarUrl = options.defaultWebIdentityAvatarUrl?.trim() || '/avatars/user.svg';

  const configuredWebIdentity = defaultWebIdentityId
    ? (db.prepare('select id from identities where id = ? limit 1').get(defaultWebIdentityId) as
        { id: string } | undefined)
    : undefined;
  const configuredWebIdentityByUsername = defaultWebIdentityUsername
    ? (db.prepare('select id from identities where username = ? limit 1').get(defaultWebIdentityUsername) as
        { id: string } | undefined)
    : undefined;
  const existingHumanIdentity = db
    .prepare('select id from identities where kind = ? order by created_at asc limit 1')
    .get('human') as { id: string } | undefined;
  const webIdentity = configuredWebIdentity ?? configuredWebIdentityByUsername ?? existingHumanIdentity;
  let webIdentityId = webIdentity?.id;

  if (!webIdentityId) {
    webIdentityId = defaultWebIdentityId ?? randomUUID();
    const now = nowIso();
    db.prepare(
      'insert into identities (id, tenant_id, display_name, kind, parent_identity_id, avatar_url, username, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      webIdentityId,
      null,
      defaultWebIdentityDisplayName,
      'human',
      null,
      defaultWebIdentityAvatarUrl,
      defaultWebIdentityUsername,
      now,
      now
    );
  } else {
    db.prepare('update identities set avatar_url = coalesce(avatar_url, ?) where id = ?').run(
      defaultWebIdentityAvatarUrl,
      webIdentityId
    );
  }

  const piCliIdentity = db.prepare("select id from identities where display_name = 'Pi CLI' limit 1").get() as
    { id: string } | undefined;
  if (!piCliIdentity) {
    const now = nowIso();
    db.prepare(
      'insert into identities (id, tenant_id, display_name, kind, parent_identity_id, avatar_url, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), null, 'Pi CLI', 'system', null, '/avatars/pi-cli.gif', now, now);
  }

  db.prepare("update identities set avatar_url = ? where lower(display_name) = 'muse' and avatar_url is null").run(
    '/avatars/muse.webp'
  );
  db.prepare(
    "update identities set avatar_url = ? where lower(display_name) in ('director','the director') and avatar_url is null"
  ).run('/avatars/director.webp');

  return { forumId, robotIdentityId, webIdentityId, chatRootForumId };
}
