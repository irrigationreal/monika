import type {
  AccessRuleDto,
  AdminCancelDeployOnFinishResponseDto,
  AdminDeployOnFinishResponseDto,
  AdminDeployResponseDto,
  AdminDeployStatusDto,
  AdminForumDto,
  AdminRobotPersonaDto,
  AdminSkillDto,
  AdminSkillListResponseDto,
  AdminSkillRootDto,
  AdminUserDto,
  AttachmentDto,
  ApiKeyCreateResponseDto,
  ApiKeyDto,
  ApiKeyListResponseDto,
  AuthUserDto,
  ChatCategoryDto,
  ChatCategoryListDto,
  ChatMessageDto,
  ChatMessagePageDto,
  ChatPresenceDto,
  ChatPresenceEventDto,
  ChatPresenceStateDto,
  ChatRoomDto,
  ChatRoomListDto,
  ChatTypingDto,
  DiscordBridgeStatusDto,
  DiscordChannelMappingDto,
  UserFileDto,
  ForumDto,
  ForumLastPostDto,
  ListForumsRequest,
  LoginResponseDto,
  ImpersonationTokenCreateResponseDto,
  RecentPostDto,
  RegistrationModeDto,
  ForumThemeKey,
  IdentityDto,
  IdentityPermissionsDto,
  ImpersonationTokenDto,
  ImpersonationTokenListResponseDto,
  InviteInfoDto,
  InviteDto,
  PageResponse,
  PostDto,
  RegisterResponseDto,
  SearchResultsDto,
  UserProfileDto,
  UserPostHistoryItemDto,
  UserPostHistoryResponseDto,
  RobotAutomationDto,
  RobotAutomationRunDto,
  TopicAutoRunDto,
  RobotDashboardDto,
  RobotPersonaDto,
  RobotQueueItemDto,
  RobotJobDto,
  RobotStateDto,
  TamperConfigDto,
  TamperPluginDto,
  TamperTestResultDto,
  SessionDto,
  SessionInspectorDto,
  ToolRunDto,
  TopicDto,
  TopicMoveDto,
  UpdatePrivateEmailResponseDto,
  VerifyResponseDto,
  OidcExternalIdentityListResponseDto,
  OidcUnlinkResponseDto,
  MatrixBridgeStatusDto,
  MatrixRoomMappingDto,
  ModelCatalogDto,
  ModelInfoDto,
  NotificationDto,
  PiSyncBackfillResponseDto,
  PiSyncHealthDto,
  PiSyncRunResponseDto,
  TopicSubscriptionDto,
  TopicUnreadDto
} from '@irrigationreal/codex-forum-contracts';

import type { ForumApi } from '@irrigationreal/codex-forum-contracts';
import { BrowserTokenStorage, MemoryTokenStorage, type TokenStorage } from './storage';

export type {
  AccessRuleDto,
  AdminCancelDeployOnFinishResponseDto,
  AdminDeployOnFinishResponseDto,
  AdminDeployResponseDto,
  AdminDeployStatusDto,
  AdminForumDto,
  AdminRobotPersonaDto,
  AdminSkillDto,
  AdminSkillListResponseDto,
  AdminSkillRootDto,
  AdminUserDto,
  AttachmentDto,
  ApiKeyCreateResponseDto,
  ApiKeyDto,
  ApiKeyListResponseDto,
  AuthUserDto,
  ChatCategoryDto,
  ChatCategoryListDto,
  ChatMessageDto,
  ChatMessagePageDto,
  ChatPresenceDto,
  ChatPresenceEventDto,
  ChatPresenceStateDto,
  ChatRoomDto,
  ChatRoomListDto,
  ChatTypingDto,
  DiscordBridgeStatusDto,
  DiscordChannelMappingDto,
  UserFileDto,
  ForumDto,
  ForumLastPostDto,
  ListForumsRequest,
  LoginResponseDto,
  ImpersonationTokenCreateResponseDto,
  RecentPostDto,
  RegistrationModeDto,
  ForumThemeKey,
  IdentityDto,
  IdentityPermissionsDto,
  ImpersonationTokenDto,
  ImpersonationTokenListResponseDto,
  InviteInfoDto,
  InviteDto,
  PageResponse,
  PostDto,
  RegisterResponseDto,
  SearchResultsDto,
  UserProfileDto,
  UserPostHistoryItemDto,
  UserPostHistoryResponseDto,
  RobotAutomationDto,
  RobotAutomationRunDto,
  TopicAutoRunDto,
  RobotDashboardDto,
  RobotPersonaDto,
  RobotQueueItemDto,
  RobotJobDto,
  RobotStateDto,
  TamperConfigDto,
  TamperPluginDto,
  TamperTestResultDto,
  SessionDto,
  SessionInspectorDto,
  ToolRunDto,
  TopicDto,
  TopicMoveDto,
  UpdatePrivateEmailResponseDto,
  VerifyResponseDto,
  MatrixBridgeStatusDto,
  MatrixRoomMappingDto,
  ModelCatalogDto,
  ModelInfoDto,
  NotificationDto,
  PiSyncBackfillResponseDto,
  PiSyncHealthDto,
  PiSyncRunResponseDto,
  TopicSubscriptionDto,
  TopicUnreadDto,
  ForumApi
};

export { BrowserTokenStorage, MemoryTokenStorage };
export type { TokenStorage };

