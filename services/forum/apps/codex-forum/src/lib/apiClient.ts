import { createForumSdk } from '@irrigationreal/codex-forum-sdk';

const sdk = createForumSdk();

export const api = sdk.api;
export const createStateStream = sdk.createStateStream;
export const createNotificationStream = sdk.createNotificationStream;
export const createChatStream = sdk.createChatStream;

export type * from '@irrigationreal/codex-forum-sdk';
