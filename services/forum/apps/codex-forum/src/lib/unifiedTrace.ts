import { parseReasoningSteps } from './reasoning';

import type { ToolRunDto } from './apiClient';
import type { ReasoningStep } from './reasoning';

export type UnifiedTraceItem =
  | { type: 'reasoning'; steps: ReasoningStep[]; segmentIndex: number }
  | { type: 'tool'; tool: ToolRunDto; toolIndex: number };

interface PersistedTraceInput {
  reasoningText?: string | null;
  reasoningCheckpoints?: number[] | null;
  tools: ToolRunDto[];
}

interface LiveTraceSegment {
  kind: 'reasoning' | 'tool';
  text?: string;
  toolRunId?: string;
}

interface LiveTraceInput {
  segments: LiveTraceSegment[];
  reasoningDraft?: string | null;
  tools: ToolRunDto[];
}

function sortedTools(tools: ToolRunDto[]): ToolRunDto[] {
  return tools
    .map((tool, newestFirstIndex) => ({ tool, newestFirstIndex }))
    .sort((a, b) => {
      const byStartedAt = a.tool.startedAt.localeCompare(b.tool.startedAt);
      return byStartedAt || b.newestFirstIndex - a.newestFirstIndex;
    })
    .map(({ tool }) => tool);
}

function pushReasoning(items: UnifiedTraceItem[], text: string, segmentIndex: number): void {
  const steps = parseReasoningSteps(text.trim());
  if (steps.length > 0) items.push({ type: 'reasoning', steps, segmentIndex });
}

export function buildPersistedTraceItems(input: PersistedTraceInput): UnifiedTraceItem[] {
  const tools = sortedTools(input.tools);
  const raw = input.reasoningText ?? '';
  const checkpoints = input.reasoningCheckpoints ?? [];
  const items: UnifiedTraceItem[] = [];

  if (raw && checkpoints.length > 0) {
    let cursor = 0;
    for (let toolIndex = 0; toolIndex < tools.length; toolIndex++) {
      const rawCheckpoint = toolIndex < checkpoints.length ? checkpoints[toolIndex] : raw.length;
      const checkpoint = Math.max(cursor, Math.min(raw.length, rawCheckpoint ?? raw.length));
      pushReasoning(items, raw.slice(cursor, checkpoint), toolIndex);
      cursor = checkpoint;
      const tool = tools[toolIndex];
      if (tool) items.push({ type: 'tool', tool, toolIndex });
    }
    pushReasoning(items, raw.slice(cursor), tools.length);
    return items;
  }

  pushReasoning(items, raw, 0);
  for (let toolIndex = 0; toolIndex < tools.length; toolIndex++) {
    const tool = tools[toolIndex];
    if (tool) items.push({ type: 'tool', tool, toolIndex });
  }
  return items;
}

export function buildLiveTraceItems(input: LiveTraceInput): UnifiedTraceItem[] {
  const toolById = new Map(input.tools.map((tool) => [tool.id, tool]));
  const items: UnifiedTraceItem[] = [];
  let reasoningIndex = 0;
  let toolIndex = 0;

  for (const segment of input.segments) {
    if (segment.kind === 'reasoning' && segment.text) {
      pushReasoning(items, segment.text, reasoningIndex++);
    } else if (segment.kind === 'tool' && segment.toolRunId) {
      const tool = toolById.get(segment.toolRunId);
      if (tool) {
        items.push({ type: 'tool', tool, toolIndex });
        toolIndex += 1;
      }
    }
  }

  if (input.reasoningDraft) pushReasoning(items, input.reasoningDraft, reasoningIndex);
  return items;
}
