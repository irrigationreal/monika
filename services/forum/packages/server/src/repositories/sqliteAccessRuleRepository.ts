import type Database from 'better-sqlite3';
import type {
  AccessRule,
  AccessRuleRepository,
  AccessRuleScopeKind
} from '@irrigationreal/codex-forum-core';
import type { AccessRuleRow } from '../db';

function mapAccessRule(row: AccessRuleRow): AccessRule {
  return {
    id: row.id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    principalKind: row.principal_kind,
    principalId: row.principal_id,
    action: row.action,
    effect: row.effect,
    createdAt: row.created_at
  };
}

export class SqliteAccessRuleRepository implements AccessRuleRepository {
  constructor(private readonly db: Database.Database) {}

  async listByScope(scopeKind: AccessRuleScopeKind, scopeId: string): Promise<AccessRule[]> {
    const rows = this.db
      .prepare('select * from access_rules where scope_kind = ? and scope_id = ? order by created_at asc')
      .all(scopeKind, scopeId) as AccessRuleRow[];
    return rows.map(mapAccessRule);
  }

  async upsert(rule: AccessRule): Promise<AccessRule> {
    const principalId = rule.principalId ?? null;
    this.db
      .prepare(
        `insert into access_rules (id, scope_kind, scope_id, principal_kind, principal_id, action, effect, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(scope_kind, scope_id, principal_kind, principal_id, action)
         do update set effect = excluded.effect, created_at = excluded.created_at`
      )
      .run(
        rule.id,
        rule.scopeKind,
        rule.scopeId,
        rule.principalKind,
        principalId,
        rule.action,
        rule.effect,
        rule.createdAt
      );

    const row = this.db
      .prepare(
        `select * from access_rules
         where scope_kind = ?
           and scope_id = ?
           and principal_kind = ?
           and (principal_id = ? or (principal_id is null and ? is null))
           and action = ?`
      )
      .get(
        rule.scopeKind,
        rule.scopeId,
        rule.principalKind,
        principalId,
        principalId,
        rule.action
      ) as AccessRuleRow | undefined;

    if (!row) {
      throw new Error('access rule not found');
    }

    return mapAccessRule(row);
  }

  async delete(ruleId: string): Promise<boolean> {
    const result = this.db.prepare('delete from access_rules where id = ?').run(ruleId);
    return result.changes > 0;
  }
}
