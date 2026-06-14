import type { FastifyInstance } from 'fastify';
import type { ForumStore } from '../store';
import type { AccessHelpers } from '../utils/access';

export function registerTenantRoutes({
  app,
  store,
  access
}: {
  app: FastifyInstance;
  store: ForumStore;
  access: AccessHelpers;
}): void {
  const { requireAdmin, getCurrentUser, requireScope } = access;

  // Tenant management endpoints (admin only)
  app.get('/tenants', async (request) => {
    requireAdmin(request);
    const tenants = store.listTenants();
    return tenants.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      settings: JSON.parse(t.settings_json),
      createdAt: t.created_at,
      updatedAt: t.updated_at
    }));
  });

  app.post('/tenants', async (request) => {
    requireAdmin(request);
    const body = request.body as { name?: string; slug?: string; settings?: Record<string, unknown> };
    if (!body?.name || !body?.slug) {
      throw app.httpErrors.badRequest('name and slug are required');
    }

    const existing = store.getTenantBySlug(body.slug);
    if (existing) {
      throw app.httpErrors.conflict('Tenant with this slug already exists');
    }

    const tenant = store.createTenant(body.name, body.slug, body.settings ?? {});
    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      settings: JSON.parse(tenant.settings_json),
      createdAt: tenant.created_at,
      updatedAt: tenant.updated_at
    };
  });

  app.get('/tenants/:tenantId', async (request) => {
    requireAdmin(request);
    const { tenantId } = request.params as { tenantId: string };
    const tenant = store.getTenant(tenantId);
    if (!tenant) {
      throw app.httpErrors.notFound('Tenant not found');
    }
    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      settings: JSON.parse(tenant.settings_json),
      createdAt: tenant.created_at,
      updatedAt: tenant.updated_at
    };
  });

  app.patch('/tenants/:tenantId', async (request) => {
    requireAdmin(request);
    const { tenantId } = request.params as { tenantId: string };
    const body = request.body as { name?: string; settings?: Record<string, unknown> };

    try {
      const tenant = store.updateTenant(tenantId, body);
      return {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        settings: JSON.parse(tenant.settings_json),
        createdAt: tenant.created_at,
        updatedAt: tenant.updated_at
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'update failed';
      if (message === 'tenant not found') {
        throw app.httpErrors.notFound(message);
      }
      throw app.httpErrors.badRequest(message);
    }
  });

  app.delete('/tenants/:tenantId', async (request) => {
    requireAdmin(request);
    const { tenantId } = request.params as { tenantId: string };
    const tenant = store.getTenant(tenantId);
    if (!tenant) {
      throw app.httpErrors.notFound('Tenant not found');
    }
    store.deleteTenant(tenantId);
    return { ok: true };
  });

  // Role management endpoints (admin only)
  app.get('/roles', async (request) => {
    requireAdmin(request);
    const tenantId = (request.query as { tenantId?: string }).tenantId ?? null;
    const roles = store.listRoles(tenantId);
    return roles.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      permissions: JSON.parse(r.permissions_json),
      createdAt: r.created_at
    }));
  });

  app.post('/roles', async (request) => {
    requireAdmin(request);
    const body = request.body as { name?: string; permissions?: string[]; tenantId?: string | null };
    if (!body?.name) {
      throw app.httpErrors.badRequest('name is required');
    }

    const role = store.createRole(body.name, body.permissions ?? [], body.tenantId ?? null);
    return {
      id: role.id,
      tenantId: role.tenant_id,
      name: role.name,
      permissions: JSON.parse(role.permissions_json),
      createdAt: role.created_at
    };
  });

  app.patch('/roles/:roleId', async (request) => {
    requireAdmin(request);
    const { roleId } = request.params as { roleId: string };
    const body = request.body as { name?: string; permissions?: string[] };

    try {
      const role = store.updateRole(roleId, body);
      return {
        id: role.id,
        tenantId: role.tenant_id,
        name: role.name,
        permissions: JSON.parse(role.permissions_json),
        createdAt: role.created_at
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'update failed';
      if (message === 'role not found') {
        throw app.httpErrors.notFound(message);
      }
      throw app.httpErrors.badRequest(message);
    }
  });

  app.delete('/roles/:roleId', async (request) => {
    requireAdmin(request);
    const { roleId } = request.params as { roleId: string };
    const role = store.getRole(roleId);
    if (!role) {
      throw app.httpErrors.notFound('Role not found');
    }
    store.deleteRole(roleId);
    return { ok: true };
  });

  // Identity-Role assignment endpoints (admin only)
  app.post('/identities/:identityId/roles', async (request) => {
    requireAdmin(request);
    const { identityId } = request.params as { identityId: string };
    const body = request.body as { roleId?: string; tenantId?: string | null };
    if (!body?.roleId) {
      throw app.httpErrors.badRequest('roleId is required');
    }

    const identity = store.getIdentity(identityId);
    if (!identity) {
      throw app.httpErrors.notFound('Identity not found');
    }

    const role = store.getRole(body.roleId);
    if (!role) {
      throw app.httpErrors.notFound('Role not found');
    }

    store.assignRole(identityId, body.roleId, body.tenantId ?? null);
    return { ok: true };
  });

  app.delete('/identities/:identityId/roles/:roleId', async (request) => {
    requireAdmin(request);
    const { identityId, roleId } = request.params as { identityId: string; roleId: string };
    const tenantId = (request.query as { tenantId?: string }).tenantId ?? null;

    store.revokeRole(identityId, roleId, tenantId);
    return { ok: true };
  });

  app.get('/identities/:identityId/roles', async (request) => {
    const user = requireScope(getCurrentUser(request), 'read');
    const { identityId } = request.params as { identityId: string };
    const tenantId = (request.query as { tenantId?: string }).tenantId ?? null;

    // Users can view their own roles, admins can view anyone's
    const currentIdentity = user ? store.getIdentity(user.identityId) : null;
    if (user?.identityId !== identityId && currentIdentity?.kind !== 'admin') {
      throw app.httpErrors.forbidden('Cannot view other users roles');
    }

    const roles = store.listIdentityRoles(identityId, tenantId);
    return roles.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      permissions: JSON.parse(r.permissions_json),
      createdAt: r.created_at
    }));
  });

  app.get('/identities/:identityId/permissions', async (request) => {
    const user = requireScope(getCurrentUser(request), 'read');
    const { identityId } = request.params as { identityId: string };
    const tenantId = (request.query as { tenantId?: string }).tenantId ?? null;

    // Users can view their own permissions, admins can view anyone's
    const currentIdentity = user ? store.getIdentity(user.identityId) : null;
    if (user?.identityId !== identityId && currentIdentity?.kind !== 'admin') {
      throw app.httpErrors.forbidden('Cannot view other users permissions');
    }

    const permissions = store.getIdentityPermissions(identityId, tenantId);
    return { permissions };
  });
}
