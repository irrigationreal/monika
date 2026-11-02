import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { registerSecretRoutes } from './secretRoutes';

describe('secret routes', () => {
  let db: Database.Database;
  let store: ForumStore;
  const broker = { putSecret: async () => undefined, disableSecret: async () => undefined, deleteSecret: async () => undefined };
  beforeEach(() => { db = new Database(':memory:'); migrate(db); store = new ForumStore(db); });
  afterEach(() => db.close());
  async function app() {
    const instance = Fastify({ logger: false });
    await instance.register(sensible);
    registerSecretRoutes({ app: instance, store, access: createAccessHelpers(instance, store), broker });
    await instance.ready();
    return instance;
  }
  it('requires browser sessions, enforces SQL-backed ownership, and never returns plaintext', async () => {
    const instance = await app();
    const owner = store.createIdentity('Owner');
    const other = store.createIdentity('Other');
    store.createAuthSession('owner-token', owner.id);
    store.createAuthSession('other-token', other.id);
    expect((await instance.inject({ method: 'GET', url: '/secrets' })).statusCode).toBe(401);
    const created = await instance.inject({ method: 'POST', url: '/secrets', headers: { authorization: 'Bearer owner-token' }, payload: { name: 'API token', value: 'plaintext-value', tags: ['prod'] } });
    expect(created.statusCode).toBe(200);
    expect(JSON.stringify(created.json())).not.toContain('plaintext-value');
    expect((db.prepare('select * from secrets').get() as { name: string; tags_json: string }).name).toBe('API token');
    expect(JSON.stringify(db.prepare('select * from secrets').get())).not.toContain('plaintext-value');
    const id = created.json().secret.id as string;
    expect((await instance.inject({ method: 'GET', url: '/secrets', headers: { authorization: 'Bearer other-token' } })).json()).toEqual({ items: [] });
    expect((await instance.inject({ method: 'DELETE', url: `/secrets/${id}`, headers: { authorization: 'Bearer other-token' } })).statusCode).toBe(404);
    expect((await instance.inject({ method: 'GET', url: '/secrets', headers: { authorization: 'Bearer owner-token' } })).json().items[0]).not.toHaveProperty('value');
  });
  it('preserves disabled state when replacing a secret without explicit enablement', async () => {
    const instance = await app();
    const owner = store.createIdentity('Owner');
    store.createAuthSession('owner-token', owner.id);
    const created = await instance.inject({ method: 'POST', url: '/secrets', headers: { authorization: 'Bearer owner-token' }, payload: { name: 'API token', value: 'first-value' } });
    const id = created.json().secret.id as string;
    expect((await instance.inject({ method: 'PATCH', url: `/secrets/${id}/disable`, headers: { authorization: 'Bearer owner-token' } })).statusCode).toBe(200);
    const replaced = await instance.inject({ method: 'PUT', url: `/secrets/${id}`, headers: { authorization: 'Bearer owner-token' }, payload: { name: 'API token', value: 'second-value' } });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().secret.enabled).toBe(false);
  });
});
