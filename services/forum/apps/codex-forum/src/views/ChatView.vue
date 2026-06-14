<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useChatState } from '../composables/useChatState';
import { useForumState } from '../composables/useForumState';
import type { AttachmentDto, ChatMessageDto, ChatRoomDto } from '../lib/apiClient';

type ChatLine = {
  id: string;
  roomId: string;
  createdAt: string;
  body: string;
  system?: boolean;
  author?: ChatMessageDto['author'];
  attachments?: AttachmentDto[];
};

const router = useRouter();
const route = useRoute();
const forumState = useForumState();
const state = useChatState();

const draft = ref('');
const sending = ref(false);
const scrollbackRef = ref<HTMLDivElement | null>(null);
const idleLines = ref<ChatLine[]>([]);
let resyncTimer: ReturnType<typeof setInterval> | null = null;

const categories = computed(() => state.categories.value);
const currentRoomId = computed(() => state.currentRoomId.value);
const currentMessages = computed(() => state.currentMessages.value);

const channels = computed(() => {
  const list: ChatRoomDto[] = [];
  for (const category of categories.value) {
    const rooms = state.roomsByCategory.value[category.id] ?? [];
    list.push(...rooms);
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
});

const currentRoom = computed(() => channels.value.find((room) => room.id === currentRoomId.value) ?? null);

const displayLines = computed<ChatLine[]>(() => {
  if (currentRoomId.value) {
    return currentMessages.value as ChatLine[];
  }
  return idleLines.value;
});

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function normalizeChannelName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

function addIdleLine(body: string): void {
  idleLines.value = [
    ...idleLines.value,
    {
      id: `idle-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      roomId: 'idle',
      createdAt: new Date().toISOString(),
      body,
      system: true
    }
  ];
}

function addSystemLine(body: string): void {
  if (currentRoomId.value) {
    state.appendSystemMessage(currentRoomId.value, body);
  } else {
    addIdleLine(body);
  }
}

function handleResync(): void {
  if (typeof document !== 'undefined' && document.hidden) {
    return;
  }
  if (currentRoomId.value) {
    void state.resyncRoom(currentRoomId.value);
  }
}

function parseDurationSeconds(input: string): number | null {
  const match = input.trim().match(/^(\d+)([smhd]?)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = (match[2] ?? 's').toLowerCase();
  if (unit === 'm') return amount * 60;
  if (unit === 'h') return amount * 60 * 60;
  if (unit === 'd') return amount * 60 * 60 * 24;
  return amount;
}

async function scrollToBottom(): Promise<void> {
  await nextTick();
  const el = scrollbackRef.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

async function selectRoom(room: ChatRoomDto): Promise<void> {
  if (room.id === currentRoomId.value) return;
  idleLines.value = [];
  await state.selectRoom(room);
  state.appendSystemMessage(room.id, `*** switched to ${room.name}`);
  await router.replace({ name: 'chat.room', params: { roomId: room.id } });
  await scrollToBottom();
}

async function handleCommand(commandLine: string): Promise<void> {
  const [rawCommand, ...rest] = commandLine.trim().split(/\s+/);
  const command = rawCommand.replace('/', '').toLowerCase();
  const argument = rest.join(' ').trim();

  if (command === 'join') {
    if (!argument) {
      addSystemLine('*** usage: /join #channel');
      return;
    }
    const target = normalizeChannelName(argument);
    let room = channels.value.find((candidate) => normalizeChannelName(candidate.name) === target) ?? null;
    if (!room) {
      const categoryId = state.currentCategoryId.value ?? categories.value[0]?.id ?? null;
      if (!categoryId) {
        addSystemLine('*** no categories available');
        return;
      }
      try {
        room = await state.createRoom(categoryId, target);
        addSystemLine(`*** created ${target}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create channel.';
        addSystemLine(`*** ${message}`);
        return;
      }
    }
    await selectRoom(room);
    return;
  }

  if (command === 'part') {
    if (!currentRoomId.value) {
      addSystemLine('*** not in a channel');
      return;
    }
    const name = currentRoom.value?.name ?? '#channel';
    state.closeStream();
    state.currentRoomId.value = null;
    addIdleLine(`*** left ${name}`);
    await router.replace({ name: 'chat.home' });
    return;
  }

  if (command === 'expire' || command === 'ttl') {
    if (!currentRoomId.value) {
      addSystemLine('*** join a channel first');
      return;
    }
    const [durationRaw, ...messageParts] = argument.split(/\s+/);
    const message = messageParts.join(' ').trim();
    if (!durationRaw || !message) {
      addSystemLine('*** usage: /expire <seconds|1m|1h|1d> <message>');
      return;
    }
    const durationSeconds = parseDurationSeconds(durationRaw);
    if (!durationSeconds) {
      addSystemLine('*** invalid duration (use seconds or 1m/1h/1d)');
      return;
    }
    await state.sendMessage(currentRoomId.value, message, { expiresInSeconds: durationSeconds });
    await scrollToBottom();
    return;
  }

  if (command === 'me') {
    if (!argument) {
      addSystemLine('*** usage: /me <action>');
      return;
    }
    if (!currentRoomId.value) {
      addSystemLine('*** join a channel first');
      return;
    }
    const displayName = forumState.currentUser.value?.displayName ?? 'Guest';
    await state.sendMessage(currentRoomId.value, `* ${displayName} ${argument}`);
    await scrollToBottom();
    return;
  }

  if (command === 'who') {
    if (!currentRoomId.value) {
      addSystemLine('*** join a channel first');
      return;
    }
    const members = state.currentPresence.value.map((member) => member.displayName);
    addSystemLine(members.length ? `*** online: ${members.join(', ')}` : '*** no one else is here');
    return;
  }

  if (command === 'topic') {
    if (!argument) {
      addSystemLine('*** usage: /topic <text>');
      return;
    }
    addSystemLine(`*** topic set to: ${argument}`);
    return;
  }

  if (command === 'msg') {
    addSystemLine('*** /msg is not available in this client');
    return;
  }

  addSystemLine(`*** unknown command: ${command}`);
}

