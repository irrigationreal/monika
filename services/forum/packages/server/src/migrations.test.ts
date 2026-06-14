import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  runMigrations,
  SCHEMA_VERSION
} from './migrations';

describe('schema migrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('records applied schema versions', () => {
    runMigrations(db);
    const rows = db
      .prepare('select version from schema_migrations order by version asc')
      .all() as Array<{ version: number }>;
    expect(rows).toHaveLength(MIGRATIONS.length);
    expect(rows.at(-1)?.version).toBe(SCHEMA_VERSION);
  });

});
