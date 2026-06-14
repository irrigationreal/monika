import { computed, ref } from 'vue';
import {
  api,
  createChatStream,
  type ChatCategoryDto,
  type ChatRoomDto,
  type ChatMessageDto,
  type ChatPresenceDto,
  type ChatTypingDto,
  type AttachmentDto
} from '../lib/apiClient';

type ChatMessageItem = ChatMessageDto & { system?: boolean };

const categories = ref<ChatCategoryDto[]>([]);
const roomsByCategory = ref<Record<string, ChatRoomDto[]>>({});
const currentRoomId = ref<string | null>(null);
const currentCategoryId = ref<string | null>(null);
const messagesByRoom = ref<Record<string, ChatMessageItem[]>>({});
const presenceByRoom = ref<Record<string, ChatPresenceDto[]>>({});
const typingByRoom = ref<Record<string, Record<string, { displayName: string }>>>({});
const loading = ref(false);
const error = ref<string | null>(null);

const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let typingStopTimer: ReturnType<typeof setTimeout> | null = null;
let lastTypingSentAt = 0;
const TYPING_THROTTLE_MS = 1500;
const TYPING_STOP_DELAY_MS = 2500;

let stream: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = 2000;
let streamManuallyClosed = false;

function setError(message: string | null): void {
  error.value = message;
}

function setRooms(categoryId: string, rooms: ChatRoomDto[]): void {
  roomsByCategory.value = {
    ...roomsByCategory.value,
    [categoryId]: rooms
  };
}

function upsertRoom(categoryId: string, room: ChatRoomDto): void {
  const existing = roomsByCategory.value[categoryId] ?? [];
  const index = existing.findIndex((item) => item.id === room.id);
  const next = index >= 0 ? existing.map((item) => (item.id === room.id ? room : item)) : [...existing, room];
  setRooms(categoryId, next);
}

function setMessages(roomId: string, messages: ChatMessageItem[]): void {
  messagesByRoom.value = {
    ...messagesByRoom.value,
    [roomId]: messages
  };
  for (const message of messages) {
    scheduleExpiry(roomId, message);
  }
}

function appendMessage(roomId: string, message: ChatMessageItem): void {
  const existing = messagesByRoom.value[roomId] ?? [];
  if (existing.some((item) => item.id === message.id)) {
    return;
  }
  setMessages(roomId, [...existing, message]);
  scheduleExpiry(roomId, message);
}

function removeMessage(roomId: string, messageId: string): void {
  const existing = messagesByRoom.value[roomId] ?? [];
  if (!existing.length) return;
  const next = existing.filter((item) => item.id !== messageId);
  if (next.length === existing.length) return;
  const timer = expiryTimers.get(messageId);
  if (timer) {
    clearTimeout(timer);
    expiryTimers.delete(messageId);
  }
  setMessages(roomId, next);
}

function scheduleExpiry(roomId: string, message: ChatMessageItem): void {
  if (!message.expiresAt) return;
  if (expiryTimers.has(message.id)) return;
  const expiresAt = Date.parse(message.expiresAt);
  if (Number.isNaN(expiresAt)) return;
  const delay = expiresAt - Date.now();
  if (delay <= 0) {
    removeMessage(roomId, message.id);
    return;
  }
  const timer = setTimeout(() => {
    removeMessage(roomId, message.id);
    expiryTimers.delete(message.id);
  }, delay);
  expiryTimers.set(message.id, timer);
}

function updateMessageAttachment(roomId: string, postId: string, attachment: AttachmentDto): void {
  const existing = messagesByRoom.value[roomId] ?? [];
  if (!existing.length) return;
  const next = existing.map((item) => {
    if (item.id !== postId) return item;
    const attachments = item.attachments ?? [];
    if (attachments.some((att) => att.id === attachment.id)) {
      return item;
    }
    return { ...item, attachments: [...attachments, attachment] };
  });
  setMessages(roomId, next);
}

