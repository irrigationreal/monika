import type { PlanId, ToolRunId, SessionId, TopicId } from '../domain/ids';

export type RobotActivity = 'idle' | 'thinking' | 'running_tools' | 'waiting' | 'stopping' | 'stopped' | 'uncertain' | 'error';
export type ArtifactVisibility = 'public' | 'internal' | 'private';

export interface PlanArtifact {
  id: PlanId;
  topicId: TopicId;
  sessionId: SessionId;
  createdAt: string;
  updatedAt: string;
  content: string;
  summary?: string | null;
  visibility: ArtifactVisibility;
}

export interface ToolRunSummary {
  id: ToolRunId;
  topicId: TopicId;
  sessionId: SessionId;
  tool: 'exec' | 'apply_patch' | 'web' | 'other';
  startedAt: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  command?: string | null;
  filesTouched?: string[] | null;
  outputSummary?: string | null;
  redactionsApplied: boolean;
  visibility: ArtifactVisibility;
}

export interface RobotState {
  topicId: TopicId;
  sessionId: SessionId;
  activity: RobotActivity;
  model?: string | null;
  reasoningEffort?: string | null;
  lastUpdatedAt: string;
  lastTurnError?: {
    message: string;
    at: string;
    postId?: string | null;
    turnId?: string | null;
  } | null;
  currentPlan?: PlanArtifact | null;
  recentToolRuns: ToolRunSummary[];
}