export type ListForumsParams = ListForumsRequest;
export type PiSyncHealth = PiSyncHealthDto;
export type PiSyncRunResponse = PiSyncRunResponseDto;
export type PiSyncBackfillResponse = PiSyncBackfillResponseDto;
export type AdminDeployStatus = AdminDeployStatusDto;
export type AdminDeployResponse = AdminDeployResponseDto;
export type AdminDeployOnFinishResponse = AdminDeployOnFinishResponseDto;
export type AdminCancelDeployOnFinishResponse = AdminCancelDeployOnFinishResponseDto;
export type DiscordChannelMapping = DiscordChannelMappingDto;
export type DiscordBridgeStatus = DiscordBridgeStatusDto;
export type MatrixRoomMapping = MatrixRoomMappingDto;
export type MatrixBridgeStatus = MatrixBridgeStatusDto;

export interface ForumSdkOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  storage?: TokenStorage;
  eventSourceFactory?: (url: string) => EventSource;
}

type JsonFn = <T>(path: string, init?: RequestInit, options?: { skipRefresh?: boolean }) => Promise<T>;

function createApi({
  json,
  baseUrl,
  fetchImpl,
  storage
}: {
  json: JsonFn;
  baseUrl: string;
  fetchImpl: typeof fetch;
  storage: TokenStorage;
}) {
  return {
    login: (username: string, password: string) =>
      json<LoginResponseDto>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
    logout: () =>
      json<{ ok: boolean }>('/auth/logout', {
        method: 'POST',
        headers: storage.getRefreshToken() ? { 'x-refresh-token': storage.getRefreshToken() as string } : undefined
      }),
    refresh: () =>
      json<{ token: string | null; refreshToken: string | null; message?: string }>(
        '/auth/refresh',
        { method: 'POST' },
        { skipRefresh: true }
      ),
    me: () =>
      json<AuthUserDto>('/auth/me'),
    updatePrivateEmail: (emailAddress: string | null) =>
      json<UpdatePrivateEmailResponseDto>('/me/private-email', { method: 'PATCH', body: JSON.stringify({ emailAddress }) }),
    changePassword: (input: { currentPassword: string; newPassword: string }) =>
      json<{ ok: boolean }>('/me/password', { method: 'POST', body: JSON.stringify(input) }),
    listApiKeys: () =>
      json<ApiKeyListResponseDto>('/api-keys'),
    createApiKey: (input: { label: string; scopes?: string[]; expiresAt?: string | null }) =>
      json<ApiKeyCreateResponseDto>('/api-keys', { method: 'POST', body: JSON.stringify(input) }),
    revokeApiKey: (id: string) =>
      json<{ ok: boolean }>(`/api-keys/${id}`, { method: 'DELETE' }),
    listImpersonationTokens: () =>
      json<ImpersonationTokenListResponseDto>('/impersonation-tokens'),
    createImpersonationToken: (input: {
      label: string;
      displayName: string;
      avatarUrl?: string | null;
      scopes?: string[];
      expiresAt?: string | null;
    }) =>
      json<ImpersonationTokenCreateResponseDto>('/impersonation-tokens', { method: 'POST', body: JSON.stringify(input) }),
    revokeImpersonationToken: (id: string) =>
      json<{ ok: boolean }>(`/impersonation-tokens/${id}`, { method: 'DELETE' }),
    registrationMode: () =>
      json<RegistrationModeDto>('/auth/registration'),
    register: (displayName: string, inviteCode?: string, username?: string, password?: string) =>
      json<RegisterResponseDto>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ displayName, inviteCode, username, password })
      }),
    verify: (token: string) =>
      json<VerifyResponseDto>(`/auth/verify/${token}`),
    oidcEnabled: () =>
      json<{ enabled: boolean; providerKey: string | null }>(`/auth/oidc/enabled`),
    oidcStartUrl: () => `${baseUrl}/auth/oidc/start`,
    oidcStartLinkUrl: () => `${baseUrl}/auth/oidc/start/link`,
    oidcLink: (input: { username: string; password: string; subject: string; issuer?: string; providerKey?: string }) =>
      json<{ token: string; refreshToken?: string; linked?: boolean }>(`/auth/oidc/link`, { method: 'POST', body: JSON.stringify(input) }),
    oidcListLinks: () =>
      json<OidcExternalIdentityListResponseDto>(`/auth/oidc/links`),
    oidcUnlink: (input: { externalIdentityId: string }) =>
      json<OidcUnlinkResponseDto>(`/auth/oidc/unlink`, { method: 'POST', body: JSON.stringify(input) }),
    listModels: () =>
      json<ModelCatalogDto>('/models'),
    getInviteInfo: (code: string) =>
      json<InviteInfoDto>(`/auth/invite/${code}`),
    updateIdentity: (
      identityId: string,
      updates: { displayName?: string; avatarUrl?: string; location?: string | null; signature?: string | null; theme?: ForumThemeKey | null }
    ) =>
      json<IdentityDto>(`/identities/${identityId}`, {
        method: 'PATCH',
        body: JSON.stringify(updates)
      }),
    getIdentityPermissions: (identityId: string) =>
      json<IdentityPermissionsDto>(`/identities/${identityId}/permissions`),
    getUserProfile: (identityId: string) =>
      json<UserProfileDto>(`/profiles/${identityId}`),
    listUserPostHistory: (identityId: string, page = 1, pageSize = 25) => {
      const safePage = Math.max(1, Math.trunc(page));
      const safePageSize = Math.max(1, Math.min(50, Math.trunc(pageSize)));
      return json<UserPostHistoryResponseDto>(`/profiles/${identityId}/posts?page=${safePage}&pageSize=${safePageSize}`);
    },
    uploadAvatar: async (identityId: string, file: File): Promise<{ id: string; displayName: string; avatarUrl: string; message: string }> => {
      const token = storage.getAuthToken();
      const formData = new FormData();
      formData.append('file', file);

      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const res = await fetchImpl(`${baseUrl}/identities/${identityId}/avatar`, {
        method: 'POST',
        headers,
        body: formData
      });

      if (!res.ok) {
        let errorMessage = `Upload failed: ${String(res.status)}`;
        try {
          const errorBody = await res.json() as { message?: string };
          if (errorBody.message) {
            errorMessage = errorBody.message;
          }
        } catch {
          // Ignore JSON parse errors
        }
        throw new Error(errorMessage);
      }

      return (await res.json()) as { id: string; displayName: string; avatarUrl: string; message: string };
    },
    listUserFiles: () =>
      json<UserFileDto[]>('/user-files'),
    uploadUserFile: async (file: File): Promise<UserFileDto> => {
      const token = storage.getAuthToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const formData = new FormData();
      formData.append('file', file);

      const res = await fetchImpl(`${baseUrl}/user-files`, {
        method: 'POST',
        headers,
        body: formData
      });

      if (!res.ok) {
        let errorMessage = `Upload failed: ${String(res.status)}`;
        try {
          const errorBody = await res.json() as { message?: string };
          if (errorBody.message) {
            errorMessage = errorBody.message;
          }
        } catch {
          // Ignore JSON parse errors
        }
        throw new Error(errorMessage);
      }

      return (await res.json()) as UserFileDto;
    },
    deleteUserFile: (fileId: string) =>
      json<{ ok: boolean }>(`/user-files/${fileId}`, { method: 'DELETE' }),
    listPostAttachments: (postId: string) =>
      json<AttachmentDto[]>(`/posts/${postId}/attachments`),
    // NOTE: uploadPostAttachment implementation continues below in the original file.
  };
}

