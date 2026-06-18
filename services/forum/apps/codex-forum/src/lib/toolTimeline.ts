import type { ToolRunDto } from './apiClient';
import { getToolMiniModel, toolKindIcon, type ToolKind, type ToolMiniModel } from './toolMiniView';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TimelineStatus = 'running' | 'success' | 'error' | 'skipped';
export type DensityMode = 'condensed' | 'normal' | 'raw';

export interface TimelineEvent {
  type: 'event';
  id: string;
  toolRun: ToolRunDto;
  model: ToolMiniModel;
  humanTitle: string;
  subtitle: string | null;
  kind: ToolKind;
  kindAbbr: string;
  status: TimelineStatus;
  durationMs: number | null;
  durationLabel: string | null;
  timeoutLabel: string | null;
}

export interface TimelineBurst {
  type: 'burst';
  id: string;
  toolName: string;
  kind: ToolKind;
  kindAbbr: string;
  label: string;
  status: TimelineStatus | 'mixed';
  totalDurationMs: number;
  durationLabel: string;
  children: TimelineEvent[];
}

export interface TimelineAgentFrame {
  type: 'agent_frame';
  id: string;
  label: string;
  status: TimelineStatus;
  children: TimelineNode[];
}

export type TimelineNode = TimelineEvent | TimelineBurst | TimelineAgentFrame;

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function toolExitCode(tool: ToolRunDto): number | null {
  if (tool.exitCode !== null && tool.exitCode !== undefined) return tool.exitCode;
  const summary = tool.outputSummary ?? '';
  if (!summary) return null;
  const match =
    summary.match(/Process exited with code\s+(-?\d+)/i) ||
    summary.match(/Exit:\s*(-?\d+)/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isNaN(value) ? null : value;
}

export function eventStatus(tool: ToolRunDto): TimelineStatus {
  if (!tool.finishedAt) return 'running';
  const code = toolExitCode(tool);
  if (code !== null && code !== 0) return 'error';
  return 'success';
}

export function statusDotChar(status: TimelineStatus | 'mixed'): string {
  switch (status) {
    case 'running': return '◉';
    case 'success': return '●';
    case 'error':   return '⛔';
    case 'skipped': return '◌';
    case 'mixed':   return '●';
  }
}

export function statusDotClass(status: TimelineStatus | 'mixed'): string {
  switch (status) {
    case 'running': return 'vb-timeline-dot--running';
    case 'success': return 'vb-timeline-dot--success';
    case 'error':   return 'vb-timeline-dot--error';
    case 'skipped': return 'vb-timeline-dot--skipped';
    case 'mixed':   return 'vb-timeline-dot--mixed';
  }
}

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

function computeDurationMs(tool: ToolRunDto): number | null {
  if (!tool.startedAt || !tool.finishedAt) return null;
  const start = new Date(tool.startedAt).getTime();
  const end = new Date(tool.finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

// ---------------------------------------------------------------------------
// Kind abbreviations
// ---------------------------------------------------------------------------

export function kindAbbr(kind: ToolKind): string {
  switch (kind) {
    case 'exec':        return 'exec';
    case 'apply_patch': return 'patch';
    case 'read':        return 'rf';
    case 'web':         return 'http';
    case 'image':       return 'img';
    case 'forum':       return 'forum';
    case 'agent':       return 'agent';
    default:            return 'tool';
  }
}

// ---------------------------------------------------------------------------
// Human title
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  const compact = s.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}…`;
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

export function toolHumanTitle(tool: ToolRunDto, model?: ToolMiniModel): string {
  const m = model ?? getToolMiniModel(tool);
  const lowerName = (m.name ?? '').toLowerCase();

  switch (m.kind) {
    case 'exec': {
      if (lowerName === 'write_stdin') {
        const raw = m.summary ?? '';
        if (!raw) return 'stdin: <enter>';
        return `stdin: ${truncate(raw, 60)}`;
      }
      // shell_command / exec_command / shell — show the actual command
      if (m.summary) return truncate(m.summary, 100);
      return m.name;
    }
    case 'read': {
      if (lowerName === 'list_dir' || lowerName === 'ls') {
        const dir = m.summary ?? '';
        return dir ? `List ${truncate(dir, 80)}` : 'List directory';
      }
      if (lowerName === 'grep_files' || lowerName === 'grep') {
        const pattern = m.summary ?? '';
        return pattern ? `Grep "${truncate(pattern, 60)}"` : 'Grep files';
      }
      // read_file
      if (m.summary) {
        return `Inspect ${basename(m.summary)}`;
      }
      return 'Read file';
    }
    case 'apply_patch': {
      const fileCount = m.files.length;
      const adds = m.meta.adds;
      const dels = m.meta.dels;
      if (fileCount > 0) {
        const diffLabel = (adds !== null && adds !== undefined) || (dels !== null && dels !== undefined)
          ? ` (+${adds ?? 0} / -${dels ?? 0})`
          : '';
        return `Patch: ${fileCount} file${fileCount === 1 ? '' : 's'}${diffLabel}`;
      }
      return m.summary ? `Patch: ${truncate(m.summary, 80)}` : 'Apply patch';
    }
    case 'web': {
      if (lowerName === 'webfetch' || lowerName === 'open') {
        return m.summary ? `Fetch ${truncate(m.summary, 80)}` : 'Web fetch';
      }
      if (lowerName === 'screenshot') return 'Screenshot';
      if (lowerName === 'click') return m.summary ? `Click ${truncate(m.summary, 60)}` : 'Click';
      if (lowerName === 'find') return m.summary ? `Find "${truncate(m.summary, 60)}"` : 'Find element';
      // web_search / websearch / search_query
      return m.summary ? `Search "${truncate(m.summary, 60)}"` : 'Web search';
    }
    case 'image': {
      return m.summary ? `Image: ${truncate(m.summary, 60)}` : 'Image query';
    }
    case 'agent': {
      if (lowerName === 'spawn_agent') return m.summary ? `Subagent: ${truncate(m.summary, 60)}` : 'Spawn agent';
      if (lowerName === 'send_input') return m.summary ? `Send input (${truncate(m.summary, 40)})` : 'Send input';
      if (lowerName === 'wait') return m.summary ? `Wait (${truncate(m.summary, 40)})` : 'Wait for agents';
      if (lowerName === 'close_agent') return m.summary ? `Close agent (${truncate(m.summary, 40)})` : 'Close agent';
      if (lowerName.startsWith('blackboard_')) return m.summary ? `Blackboard ${truncate(m.summary, 40)}` : m.name;
      return m.summary ? truncate(m.summary, 80) : m.name;
    }
    case 'forum': {
      const action = m.name.replace('forum_', '').replace(/_/g, ' ');
      return `Forum: ${action}`;
    }
    default: {
      return m.summary ? truncate(m.summary, 80) : m.name;
    }
  }
}

// ---------------------------------------------------------------------------
// Subtitle
// ---------------------------------------------------------------------------

export function toolSubtitle(model: ToolMiniModel): string | null {
  if (model.kind === 'exec' && model.meta.cwd) {
    return `cwd: ${truncate(String(model.meta.cwd), 60)}`;
  }
  if (model.kind === 'read' && model.detail) {
    // Show file path + line range if available
    const pathLine = model.detail.lines.find((l) => l.startsWith('Path:'));
    const offsetLine = model.detail.lines.find((l) => l.startsWith('Offset:'));
    if (pathLine) {
      const path = pathLine.replace('Path:', '').trim();
      const offset = offsetLine ? `  L${offsetLine.replace('Offset:', '').trim()}` : '';
      return `${truncate(path, 60)}${offset}`;
    }
  }
  if (model.kind === 'apply_patch' && model.files.length > 0) {
    return model.files.slice(0, 3).map((f) => basename(f)).join(', ');
  }
  if (model.kind === 'web' && model.detail && model.detail.lines.length > 0) {
    return truncate(model.detail.lines[0], 60);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Build single TimelineEvent
// ---------------------------------------------------------------------------

function buildEvent(tool: ToolRunDto): TimelineEvent {
  const model = getToolMiniModel(tool);
  const status = eventStatus(tool);
  const durationMs = computeDurationMs(tool);
  return {
    type: 'event',
    id: tool.id,
    toolRun: tool,
    model,
    humanTitle: toolHumanTitle(tool, model),
    subtitle: toolSubtitle(model),
    kind: model.kind,
    kindAbbr: kindAbbr(model.kind),
    status,
    durationMs,
    durationLabel: durationMs !== null ? formatDuration(durationMs) : null,
    timeoutLabel: typeof model.meta.timeoutMs === 'number' && Number.isFinite(model.meta.timeoutMs) ? `timeout ${formatDuration(model.meta.timeoutMs as number)}` : null,
  };
}

// ---------------------------------------------------------------------------
// Burst detection
// ---------------------------------------------------------------------------

function burstStatus(children: TimelineEvent[]): TimelineStatus | 'mixed' {
  const statuses = new Set(children.map((c) => c.status));
  if (statuses.has('running')) return 'running';
  if (statuses.size === 1) return children[0].status;
  if (statuses.has('error')) return 'mixed';
  return 'success';
}

function burstLabel(toolName: string, kind: ToolKind, children: TimelineEvent[]): string {
  const count = children.length;
  const status = burstStatus(children);
  const statusText = status === 'running' ? 'running' : status === 'success' ? 'all ok' : status === 'error' ? 'has errors' : 'mixed';

  // Check if this is a shell session (consecutive execs with same cwd)
  if (kind === 'exec' && toolName !== 'write_stdin') {
    const cwds = new Set(children.map((c) => c.model.meta.cwd ?? ''));
    if (cwds.size <= 1) {
      return `Shell session (${count} commands)`;
    }
  }

  if (toolName === 'write_stdin') {
    return `Burst: write_stdin ×${count} (${statusText})`;
  }

  return `Burst: ${toolName} ×${count} (${statusText})`;
}

function burstTotalDuration(children: TimelineEvent[]): number {
  return children.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);
}

interface BurstGroup {
  groupKey: string;
  events: TimelineEvent[];
}

function groupConsecutive(events: TimelineEvent[]): BurstGroup[] {
  const groups: BurstGroup[] = [];
  for (const ev of events) {
    // Group key: same tool name. For exec, also consider cwd for shell sessions.
    const key = ev.model.name;
    const last = groups[groups.length - 1];
    if (last && last.groupKey === key) {
      last.events.push(ev);
    } else {
      groups.push({ groupKey: key, events: [ev] });
    }
  }
  return groups;
}

function densityThreshold(density: DensityMode): number {
  switch (density) {
    case 'condensed': return 3;
    case 'normal':    return 5;
    case 'raw':       return Infinity; // never collapse
  }
}

// ---------------------------------------------------------------------------
// Agent frame detection
// ---------------------------------------------------------------------------

function detectAgentFrames(nodes: TimelineNode[]): TimelineNode[] {
  const result: TimelineNode[] = [];
  let agentStack: { id: string; label: string; children: TimelineNode[] } | null = null;

  for (const node of nodes) {
    if (node.type === 'event' && node.model.name === 'spawn_agent') {
      // Start a new agent frame
      if (agentStack) {
        // Close existing agent frame
        result.push(finalizeAgentFrame(agentStack));
      }
      agentStack = {
        id: `agent-${node.id}`,
        label: node.humanTitle.replace(/^Subagent:\s*/i, '') || node.humanTitle,
        children: [node],
      };
    } else if (agentStack && node.type === 'event' && (node.model.name === 'close_agent' || node.model.name === 'wait')) {
      agentStack.children.push(node);
      result.push(finalizeAgentFrame(agentStack));
      agentStack = null;
    } else if (agentStack) {
      agentStack.children.push(node);
    } else {
      result.push(node);
    }
  }

  // Close any open agent frame
  if (agentStack) {
    result.push(finalizeAgentFrame(agentStack));
  }

  return result;
}

function finalizeAgentFrame(stack: { id: string; label: string; children: TimelineNode[] }): TimelineAgentFrame {
  const statuses = stack.children.map((c) => {
    if (c.type === 'event') return c.status;
    if (c.type === 'burst') return c.status === 'mixed' ? 'error' as const : c.status;
    return (c as TimelineAgentFrame).status;
  });
  const hasRunning = statuses.includes('running');
  const hasError = statuses.includes('error');
  const status: TimelineStatus = hasRunning ? 'running' : hasError ? 'error' : 'success';

  return {
    type: 'agent_frame',
    id: stack.id,
    label: stack.label,
    status,
    children: stack.children,
  };
}

// ---------------------------------------------------------------------------
// Build full timeline
// ---------------------------------------------------------------------------

export function buildTimeline(tools: ToolRunDto[], density: DensityMode = 'normal'): TimelineNode[] {
  if (tools.length === 0) return [];

  // Build events (input is newest-first, we process in chronological order then reverse)
  const chronological = [...tools].reverse();
  const events = chronological.map(buildEvent);

  // Group consecutive same-tool events
  const groups = groupConsecutive(events);
  const threshold = densityThreshold(density);

  // Convert groups to nodes
  let nodes: TimelineNode[] = [];
  for (const group of groups) {
    if (group.events.length >= threshold) {
      const firstEvent = group.events[0];
      const totalMs = burstTotalDuration(group.events);
      const burst: TimelineBurst = {
        type: 'burst',
        id: `burst-${group.events[0].id}`,
        toolName: group.groupKey,
        kind: firstEvent.kind,
        kindAbbr: firstEvent.kindAbbr,
        label: burstLabel(group.groupKey, firstEvent.kind, group.events),
        status: burstStatus(group.events),
        totalDurationMs: totalMs,
        durationLabel: formatDuration(totalMs),
        children: group.events,
      };
      nodes.push(burst);
    } else {
      nodes.push(...group.events);
    }
  }

  // Detect agent frames
  nodes = detectAgentFrames(nodes);

  // Return newest-first
  return nodes.reverse();
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

export function filterByKind(nodes: TimelineNode[], kind: ToolKind | null): TimelineNode[] {
  if (!kind) return nodes;
  return nodes.filter((n) => {
    if (n.type === 'event') return n.kind === kind;
    if (n.type === 'burst') return n.kind === kind;
    if (n.type === 'agent_frame') return kind === 'agent';
    return false;
  });
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export { toolKindIcon, type ToolKind } from './toolMiniView';
