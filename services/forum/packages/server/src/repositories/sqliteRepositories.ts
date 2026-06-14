import type Database from 'better-sqlite3';
import type {
  ExternalRef,
  ExternalRefKind,
  ExternalScopeKind,
  Identity,
  IdentityRepository,
  ExternalRefRepository
} from '@irrigationreal/codex-forum-core';
import type { ExternalRefRow, IdentityRow } from '../db';

type PublicIdentityRow = Pick<
  IdentityRow,
  | 'id'
  | 'tenant_id'
  | 'display_name'
  | 'kind'
  | 'parent_identity_id'
  | 'avatar_url'
  | 'created_at'
  | 'updated_at'
>;

const PUBLIC_IDENTITY_COLUMNS =
  'id, tenant_id, display_name, kind, parent_identity_id, avatar_url, created_at, updated_at';

function mapPublicIdentity(row: PublicIdentityRow): Identity {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    displayName: row.display_name,
    kind: row.kind as Identity['kind'],
    parentIdentityId: row.parent_identity_id,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapExternalRef(row: ExternalRefRow): ExternalRef {
  return {
    id: row.id,
    surfaceId: row.surface_id,
    surfaceKind: row.surface_kind as ExternalRef['surfaceKind'],
    externalId: row.external_id,
    kind: row.kind as ExternalRef['kind'],
    scope: row.scope,
    scopeKind: (row.scope_kind ?? null) as ExternalScopeKind | null,
    mappedForumId: row.mapped_forum_id,
    mappedTopicId: row.mapped_topic_id,
    mappedPostId: row.mapped_post_id,
    mappedIdentityId: row.mapped_identity_id
  };
}

export class SqliteIdentityRepository implements IdentityRepository {
  constructor(private readonly db: Database.Database) {}

  async getById(id: string): Promise<Identity | null> {
    const row = this.db
      .prepare(`select ${PUBLIC_IDENTITY_COLUMNS} from identities where id = ? limit 1`)
      .get(id) as PublicIdentityRow | undefined;
    return row ? mapPublicIdentity(row) : null;
  }

  async listByTopic(topicId: string, page = 1, pageSize = 100): Promise<Identity[]> {
    const offset = (page - 1) * pageSize;
    const rows = this.db
      .prepare(
        `select distinct ${PUBLIC_IDENTITY_COLUMNS}
         from identities i
         join posts p on p.author_id = i.id
         where p.topic_id = ?
         order by i.display_name asc
         limit ? offset ?`
      )
      .all(topicId, pageSize, offset) as PublicIdentityRow[];
    return rows.map(mapPublicIdentity);
  }

  async create(identity: Identity): Promise<void> {
    this.db
      .prepare(
        `insert into identities
          (id, tenant_id, display_name, kind, parent_identity_id, avatar_url, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        identity.id,
        identity.tenantId ?? null,
        identity.displayName,
        identity.kind,
        identity.parentIdentityId ?? null,
        identity.avatarUrl ?? null,
        identity.createdAt,
        identity.updatedAt
      );
  }

  async update(identity: Identity): Promise<void> {
    const result = this.db
      .prepare(
        `update identities
          set tenant_id = ?, display_name = ?, kind = ?, parent_identity_id = ?, avatar_url = ?, updated_at = ?
          where id = ?`
      )
      .run(
        identity.tenantId ?? null,
        identity.displayName,
        identity.kind,
        identity.parentIdentityId ?? null,
        identity.avatarUrl ?? null,
        identity.updatedAt,
        identity.id
      );
    if (result.changes === 0) {
      throw new Error('identity not found');
    }
  }
}

export class SqliteExternalRefRepository implements ExternalRefRepository {
  constructor(private readonly db: Database.Database) {}

  async getById(id: string): Promise<ExternalRef | null> {
    const row = this.db
      .prepare(
        'select id, surface_id, surface_kind, external_id, kind, scope, scope_kind, mapped_forum_id, mapped_topic_id, mapped_post_id, mapped_identity_id from external_refs where id = ? limit 1'
      )
      .get(id) as ExternalRefRow | undefined;
    return row ? mapExternalRef(row) : null;
  }

  async getByExternal(surfaceId: string, externalId: string, kind?: ExternalRefKind): Promise<ExternalRef | null> {
    const row = kind
      ? (this.db
          .prepare(
            'select id, surface_id, surface_kind, external_id, kind, scope, scope_kind, mapped_forum_id, mapped_topic_id, mapped_post_id, mapped_identity_id from external_refs where surface_id = ? and external_id = ? and kind = ? limit 1'
          )
          .get(surfaceId, externalId, kind) as ExternalRefRow | undefined)
      : (this.db
          .prepare(
            'select id, surface_id, surface_kind, external_id, kind, scope, scope_kind, mapped_forum_id, mapped_topic_id, mapped_post_id, mapped_identity_id from external_refs where surface_id = ? and external_id = ? limit 1'
          )
          .get(surfaceId, externalId) as ExternalRefRow | undefined);
    return row ? mapExternalRef(row) : null;
  }

  async listByTopic(topicId: string): Promise<ExternalRef[]> {
    const rows = this.db
      .prepare(
        'select id, surface_id, surface_kind, external_id, kind, scope, scope_kind, mapped_forum_id, mapped_topic_id, mapped_post_id, mapped_identity_id from external_refs where mapped_topic_id = ?'
      )
      .all(topicId) as ExternalRefRow[];
    return rows.map(mapExternalRef);
  }

  async create(ref: ExternalRef): Promise<void> {
    this.db
      .prepare(
        `insert into external_refs
          (id, surface_id, surface_kind, external_id, kind, scope, scope_kind, mapped_forum_id, mapped_topic_id, mapped_post_id, mapped_identity_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ref.id,
        ref.surfaceId,
        ref.surfaceKind,
        ref.externalId,
        ref.kind,
        ref.scope ?? null,
        ref.scopeKind ?? null,
        ref.mappedForumId ?? null,
        ref.mappedTopicId ?? null,
        ref.mappedPostId ?? null,
        ref.mappedIdentityId ?? null
      );
  }

  async update(ref: ExternalRef): Promise<void> {
    const result = this.db
      .prepare(
        `update external_refs
          set surface_id = ?, surface_kind = ?, external_id = ?, kind = ?, scope = ?, scope_kind = ?, mapped_forum_id = ?, mapped_topic_id = ?, mapped_post_id = ?, mapped_identity_id = ?
          where id = ?`
      )
      .run(
        ref.surfaceId,
        ref.surfaceKind,
        ref.externalId,
        ref.kind,
        ref.scope ?? null,
        ref.scopeKind ?? null,
        ref.mappedForumId ?? null,
        ref.mappedTopicId ?? null,
        ref.mappedPostId ?? null,
        ref.mappedIdentityId ?? null,
        ref.id
      );
    if (result.changes === 0) {
      throw new Error('external ref not found');
    }
  }
}
