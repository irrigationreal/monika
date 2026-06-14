import { BrowserTokenStorage, createForumSdk } from '@irrigationreal/codex-forum-sdk';

const sdk = createForumSdk({
  storage: new BrowserTokenStorage()
});

export const api = sdk.api;
export const createStateStream = sdk.createStateStream;
export const createNotificationStream = sdk.createNotificationStream;
export const createChatStream = sdk.createChatStream;
export const getAuthToken = sdk.storage.getAuthToken.bind(sdk.storage);
export const setAuthToken = sdk.storage.setAuthToken.bind(sdk.storage);
export const getRefreshToken = sdk.storage.getRefreshToken.bind(sdk.storage);
export const setRefreshToken = sdk.storage.setRefreshToken.bind(sdk.storage);

export type * from '@irrigationreal/codex-forum-sdk';