export type ForumSdkApi = ReturnType<typeof createApi>;

export interface ForumSdk {
  api: ForumSdkApi;
  createStateStream: (topicId: string) => EventSource;
  createNotificationStream: () => EventSource;
  createChatStream: (roomId: string) => EventSource;
  storage: TokenStorage;
  baseUrl: string;
}

const normalizeBaseUrl = (baseUrl?: string): string => {
  if (!baseUrl) return '/api';
  const trimmed = baseUrl.trim();
  if (!trimmed) return '/api';
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
};

const defaultEventSourceFactory = (url: string): EventSource => {
  if (typeof EventSource === 'undefined') {
    throw new Error('EventSource is not available; provide eventSourceFactory in ForumSdkOptions.');
  }
  return new EventSource(url);
};

export function createForumSdk(options?: ForumSdkOptions): ForumSdk {
  const baseUrl = normalizeBaseUrl(options?.baseUrl);
  const fetchImpl = options?.fetch ?? fetch;
  const storage = options?.storage ?? new BrowserTokenStorage();
  const eventSourceFactory = options?.eventSourceFactory ?? defaultEventSourceFactory;

  async function refreshAuthTokens(): Promise<{ token: string; refreshToken: string } | null> {
    const refreshToken = storage.getRefreshToken();
    if (!refreshToken) return null;
    const res = await fetchImpl(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        'x-refresh-token': refreshToken
      }
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { token?: string | null; refreshToken?: string | null };
    if (!body.token || !body.refreshToken) {
      return null;
    }
    storage.setAuthToken(body.token);
    storage.setRefreshToken(body.refreshToken);
    return { token: body.token, refreshToken: body.refreshToken };
  }

  async function json<T>(path: string, init?: RequestInit, options?: { skipRefresh?: boolean }): Promise<T> {
    const token = storage.getAuthToken();
    const headers: Record<string, string> = {};
    if (init?.body) {
      headers['Content-Type'] = 'application/json';
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const initHeaders = init?.headers;
    const normalizedInitHeaders =
      initHeaders instanceof Headers
        ? Object.fromEntries(initHeaders.entries())
        : Array.isArray(initHeaders)
          ? Object.fromEntries(initHeaders)
          : initHeaders ?? {};
    const { headers: _ignored, ...restInit } = init ?? {};
    const res = await fetchImpl(`${baseUrl}${path}`, {
      headers: {
        ...headers,
        ...(normalizedInitHeaders as Record<string, string>)
      },
      ...restInit
    });
    const refreshEligible =
      !options?.skipRefresh &&
      !path.startsWith('/auth/refresh') &&
      !path.startsWith('/auth/login') &&
      !path.startsWith('/auth/register') &&
      !path.startsWith('/auth/verify') &&
      !path.startsWith('/auth/invite');
    if (res.status === 401 && refreshEligible) {
      const refreshed = await refreshAuthTokens();
      if (refreshed) {
        return json<T>(path, init, { skipRefresh: true });
      }
    }
    if (!res.ok) {
      let errorMessage = `Request failed: ${String(res.status)}`;
      let errorCode: string | undefined;
      let errorDetails: Record<string, unknown> | undefined;
      try {
        const errorBody = (await res.json()) as { message?: string; code?: string; details?: Record<string, unknown> };
        if (errorBody.message) {
          errorMessage = errorBody.message;
        }
        if (errorBody.code) {
          errorCode = errorBody.code;
        }
        if (errorBody.details) {
          errorDetails = errorBody.details;
        }
      } catch {
        // Ignore JSON parse errors
      }
      if (res.status === 401) {
        errorMessage = 'Please log in to continue. ' + errorMessage;
      }
      const error = new Error(errorMessage) as Error & { code?: string; status?: number; details?: Record<string, unknown> };
      error.code = errorCode;
      error.status = res.status;
      error.details = errorDetails;
      throw error;
    }
    return (await res.json()) as T;
  }

  const api = {
    ...createApi({ json, baseUrl, fetchImpl, storage }),
    uploadPostAttachment: async (postId: string, file: File): Promise<AttachmentDto> => {
      const token = storage.getAuthToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const parseError = async (res: Response): Promise<never> => {
        let errorMessage = `Upload failed: ${String(res.status)}`;
        try {
          const errorBody = await res.json() as { message?: string };
          if (errorBody.message) {
            errorMessage = errorBody.message;
          }
        } catch {
          // Ignore JSON parse errors
        }
        throw new Error(errorMessage);
      };

      const CHUNKED_THRESHOLD_BYTES = 90 * 1024 * 1024;
      if (file.size > CHUNKED_THRESHOLD_BYTES) {
        const startRes = await fetchImpl(`${baseUrl}/posts/${postId}/attachments/chunked/start`, {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
            sizeBytes: file.size
          })
        });

        if (!startRes.ok) {
          return parseError(startRes);
        }

        const startBody = await startRes.json() as { uploadId: string; chunkBytes: number; totalChunks: number };
        const chunkBytes = Math.max(1, Number(startBody.chunkBytes));
        const totalChunks = Math.max(1, Number(startBody.totalChunks));

        try {
          for (let index = 0; index < totalChunks; index += 1) {
            const start = index * chunkBytes;
            const end = Math.min(file.size, start + chunkBytes);
            const chunk = file.slice(start, end);
            const formData = new FormData();
            formData.append('file', chunk, file.name);

            const chunkRes = await fetchImpl(
              `${baseUrl}/posts/${postId}/attachments/chunked/${startBody.uploadId}/chunk?index=${index}`,
              {
                method: 'POST',
                headers,
                body: formData
              }
            );

            if (!chunkRes.ok) {
              await parseError(chunkRes);
            }
          }

          const completeRes = await fetchImpl(
            `${baseUrl}/posts/${postId}/attachments/chunked/${startBody.uploadId}/complete`,
            {
              method: 'POST',
              headers
            }
          );

          if (!completeRes.ok) {
            return parseError(completeRes);
          }

          return (await completeRes.json()) as AttachmentDto;
        } catch (err) {
          try {
            await fetchImpl(
              `${baseUrl}/posts/${postId}/attachments/chunked/${startBody.uploadId}/abort`,
              { method: 'POST', headers }
            );
          } catch {
            // ignore abort errors
          }
          throw err;
        }
      }

      const formData = new FormData();
      formData.append('file', file);

      const res = await fetchImpl(`${baseUrl}/posts/${postId}/attachments`, {
        method: 'POST',
        headers,
        body: formData
      });

      if (!res.ok) {
        return parseError(res);
      }

      return (await res.json()) as AttachmentDto;
    },
    deleteAttachment: (attachmentId: string) =>
      json<{ ok: boolean }>(`/attachments/${attachmentId}`, { method: 'DELETE' }),
    generatePostTts: (postId: string) =>
      json<AttachmentDto>(`/posts/${postId}/tts`, { method: 'POST' }),
    search: (q: string, scope: 'all' | 'topics' | 'posts' = 'all', options?: { forumId?: string; limit?: number }) => {
      const query = new URLSearchParams({ q, scope });
      if (options?.forumId) query.set('forumId', options.forumId);
      if (options?.limit !== undefined) query.set('limit', String(options.limit));
      return json<SearchResultsDto>(`/search?${query.toString()}`);
    },
    listForums: (params?: ListForumsParams) => {
      if (!params) {
        return json<ForumDto[]>('/forums');
      }
      const query = new URLSearchParams();
      if (params.parentForumId !== undefined) {
        query.set('parentForumId', params.parentForumId ?? '');
      }
      if (params.status) {
        query.set('status', params.status);
      }
      if (params.includeArchived !== undefined) {
        query.set('includeArchived', String(params.includeArchived));
      }
      const suffix = query.toString();
      return json<ForumDto[]>(suffix ? `/forums?${suffix}` : '/forums');
    },
    listRecentPosts: (limit = 3) => {
      const safeLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
      const query = new URLSearchParams({ limit: String(safeLimit) });
      return json<RecentPostDto[]>(`/posts/recent?${query.toString()}`);
    },

    // Chat endpoints
    listChatCategories: () =>
      json<ChatCategoryListDto>('/chat/categories'),
    createChatCategory: (input: { name: string; description?: string | null; visibility?: 'public' | 'members' | 'admin' }) =>
      json<ChatCategoryDto>('/chat/categories', { method: 'POST', body: JSON.stringify(input) }),
    listChatRooms: (categoryId: string) => {
      const query = new URLSearchParams({ categoryId });
      return json<ChatRoomListDto>(`/chat/rooms?${query.toString()}`);
    },
    createChatRoom: (input: { categoryId: string; name: string; topic?: string | null }) =>
      json<ChatRoomDto>('/chat/rooms', { method: 'POST', body: JSON.stringify(input) }),
    listChatMessages: (roomId: string, options?: { limit?: number; before?: string | null; after?: string | null }) => {
      const query = new URLSearchParams();
      if (options?.limit) {
        query.set('limit', String(Math.max(1, Math.min(500, Math.trunc(options.limit)))));
      }
      if (options?.before) {
        query.set('before', options.before);
      }
      if (options?.after) {
        query.set('after', options.after);
      }
      const suffix = query.toString();
      return json<ChatMessagePageDto>(suffix ? `/chat/rooms/${roomId}/messages?${suffix}` : `/chat/rooms/${roomId}/messages`);
    },
    sendChatMessage: (roomId: string, body: string, options?: { expiresInSeconds?: number | null }) => {
      const payload: { body: string; expiresInSeconds?: number } = { body };
      if (typeof options?.expiresInSeconds === 'number') {
        payload.expiresInSeconds = options.expiresInSeconds;
      }
      return json<ChatMessageDto>(`/chat/rooms/${roomId}/messages`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    },
    sendChatTyping: (roomId: string, isTyping: boolean) =>
      json<{ ok: true }>(`/chat/rooms/${roomId}/typing`, { method: 'POST', body: JSON.stringify({ isTyping }) }),

    // Discord adapter methods
    getDiscordStatus: () => json<DiscordBridgeStatus>('/adapters/discord/status'),
    connectDiscord: (config: { token: string; guildId: string }) =>
      json<{ ok: boolean; status?: DiscordBridgeStatus }>('/adapters/discord/connect', { method: 'POST', body: JSON.stringify(config) }),
    disconnectDiscord: () =>
      json<{ ok: boolean; message?: string }>('/adapters/discord/disconnect', { method: 'POST' }),
    mapDiscordChannel: (channelId: string, forumId: string) =>
      json<{ ok: boolean; mapping: { channelId: string; forumId: string } }>('/adapters/discord/map', { method: 'POST', body: JSON.stringify({ channelId, forumId }) }),
    unmapDiscordChannel: (channelId: string) =>
      json<{ ok: boolean }>(`/adapters/discord/map/${encodeURIComponent(channelId)}`, { method: 'DELETE' }),

    // Matrix adapter methods
    getMatrixStatus: () => json<MatrixBridgeStatus>('/adapters/matrix/status'),
    connectMatrix: (config: { homeserverUrl: string; accessToken: string; userId: string }) =>
      json<{ ok: boolean; status?: MatrixBridgeStatus }>('/adapters/matrix/connect', { method: 'POST', body: JSON.stringify(config) }),
    disconnectMatrix: () =>
      json<{ ok: boolean; message?: string }>('/adapters/matrix/disconnect', { method: 'POST' }),
    mapMatrixRoom: (roomId: string, forumId: string) =>
      json<{ ok: boolean; mapping: { roomId: string; forumId: string } }>('/adapters/matrix/map', { method: 'POST', body: JSON.stringify({ roomId, forumId }) }),
    unmapMatrixRoom: (roomId: string) =>
      json<{ ok: boolean }>(`/adapters/matrix/map/${encodeURIComponent(roomId)}`, { method: 'DELETE' }),
    listTopics: (
      forumId: string,
      opts?: {
        since?: string;
        page?: number;
        pageSize?: number;
      }
    ) => {
      const params = new URLSearchParams();
      if (opts?.since) params.set('since', opts.since);
      if (opts?.page) params.set('page', String(opts.page));
      if (opts?.pageSize) params.set('pageSize', String(opts.pageSize));
      const suffix = params.toString() ? `?${params.toString()}` : '';
      return json<PageResponse<TopicDto>>(`/forums/${forumId}/topics${suffix}`);
    },
    createTopic: (
      forumId: string,
      payload: {
        title: string;
        body: string;
        model?: string | null;
        reasoningEffort?: string | null;
        attachmentsPending?: boolean;
        robotMode?: 'auto' | 'mention' | 'off';
        silent?: boolean;
      }
    ) =>
      json<TopicDto>(`/forums/${forumId}/topics`, { method: 'POST', body: JSON.stringify(payload) }),
    getTopic: (topicId: string) => json<TopicDto>(`/topics/${topicId}`),
    generateHandoffDraft: (
      topicId: string,
      payload: { goal: string; model?: string | null; reasoningEffort?: string | null; systemPrompt?: string | null }
    ) =>
      json<{ source?: unknown; goal: string; draft: string; model?: string | null; reasoning?: string | null }>(
        `/topics/${topicId}/handoff/draft`,
        { method: 'POST', body: JSON.stringify(payload) }
      ),
    createHandoff: (
      topicId: string,
      payload: { title: string; draft: string; forumId?: string; cwd?: string | null; model?: string | null; reasoningEffort?: string | null }
    ) =>
      json<{ topic: TopicDto; post: PostDto }>(`/topics/${topicId}/handoff`, {
        method: 'POST',
        body: JSON.stringify(payload)
      }),
    updateTopicStatus: (topicId: string, status: 'open' | 'locked' | 'archived') =>
      json<TopicDto>(`/topics/${topicId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    updateTopicTitle: (topicId: string, title: string) =>
      json<TopicDto>(`/topics/${topicId}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
    updateTopicSticky: (topicId: string, sticky: boolean) =>
      json<TopicDto>(`/topics/${topicId}/tags`, { method: 'PATCH', body: JSON.stringify({ sticky }) }),
    deleteTopic: (topicId: string) =>
      json<{ ok: boolean }>(`/topics/${topicId}`, { method: 'DELETE' }),
    listPosts: (topicId: string, opts?: { page?: number; pageSize?: number; include?: string[] | string }) => {
      const params = new URLSearchParams();
      if (opts?.page) params.set('page', String(opts.page));
      if (opts?.pageSize) params.set('pageSize', String(opts.pageSize));
      if (opts?.include) {
        const include = Array.isArray(opts.include) ? opts.include.join(',') : opts.include;
        if (include) params.set('include', include);
      }
      const suffix = params.toString() ? `?${params.toString()}` : '';
      return json<PageResponse<PostDto>>(`/topics/${topicId}/posts${suffix}`);
    },
    createPost: (
      topicId: string,
      payload: {
        body: string;
        parentPostId?: string | null;
        model?: string;
        reasoningEffort?: string;
        attachmentsPending?: boolean;
        silent?: boolean;
      }
    ) =>
      json<PostDto>(`/topics/${topicId}/posts`, { method: 'POST', body: JSON.stringify(payload) }),
    dispatchPost: (postId: string, payload: { model?: string | null; reasoningEffort?: string | null } = {}) =>
      json<{ ok: boolean; dispatched: boolean; post: PostDto }>(`/posts/${postId}/dispatch`, { method: 'POST', body: JSON.stringify(payload) }),
    updatePost: (postId: string, payload: { body: string }) =>
      json<PostDto>(`/posts/${postId}`, { method: 'PATCH', body: JSON.stringify(payload) }),
    deletePost: (postId: string) =>
      json<PostDto>(`/posts/${postId}`, { method: 'DELETE' }),
    listIdentities: (topicId: string, opts?: { page?: number; pageSize?: number }) => {
      const params = new URLSearchParams();
      if (opts?.page) params.set('page', String(opts.page));
      if (opts?.pageSize) params.set('pageSize', String(opts.pageSize));
      const suffix = params.toString() ? `?${params.toString()}` : '';
      return json<PageResponse<IdentityDto>>(`/topics/${topicId}/identities${suffix}`);
    },
    listTopicPersonas: (topicId: string) => json<{ items: RobotPersonaDto[] }>(`/topics/${topicId}/personas`),
    getRobotState: (topicId: string, opts?: { include?: string[] | string; view?: 'summary' | 'full' }) => {
      const params = new URLSearchParams();
      if (opts?.include) {
        const include = Array.isArray(opts.include) ? opts.include.join(',') : opts.include;
        if (include) params.set('include', include);
      }
      if (opts?.view) params.set('view', opts.view);
      const suffix = params.toString() ? `?${params.toString()}` : '';
      return json<RobotStateDto | null>(`/topics/${topicId}/state${suffix}`);
    },
    getTopicAutoRun: (topicId: string) => json<TopicAutoRunDto>(`/topics/${topicId}/auto-run`),
    updateTopicAutoRun: (
      topicId: string,
      input: {
        enabled?: boolean;
        context?: string | null;
        worker?: 'echs';
        model?: string | null;
        reasoningEffort?: string | null;
        maxReplies?: number | null;
        resetCount?: boolean;
        steerMessage?: string | null;
      }
    ) => json<TopicAutoRunDto>(`/topics/${topicId}/auto-run`, { method: 'PATCH', body: JSON.stringify(input) }),
    runTopicAutoRun: (topicId: string, input?: { steerMessage?: string | null }) =>
      json<{ ok: boolean; message?: string }>(`/topics/${topicId}/auto-run/run`, { method: 'POST', body: JSON.stringify(input ?? {}) }),
    interruptRobot: (topicId: string) => json<{ ok: boolean; message?: string }>(`/topics/${topicId}/robot/interrupt`, { method: 'POST' }),
    continueRobot: (topicId: string) => json<{ ok: boolean; message?: string }>(`/topics/${topicId}/robot/continue`, { method: 'POST' }),
    getSessionByTopic: (topicId: string) => json<SessionDto | null>(`/topics/${topicId}/session`),
    inspectSession: (sessionId: string) => json<SessionInspectorDto>(`/sessions/${sessionId}/inspector`),

    // Notifications
    listNotifications: (opts?: { page?: number; pageSize?: number; unreadOnly?: boolean }) => {
      const params = new URLSearchParams();
      if (opts?.page) params.set('page', String(opts.page));
      if (opts?.pageSize) params.set('pageSize', String(opts.pageSize));
      if (opts?.unreadOnly !== undefined) params.set('unreadOnly', String(opts.unreadOnly));
      const suffix = params.toString() ? `?${params.toString()}` : '';
      return json<PageResponse<NotificationDto>>(`/notifications${suffix}`);
    },
    markNotification: (notificationId: string, readAt: string | null = new Date().toISOString()) =>
      json<NotificationDto>(`/notifications/${notificationId}`, { method: 'PATCH', body: JSON.stringify({ readAt }) }),
    markAllNotificationsRead: () =>
      json<{ ok: boolean; readCount: number }>(`/notifications/mark-all-read`, { method: 'POST' }),
    getTopicUnread: (topicId: string) =>
      json<TopicUnreadDto>(`/topics/${topicId}/unread`),
    markTopicRead: (topicId: string, input: { lastReadPostId?: string; lastReadAt?: string }) =>
      json<TopicUnreadDto>(`/topics/${topicId}/read`, { method: 'PUT', body: JSON.stringify(input) }),
    getTopicSubscription: (topicId: string) =>
      json<TopicSubscriptionDto>(`/topics/${topicId}/subscription`),
    setTopicSubscription: (topicId: string, mode: 'watching' | 'muted' | 'off') =>
      json<TopicSubscriptionDto>(`/topics/${topicId}/subscription`, { method: 'PUT', body: JSON.stringify({ mode }) }),
    listSubscriptions: () =>
      json<{ items: TopicSubscriptionDto[] }>(`/me/subscriptions`),

    // User Management (Admin)
    listUsers: (page = 1, pageSize = 50) =>
      json<PageResponse<AdminUserDto>>(`/admin/users?page=${page}&pageSize=${pageSize}`),
    createUser: (input: { displayName: string; username?: string; password?: string; kind?: string }) =>
      json<AdminUserDto>('/admin/users', { method: 'POST', body: JSON.stringify(input) }),
    updateUser: (userId: string, input: { displayName?: string; kind?: string; password?: string }) =>
      json<AdminUserDto>(`/admin/users/${userId}`, { method: 'PATCH', body: JSON.stringify(input) }),
    deleteUser: (userId: string) =>
      json<{ ok: boolean }>(`/admin/users/${userId}`, { method: 'DELETE' }),

    // Invite Management (Admin)
    listInvites: (page = 1, pageSize = 50) =>
      json<PageResponse<InviteDto>>(`/invites?page=${page}&pageSize=${pageSize}`),
    createInvite: (input: { maxUses?: number; expiresInDays?: number }) =>
      json<InviteDto>('/invites', { method: 'POST', body: JSON.stringify(input) }),
    deleteInvite: (inviteId: string) =>
      json<{ ok: boolean }>(`/invites/${inviteId}`, { method: 'DELETE' }),

    // Forum Management (Admin)
    listAdminForums: () =>
      json<{ items: AdminForumDto[] }>('/admin/forums'),
    createAdminForum: (input: { name: string; description?: string | null; cwd?: string | null; prePrompt?: string | null; parentForumId?: string | null; category?: string | null; status?: 'active' | 'archived'; visibility?: 'public' | 'members' | 'admin' }) =>
      json<AdminForumDto>('/admin/forums', { method: 'POST', body: JSON.stringify(input) }),
    updateAdminForum: (forumId: string, input: { name?: string; description?: string | null; cwd?: string | null; prePrompt?: string | null; parentForumId?: string | null; category?: string | null; status?: 'active' | 'archived'; visibility?: 'public' | 'members' | 'admin'; archivedAt?: string | null }) =>
      json<AdminForumDto>(`/admin/forums/${forumId}`, { method: 'PATCH', body: JSON.stringify(input) }),
    deleteAdminForum: (forumId: string) =>
      json<{ ok: boolean }>(`/admin/forums/${forumId}`, { method: 'DELETE' }),
    listAdminForumPersonas: (forumId: string) =>
      json<{ items: AdminRobotPersonaDto[] }>(`/admin/forums/${forumId}/personas`),
    createAdminForumPersona: (forumId: string, input: { key: string; displayName: string; description?: string | null; accentColor?: string | null; avatarUrl?: string | null; signature?: string | null; soul?: string | null }) =>
      json<AdminRobotPersonaDto>(`/admin/forums/${forumId}/personas`, { method: 'POST', body: JSON.stringify(input) }),
    updateAdminForumPersona: (forumId: string, key: string, input: { displayName?: string; description?: string | null; accentColor?: string | null; avatarUrl?: string | null; signature?: string | null; soul?: string | null }) =>
      json<AdminRobotPersonaDto>(`/admin/forums/${forumId}/personas/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify(input) }),
    deleteAdminForumPersona: (forumId: string, key: string) =>
      json<{ ok: boolean }>(`/admin/forums/${forumId}/personas/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    listForumAccessRules: (forumId: string) =>
      json<{ items: AccessRuleDto[] }>(`/admin/forums/${forumId}/access`),
    createForumAccessRule: (forumId: string, input: { principalKind: 'all' | 'logged_in' | 'identity' | 'role'; principalId?: string | null; action: 'view' | 'post' | 'topic.create' | 'moderate'; effect: 'allow' | 'deny' }) =>
      json<AccessRuleDto>(`/admin/forums/${forumId}/access`, { method: 'POST', body: JSON.stringify(input) }),
    listTopicAccessRules: (topicId: string) =>
      json<{ items: AccessRuleDto[] }>(`/admin/topics/${topicId}/access`),
    createTopicAccessRule: (topicId: string, input: { principalKind: 'all' | 'logged_in' | 'identity' | 'role'; principalId?: string | null; action: 'view' | 'post' | 'topic.create' | 'moderate'; effect: 'allow' | 'deny' }) =>
      json<AccessRuleDto>(`/admin/topics/${topicId}/access`, { method: 'POST', body: JSON.stringify(input) }),
    moveTopic: (topicId: string, forumId: string, opts?: { silent?: boolean }) =>
      json<{ topic: TopicDto; move: TopicMoveDto }>(`/admin/topics/${topicId}/move`, { method: 'POST', body: JSON.stringify({ forumId, ...(opts?.silent !== undefined ? { silent: opts.silent } : {}) }) }),
    deleteAccessRule: (ruleId: string) =>
      json<{ ok: boolean }>(`/admin/access/${ruleId}`, { method: 'DELETE' }),

    // Pi session sync health (Admin)
    getPiSyncHealth: () =>
      json<PiSyncHealth>('/admin/pi-sync/health'),
    runPiSync: () =>
      json<PiSyncRunResponse>('/admin/pi-sync/run', { method: 'POST' }),
    runPiSessionSync: (piSessionId: string) =>
      json<PiSyncRunResponse>(`/admin/pi-sync/sessions/${encodeURIComponent(piSessionId)}/run`, { method: 'POST' }),
    backfillPiSyncAnomaly: (anomalyId: string, opts?: { bumpTopic?: boolean }) =>
      json<PiSyncBackfillResponse>(`/admin/pi-sync/anomalies/${encodeURIComponent(anomalyId)}/backfill`, {
        method: 'POST',
        body: JSON.stringify(opts ?? {})
      }),
    ignorePiSyncAnomaly: (anomalyId: string, opts?: { note?: string | null }) =>
      json<PiSyncBackfillResponse>(`/admin/pi-sync/anomalies/${encodeURIComponent(anomalyId)}/ignore`, {
        method: 'POST',
        body: JSON.stringify(opts ?? {})
      }),

    // Deploy Management (Admin)
    getDeployStatus: () =>
      json<AdminDeployStatus>('/admin/deploy/status'),
    triggerDeploy: () =>
      json<AdminDeployResponse>('/admin/deploy', { method: 'POST' }),
    triggerDeployOnFinish: () =>
      json<AdminDeployOnFinishResponse>('/admin/deploy/on-finish', { method: 'POST' }),
    cancelDeployOnFinish: () =>
      json<AdminCancelDeployOnFinishResponse>('/admin/deploy/on-finish/cancel', { method: 'POST' }),

    // Robot automations (Admin)
    listRobotAutomations: () =>
      json<{ items: RobotAutomationDto[] }>('/admin/robot/automations'),
    getRobotDashboard: () =>
      json<RobotDashboardDto>('/admin/robot/dashboard'),
    updateRobotSettings: (input: { maxConcurrentTurns?: number }) =>
      json<{ maxConcurrentTurns: number }>('/admin/robot/settings', { method: 'PATCH', body: JSON.stringify(input) }),
    createRobotAutomation: (input: {
      name: string;
      forumId?: string | null;
      prompt: string;
      enabled?: boolean;
      worker: 'echs';
      model?: string | null;
      reasoningEffort?: string | null;
      runMode?: 'manual' | 'interval';
      intervalMinutes?: number | null;
    }) =>
      json<RobotAutomationDto>('/admin/robot/automations', { method: 'POST', body: JSON.stringify(input) }),
    updateRobotAutomation: (
      automationId: string,
      input: {
        name?: string;
        forumId?: string | null;
        prompt?: string;
        enabled?: boolean;
        worker?: 'echs';
        model?: string | null;
        reasoningEffort?: string | null;
        runMode?: 'manual' | 'interval';
        intervalMinutes?: number | null;
      }
    ) =>
      json<RobotAutomationDto>(`/admin/robot/automations/${automationId}`, { method: 'PATCH', body: JSON.stringify(input) }),
    deleteRobotAutomation: (automationId: string) =>
      json<{ ok: boolean }>(`/admin/robot/automations/${automationId}`, { method: 'DELETE' }),
    runRobotAutomation: (automationId: string) =>
      json<{ ok: boolean }>(`/admin/robot/automations/${automationId}/run`, { method: 'POST' }),
    listRobotAutomationRuns: (automationId: string) =>
      json<{ items: RobotAutomationRunDto[] }>(`/admin/robot/automations/${automationId}/runs`),

    // Tamper Layer (Admin)
    listAdminSkills: () =>
      json<AdminSkillListResponseDto>('/admin/skills'),
    listTamperPlugins: () =>
      json<{ items: TamperPluginDto[] }>('/admin/tampers/plugins'),
    listTamperConfigs: (forumId?: string | null) => {
      const query = forumId ? `?forumId=${encodeURIComponent(forumId)}` : '';
      return json<{ items: TamperConfigDto[] }>(`/admin/tampers${query}`);
    },
    createTamperConfig: (input: {
      forumId?: string | null;
      pluginKey: string;
      enabled: boolean;
      priority?: number;
      direction?: 'inbound' | 'outbound' | 'both' | null;
      onlyFirstMessage?: boolean | null;
      config?: Record<string, unknown> | null;
    }) =>
      json<TamperConfigDto>('/admin/tampers', { method: 'POST', body: JSON.stringify(input) }),
    updateTamperConfig: (
      configId: string,
      input: {
        forumId?: string | null;
        enabled?: boolean;
        priority?: number;
        direction?: 'inbound' | 'outbound' | 'both' | null;
        onlyFirstMessage?: boolean | null;
        config?: Record<string, unknown> | null;
      }
    ) =>
      json<TamperConfigDto>(`/admin/tampers/${configId}`, { method: 'PATCH', body: JSON.stringify(input) }),
    deleteTamperConfig: (configId: string) =>
      json<{ ok: boolean }>(`/admin/tampers/${configId}`, { method: 'DELETE' }),
    testTamper: (input: {
      text: string;
      forumId?: string | null;
      stage?: string;
      direction?: string;
      pluginKey?: string | null;
      pluginConfig?: Record<string, unknown> | null;
      onlyPlugin?: boolean;
      isFirstMessage?: boolean;
    }) =>
      json<TamperTestResultDto>('/admin/tampers/test', { method: 'POST', body: JSON.stringify(input) })
  };

  const createStateStream = (topicId: string): EventSource => {
    const token = storage.getAuthToken();
    const url = token
      ? `${baseUrl}/topics/${topicId}/state/stream?token=${encodeURIComponent(token)}`
      : `${baseUrl}/topics/${topicId}/state/stream`;
    return eventSourceFactory(url);
  };

  const createNotificationStream = (): EventSource => {
    const token = storage.getAuthToken();
    const url = token
      ? `${baseUrl}/notifications/stream?token=${encodeURIComponent(token)}`
      : `${baseUrl}/notifications/stream`;
    return eventSourceFactory(url);
  };

  const createChatStream = (roomId: string): EventSource => {
    const token = storage.getAuthToken();
    const url = token
      ? `${baseUrl}/chat/rooms/${roomId}/stream?token=${encodeURIComponent(token)}`
      : `${baseUrl}/chat/rooms/${roomId}/stream`;
    return eventSourceFactory(url);
  };

  return { api, createStateStream, createNotificationStream, createChatStream, storage, baseUrl };
}

const defaultSdk = createForumSdk();

export const api = defaultSdk.api;
export const createStateStream = defaultSdk.createStateStream;
export const createNotificationStream = defaultSdk.createNotificationStream;
export const createChatStream = defaultSdk.createChatStream;
export const getAuthToken = (): string | null => defaultSdk.storage.getAuthToken();
export const setAuthToken = (token: string | null): void => defaultSdk.storage.setAuthToken(token);
export const getRefreshToken = (): string | null => defaultSdk.storage.getRefreshToken();
export const setRefreshToken = (token: string | null): void => defaultSdk.storage.setRefreshToken(token);
