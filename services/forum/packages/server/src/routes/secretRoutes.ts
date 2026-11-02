import { randomUUID } from 'node:crypto';

import { SecretWriteRequestSchema } from '@irrigationreal/codex-forum-contracts';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { SecretBroker } from '@irrigationreal/codex-forum-core';

import type { ForumStore } from '../store';
import type { AccessHelpers } from '../utils/access';

export function registerSecretRoutes({ app, store, access, broker }: { app: FastifyInstance; store: ForumStore; access: AccessHelpers; broker: SecretBroker }): void {
  const browserUser = (request: FastifyRequest): string => {
    const user = access.getCurrentUser(request);
    if (!user) throw app.httpErrors.unauthorized('Authentication required');
    if (user.authType !== 'session') throw app.httpErrors.forbidden('Secrets require a browser session');
    return user.identityId;
  };
  const dto = (secret: ReturnType<ForumStore['getSecret']>) => secret && ({
    id: secret.id, ownerIdentityId: secret.ownerIdentityId, name: secret.name, tags: secret.tags,
    expiresAt: secret.expiresAt, enabled: secret.enabled, createdAt: secret.createdAt, updatedAt: secret.updatedAt,
  });
  const adminUser = (request: FastifyRequest): string => {
    const owner = browserUser(request);
    access.requireAdmin(request);
    return owner;
  };
  const body = (app: FastifyInstance, request: FastifyRequest) => {
    const parsed = SecretWriteRequestSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? 'Invalid secret');
    return parsed.data;
  };
  const privateResponse = (reply: { header: (name: string, value: string) => unknown }) => reply.header('cache-control', 'no-store');

  app.get('/secrets', async (request, reply) => {
    privateResponse(reply);
    const owner = browserUser(request);
    return { items: store.listSecrets(owner).map(dto) };
  });
  app.get('/secrets/:id', async (request, reply) => {
    privateResponse(reply);
    const owner = browserUser(request);
    const secret = store.getSecret((request.params as { id: string }).id, owner);
    if (!secret) throw app.httpErrors.notFound('Secret not found');
    return { secret: dto(secret) };
  });
  app.get('/admin/secrets', async (request, reply) => {
    privateResponse(reply);
    browserUser(request);
    access.requireAdmin(request);
    return { items: store.listSecrets().map(dto) };
  });
  app.post('/secrets', async (request, reply) => {
    privateResponse(reply);
    const owner = browserUser(request);
    const input = body(app, request);
    const id = randomUUID();
    const enabled = input.enabled ?? true;
    await broker.putSecret(id, { value: input.value, name: input.name, tags: input.tags, expiresAt: input.expiresAt ?? null, enabled });
    const secret = store.createSecret({ id, ownerIdentityId: owner, name: input.name, tags: input.tags, expiresAt: input.expiresAt ?? null, enabled });
    return { secret: dto(secret) };
  });
  app.put('/secrets/:id', async (request, reply) => {
    privateResponse(reply);
    const owner = browserUser(request);
    const id = (request.params as { id: string }).id;
    const current = store.getSecret(id, owner);
    if (!current) throw app.httpErrors.notFound('Secret not found');
    const input = body(app, request);
    const enabled = input.enabled ?? current.enabled;
    await broker.putSecret(id, { value: input.value, name: input.name, tags: input.tags, expiresAt: input.expiresAt ?? null, enabled });
    const secret = store.updateSecret(id, owner, { name: input.name, tags: input.tags, expiresAt: input.expiresAt ?? null, enabled });
    return { secret: dto(secret) };
  });
  app.patch('/secrets/:id/disable', async (request, reply) => {
    privateResponse(reply);
    const owner = browserUser(request);
    const id = (request.params as { id: string }).id;
    const current = store.getSecret(id, owner);
    if (!current) throw app.httpErrors.notFound('Secret not found');
    await broker.disableSecret(id);
    const secret = store.updateSecret(id, owner, { name: current.name, tags: current.tags, expiresAt: current.expiresAt, enabled: false });
    return { secret: dto(secret) };
  });
  app.delete('/secrets/:id', async (request, reply) => {
    privateResponse(reply);
    const owner = browserUser(request);
    const id = (request.params as { id: string }).id;
    if (!store.getSecret(id, owner)) throw app.httpErrors.notFound('Secret not found');
    await broker.deleteSecret(id);
    store.deleteSecret(id, owner);
    return { ok: true };
  });
  app.put('/admin/secrets/:id', async (request, reply) => {
    privateResponse(reply);
    adminUser(request);
    const id = (request.params as { id: string }).id;
    const current = store.getSecret(id);
    if (!current) throw app.httpErrors.notFound('Secret not found');
    const input = body(app, request);
    const enabled = input.enabled ?? current.enabled;
    await broker.putSecret(id, { value: input.value, name: input.name, tags: input.tags, expiresAt: input.expiresAt ?? null, enabled });
    const secret = store.updateSecret(id, current.ownerIdentityId, { name: input.name, tags: input.tags, expiresAt: input.expiresAt ?? null, enabled });
    return { secret: dto(secret) };
  });
  app.patch('/admin/secrets/:id/disable', async (request, reply) => {
    privateResponse(reply);
    adminUser(request);
    const id = (request.params as { id: string }).id;
    const current = store.getSecret(id);
    if (!current) throw app.httpErrors.notFound('Secret not found');
    await broker.disableSecret(id);
    const secret = store.updateSecret(id, current.ownerIdentityId, { name: current.name, tags: current.tags, expiresAt: current.expiresAt, enabled: false });
    return { secret: dto(secret) };
  });
  app.delete('/admin/secrets/:id', async (request, reply) => {
    privateResponse(reply);
    adminUser(request);
    const id = (request.params as { id: string }).id;
    if (!store.getSecret(id)) throw app.httpErrors.notFound('Secret not found');
    await broker.deleteSecret(id);
    store.deleteSecret(id);
    return { ok: true };
  });
}