async function sendMessage(): Promise<void> {
  const text = draft.value.trim();
  if (!text) return;
  draft.value = '';
  if (text.startsWith('/')) {
    await handleCommand(text);
    return;
  }
  if (!currentRoomId.value) {
    addSystemLine('*** join a channel first');
    return;
  }
  sending.value = true;
  try {
    await state.sendMessage(currentRoomId.value, text);
    await scrollToBottom();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to send message.';
    addSystemLine(`*** ${message}`);
  } finally {
    sending.value = false;
  }
}

onMounted(async () => {
  await state.loadCategories();
  const routeRoomId = route.params['roomId'] as string | undefined;
  if (routeRoomId) {
    const target = channels.value.find((room) => room.id === routeRoomId);
    if (target) {
      await selectRoom(target);
      return;
    }
  }
  if (channels.value.length > 0) {
    await selectRoom(channels.value[0]!);
  } else {
    addIdleLine('*** no channels available');
  }
  document.addEventListener('visibilitychange', handleResync);
  window.addEventListener('focus', handleResync);
  window.addEventListener('online', handleResync);
  resyncTimer = setInterval(handleResync, 20_000);
});

onUnmounted(() => {
  if (currentRoomId.value) {
    void state.stopTyping(currentRoomId.value);
  }
  if (resyncTimer) {
    clearInterval(resyncTimer);
    resyncTimer = null;
  }
  document.removeEventListener('visibilitychange', handleResync);
  window.removeEventListener('focus', handleResync);
  window.removeEventListener('online', handleResync);
  state.closeStream();
});

watch(
  () => displayLines.value.length,
  () => {
    void scrollToBottom();
  }
);
</script>

<template>
  <section class="vb-section terminal-chat-shell">
    <div class="terminal-chat-frame">
      <div class="terminal-chat__left">
        <div class="terminal-chat__log" ref="scrollbackRef">
          <div v-if="displayLines.length === 0" class="terminal-chat__empty">
            *** join a channel to start
          </div>
          <div
            v-for="line in displayLines"
            :key="line.id"
            class="terminal-chat__line"
            :class="{ 'is-system': line.system }"
          >
            <template v-if="line.system">
              <span class="terminal-chat__system">{{ line.body }}</span>
            </template>
            <template v-else>
              <span class="terminal-chat__time">[{{ formatTimestamp(line.createdAt) }}]</span>
              <span class="terminal-chat__nick">&lt;{{ line.author?.displayName ?? 'unknown' }}&gt;</span>
              <span class="terminal-chat__text">{{ line.body }}</span>
              <span
                v-for="attachment in line.attachments ?? []"
                :key="attachment.id"
                class="terminal-chat__attachment"
              >
                [file:
                <a :href="`/api/attachments/${attachment.id}`" target="_blank" rel="noopener">
                  {{ attachment.filename }}
                </a>]
              </span>
            </template>
          </div>
        </div>

        <div class="terminal-chat__input">
          <input
            v-model="draft"
            type="text"
            placeholder="Type a message or /join #channel"
            :disabled="sending"
            @keyup.enter="sendMessage"
          />
        </div>
      </div>

      <aside class="terminal-chat__channels">
        <div
          v-for="room in channels"
          :key="room.id"
          class="terminal-chat__channel"
          :class="{ 'is-active': room.id === currentRoomId }"
          @click="selectRoom(room)"
        >
          {{ normalizeChannelName(room.name) }}
        </div>
      </aside>
    </div>
  </section>
</template>
