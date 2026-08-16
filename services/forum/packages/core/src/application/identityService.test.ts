import { describe, expect, it } from 'vitest';

import { IdentityServiceImpl } from './identityService';

import type { IdentityPrivate } from '../domain/entities';
import type { IdentityRepository } from '../interfaces/repositories';

const privateIdentity: IdentityPrivate = {
  id: 'identity-1',
  displayName: 'Reader',
  kind: 'human',
  username: 'reader',
  passwordHash: 'secret',
  privateEmail: 'reader@example.com',
  quickReplyDesktopMode: 'docked',
  quickReplyMobileMode: 'inline',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

describe('IdentityServiceImpl', () => {
  it('strips every private account field from the public identity projection', async () => {
    const repo: IdentityRepository = {
      getById: async () => privateIdentity,
      listByTopic: async () => [],
      create: async () => {},
      update: async () => {},
    };
    const service = new IdentityServiceImpl(repo);

    const identity = await service.getIdentity(privateIdentity.id);

    expect(identity).toMatchObject({ id: privateIdentity.id, displayName: 'Reader' });
    expect(identity).not.toHaveProperty('username');
    expect(identity).not.toHaveProperty('passwordHash');
    expect(identity).not.toHaveProperty('privateEmail');
    expect(identity).not.toHaveProperty('quickReplyDesktopMode');
    expect(identity).not.toHaveProperty('quickReplyMobileMode');
  });
});
