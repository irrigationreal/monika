import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from './migrations';

describe('migration 47 unified user files', () => {
  it('preserves legacy IDs and grandfathers standalone files as private and never-expiring', () => {
    const db = new Database(':memory:');
    runMigrations(db, { targetVersion: 46 });
    const now = '2026-01-01T00:00:00.000Z';
    db.prepare(
      "insert into identities (id,display_name,kind,created_at,updated_at) values ('human','Human','human',?,?)"
    ).run(now, now);
    db.prepare(
      "insert into forums (id,name,status,visibility,created_at,updated_at) values ('forum','Forum','active','public',?,?)"
    ).run(now, now);
    db.prepare(
      "insert into topics (id,forum_id,title,status,tags_json,created_by,created_at,updated_at) values ('topic','forum','Topic','open','[]','human',?,?)"
    ).run(now, now);
    db.prepare(
      "insert into posts (id,topic_id,author_id,body,created_at) values ('post','topic','human','body',?)"
    ).run(now);
    db.prepare(
      "insert into posts (id,topic_id,author_id,body,created_at,deleted_at) values ('deleted-post','topic','human','[This post has been deleted]',?,?)"
    ).run(now, now);
    db.prepare(
      "insert into user_files (id,identity_id,filename,mime_type,size_bytes,storage_path,created_at) values ('user-file','human','u.txt','text/plain',1,'/tmp/u',?)"
    ).run(now);
    db.prepare(
      "insert into attachments (id,post_id,filename,mime_type,size_bytes,storage_path,sha256,created_at) values ('attachment','post','a.txt','text/plain',1,'/tmp/a','sha',?)"
    ).run(now);
    db.prepare(
      "insert into attachments (id,post_id,filename,mime_type,size_bytes,storage_path,sha256,created_at) values ('deleted-attachment','deleted-post','secret.txt','text/plain',1,'/tmp/secret','secret-sha',?)"
    ).run(now);
    runMigrations(db);
    expect(
      db
        .prepare("select id, identity_id, standalone, visibility, expires_at from user_files where id='user-file'")
        .get()
    ).toEqual({ id: 'user-file', identity_id: 'human', standalone: 1, visibility: 'private', expires_at: null });
    expect(db.prepare("select id, post_id, deleted_at from attachments where id='attachment'").get()).toEqual({
      id: 'attachment',
      post_id: 'post',
      deleted_at: null,
    });
    expect(db.prepare("select deleted_at, delete_reason from attachments where id='deleted-attachment'").get()).toEqual(
      {
        deleted_at: now,
        delete_reason: 'post_deleted',
      }
    );
    expect(db.prepare("select identity_id, standalone from user_files where id='post-file-attachment'").get()).toEqual({
      identity_id: 'human',
      standalone: 0,
    });
    expect(
      db.prepare("select name from sqlite_master where type='table' and name='file_deletion_queue'").get()
    ).toEqual({
      name: 'file_deletion_queue',
    });
    db.close();
  });
});
