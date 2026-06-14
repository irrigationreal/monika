import { DiscordBridge } from './discordBridge';
import { MatrixBridge } from './matrixBridge';
import type { AgentBridge } from '../agentBridge';
import type { ForumStore } from '../store';
import type { StreamBusInterface } from '../streamBus';

export function createAdapterRegistry({
  store,
  bus,
  codex,
  defaultForumId,
  discord,
  matrix
}: {
  store: ForumStore;
  bus: StreamBusInterface;
  codex: AgentBridge;
  defaultForumId: string;
  discord: { token: string | null; guildId: string | null };
  matrix: { homeserverUrl: string | null; accessToken: string | null; userId: string | null };
}): { getDiscordBridge: () => DiscordBridge | null; getMatrixBridge: () => MatrixBridge | null } {
  let discordBridge: DiscordBridge | null = null;
  let matrixBridge: MatrixBridge | null = null;

  function getDiscordBridge(): DiscordBridge | null {
    if (!discord.token || !discord.guildId) {
      return null;
    }
    if (!discordBridge) {
      discordBridge = new DiscordBridge(
        store,
        bus,
        {
          token: discord.token,
          guildId: discord.guildId,
          defaultForumId
        },
        codex
      );
    }
    return discordBridge;
  }

  function getMatrixBridge(): MatrixBridge | null {
    if (!matrix.homeserverUrl || !matrix.accessToken || !matrix.userId) {
      return null;
    }
    if (!matrixBridge) {
      matrixBridge = new MatrixBridge(
        store,
        bus,
        {
          homeserverUrl: matrix.homeserverUrl,
          accessToken: matrix.accessToken,
          userId: matrix.userId,
          defaultForumId
        },
        codex
      );
    }
    return matrixBridge;
  }

  return { getDiscordBridge, getMatrixBridge };
}
