import Database from 'better-sqlite3';

export type Migration = {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
};

const nowIso = (): string => new Date().toISOString();

const ensureSchemaMigrationsTable = (db: Database.Database): void => {
  db.exec(`
    create table if not exists schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );
  `);
};

const getAppliedVersions = (db: Database.Database): Set<number> => {
  const rows = db.prepare('select version from schema_migrations order by version asc').all() as Array<{
    version: number;
  }>;
  return new Set(rows.map((row) => row.version));
};

const getTableColumns = (db: Database.Database, tableName: string): Set<string> => {
  const rows = db.prepare(`pragma table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
};

const hasColumn = (db: Database.Database, tableName: string, columnName: string): boolean =>
  getTableColumns(db, tableName).has(columnName);

const hasTable = (db: Database.Database, tableName: string): boolean => {
  const row = db.prepare("select name from sqlite_master where type = 'table' and name = ?").get(tableName) as
    | { name: string }
    | undefined;
  return Boolean(row?.name);
};

const MIGRATION_001 = `
  create table if not exists forums (
    id text primary key,
    tenant_id text,
    parent_forum_id text,
    category text,
    name text not null,
    description text,
    pre_prompt text,
    status text not null default 'active',
    visibility text not null default 'public',
    archived_at text,
    created_at text not null,
    updated_at text not null,
    foreign key (parent_forum_id) references forums(id)
  );

  create table if not exists topics (
    id text primary key,
    forum_id text not null,
    tenant_id text,
    title text not null,
    status text not null,
    tags_json text not null,
    robot_mode text not null default 'auto',
    created_by text not null,
    created_at text not null,
    updated_at text not null,
    foreign key (forum_id) references forums(id)
  );

  create table if not exists topic_moves (
    id text primary key,
    topic_id text not null,
    from_forum_id text not null,
    to_forum_id text not null,
    moved_by text not null,
    moved_at text not null,
    marker_post_id text,
    needs_reprompt integer not null default 1,
    silent integer not null default 0,
    foreign key (topic_id) references topics(id),
    foreign key (from_forum_id) references forums(id),
    foreign key (to_forum_id) references forums(id),
    foreign key (moved_by) references identities(id),
    foreign key (marker_post_id) references posts(id)
  );

  create table if not exists posts (
    id text primary key,
    topic_id text not null,
    tenant_id text,
    parent_post_id text,
    author_id text not null,
    body text not null,
    source_message_id text,
    silent integer not null default 0,
    created_at text not null,
    edited_at text,
    deleted_at text,
    foreign key (topic_id) references topics(id)
  );

  create table if not exists identities (
    id text primary key,
    tenant_id text,
    display_name text not null,
    kind text not null,
    parent_identity_id text,
    avatar_url text,
    theme text,
    private_email text,
    created_at text not null,
    updated_at text not null
  );

  create table if not exists sessions (
    id text primary key,
    topic_id text not null,
    codex_thread_id text,
    agent_thread_id text,
    agent_backend text,
    personas_synced_at text,
    context_synced_forum_id text,
    last_dispatched_post_id text,
    created_at text not null,
    updated_at text not null,
    status text not null,
    foreign key (topic_id) references topics(id)
  );

  create table if not exists robot_personas (
    forum_id text not null,
    id text not null,
    identity_id text not null,
    description text,
    accent_color text,
    soul text,
    created_at text not null,
    updated_at text not null,
    foreign key (forum_id) references forums(id),
    foreign key (identity_id) references identities(id),
    unique(forum_id, identity_id),
    primary key (forum_id, id)
  );

  create table if not exists session_messages (
    id text primary key,
    session_id text not null,
    role text not null,
    content text not null,
    created_at text not null,
    visibility text not null,
    foreign key (session_id) references sessions(id)
  );

  create table if not exists tamper_configs (
    id text primary key,
    forum_id text,
    plugin_key text not null,
    enabled integer not null default 1,
    priority integer not null default 0,
    direction text,
    only_first_message integer,
    config_json text,
    created_at text not null,
    updated_at text not null,
    foreign key (forum_id) references forums(id)
  );

  create table if not exists message_tampers (
    id text primary key,
    topic_id text not null,
    session_id text not null,
    post_id text,
    session_message_id text,
    direction text not null,
    stage text not null,
    plugin_key text not null,
    plugin_priority integer not null,
    input_text text not null,
    output_text text not null,
    changed integer not null,
    error text,
    duration_ms integer,
    created_at text not null,
    foreign key (topic_id) references topics(id),
    foreign key (session_id) references sessions(id),
    foreign key (post_id) references posts(id),
    foreign key (session_message_id) references session_messages(id)
  );

  create table if not exists plans (
    id text primary key,
    topic_id text not null,
    session_id text not null,
    content text not null,
    summary text,
    parent_post_id text,
    visibility text not null,
    created_at text not null,
    updated_at text not null,
    foreign key (topic_id) references topics(id),
    foreign key (session_id) references sessions(id)
  );

  create table if not exists tool_runs (
    id text primary key,
    topic_id text not null,
    session_id text not null,
    tool text not null,
    parent_post_id text,
    started_at text not null,
    finished_at text,
    exit_code integer,
    command text,
    files_touched_json text,
    output_summary text,
    redactions_applied integer not null,
    visibility text not null,
    foreign key (topic_id) references topics(id),
    foreign key (session_id) references sessions(id)
  );

  create table if not exists robot_state (
    topic_id text primary key,
    session_id text not null,
    activity text not null,
    model text,
    reasoning_effort text,
    last_updated_at text not null,
    current_plan_id text,
    foreign key (topic_id) references topics(id),
    foreign key (session_id) references sessions(id),
    foreign key (current_plan_id) references plans(id)
  );

  create table if not exists robot_automations (
    id text primary key,
    name text not null,
    forum_id text,
    prompt text not null,
    enabled integer not null default 1,
    worker text not null,
    model text,
    reasoning_effort text,
    worker_thread_id text,
    run_mode text not null default 'manual',
    interval_minutes integer,
    last_run_at text,
    created_at text not null,
    updated_at text not null,
    foreign key (forum_id) references forums(id)
  );

  create table if not exists robot_automation_runs (
    id text primary key,
    automation_id text not null,
    worker text not null,
    model text,
    reasoning_effort text,
    status text not null,
    started_at text not null,
    finished_at text,
    exit_code integer,
    output_summary text,
    last_message text,
    log_path text,
    foreign key (automation_id) references robot_automations(id)
  );

  create table if not exists external_refs (
    id text primary key,
    surface_id text not null,
    surface_kind text not null,
    external_id text not null,
    kind text not null,
    scope text,
    scope_kind text,
    mapped_forum_id text,
    mapped_topic_id text,
    mapped_post_id text,
    mapped_identity_id text
  );

  create table if not exists one_time_links (
    token text primary key,
    identity_id text,
    expires_at text not null,
    used_at text,
    created_at text not null,
    foreign key (identity_id) references identities(id)
  );

  create table if not exists invites (
    id text primary key,
    code text not null unique,
    created_by text not null,
    max_uses integer not null default 1,
    uses integer not null default 0,
    expires_at text,
    created_at text not null,
    foreign key (created_by) references identities(id)
  );

  create table if not exists pending_attachments (
    id text primary key,
    topic_id text not null,
    filename text not null,
    mime_type text not null,
    size_bytes integer not null,
    storage_path text not null,
    sha256 text,
    created_by text,
    created_at text not null,
    expires_at text not null,
    foreign key (topic_id) references topics(id)
  );

  create table if not exists attachments (
    id text primary key,
    post_id text not null,
    filename text not null,
    mime_type text not null,
    size_bytes integer not null,
    storage_path text not null,
    sha256 text,
    created_at text not null,
    foreign key (post_id) references posts(id)
  );

  create table if not exists user_files (
    id text primary key,
    identity_id text not null,
    filename text not null,
    mime_type text not null,
    size_bytes integer not null,
    storage_path text not null,
    created_at text not null,
    foreign key (identity_id) references identities(id)
  );

  create table if not exists reactions (
    id text primary key,
    post_id text not null,
    identity_id text not null,
    emoji text not null,
    created_at text not null,
    foreign key (post_id) references posts(id),
    foreign key (identity_id) references identities(id),
    unique(post_id, identity_id, emoji)
  );

  create table if not exists tenants (
    id text primary key,
    name text not null,
    slug text not null unique,
    settings_json text not null default '{}',
    created_at text not null,
    updated_at text not null
  );

  create table if not exists roles (
    id text primary key,
    tenant_id text,
    name text not null,
    permissions_json text not null default '[]',
    created_at text not null,
    foreign key (tenant_id) references tenants(id)
  );

  create table if not exists identity_roles (
    identity_id text not null,
    role_id text not null,
    tenant_id text,
    created_at text not null,
    primary key (identity_id, role_id, tenant_id),
    foreign key (identity_id) references identities(id),
    foreign key (role_id) references roles(id),
    foreign key (tenant_id) references tenants(id)
  );

  create table if not exists access_rules (
    id text primary key,
    scope_kind text not null,
    scope_id text not null,
    principal_kind text not null,
    principal_id text,
    action text not null,
    effect text not null,
    created_at text not null
  );

  create table if not exists webhooks (
    id text primary key,
    url text not null,
    secret text not null,
    events text not null,
    enabled integer default 1,
    created_at text not null,
    updated_at text not null
  );

  create table if not exists auth_sessions (
    token text primary key,
    identity_id text not null,
    created_at text not null,
    expires_at text not null,
    foreign key (identity_id) references identities(id)
  );

  create table if not exists refresh_sessions (
    token text primary key,
    identity_id text not null,
    created_at text not null,
    expires_at text not null,
    foreign key (identity_id) references identities(id)
  );

  create table if not exists api_keys (
    id text primary key,
    identity_id text not null,
    label text not null,
    token_hash text not null,
    token_prefix text not null,
    scopes_json text not null,
    last_used_at text,
    expires_at text,
    created_at text not null,
    revoked_at text,
    foreign key (identity_id) references identities(id)
  );

  create table if not exists impersonation_tokens (
    id text primary key,
    owner_identity_id text not null,
    impersonated_identity_id text not null,
    label text not null,
    token_hash text not null,
    token_prefix text not null,
    scopes_json text not null,
    last_used_at text,
    expires_at text,
    created_at text not null,
    revoked_at text,
    foreign key (owner_identity_id) references identities(id),
    foreign key (impersonated_identity_id) references identities(id)
  );

  create table if not exists system_settings (
    key text primary key,
    value text not null,
    updated_at text not null
  );

  create index if not exists idx_auth_sessions_identity on auth_sessions(identity_id);
  create index if not exists idx_auth_sessions_expires on auth_sessions(expires_at);
  create index if not exists idx_refresh_sessions_identity on refresh_sessions(identity_id);
  create index if not exists idx_refresh_sessions_expires on refresh_sessions(expires_at);
  create index if not exists idx_api_keys_identity on api_keys(identity_id);
  create unique index if not exists idx_api_keys_token_hash on api_keys(token_hash);
  create index if not exists idx_api_keys_expires on api_keys(expires_at);
  create index if not exists idx_impersonation_owner on impersonation_tokens(owner_identity_id);
  create index if not exists idx_impersonation_identity on impersonation_tokens(impersonated_identity_id);
  create unique index if not exists idx_impersonation_token_hash on impersonation_tokens(token_hash);
  create index if not exists idx_impersonation_expires on impersonation_tokens(expires_at);

  create index if not exists idx_topics_forum on topics(forum_id);
  create index if not exists idx_topics_tenant on topics(tenant_id);
  create index if not exists idx_topic_moves_topic on topic_moves(topic_id);
  create index if not exists idx_topic_moves_pending on topic_moves(topic_id, needs_reprompt);
  create index if not exists idx_forums_tenant on forums(tenant_id);
  create index if not exists idx_posts_tenant on posts(tenant_id);
  create index if not exists idx_posts_topic on posts(topic_id);
  create index if not exists idx_sessions_topic on sessions(topic_id);
  create index if not exists idx_session_messages_session on session_messages(session_id);
  create index if not exists idx_tamper_configs_forum on tamper_configs(forum_id);
  create index if not exists idx_tamper_configs_plugin on tamper_configs(plugin_key);
  create unique index if not exists idx_tamper_configs_forum_plugin on tamper_configs(forum_id, plugin_key, direction) where forum_id is not null;
  create unique index if not exists idx_tamper_configs_global_plugin on tamper_configs(plugin_key, direction) where forum_id is null;
  create index if not exists idx_message_tampers_session on message_tampers(session_id);
  create index if not exists idx_message_tampers_post on message_tampers(post_id);
  create index if not exists idx_message_tampers_session_message on message_tampers(session_message_id);
  create index if not exists idx_external_refs_topic on external_refs(mapped_topic_id);
  create index if not exists idx_one_time_links_identity on one_time_links(identity_id);
  create index if not exists idx_invites_code on invites(code);
  create index if not exists idx_attachments_post on attachments(post_id);
  create index if not exists idx_user_files_identity on user_files(identity_id);
  create index if not exists idx_reactions_post on reactions(post_id);
  create index if not exists idx_access_rules_scope on access_rules(scope_kind, scope_id);
  create index if not exists idx_access_rules_principal on access_rules(principal_kind, principal_id);
  create unique index if not exists idx_access_rules_unique on access_rules(scope_kind, scope_id, principal_kind, principal_id, action);

  create virtual table if not exists posts_fts using fts5(
    body,
    content='posts',
    content_rowid='rowid'
  );

  create virtual table if not exists topics_fts using fts5(
    title,
    content='topics',
    content_rowid='rowid'
  );
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => {
      db.exec(MIGRATION_001);
    },
  },
  {
    version: 2,
    name: 'sessions-columns',
    up: (db) => {
      const sessionColumns = getTableColumns(db, 'sessions');
      if (!sessionColumns.has('codex_thread_id')) {
        db.prepare('alter table sessions add column codex_thread_id text').run();
      }
      if (!sessionColumns.has('personas_synced_at')) {
        db.prepare('alter table sessions add column personas_synced_at text').run();
      }
      if (!sessionColumns.has('last_dispatched_post_id')) {
        db.prepare('alter table sessions add column last_dispatched_post_id text').run();
      }
    },
  },
  {
    version: 3,
    name: 'identity-columns',
    up: (db) => {
      const identityColumns = getTableColumns(db, 'identities');
      if (!identityColumns.has('avatar_url')) {
        db.prepare('alter table identities add column avatar_url text').run();
      }
      if (!identityColumns.has('parent_identity_id')) {
        db.prepare('alter table identities add column parent_identity_id text').run();
      }
      if (!identityColumns.has('password_hash')) {
        db.prepare('alter table identities add column password_hash text').run();
      }
      if (!identityColumns.has('username')) {
        db.prepare('alter table identities add column username text').run();
        db.prepare(
          'create unique index if not exists idx_identities_username on identities(username) where username is not null'
        ).run();
      }
      if (!identityColumns.has('location')) {
        db.prepare('alter table identities add column location text').run();
      }
      if (!identityColumns.has('signature')) {
        db.prepare('alter table identities add column signature text').run();
      }
      if (!identityColumns.has('theme')) {
        db.prepare('alter table identities add column theme text').run();
      }
      if (!identityColumns.has('private_email')) {
        db.prepare('alter table identities add column private_email text').run();
      }
    },
  },
  {
    version: 4,
    name: 'plan-parent-post',
    up: (db) => {
      if (!hasColumn(db, 'plans', 'parent_post_id')) {
        db.prepare('alter table plans add column parent_post_id text').run();
      }
    },
  },
  {
    version: 5,
    name: 'tool-run-parent-post',
    up: (db) => {
      if (!hasColumn(db, 'tool_runs', 'parent_post_id')) {
        db.prepare('alter table tool_runs add column parent_post_id text').run();
      }
    },
  },
  {
    version: 6,
    name: 'post-source-message-and-silent',
    up: (db) => {
      const postColumns = getTableColumns(db, 'posts');
      if (!postColumns.has('source_message_id')) {
        db.prepare('alter table posts add column source_message_id text').run();
      }
      if (!postColumns.has('silent')) {
        db.prepare('alter table posts add column silent integer not null default 0').run();
      }
    },
  },
  {
    version: 7,
    name: 'topic-robot-mode',
    up: (db) => {
      if (!hasColumn(db, 'topics', 'robot_mode')) {
        db.prepare("alter table topics add column robot_mode text not null default 'auto'").run();
      }
    },
  },
  {
    version: 8,
    name: 'forum-columns',
    up: (db) => {
      const forumColumns = getTableColumns(db, 'forums');
      if (!forumColumns.has('cwd')) {
        db.prepare('alter table forums add column cwd text').run();
      }
      if (!forumColumns.has('parent_forum_id')) {
        db.prepare('alter table forums add column parent_forum_id text').run();
        db.prepare('create index if not exists idx_forums_parent on forums(parent_forum_id)').run();
      }
      if (!forumColumns.has('status')) {
        db.prepare("alter table forums add column status text not null default 'active'").run();
        db.prepare('create index if not exists idx_forums_status on forums(status)').run();
      }
      if (!forumColumns.has('archived_at')) {
        db.prepare('alter table forums add column archived_at text').run();
      }
      if (!forumColumns.has('category')) {
        db.prepare('alter table forums add column category text').run();
      }
      if (!forumColumns.has('visibility')) {
        db.prepare("alter table forums add column visibility text not null default 'public'").run();
      }
      if (!forumColumns.has('pre_prompt')) {
        db.prepare('alter table forums add column pre_prompt text').run();
      }
    },
  },
  {
    version: 9,
    name: 'tamper-config-direction-only-first',
    up: (db) => {
      const tamperColumns = getTableColumns(db, 'tamper_configs');
      const hasTamperDirection = tamperColumns.has('direction');
      const hasTamperOnlyFirst = tamperColumns.has('only_first_message');
      if (!hasTamperDirection) {
        db.prepare('alter table tamper_configs add column direction text').run();
      }
      if (!hasTamperOnlyFirst) {
        db.prepare('alter table tamper_configs add column only_first_message integer').run();
      }
      if (!hasTamperDirection || !hasTamperOnlyFirst) {
        db.prepare('drop index if exists idx_tamper_configs_forum_plugin').run();
        db.prepare('drop index if exists idx_tamper_configs_global_plugin').run();
        db.prepare(
          'create unique index if not exists idx_tamper_configs_forum_plugin on tamper_configs(forum_id, plugin_key, direction) where forum_id is not null'
        ).run();
        db.prepare(
          'create unique index if not exists idx_tamper_configs_global_plugin on tamper_configs(plugin_key, direction) where forum_id is null'
        ).run();
      }
      if (!hasTamperDirection) {
        db.prepare(
          "update tamper_configs set direction = 'inbound' where direction is null and plugin_key = 'prompt.enhancer'"
        ).run();
        db.prepare("update tamper_configs set direction = 'both' where direction is null").run();
      }
      if (!hasTamperOnlyFirst) {
        const tamperRows = db
          .prepare('select id, plugin_key, config_json, only_first_message from tamper_configs')
          .all() as Array<{
          id: string;
          plugin_key: string;
          config_json: string | null;
          only_first_message: number | null;
        }>;
        for (const row of tamperRows) {
          if (row.only_first_message !== null) continue;
          if (row.plugin_key !== 'prompt.enhancer') continue;
          let value: number | null = null;
          if (row.config_json) {
            try {
              const parsed = JSON.parse(row.config_json) as { onlyFirstMessage?: boolean };
              if (typeof parsed.onlyFirstMessage === 'boolean') {
                value = parsed.onlyFirstMessage ? 1 : 0;
              }
            } catch {
              value = null;
            }
          }
          if (value === null) {
            value = 1;
          }
          db.prepare('update tamper_configs set only_first_message = ? where id = ?').run(value, row.id);
        }
      }
    },
  },
  {
    version: 11,
    name: 'robot-personas-primary-key',
    up: (db) => {
      const robotPersonaCols = db.prepare('pragma table_info(robot_personas)').all() as Array<{
        name: string;
        pk: number;
      }>;
      if (robotPersonaCols.length === 0) return;
      const idPk = robotPersonaCols.find((col) => col.name === 'id')?.pk ?? 0;
      const forumPk = robotPersonaCols.find((col) => col.name === 'forum_id')?.pk ?? 0;
      if (idPk === 1 && forumPk === 0) {
        db.exec(`
          create table if not exists robot_personas_new (
            forum_id text not null,
            id text not null,
            identity_id text not null,
            description text,
            accent_color text,
            soul text,
            created_at text not null,
            updated_at text not null,
            foreign key (forum_id) references forums(id),
            foreign key (identity_id) references identities(id),
            unique(forum_id, identity_id),
            primary key (forum_id, id)
          );
          insert into robot_personas_new (forum_id, id, identity_id, description, accent_color, soul, created_at, updated_at)
            select forum_id, id, identity_id, description, accent_color, soul, created_at, updated_at from robot_personas;
          drop table robot_personas;
          alter table robot_personas_new rename to robot_personas;
        `);
      }
    },
  },
  {
    version: 12,
    name: 'topic-auto-run',
    up: (db) => {
      db.exec(`
        create table if not exists topic_auto_runs (
          topic_id text primary key,
          enabled integer not null default 0,
          context text,
          worker text not null default 'echs',
          model text,
          reasoning_effort text,
          director_thread_id text,
          max_replies integer not null default 20,
          reply_count integer not null default 0,
          status text not null default 'idle',
          last_run_at text,
          last_reply_at text,
          last_summary text,
          last_notes text,
          last_error text,
          last_trigger_post_id text,
          steer_message text,
          created_at text not null,
          updated_at text not null,
          foreign key (topic_id) references topics(id)
        );
      `);
    },
  },
  {
    version: 13,
    name: 'topic-auto-run-director-thread',
    up: (db) => {
      if (!hasColumn(db, 'topic_auto_runs', 'director_thread_id')) {
        db.prepare('alter table topic_auto_runs add column director_thread_id text').run();
      }
    },
  },
  {
    version: 14,
    name: 'robot-automation-worker-thread',
    up: (db) => {
      if (!hasColumn(db, 'robot_automations', 'worker_thread_id')) {
        db.prepare('alter table robot_automations add column worker_thread_id text').run();
      }
    },
  },
  {
    version: 15,
    name: 'chat-posts-topic-created-at-index',
    up: (db) => {
      db.exec('create index if not exists idx_posts_topic_created_at on posts(topic_id, created_at)');
    },
  },
  {
    version: 16,
    name: 'notifications-and-topic-reads',
    up: (db) => {
      db.exec(`
        create table if not exists topic_reads (
          identity_id text not null,
          topic_id text not null,
          last_read_post_id text,
          last_read_at text,
          created_at text not null,
          updated_at text not null,
          primary key (identity_id, topic_id),
          foreign key (identity_id) references identities(id),
          foreign key (topic_id) references topics(id),
          foreign key (last_read_post_id) references posts(id)
        );

        create table if not exists topic_subscriptions (
          identity_id text not null,
          topic_id text not null,
          mode text not null default 'off',
          created_at text not null,
          updated_at text not null,
          primary key (identity_id, topic_id),
          foreign key (identity_id) references identities(id),
          foreign key (topic_id) references topics(id)
        );

        create table if not exists notifications (
          id text primary key,
          identity_id text not null,
          type text not null,
          actor_id text,
          topic_id text,
          post_id text,
          payload_json text,
          created_at text not null,
          read_at text,
          foreign key (identity_id) references identities(id),
          foreign key (actor_id) references identities(id),
          foreign key (topic_id) references topics(id),
          foreign key (post_id) references posts(id)
        );

        create index if not exists idx_topic_reads_identity on topic_reads(identity_id);
        create index if not exists idx_topic_subscriptions_topic on topic_subscriptions(topic_id);
        create index if not exists idx_notifications_identity_created on notifications(identity_id, created_at desc);
        create index if not exists idx_notifications_identity_read on notifications(identity_id, read_at);
      `);
    },
  },
  {
    version: 17,
    name: 'chat-standalone-tables',
    up: (db) => {
      db.exec(`
        create table if not exists chat_categories (
          id text primary key,
          name text not null,
          description text,
          visibility text not null default 'public',
          created_at text not null,
          updated_at text not null
        );

        create table if not exists chat_rooms (
          id text primary key,
          category_id text not null,
          name text not null,
          topic text,
          status text not null default 'open',
          visibility text not null default 'public',
          message_count integer not null default 0,
          last_message_at text,
          last_message_author_name text,
          created_at text not null,
          updated_at text not null,
          foreign key (category_id) references chat_categories(id)
        );

        create table if not exists chat_messages (
          id text primary key,
          room_id text not null,
          author_id text not null,
          author_name text not null,
          author_avatar_url text,
          body text not null,
          created_at text not null,
          edited_at text,
          foreign key (room_id) references chat_rooms(id)
        );

        create index if not exists idx_chat_rooms_category on chat_rooms(category_id);
        create index if not exists idx_chat_messages_room_created on chat_messages(room_id, created_at);
      `);
    },
  },
  {
    version: 18,
    name: 'chat-message-expiry',
    up: (db) => {
      const columns = db.prepare('pragma table_info(chat_messages)').all() as Array<{ name: string }>;
      const hasExpiresAt = columns.some((column) => column.name === 'expires_at');
      if (!hasExpiresAt) {
        db.exec('alter table chat_messages add column expires_at text;');
      }
      db.exec('create index if not exists idx_chat_messages_expires on chat_messages(expires_at);');
    },
  },
  {
    version: 19,
    name: 'session-agent-backend',
    up: (db) => {
      const sessionColumns = getTableColumns(db, 'sessions');
      if (!sessionColumns.has('agent_thread_id')) {
        db.prepare('alter table sessions add column agent_thread_id text').run();
      }
      if (!sessionColumns.has('agent_backend')) {
        db.prepare('alter table sessions add column agent_backend text').run();
      }
      // Legacy databases may still have `codex_thread_id` populated.
      // In ECHS-only mode we cannot safely reuse those ids as ECHS thread ids.
      // Mark the backend as ECHS but leave the thread id unset so the runtime can start fresh.
      db.prepare("update sessions set agent_backend = 'echs' where agent_backend is null").run();
      db.exec('create index if not exists idx_sessions_agent_backend on sessions(agent_backend)');
      db.exec('create index if not exists idx_sessions_agent_thread on sessions(agent_thread_id)');
    },
  },
  {
    version: 20,
    name: 'external-identities',
    up: (db) => {
      db.exec(`
        create table if not exists external_identities (
          id text primary key,
          identity_id text not null,
          provider_key text not null,
          issuer text not null,
          subject text not null,
          created_at text not null,
          last_login_at text,
          foreign key (identity_id) references identities(id)
        );
        create unique index if not exists idx_external_identities_provider_subject
          on external_identities(provider_key, issuer, subject);
        create index if not exists idx_external_identities_identity
          on external_identities(identity_id);
      `);
    },
  },
  {
    version: 21,
    name: 'echs-only-worker',
    up: (db) => {
      if (hasTable(db, 'topic_auto_runs')) {
        db.prepare(
          "update topic_auto_runs set worker = 'echs' where worker is null or trim(lower(worker)) != 'echs'"
        ).run();
      }
      if (hasTable(db, 'robot_automations')) {
        db.prepare(
          "update robot_automations set worker = 'echs' where worker is null or trim(lower(worker)) != 'echs'"
        ).run();
      }
      if (hasTable(db, 'robot_automation_runs')) {
        db.prepare(
          "update robot_automation_runs set worker = 'echs' where worker is null or trim(lower(worker)) != 'echs'"
        ).run();
      }
    },
  },
  {
    version: 22,
    name: 'echs-session-normalization',
    up: (db) => {
      if (!hasTable(db, 'sessions')) return;
      const sessionColumns = getTableColumns(db, 'sessions');

      if (sessionColumns.has('agent_backend')) {
        db.prepare(
          "update sessions set agent_backend = 'echs' where agent_backend is null or trim(lower(agent_backend)) != 'echs'"
        ).run();
      }

      // If a previous build copied `codex_thread_id` into `agent_thread_id`, clear it.
      // This prevents ECHS attempting to resume legacy Codex threads.
      if (sessionColumns.has('codex_thread_id') && sessionColumns.has('agent_thread_id')) {
        db.prepare(
          'update sessions set agent_thread_id = null where agent_thread_id is not null and codex_thread_id is not null and agent_thread_id = codex_thread_id'
        ).run();
      }
    },
  },
  {
    version: 23,
    name: 'pi-session-import-links',
    up: (db) => {
      db.exec(`
        create table if not exists pi_import_runs (
          id text primary key,
          started_at text not null,
          finished_at text,
          status text not null,
          agentd_base_url text,
          sessions_seen integer not null default 0,
          sessions_imported integer not null default 0,
          posts_imported integer not null default 0,
          metadata_json text
        );

        create table if not exists pi_session_links (
          id text primary key,
          pi_session_id text not null,
          pi_session_path text not null,
          topic_id text not null,
          session_id text not null,
          cwd text,
          kind text not null,
          pi_timestamp text,
          imported_at text not null,
          last_import_run_id text,
          metadata_json text,
          foreign key (topic_id) references topics(id),
          foreign key (session_id) references sessions(id),
          foreign key (last_import_run_id) references pi_import_runs(id)
        );
        create unique index if not exists idx_pi_session_links_session_id on pi_session_links(pi_session_id);
        create unique index if not exists idx_pi_session_links_session_path on pi_session_links(pi_session_path);
        create unique index if not exists idx_pi_session_links_topic on pi_session_links(topic_id);

        create table if not exists pi_message_links (
          id text primary key,
          pi_session_id text not null,
          pi_message_id text not null,
          post_id text,
          session_message_id text,
          role text,
          imported_at text not null,
          metadata_json text,
          foreign key (post_id) references posts(id),
          foreign key (session_message_id) references session_messages(id)
        );
        create unique index if not exists idx_pi_message_links_session_message
          on pi_message_links(pi_session_id, pi_message_id);
        create index if not exists idx_pi_message_links_post on pi_message_links(post_id);
      `);
    },
  },
  {
    version: 24,
    name: 'pi-session-lineage',
    up: (db) => {
      if (!hasTable(db, 'pi_session_links')) return;
      if (!hasColumn(db, 'pi_session_links', 'parent_pi_session_id')) {
        db.prepare('alter table pi_session_links add column parent_pi_session_id text').run();
      }
      if (!hasColumn(db, 'pi_session_links', 'parent_pi_session_path')) {
        db.prepare('alter table pi_session_links add column parent_pi_session_path text').run();
      }
      if (!hasColumn(db, 'pi_session_links', 'lineage_kind')) {
        db.prepare('alter table pi_session_links add column lineage_kind text').run();
      }
      if (!hasColumn(db, 'pi_session_links', 'lineage_source')) {
        db.prepare('alter table pi_session_links add column lineage_source text').run();
      }
      db.exec('create index if not exists idx_pi_session_links_parent_id on pi_session_links(parent_pi_session_id)');
      db.exec('create index if not exists idx_pi_session_links_parent_path on pi_session_links(parent_pi_session_path)');
    },
  },
  {
    version: 25,
    name: 'attachment-sha256',
    up: (db) => {
      if (!hasTable(db, 'attachments')) return;
      if (!hasColumn(db, 'attachments', 'sha256')) {
        db.prepare('alter table attachments add column sha256 text').run();
      }
    },
  },
  {
    version: 26,
    name: 'pending-attachments',
    up: (db) => {
      db.exec(`
        create table if not exists pending_attachments (
          id text primary key,
          topic_id text not null,
          filename text not null,
          mime_type text not null,
          size_bytes integer not null,
          storage_path text not null,
          sha256 text,
          created_by text,
          created_at text not null,
          expires_at text not null,
          foreign key (topic_id) references topics(id)
        );
        create index if not exists idx_pending_attachments_topic on pending_attachments(topic_id);
        create index if not exists idx_pending_attachments_expires on pending_attachments(expires_at);
      `);
    },
  },
  {
    version: 27,
    name: 'durable-post-dispatches',
    up: (db) => {
      db.exec(`
        create table if not exists post_dispatches (
          id text primary key,
          topic_id text not null,
          post_id text not null unique,
          session_id text not null,
          status text not null,
          mode text not null default 'auto',
          model text,
          reasoning_effort text,
          attempt_count integer not null default 0,
          last_attempt_at text,
          next_attempt_at text,
          dispatched_at text,
          error_message text,
          created_at text not null,
          updated_at text not null,
          foreign key (topic_id) references topics(id),
          foreign key (post_id) references posts(id),
          foreign key (session_id) references sessions(id)
        );
        create index if not exists idx_post_dispatches_due on post_dispatches(status, next_attempt_at, created_at);
        create index if not exists idx_post_dispatches_topic_status on post_dispatches(topic_id, status, created_at);
      `);

      if (!hasColumn(db, 'robot_state', 'last_error_message')) {
        db.prepare('alter table robot_state add column last_error_message text').run();
      }
      if (!hasColumn(db, 'robot_state', 'last_error_at')) {
        db.prepare('alter table robot_state add column last_error_at text').run();
      }
      if (!hasColumn(db, 'robot_state', 'last_error_post_id')) {
        db.prepare('alter table robot_state add column last_error_post_id text').run();
      }
      if (!hasColumn(db, 'robot_state', 'last_error_turn_id')) {
        db.prepare('alter table robot_state add column last_error_turn_id text').run();
      }
    },
  },
  {
    version: 28,
    name: 'pi-sync-anomalies',
    up: (db) => {
      db.exec(`
        create table if not exists pi_sync_anomalies (
          id text primary key,
          pi_session_id text not null,
          pi_message_id text not null,
          topic_id text not null,
          session_id text not null,
          role text,
          status text not null,
          reason text not null,
          preview text,
          first_seen_at text not null,
          last_seen_at text not null,
          last_checked_at text,
          next_retry_at text,
          retry_count integer not null default 0,
          resolved_at text,
          resolved_by text,
          resolution text,
          resolution_note text,
          post_id text,
          metadata_json text,
          foreign key (topic_id) references topics(id),
          foreign key (session_id) references sessions(id),
          foreign key (post_id) references posts(id),
          unique (pi_session_id, pi_message_id, reason)
        );
        create index if not exists idx_pi_sync_anomalies_status on pi_sync_anomalies(status, next_retry_at);
        create index if not exists idx_pi_sync_anomalies_topic on pi_sync_anomalies(topic_id);
        create index if not exists idx_pi_sync_anomalies_session on pi_sync_anomalies(pi_session_id);
      `);
    },
  },
  {
    version: 29,
    name: 'plan-reasoning-checkpoints',
    up: (db) => {
      if (!hasColumn(db, 'plans', 'reasoning_checkpoints_json')) {
        db.prepare('alter table plans add column reasoning_checkpoints_json text').run();
      }
    },
  },
  {
    version: 30,
    name: 'silent-topic-moves',
    up: (db) => {
      if (!hasColumn(db, 'topic_moves', 'silent')) {
        db.prepare('alter table topic_moves add column silent integer not null default 0').run();
      }
      if (!hasColumn(db, 'sessions', 'context_synced_forum_id')) {
        db.prepare('alter table sessions add column context_synced_forum_id text').run();
      }
    },
  },
  {
    version: 31,
    name: 'clear-idle-current-plans',
    up: (db) => {
      db.prepare("update robot_state set current_plan_id = null where activity = 'idle' and current_plan_id is not null").run();
    },
  },
  {
    version: 32,
    name: 'pi-entry-index-and-active-branch',
    up: (db) => {
      db.exec(`
        create table if not exists pi_entry_index (
          pi_session_id text not null,
          entry_id text not null,
          parent_entry_id text,
          entry_type text not null,
          role text,
          custom_type text,
          entry_timestamp text,
          has_visible_text integer not null default 0,
          first_indexed_at text not null,
          metadata_json text,
          primary key (pi_session_id, entry_id)
        );
        create index if not exists idx_pi_entry_index_parent
          on pi_entry_index(pi_session_id, parent_entry_id);
        create index if not exists idx_pi_entry_index_type
          on pi_entry_index(pi_session_id, entry_type, role);

        create table if not exists pi_session_heads (
          pi_session_id text primary key,
          leaf_entry_id text,
          active_entry_ids_json text not null,
          observed_at text not null,
          metadata_json text
        );

        create table if not exists pi_projection_divergences (
          id text primary key,
          pi_session_id text not null,
          pi_message_id text not null,
          post_id text not null,
          first_observed_at text not null,
          last_observed_at text not null,
          status text not null default 'inactive_branch',
          metadata_json text,
          unique (pi_session_id, pi_message_id, post_id)
        );
        create index if not exists idx_pi_projection_divergences_session
          on pi_projection_divergences(pi_session_id, status);

        update pi_sync_anomalies
        set status = 'deferred', next_retry_at = null
        where status = 'needs_manual_review'
          and reason = 'live-topic-unmatched-visible-message';
      `);
    },
  },
];

export const SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export type MigrationRunOptions = {
  targetVersion?: number;
};

export function runMigrations(db: Database.Database, options?: MigrationRunOptions): void {
  ensureSchemaMigrationsTable(db);
  const applied = getAppliedVersions(db);
  const targetVersion = options?.targetVersion ?? Infinity;

  for (const migration of MIGRATIONS) {
    if (migration.version > targetVersion) break;
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      migration.up(db);
      db.prepare('insert into schema_migrations (version, name, applied_at) values (?, ?, ?)').run(
        migration.version,
        migration.name,
        nowIso()
      );
    })();
    applied.add(migration.version);
  }
}