function appendSystemMessage(roomId: string, body: string): void {
  const message: ChatMessageItem = {
    id: `system-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    roomId,
    author: {
      id: 'system',
      displayName: 'system',
      avatarUrl: null
    },
    body,
    createdAt: new Date().toISOString(),
    editedAt: null,
    attachments: [],
    system: true
  };
  appendMessage(roomId, message);
}

function setPresence(roomId: string, members: ChatPresenceDto[]): void {
  const unique = new Map<string, ChatPresenceDto>();
  for (const member of members) {
    unique.set(member.id, member);
  }
  presenceByRoom.value = {
    ...presenceByRoom.value,
    [roomId]: Array.from(unique.values()).sort((a, b) => a.displayName.localeCompare(b.displayName))
  };
}

function addPresenceMember(roomId: string, member: ChatPresenceDto): void {
  const existing = presenceByRoom.value[roomId] ?? [];
  if (existing.some((item) => item.id === member.id)) return;
  setPresence(roomId, [...existing, member]);
}

function removePresenceMember(roomId: string, memberId: string): void {
  const existing = presenceByRoom.value[roomId] ?? [];
  if (!existing.length) return;
  setPresence(
    roomId,
    existing.filter((item) => item.id !== memberId)
  );
}

function setTyping(roomId: string, payload: ChatTypingDto): void {
  const key = `${roomId}:${payload.identityId}`;
  const current = { ...(typingByRoom.value[roomId] ?? {}) };
  if (payload.isTyping) {
    current[payload.identityId] = { displayName: payload.displayName };
    typingByRoom.value = { ...typingByRoom.value, [roomId]: current };
    const existingTimer = typingTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timeout = setTimeout(() => {
      const next = { ...(typingByRoom.value[roomId] ?? {}) };
      delete next[payload.identityId];
      typingByRoom.value = { ...typingByRoom.value, [roomId]: next };
      typingTimers.delete(key);
    }, 5000);
    typingTimers.set(key, timeout);
  } else {
    delete current[payload.identityId];
    typingByRoom.value = { ...typingByRoom.value, [roomId]: current };
    const existingTimer = typingTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      typingTimers.delete(key);
    }
  }
}

function closeStream(): void {
  if (stream) {
    stream.close();
    stream = null;
  }
  streamManuallyClosed = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectDelayMs = 2000;
}

async function resyncRoom(roomId: string): Promise<void> {
  try {
    const existing = messagesByRoom.value[roomId] ?? [];
    const lastId = existing[existing.length - 1]?.id ?? null;
    const page = lastId
      ? await api.listChatMessages(roomId, { limit: 200, after: lastId })
      : await api.listChatMessages(roomId, { limit: 200 });
    if (page.items.length > 0) {
      for (const message of page.items) {
        appendMessage(roomId, message);
      }
    }
    let nextAfter = page.nextAfter ?? null;
    let hasMore = page.hasMore;
    let guard = 0;
    while (hasMore && nextAfter && guard < 5) {
      const nextPage = await api.listChatMessages(roomId, { limit: 200, after: nextAfter });
      if (!nextPage.items.length) {
        break;
      }
      for (const message of nextPage.items) {
        appendMessage(roomId, message);
      }
      nextAfter = nextPage.nextAfter ?? null;
      hasMore = nextPage.hasMore;
      guard += 1;
    }
    if (existing.length) {
      const now = Date.now();
      const pruned = (messagesByRoom.value[roomId] ?? []).filter((item) => {
        if (!item.expiresAt) return true;
        const expiresAt = Date.parse(item.expiresAt);
        return Number.isNaN(expiresAt) || expiresAt > now;
      });
      if (pruned.length !== (messagesByRoom.value[roomId] ?? []).length) {
        setMessages(roomId, pruned);
      }
    }
  } catch {
    // Ignore resync errors.
  }
}

function openStream(roomId: string): void {
  closeStream();
  streamManuallyClosed = false;
  stream = createChatStream(roomId);
  stream.addEventListener('open', () => {
    reconnectDelayMs = 2000;
    void resyncRoom(roomId);
  });
  stream.addEventListener('chat_message', (event: MessageEvent<string>) => {
    const payload = JSON.parse(event.data) as ChatMessageDto;
    appendMessage(roomId, payload);
  });
  stream.addEventListener('chat_message_expired', (event: MessageEvent<string>) => {
    const payload = JSON.parse(event.data) as { roomId: string; messageId: string };
    removeMessage(payload.roomId, payload.messageId);
  });
  stream.addEventListener('chat_attachment', (event: MessageEvent<string>) => {
    const payload = JSON.parse(event.data) as { roomId: string; postId: string; attachment: AttachmentDto };
    updateMessageAttachment(payload.roomId, payload.postId, payload.attachment);
  });
  stream.addEventListener('chat_presence_state', (event: MessageEvent<string>) => {
    const payload = JSON.parse(event.data) as { roomId: string; members: ChatPresenceDto[] };
    setPresence(payload.roomId, payload.members);
  });
  stream.addEventListener('chat_join', (event: MessageEvent<string>) => {
    const payload = JSON.parse(event.data) as { roomId: string; member: ChatPresenceDto };
    addPresenceMember(payload.roomId, payload.member);
    appendSystemMessage(payload.roomId, `*** ${payload.member.displayName} joined`);
  });
  stream.addEventListener('chat_part', (event: MessageEvent<string>) => {
    const payload = JSON.parse(event.data) as { roomId: string; member: ChatPresenceDto };
    removePresenceMember(payload.roomId, payload.member.id);
    appendSystemMessage(payload.roomId, `*** ${payload.member.displayName} left`);
  });
  stream.addEventListener('chat_typing', (event: MessageEvent<string>) => {
    const payload = JSON.parse(event.data) as ChatTypingDto;
    setTyping(payload.roomId, payload);
  });
  stream.addEventListener('error', () => {
    if (streamManuallyClosed || !currentRoomId.value) {
      return;
    }
    if (reconnectTimer) {
      return;
    }
    const activeRoomId = currentRoomId.value;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
      openStream(activeRoomId);
    }, reconnectDelayMs);
  });
}

async function loadCategories(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await api.listChatCategories();
    categories.value = res.items;
    if (!currentCategoryId.value && res.items[0]) {
      currentCategoryId.value = res.items[0].id;
    }
    for (const category of res.items) {
      await loadRooms(category.id);
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load chat categories.';
  } finally {
    loading.value = false;
  }
}

async function loadRooms(categoryId: string): Promise<void> {
  const res = await api.listChatRooms(categoryId);
  setRooms(categoryId, res.items);
}

async function createRoom(categoryId: string, name: string, topic?: string | null): Promise<ChatRoomDto> {
  const room = await api.createChatRoom({ categoryId, name, topic: topic ?? null });
  upsertRoom(categoryId, room);
  return room;
}

async function selectRoom(room: ChatRoomDto): Promise<void> {
  if (currentRoomId.value === room.id) return;
  const previousRoomId = currentRoomId.value;
  if (previousRoomId) {
    void stopTyping(previousRoomId);
  }
  currentRoomId.value = room.id;
  currentCategoryId.value = room.categoryId;
  const page = await api.listChatMessages(room.id, { limit: 200 });
  setMessages(room.id, page.items);
  openStream(room.id);
}

async function sendMessage(
  roomId: string,
  body: string,
  options?: { expiresInSeconds?: number | null }
): Promise<ChatMessageDto> {
  await stopTyping(roomId);
  const message = await api.sendChatMessage(roomId, body, options);
  appendMessage(roomId, message);
  return message;
}

async function notifyTyping(roomId: string): Promise<void> {
  if (!roomId) return;
  const now = Date.now();
  if (now - lastTypingSentAt > TYPING_THROTTLE_MS) {
    lastTypingSentAt = now;
    try {
      await api.sendChatTyping(roomId, true);
    } catch {
      // Ignore typing errors.
    }
  }
  if (typingStopTimer) {
    clearTimeout(typingStopTimer);
  }
  typingStopTimer = setTimeout(() => {
    void api.sendChatTyping(roomId, false);
  }, TYPING_STOP_DELAY_MS);
}

async function stopTyping(roomId: string): Promise<void> {
  if (!roomId) return;
  if (typingStopTimer) {
    clearTimeout(typingStopTimer);
    typingStopTimer = null;
  }
  lastTypingSentAt = 0;
  try {
    await api.sendChatTyping(roomId, false);
  } catch {
    // Ignore typing errors.
  }
}

function addAttachment(roomId: string, postId: string, attachment: AttachmentDto): void {
  updateMessageAttachment(roomId, postId, attachment);
}

const currentMessages = computed(() => {
  if (!currentRoomId.value) return [];
  return messagesByRoom.value[currentRoomId.value] ?? [];
});

const currentPresence = computed(() => {
  if (!currentRoomId.value) return [];
  return presenceByRoom.value[currentRoomId.value] ?? [];
});

const currentTyping = computed(() => {
  if (!currentRoomId.value) return [];
  const roomTyping = typingByRoom.value[currentRoomId.value] ?? {};
  return Object.values(roomTyping).map((entry) => entry.displayName);
});

const currentRooms = computed(() => {
  if (!currentCategoryId.value) return [];
  return roomsByCategory.value[currentCategoryId.value] ?? [];
});

export function useChatState() {
  return {
    categories,
    roomsByCategory,
    currentRoomId,
    currentCategoryId,
    currentMessages,
    currentPresence,
    currentTyping,
    currentRooms,
    loading,
    error,
    loadCategories,
    loadRooms,
    selectRoom,
    sendMessage,
    createRoom,
    notifyTyping,
    stopTyping,
    addAttachment,
    appendSystemMessage,
    setError,
    closeStream,
    resyncRoom,
    removeMessage
  };
}
