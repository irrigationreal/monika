import type { FastifyRequest } from 'fastify';
import type { AccessHelpers } from './access';

export function rateLimitKeyForRequest(request: FastifyRequest, access: Pick<AccessHelpers, 'getCurrentUser'>): string {
  const user = access.getCurrentUser(request);
  if (!user) {
    return `ip:${request.ip}`;
  }

  if (user.authType === 'apiKey' && user.tokenId) {
    return `apiKey:${user.tokenId}`;
  }

  if (user.authType === 'impersonation' && user.tokenId) {
    return `impersonation:${user.tokenId}`;
  }

  return `identity:${user.identityId}`;
}
