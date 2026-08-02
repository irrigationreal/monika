import { BASE_URL } from '../runtimeConfig';
import { FORUM_SESSION_COOKIE } from '../utils/access';
import { generateToken } from '../utils/auth';

import type { AuthenticationMethod } from '@irrigationreal/codex-forum-core';
import type { FastifyReply } from 'fastify';

import type { ForumStore } from '../store';

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const secure = new URL(BASE_URL).protocol === 'https:';

export function issueBrowserSession(
  reply: FastifyReply,
  store: ForumStore,
  identityId: string,
  method: Exclude<AuthenticationMethod, 'internal'>
): void {
  // Issue an independent per-device session. Credential changes deliberately
  // revoke other sessions, but ordinary login must not sign out other devices.
  const token = generateToken('cforum_session');
  store.createAuthSession(token, identityId, 7, method);
  const attributes = [
    `${FORUM_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${String(SESSION_MAX_AGE_SECONDS)}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ];
  reply.header('set-cookie', attributes.join('; '));
}

export function clearBrowserSession(reply: FastifyReply): void {
  const attributes = [
    `${FORUM_SESSION_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ];
  reply.header('set-cookie', attributes.join('; '));
}
