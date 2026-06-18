import type { ToolRunDto } from './apiClient';

export type ToolKind =
  | 'exec'
  | 'apply_patch'
  | 'read'
  | 'web'
  | 'image'
  | 'forum'
  | 'agent'
  | 'other';

export type ToolMiniDetailStyle = 'mono' | 'diff' | 'table' | 'chips' | 'plain';

export interface ToolMiniDetail {
  style: ToolMiniDetailStyle;
  lines: string[];
}

export interface ToolMiniModel {
  name: string;
  kind: ToolKind;
  summary: string | null;
  detail: ToolMiniDetail | null;
  input: string | null;
  output: string | null;
  files: string[];
  meta: Record<string, string | number | boolean | null>;
}

const KNOWN_TOOL_NAMES = new Set([
  'shell_command',
  'shell',
  'exec_command',
  'write_stdin',
  'read',
  'grep',
  'find',
  'ls',
  'read_file',
  'list_dir',
  'grep_files',
  'apply_patch',
  'search_query',
  'web_search',
  'websearch',
  'webfetch',
  'open',
  'click',
  'find',
  'screenshot',
  'image_query',
  'view_image',
  'calculator',
  'time',
  'weather',
  'finance',
  'sports',
  'spawn_agent',
  'send_input',
  'wait',
  'close_agent',
  'blackboard_read',
  'blackboard_write'
]);

const WEB_TOOL_NAMES = new Set([
  'search_query',
  'web_search',
  'websearch',
  'webfetch',
  'open',
  'click',
  'find',
  'screenshot'
]);

const IMAGE_TOOL_NAMES = new Set(['image_query', 'view_image']);

const READ_TOOL_NAMES = new Set(['read', 'grep', 'find', 'ls', 'read_file', 'list_dir', 'grep_files']);

const EXEC_TOOL_NAMES = new Set(['shell_command', 'shell', 'exec_command', 'write_stdin', 'exec']);

const AGENT_TOOL_NAMES = new Set([
  'spawn_agent',
  'send_input',
  'wait',
  'close_agent',
  'blackboard_read',
  'blackboard_write'
]);

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function truncateOneLine(value: string, max = 120): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}…`;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? '');
  }
}

function parseToolCommand(command: string | null | undefined, toolType?: string): {
  name: string | null;
  rawInput: string | null;
  inputJson: unknown | null;
} {
  const raw = command?.trim() ?? '';
  if (!raw) return { name: null, rawInput: null, inputJson: null };

  const spaceIndex = raw.indexOf(' ');
  const head = spaceIndex === -1 ? raw : raw.slice(0, spaceIndex).trim();
  const tail = spaceIndex === -1 ? '' : raw.slice(spaceIndex + 1).trim();
  const isKnown = KNOWN_TOOL_NAMES.has(head) || head.startsWith('forum_') || head.startsWith('mcp_');
  const looksLikeToolName = /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(head);
  const inputJson = tail && (tail.startsWith('{') || tail.startsWith('[')) ? safeJsonParse(tail) : null;

  if (isKnown || (looksLikeToolName && (inputJson !== null || tail))) {
    return { name: head, rawInput: tail || null, inputJson };
  }

  return { name: null, rawInput: raw, inputJson: null };
}

function toolKindFromName(name: string | null, toolType?: string): ToolKind {
  if (name) {
    if (name.startsWith('forum_')) return 'forum';
    if (name.startsWith('mcp_')) return 'agent';
    if (EXEC_TOOL_NAMES.has(name)) return 'exec';
    if (name === 'apply_patch') return 'apply_patch';
    if (READ_TOOL_NAMES.has(name)) return 'read';
    if (WEB_TOOL_NAMES.has(name)) return 'web';
    if (IMAGE_TOOL_NAMES.has(name)) return 'image';
    if (AGENT_TOOL_NAMES.has(name)) return 'agent';
  }
  const type = (toolType ?? '').toLowerCase();
  if (type === 'exec') return 'exec';
  if (type === 'apply_patch') return 'apply_patch';
  if (type === 'web') return 'web';
  if (type === 'mcp') return 'agent';
  if (type === 'read') return 'read';
  return 'other';
}

function normalizeInput(inputJson: unknown, rawInput: string | null): string | null {
  if (inputJson !== null && inputJson !== undefined) {
    return formatJson(inputJson);
  }
  if (!rawInput) return null;
  return rawInput.trim() || null;
}

function extractTimeoutMs(inputJson: unknown): number | null {
  if (!inputJson || typeof inputJson !== 'object') return null;
  const record = inputJson as Record<string, unknown>;
  // timeoutMs / timeout_ms are already in milliseconds.
  // timeout is in seconds (Pi's Bash tool uses this convention).
  if (record.timeoutMs !== null && record.timeoutMs !== undefined) {
    const v = typeof record.timeoutMs === 'number' ? record.timeoutMs : Number(record.timeoutMs);
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  if (record.timeout_ms !== null && record.timeout_ms !== undefined) {
    const v = typeof record.timeout_ms === 'number' ? record.timeout_ms : Number(record.timeout_ms);
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  if (record.timeout !== null && record.timeout !== undefined) {
    const v = typeof record.timeout === 'number' ? record.timeout : Number(record.timeout);
    return Number.isFinite(v) && v > 0 ? v * 1000 : null;  // seconds → ms
  }
  return null;
}

function extractCommand(inputJson: unknown, rawInput: string | null): string | null {
  if (inputJson && typeof inputJson === 'object' && 'command' in (inputJson as Record<string, unknown>)) {
    const command = (inputJson as Record<string, unknown>).command;
    if (Array.isArray(command)) return command.map(String).join(' ');
    if (typeof command === 'string') return command;
  }
  return rawInput ? rawInput.trim() : null;
}

function textFromToolResultPayload(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => textFromToolResultPayload(item))
      .filter(Boolean)
      .join('\n');
    return text.trim() || null;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.content)) return textFromToolResultPayload(record.content);
    if (typeof record.text === 'string') return record.text.trim() || null;
    if (typeof record.output === 'string') return record.output.trim() || null;
    if (typeof record.result === 'string') return record.result.trim() || null;
  }
  return null;
}

function extractOutputSummary(summary: string | null | undefined): string | null {
  const trimmed = summary?.trim();
  if (!trimmed) return null;
  const parsed = safeJsonParse(trimmed);
  const parsedText = parsed !== null ? textFromToolResultPayload(parsed) : null;
  if (parsedText) return parsedText;
  const outputMatch = trimmed.match(/Output:\s*([\s\S]*)$/i);
  if (outputMatch) {
    const extracted = outputMatch[1].trim();
    const parsedOutput = safeJsonParse(extracted);
    const parsedOutputText = parsedOutput !== null ? textFromToolResultPayload(parsedOutput) : null;
    return parsedOutputText || (extracted ? extracted : null);
  }
  const lines = trimmed
    .split('\n')
    .filter((line) => !line.startsWith('Command:') && !line.startsWith('Exit:') && !line.startsWith('Wall time:'))
    .join('\n')
    .trim();
  return lines || trimmed;
}

function inferPatchStats(patch: string): { adds: number; dels: number; files: string[] } {
  const lines = patch.split('\n');
  let adds = 0;
  let dels = 0;
  const files = new Set<string>();
  for (const line of lines) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) adds += 1;
    if (line.startsWith('-')) dels += 1;
    const codexMatch = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/i);
    if (codexMatch) {
      files.add(codexMatch[1].trim());
    }
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      files.add(diffMatch[2].trim());
    }
  }
  return { adds, dels, files: Array.from(files) };
}

function limitLines(lines: string[], max = 3): string[] {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max - 1), `+${lines.length - (max - 1)} more`];
}

function formatKeyValueLine(label: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return `${label}: ${String(value)}`;
}

export function toolKindIcon(kind: ToolKind): string {
  switch (kind) {
    case 'exec':
      return '⌘';
    case 'apply_patch':
      return '✚';
    case 'read':
      return '📄';
    case 'web':
      return '🔎';
    case 'image':
      return '🖼️';
    case 'forum':
      return '🧩';
    case 'agent':
      return '🧠';
    default:
      return '🔧';
  }
}

export function traceToneForKind(kind: ToolKind): string {
  switch (kind) {
    case 'web':
      return 'vb-trace-card--search';
    case 'image':
      return 'vb-trace-card--image';
    case 'read':
      return 'vb-trace-card--read';
    case 'exec':
      return 'vb-trace-card--exec';
    default:
      return 'vb-trace-card--tool';
  }
}

export function getToolMiniModel(tool: ToolRunDto): ToolMiniModel {
  const parsed = parseToolCommand(tool.command ?? null, tool.tool);
  const name = parsed.name ?? tool.tool;
  const kind = toolKindFromName(parsed.name, tool.tool);
  const inputText = normalizeInput(parsed.inputJson, parsed.rawInput);
  let outputText = extractOutputSummary(tool.outputSummary);
  // Clean up raw JSON agent_id output from spawn_agent
  if (outputText) {
    const parsedOut = safeJsonParse(outputText);
    if (parsedOut && typeof parsedOut === 'object' && 'agent_id' in (parsedOut as Record<string, unknown>)) {
      outputText = `Subagent started (${(parsedOut as Record<string, unknown>).agent_id})`;
    }
  }
  const meta: Record<string, string | number | boolean | null> = {};
  let summary: string | null = null;
  let detail: ToolMiniDetail | null = null;
  let files: string[] = Array.isArray(tool.filesTouched) ? tool.filesTouched : [];

  // Extract timeout from input JSON (Pi tools often pass timeout/timeoutMs)
  const timeoutMs = extractTimeoutMs(parsed.inputJson);
  if (timeoutMs !== null) meta.timeoutMs = timeoutMs;

  // Use `kind` for formatting branches rather than name sets, because Pi tool
  // names arrive capitalised (e.g. "Bash") while the legacy sets are lowercase.
  if (kind === 'exec') {
    const command = extractCommand(parsed.inputJson, parsed.rawInput);
    summary = command ? truncateOneLine(command, 80) : null;
    if (parsed.inputJson && typeof parsed.inputJson === 'object') {
      const cwd = (parsed.inputJson as Record<string, unknown>).workdir ?? (parsed.inputJson as Record<string, unknown>).cwd;
      if (cwd) meta.cwd = String(cwd);
    }
    const lines = [
      command ? `> ${truncateOneLine(command, 140)}` : null,
      meta.cwd ? `cwd: ${meta.cwd}` : null
    ].filter(Boolean) as string[];
    if (lines.length > 0) detail = { style: 'mono', lines };
  } else if (kind === 'apply_patch') {
    // Extract actual patch/diff text from JSON input (server stores as {patch: "..."})
    const patchFromJson = parsed.inputJson && typeof parsed.inputJson === 'object'
      ? String((parsed.inputJson as Record<string, unknown>).patch ?? (parsed.inputJson as Record<string, unknown>).diff ?? '')
      : '';
    const patchSource = patchFromJson || parsed.rawInput || outputText || '';
    if (!files.length && patchSource) {
      const stats = inferPatchStats(patchSource);
      files = stats.files;
      meta.adds = stats.adds;
      meta.dels = stats.dels;
    }
    const diffLine = meta.adds !== undefined || meta.dels !== undefined
      ? `+${meta.adds ?? 0} / -${meta.dels ?? 0}`
      : 'Patch';
    summary = files.length > 0 ? `${files.length} file${files.length === 1 ? '' : 's'}` : diffLine;
    const fileLines = files.length > 0 ? limitLines(files, 3) : [];
    const lines = [diffLine, ...fileLines.map((file) => `• ${file}`)];
    detail = lines.length > 0 ? { style: 'diff', lines } : null;
  } else if (kind === 'read') {
    const input = parsed.inputJson as Record<string, unknown> | null;
    const lowerName = (name ?? '').toLowerCase();
    if (lowerName === 'read_file' || lowerName === 'read') {
      const filePath = input?.file_path ?? input?.path;
      summary = filePath ? truncateOneLine(String(filePath), 60) : null;
      const lines = [
        formatKeyValueLine('Path', filePath),
        formatKeyValueLine('Offset', input?.offset),
        formatKeyValueLine('Limit', input?.limit),
        formatKeyValueLine('Mode', input?.mode)
      ].filter(Boolean) as string[];
      detail = lines.length > 0 ? { style: 'table', lines } : null;
    } else if (lowerName === 'list_dir' || lowerName === 'ls') {
      const dirPath = input?.dir_path ?? input?.path;
      summary = dirPath ? truncateOneLine(String(dirPath), 60) : null;
      const lines = [
        formatKeyValueLine('Dir', dirPath),
        formatKeyValueLine('Depth', input?.depth),
        formatKeyValueLine('Limit', input?.limit)
      ].filter(Boolean) as string[];
      detail = lines.length > 0 ? { style: 'table', lines } : null;
    } else if (lowerName === 'grep_files' || lowerName === 'grep') {
      summary = input?.pattern ? truncateOneLine(String(input.pattern), 60) : null;
      const lines = [
        formatKeyValueLine('Pattern', input?.pattern),
        formatKeyValueLine('Glob', input?.glob),
        formatKeyValueLine('Include', input?.include),
        formatKeyValueLine('Path', input?.path)
      ].filter(Boolean) as string[];
      detail = lines.length > 0 ? { style: 'table', lines } : null;
    } else if (lowerName === 'find') {
      summary = input?.pattern ? truncateOneLine(String(input.pattern), 60) : null;
      const lines = [
        formatKeyValueLine('Pattern', input?.pattern),
        formatKeyValueLine('Path', input?.path),
        formatKeyValueLine('Limit', input?.limit)
      ].filter(Boolean) as string[];
      detail = lines.length > 0 ? { style: 'table', lines } : null;
    }
  } else if (kind === 'web') {
    const input = parsed.inputJson as Record<string, unknown> | null;
    summary = input?.q ? truncateOneLine(String(input.q), 80) : truncateOneLine(parsed.rawInput ?? '', 80) || null;
    const chips = [
      formatKeyValueLine('q', input?.q),
      formatKeyValueLine('ref', input?.ref_id ?? input?.refId),
      formatKeyValueLine('id', input?.id),
      formatKeyValueLine('pattern', input?.pattern),
      formatKeyValueLine('pageno', input?.pageno)
    ].filter(Boolean) as string[];
    detail = chips.length > 0 ? { style: 'chips', lines: limitLines(chips, 4) } : null;
  } else if (kind === 'image') {
    const input = parsed.inputJson as Record<string, unknown> | null;
    summary = input?.q ? truncateOneLine(String(input.q), 80) : input?.path ? truncateOneLine(String(input.path), 80) : null;
    const chips = [
      formatKeyValueLine('q', input?.q),
      formatKeyValueLine('path', input?.path)
    ].filter(Boolean) as string[];
    detail = chips.length > 0 ? { style: 'chips', lines: limitLines(chips, 4) } : null;
  } else if (kind === 'agent') {
    const input = parsed.inputJson as Record<string, unknown> | null;
    const lowerName = (name ?? '').toLowerCase();
    if (lowerName === 'spawn_agent') {
      const agentType = input?.agent_type ? String(input.agent_type) : '';
      const firstLine = input?.message ? String(input.message).split('\n')[0].trim() : null;
      const isGenericType = !agentType || agentType === 'default' || agentType === 'agent';
      summary = isGenericType && firstLine
        ? truncateOneLine(firstLine, 80)
        : agentType || (firstLine ? truncateOneLine(firstLine, 80) : 'spawn');
      const lines = [
        !isGenericType ? formatKeyValueLine('Type', agentType) : null,
        firstLine ? truncateOneLine(firstLine, 120) : null
      ].filter(Boolean) as string[];
      detail = lines.length > 0 ? { style: 'plain', lines } : null;
    } else if (lowerName === 'send_input') {
      summary = input?.id ? `id: ${String(input.id)}` : 'send';
      const firstLine = input?.message ? String(input.message).split('\n')[0] : null;
      const lines = [
        formatKeyValueLine('Id', input?.id),
        firstLine ? truncateOneLine(firstLine, 120) : null,
        input?.interrupt ? 'interrupt: true' : null
      ].filter(Boolean) as string[];
      detail = lines.length > 0 ? { style: 'plain', lines } : null;
    } else if (lowerName === 'wait') {
      summary = Array.isArray(input?.ids) ? `${input?.ids.length} ids` : 'wait';
      const lines = [
        formatKeyValueLine('Ids', Array.isArray(input?.ids) ? input.ids.join(', ') : null),
        formatKeyValueLine('Timeout', input?.timeout_ms)
      ].filter(Boolean) as string[];
      detail = lines.length > 0 ? { style: 'plain', lines } : null;
    } else if (lowerName === 'close_agent') {
      summary = input?.id ? `id: ${String(input.id)}` : 'close';
      const lines = [formatKeyValueLine('Id', input?.id)].filter(Boolean) as string[];
      detail = lines.length > 0 ? { style: 'plain', lines } : null;
    } else if (lowerName.startsWith('blackboard_')) {
      summary = input?.key ? `key: ${String(input.key)}` : 'blackboard';
      const lines = [
        formatKeyValueLine('Key', input?.key),
        input?.notify_parent ? 'notify_parent: true' : null
      ].filter(Boolean) as string[];
      detail = lines.length > 0 ? { style: 'plain', lines } : null;
    }
  } else if (kind === 'forum') {
    const input = parsed.inputJson as Record<string, unknown> | null;
    summary = truncateOneLine(name.replace('forum_', '').replace(/_/g, ' '), 40);
    const chips = [
      formatKeyValueLine('topic', input?.topicId ?? input?.topic_id),
      formatKeyValueLine('post', input?.postId ?? input?.post_id),
      formatKeyValueLine('forum', input?.forumId ?? input?.forum_id)
    ].filter(Boolean) as string[];
    detail = chips.length > 0 ? { style: 'chips', lines: limitLines(chips, 4) } : null;
  } else {
    summary = parsed.rawInput ? truncateOneLine(parsed.rawInput, 80) : outputText ? truncateOneLine(outputText, 80) : null;
    if (summary) {
      detail = { style: 'plain', lines: [summary] };
    }
  }

  if (!summary && inputText) summary = truncateOneLine(inputText, 80);
  if (!summary && outputText) summary = truncateOneLine(outputText, 80);

  return {
    name,
    kind,
    summary,
    detail,
    input: inputText,
    output: outputText,
    files,
    meta
  };
}
