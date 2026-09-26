/**
 * Claude Code compatibility adapter with dynamic tool discovery.
 *
 * This runtime-owned extension adapts requests destined for the Monika pool's
 * Anthropic route and Pi's native Anthropic route. Its payload and tool
 * transformations are informed by current Claude Code compatibility behavior;
 * its header profile is applied when Pi provides the header hook.
 *
 * Authentication and transport remain owned by the selected provider. The pool
 * is a routing layer, not an exemption from compatibility shaping.
 */

import { appendFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ToolRegistration = Parameters<ExtensionAPI["registerTool"]>[0];
type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];
// Execute function signature from ToolDefinition.execute. Parameterized as `any` because
// we only need to forward the call — we don't validate or transform params/results.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolExecuteFn = (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => Promise<any>;

// Maps flat tool names (lowercase) → their execute functions.
// Populated via Map.prototype.set monkey-patch during extension loading.
// Append-only; never cleared mid-session.
const TOOL_EXECUTES = new Map<string, ToolExecuteFn>();

// ============================================================================
// Constants
// ============================================================================

/**
 * Core Claude Code tool names that always pass through Anthropic OAuth filtering.
 * Stored lowercase for case-insensitive matching.
 * Mirrors Pi core's claudeCodeTools list in packages/ai/src/providers/anthropic.ts
 */
const CORE_TOOL_NAMES = new Set([
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"glob",
	"askuserquestion",
	"enterplanmode",
	"exitplanmode",
	"killshell",
	"notebookedit",
	"skill",
	"task",
	"taskoutput",
	"todowrite",
	"webfetch",
	"websearch",
]);

/**
 * Flat tool name → namespace for tools that don't have sourceInfo.
 * Covers tools registered asynchronously (e.g. stateful-memory registers inside session_start,
 * after the resource loader has already attached sourceInfo to other extensions' tools).
 * Namespace is the directory name of the extension that owns the tool.
 */
const KNOWN_TOOLS = new Map<string, string>([
	// stateful-memory
	["list_topics", "stateful-memory"],
	["load_topic", "stateful-memory"],
	["remember", "stateful-memory"],
	["remember_session", "stateful-memory"],
	["recall", "stateful-memory"],
	// pi-self
	["pi_run", "pi-self"],
	// web-search
	["web_search", "web-search"],
	// ssh (includes relocate)
	["relocate", "ssh"],
	// browser (pi-agent-browser npm package — loaded as npm package, not extension dir)
	["browser", "pi-agent-browser"],
]);

// ============================================================================
// Helpers
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lower(name: string | undefined): string {
	return (name ?? "").trim().toLowerCase();
}

/**
 * Claude Code compatibility is for Anthropic-destined routes only. The API
 * format alone is not sufficient: another provider may speak the same wire
 * protocol without accepting Claude Code's tool and prompt conventions.
 *
 * `claude` is the Monika pool route; `anthropic` is Pi's native route. Keep
 * this allowlist explicit so new providers do not inherit the transformation
 * accidentally.
 */
function isAnthropicTarget(model: { api?: string; provider?: string } | undefined): boolean {
	if (!model || model.api !== "anthropic-messages") return false;
	const provider = lower(model.provider);
	return provider === "claude" || provider === "anthropic";
}

/**
 * Derive an MCP alias name from a tool's sourceInfo.
 * Returns e.g. "mcp__stateful-memory__remember" for a tool registered from
 * ~/.pi/agent/extensions/stateful-memory/extension.js
 *
 * Normalizes the extension directory name to a clean namespace identifier.
 * Falls back to the KNOWN_TOOLS map for tools registered asynchronously
 * (e.g. stateful-memory registers tools inside session_start, after extension load,
 * so they never get sourceInfo attached by the resource loader).
 */
function deriveMcpAlias(tool: ToolInfo, flatName: string): string | null {
	const flatNameLc = lower(flatName);

	// Fallback: check known tools map first (for asynchronously-registered tools)
	if (KNOWN_TOOLS.has(flatNameLc)) {
		return `mcp__${KNOWN_TOOLS.get(flatNameLc)}__${flatName}`;
	}

	if (!tool.sourceInfo) return null;

	const baseDir = tool.sourceInfo.baseDir;
	const fullPath = tool.sourceInfo.path ?? "";

	// Try baseDir first
	if (baseDir) {
		const dirName = basename(baseDir.replace(/\/$/, ""));
		// Skip "extensions" subdirectory — use the parent directory name instead
		const normalized = dirName === "extensions" ? basename(dirname(baseDir)) : dirName;
		if (normalized && normalized !== "agent" && normalized !== "extensions") {
			const safeNamespace = normalized.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
			return `mcp__${safeNamespace}__${flatName}`;
		}
	}

	// Fall back to extracting from the file path
	if (fullPath) {
		// Try to find a directory name that looks like an extension name
		// e.g. /app/.pi/agent/extensions/stateful-memory/extension.js
		// → stateful-memory
		const pathParts = fullPath.replace(/\\/g, "/").split("/");
		const extIndex = pathParts.indexOf("extensions");
		if (extIndex > 0) {
			const parentDir = pathParts[extIndex - 1];
			if (parentDir && parentDir !== "agent") {
				const safeNamespace = parentDir.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
				return `mcp__${safeNamespace}__${flatName}`;
			}
		}
	}

	return null;
}

// ============================================================================
// System prompt rewrite
//
// Replace Pi-identifying text with Claude Code-compatible wording. The
// identity preamble is deliberately added only after isAnthropicTarget() has
// selected an Anthropic-destined route.
// ============================================================================

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_CODE_VERSION = process.env.PI_CLAUDE_CODE_USE_VERSION?.trim() || "2.1.275";
const CLAUDE_CODE_BETAS = ["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14"];

function rewritePromptText(text: string): string {
	return text
		.replaceAll("pi itself", "the cli itself")
		.replaceAll("pi .md files", "cli .md files")
		.replaceAll("pi packages", "cli packages");
}

function rewriteSystemField(system: unknown): unknown {
	if (typeof system === "string") {
		const rewritten = rewriteAvailableToolsSection(rewritePromptText(system));
		return ensureClaudeCodeIdentity(rewritten);
	}
	if (!Array.isArray(system)) {
		return system;
	}
	let identityPresent = false;
	const rewrittenBlocks = system.map((block) => {
		if (!isPlainObject(block) || block.type !== "text" || typeof block.text !== "string") {
			return block;
		}
		const text = rewriteAvailableToolsSection(rewritePromptText(block.text));
		if (text.includes(CLAUDE_CODE_IDENTITY)) identityPresent = true;
		return text === block.text ? block : { ...block, text };
	});
	if (identityPresent) return rewrittenBlocks;
	return [{ type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: { type: "ephemeral" } }, ...rewrittenBlocks];
}

// ============================================================================
// Tool filtering and MCP alias remapping
//
// Rules applied per tool:
// 1. Anthropic-native typed tools (have a `type` field) → pass through
// 2. Core Claude Code tool names → pass through
// 3. Tools already prefixed with mcp__ → pass through (with dedup)
// 4. Unknown flat-named tools → filtered out
// Copied from upstream with dynamic companion discovery removed (handled separately).
// ============================================================================

function collectToolNames(tools: unknown[]): Set<string> {
	const names = new Set<string>();
	for (const tool of tools) {
		if (isPlainObject(tool) && typeof tool.name === "string") {
			names.add(lower(tool.name));
		}
	}
	return names;
}

function filterAndRemapTools(tools: unknown[] | undefined, disableFilter: boolean): unknown[] | undefined {
	if (!Array.isArray(tools)) return tools;

	const advertised = collectToolNames(tools);
	const emitted = new Set<string>();
	const result: unknown[] = [];

	for (const tool of tools) {
		if (!isPlainObject(tool)) continue;

		// Rule 1: native typed tools always pass through
		if (typeof tool.type === "string" && tool.type.trim().length > 0) {
			result.push(tool);
			continue;
		}

		const name = typeof tool.name === "string" ? tool.name : "";
		if (!name) continue;
		const nameLc = lower(name);

		// Rules 2 & 3: core tools and mcp__-prefixed pass through (with dedup)
		if (CORE_TOOL_NAMES.has(nameLc) || nameLc.startsWith("mcp__")) {
			if (!emitted.has(nameLc)) {
				emitted.add(nameLc);
				result.push(tool);
			}
			continue;
		}

		// Rule 4: unknown flat-named tool — filter out (unless filter disabled)
		if (disableFilter && !emitted.has(nameLc)) {
			emitted.add(nameLc);
			result.push(tool);
		}
	}

	return result;
}

// ============================================================================
// tool_choice remapping
// Copied from upstream.
// ============================================================================

function remapToolChoice(
	toolChoice: Record<string, unknown>,
	survivingNames: Map<string, string>,
): Record<string, unknown> | undefined {
	if (toolChoice.type !== "tool" || typeof toolChoice.name !== "string") {
		return toolChoice;
	}

	const nameLc = lower(toolChoice.name);
	const actualName = survivingNames.get(nameLc);
	if (actualName) {
		return actualName === toolChoice.name ? toolChoice : { ...toolChoice, name: actualName };
	}

	// Also check mcp__ prefixed names
	if (nameLc.startsWith("mcp__") && survivingNames.has(nameLc)) {
		return toolChoice;
	}

	return undefined;
}

// ============================================================================
// Message history rewriting
// Rewrites tool_use blocks in conversation history to use MCP aliases.
// Copied from upstream.
// ============================================================================

function remapMessageToolNames(messages: unknown[], survivingNames: Map<string, string>): unknown[] {
	let anyChanged = false;
	const result = messages.map((msg) => {
		if (!isPlainObject(msg) || !Array.isArray(msg.content)) return msg;

		let msgChanged = false;
		const content = (msg.content as unknown[]).map((block) => {
			if (!isPlainObject(block) || block.type !== "tool_use" || typeof block.name !== "string") {
				return block;
			}
			const nameLc = lower(block.name);
			const actualName = survivingNames.get(nameLc);
			if (actualName && actualName !== block.name) {
				msgChanged = true;
				return { ...block, name: actualName };
			}
			return block;
		});

		if (msgChanged) {
			anyChanged = true;
			return { ...msg, content };
		}
		return msg;
	});

	return anyChanged ? result : messages;
}

// System prompt rewrite — Available tools section
// Replaces flat tool names in the "Available tools:" section with MCP aliases
// and removes entries for tools that have no MCP alias (they'll fail OAuth anyway).
function ensureClaudeCodeIdentity(systemText: string): string {
	if (systemText.includes(CLAUDE_CODE_IDENTITY)) return systemText;
	return `${CLAUDE_CODE_IDENTITY}\n\n${systemText}`;
}

function rewriteAvailableToolsSection(systemText: string): string {
	const marker = "Available tools:";
	const endMarker = "Guidelines:";
	const start = systemText.indexOf(marker);
	if (start === -1) return systemText;
	const end = systemText.indexOf(endMarker, start);
	if (end === -1) return systemText;

	const before = systemText.slice(0, start);
	const toolsBlock = systemText.slice(start, end);
	const after = systemText.slice(end);

	// FLAT_TO_MCP maps flat_name → mcp_alias
	const lines = toolsBlock.split("\n");
	const result: string[] = [];
	let skipUntilNext = false;

	for (const raw of lines) {
		const line = raw;
		// Detect tool header: "- ToolName: description"
		const header = line.match(/^(\s*-\s+)([A-Za-z_][A-Za-z0-9_]*)(:)(.*)/);
		if (header) {
			const [, indent, name, colon, rest] = header;
			const mcp = FLAT_TO_MCP.get(name.toLowerCase());
			if (mcp) {
				result.push(`${indent}- ${mcp}${colon}${rest}`);
				skipUntilNext = false;
			} else {
				// No MCP alias — skip this tool's header and all its description lines
				skipUntilNext = true;
			}
		} else if (skipUntilNext) {
			// Inside a skipped tool's description — skip unless this is an empty line
			// or clearly a new tool entry
			if (/^\s*$/.test(line) || /^\s*-\s/.test(line)) {
				skipUntilNext = false;
				if (/^\s*-\s/.test(line)) {
					// Reprocess as new header
					const h = line.match(/^(\s*-\s+)([A-Za-z_][A-Za-z0-9_]*)(:)(.*)/);
					if (h) {
						const [, indent2, name2, colon2, rest2] = h;
						const mcp2 = FLAT_TO_MCP.get(name2.toLowerCase());
						if (mcp2) {
							result.push(line.replace(`${indent2}- ${name2}${colon2}`, `${indent2}- ${mcp2}${colon2}`));
						} else {
							skipUntilNext = true;
						}
					} else {
						result.push(line);
					}
				} else {
					result.push(line);
				}
			}
		} else {
			result.push(line);
		}
	}

	return before + result.join("\n") + after;
}

// ============================================================================
// Full payload transform
// Copied from upstream with companion-specific logic removed.
// ============================================================================

function transformPayload(raw: Record<string, unknown>, disableFilter: boolean): Record<string, unknown> {
	const payload = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;

	// 1. System prompt rewrite and Claude Code identity (always applies to the
	// already-selected Anthropic target).
	if (payload.system === undefined) {
		payload.system = [{ type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: { type: "ephemeral" } }];
	} else {
		payload.system = rewriteSystemField(payload.system);
	}

	// When escape hatch is active, skip all tool filtering/remapping
	if (disableFilter) {
		return payload;
	}

	// 2. Tool filtering
	payload.tools = filterAndRemapTools(payload.tools as unknown[] | undefined, false);

	// 3. Build map of tool names that survived filtering (lowercase → actual name)
	const survivingNames = new Map<string, string>();
	if (Array.isArray(payload.tools)) {
		for (const tool of payload.tools) {
			if (isPlainObject(tool) && typeof tool.name === "string") {
				survivingNames.set(lower(tool.name), tool.name as string);
			}
		}
	}

	// 4. Remap tool_choice if it references a renamed or filtered tool
	if (isPlainObject(payload.tool_choice)) {
		const remapped = remapToolChoice(payload.tool_choice, survivingNames);
		if (remapped === undefined) {
			delete payload.tool_choice;
		} else {
			payload.tool_choice = remapped;
		}
	}

	// 5. Rewrite historical tool_use blocks in message history
	if (Array.isArray(payload.messages)) {
		payload.messages = remapMessageToolNames(payload.messages, survivingNames);
	}

	return payload;
}

// ============================================================================
// Debug logging
// Copied from upstream.
// ============================================================================

const debugLogPath = process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG;

function writeDebugLog(payload: unknown): void {
	if (!debugLogPath) return;
	try {
		appendFileSync(debugLogPath, `${new Date().toISOString()}\n${JSON.stringify(payload, null, 2)}\n---\n`, "utf-8");
	} catch {
		// Debug logging must never break actual requests
	}
}

// ============================================================================
// Dynamic MCP alias registration
//
// Instead of a hardcoded companion list, we dynamically discover all registered
// tools on every agent turn and register MCP-style aliases for any flat-named tool
// that isn't on the allowlist and isn't already mcp-prefixed.
//
// This means ANY extension's tools survive the filter automatically.
// ============================================================================

const registeredMcpAliases = new Set<string>();
const autoActivatedAliases = new Set<string>();
let lastManagedToolList: string[] | undefined;
let anthropicRouteActive = false;

const FLAT_TO_MCP = new Map<string, string>(); // flat → mcp (append-only, never cleared mid-session)
const FLAT_TOOL_DEFS = new Map<string, ToolInfo>(); // flat name → original tool definition (cleared/rebuilt each turn)

async function registerAliasesForAllTools(pi: ExtensionAPI): Promise<void> {
	FLAT_TOOL_DEFS.clear();
	// NOTE: Do NOT clear FLAT_TO_MCP. It is append-only (keyed by flat name).
	// Clearing it mid-session causes the execute shim to lose the flat→mcp lookup
	// when registerAliasesForAllTools runs again in the same turn after the model
	// calls an MCP alias tool (turn 2 onward). Since FLAT_TO_MCP is keyed by flat name,
	// not MCP alias, re-registering the same alias overwrites nothing harmful.

	const allTools = pi.getAllTools();
	const knownNames = new Set(allTools.map((t) => lower(t.name)));

	// Populate FLAT_TOOL_DEFS so execute delegation can find original tools by flat name.
	// Exclude MCP alias tools that were registered in previous turns — we only want
	// the original flat-named tools so the execute delegation works correctly.
	for (const tool of allTools) {
		const nameLc = lower(tool.name);
		if (nameLc.startsWith("mcp__")) continue;
		FLAT_TOOL_DEFS.set(nameLc, tool);
	}

	if (process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG) {
		const debug = (msg: string) =>
			appendFileSync(process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG!, `${new Date().toISOString()} [register] ${msg}\n`, "utf-8");
		debug(`knownNames: ${[...knownNames].sort().join(", ")}`);
		debug(`FLAT_TOOL_DEFS size: ${FLAT_TOOL_DEFS.size}, keys: ${[...FLAT_TOOL_DEFS.keys()].sort().join(", ")}`);
		debug(`FLAT_TO_MCP size: ${FLAT_TO_MCP.size}, entries: ${[...FLAT_TO_MCP.entries()].map(([k, v]) => `${k}→${v}`).sort().join(", ")}`);
	}

	// Process each tool — register MCP alias for flat-named non-core non-mcp tools
	for (const tool of allTools) {
		const flatName = tool.name;
		const flatNameLc = lower(flatName);

		// Skip core tools and MCP-prefixed tools
		if (CORE_TOOL_NAMES.has(flatNameLc)) continue;
		if (flatNameLc.startsWith("mcp__")) continue;

		// Derive MCP alias from sourceInfo (or KNOWN_TOOLS fallback)
		const mcpAlias = deriveMcpAlias(tool, flatName);
		if (!mcpAlias) {
			if (process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG) {
				appendFileSync(
					process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG!,
					`${new Date().toISOString()} [skip] ${flatName}: deriveMcpAlias returned null\n`,
					"utf-8",
				);
			}
			continue;
		}

		const mcpAliasLc = lower(mcpAlias);

		// Skip if already registered in a previous turn
		if (registeredMcpAliases.has(mcpAliasLc)) {
			// Already exists — add to FLAT_TO_MCP for this turn's sync
			FLAT_TO_MCP.set(flatNameLc, mcpAliasLc);
			continue;
		}

		// Look up the original tool's definition (stored for execute delegation)
		// FLAT_TOOL_DEFS has flat names as keys (MCP aliases filtered out), so we
		// look up by flatNameLc directly.
		const originalTool = FLAT_TOOL_DEFS.get(flatNameLc);
		if (!originalTool) continue;

		// Register the MCP alias with an execute function that delegates to the original tool.
		// The execute function is NOT stored in FLAT_TOOL_DEFS (ToolInfo omits it intentionally).
		// Instead, it was captured via:
		//   1. The registerTool monkey-patch (catches tools registered after our patch)
		//   2. captureExecuteFromRunner via getAllTools (catches tools registered before)
		// We look it up in TOOL_EXECUTES at execution time — this is always correct
		// since execute functions are immutable and TOOL_EXECUTES is never cleared.
		const flatKey = flatNameLc;
		pi.registerTool({
			name: mcpAlias,
			label: `MCP ${originalTool.label ?? flatName}`,
			description: originalTool.description ?? "",
			parameters: originalTool.parameters ?? Type.Object({}),
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				if (process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG) {
					appendFileSync(
						process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG!,
						`${new Date().toISOString()} [execute] ${mcpAlias} called — flatKey=${flatKey} hasExecute=${TOOL_EXECUTES.has(flatKey)}\n`,
					);
				}
				const executeFn = TOOL_EXECUTES.get(flatKey);
				if (!executeFn) {
					return { content: [{ type: "text", text: `Tool ${mcpAlias} has no execute function cached` }], isError: true };
				}
				return executeFn(toolCallId, params, signal, onUpdate, ctx);
			},
		});

		registeredMcpAliases.add(mcpAliasLc);
		FLAT_TO_MCP.set(flatNameLc, mcpAliasLc);
	}
}

/**
 * Synchronize MCP alias tool activation with the current model state.
 * Auto-activates MCP aliases when their flat counterpart is active.
 * Removes auto-activated aliases when OAuth is inactive (but preserves user-selected).
 */
function syncAliasActivation(pi: ExtensionAPI, enableAliases: boolean): void {
	const activeNames = pi.getActiveTools();
	const allNames = new Set(pi.getAllTools().map((t) => lower(t.name)));

	if (enableAliases) {
		const activeLc = new Set(activeNames.map(lower));
		const desiredAliases: string[] = [];

		for (const [flat, mcp] of FLAT_TO_MCP) {
			if (activeLc.has(flat) && allNames.has(lower(mcp)) && registeredMcpAliases.has(lower(mcp))) {
				desiredAliases.push(mcp);
			}
		}
		const desiredSet = new Set(desiredAliases);

		// Promote auto-activated aliases to user-selected when user explicitly kept
		// the alias while removing its flat counterpart
		if (lastManagedToolList !== undefined) {
			const activeSet = new Set(activeNames.map(lower));
			const lastManaged = new Set(lastManagedToolList.map(lower));
			for (const alias of autoActivatedAliases) {
				if (!activeSet.has(alias) || desiredSet.has(alias)) continue;
				// Find the flat name for this alias
				const flatName = [...FLAT_TO_MCP.entries()].find(([, mcp]) => lower(mcp) === alias)?.[0];
				if (flatName && lastManaged.has(lower(flatName)) && !activeSet.has(lower(flatName))) {
					autoActivatedAliases.delete(alias);
				}
			}
		}

		const activeRegistered = activeNames.filter((n) => registeredMcpAliases.has(lower(n)));
		const preserved = activeRegistered.filter((n) => !autoActivatedAliases.has(lower(n)));

		const nonAlias = activeNames.filter((n) => !registeredMcpAliases.has(lower(n)));
		const next = Array.from(new Set([...nonAlias, ...preserved, ...desiredAliases]));

		const preservedSet = new Set(preserved.map(lower));
		autoActivatedAliases.clear();
		for (const name of desiredAliases) {
			if (!preservedSet.has(lower(name))) {
				autoActivatedAliases.add(name);
			}
		}

		if (next.length !== activeNames.length || next.some((n, i) => n !== activeNames[i])) {
			pi.setActiveTools(next);
			lastManagedToolList = next;
		}
	} else {
		const next = activeNames.filter((n) => !autoActivatedAliases.has(lower(n)));
		autoActivatedAliases.clear();

		if (next.length !== activeNames.length || next.some((n, i) => n !== activeNames[i])) {
			pi.setActiveTools(next);
			lastManagedToolList = next;
		} else {
			lastManagedToolList = undefined;
		}
	}
}

// ============================================================================
// Extension entry point
// ============================================================================

export default async function claudeCodeUse(pi: ExtensionAPI): Promise<void> {

	// Monkey-patch Map.prototype.set to capture execute functions from ALL extensions'
	// tool registrations. Each extension gets its own ExtensionAPI object with its own
	// registerTool closure, so patching pi.registerTool only catches our own calls.
	// But all extensions store tools in Map instances (extension.tools.set()), and
	// Map.prototype.set is shared. We detect tool registrations by checking the value
	// shape: {definition: {name: string, execute: Function}}.
	const origMapSet = Map.prototype.set;
	const mcpAliasPattern = /^mcp__/;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(Map.prototype as any).set = function (key: unknown, value: unknown) {
		if (
			typeof key === "string" &&
			value != null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(typeof (value as any).definition?.execute === "function") &&
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			typeof (value as any).definition?.name === "string" &&
			!mcpAliasPattern.test(key.toLowerCase())
		) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const name = (value as any).definition.name as string;
			const execute = (value as any).definition.execute as ToolExecuteFn;
			TOOL_EXECUTES.set(name.toLowerCase(), execute);
			if (process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG) {
				appendFileSync(
					process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG!,
					`${new Date().toISOString()} [map-set] captured execute for ${name}\n`,
					"utf-8",
				);
			}
		}
		return origMapSet.call(this, key, value);
	};

	// Restore Map.prototype.set after the session_start dispatch reaches the next
	// event-loop turn. This keeps capture active for tools registered by later
	// session_start handlers, while still limiting the global patch window.
	let mapSetRestored = false;
	function restoreMapSet() {
		if (mapSetRestored) return;
		mapSetRestored = true;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(Map.prototype as any).set = origMapSet;
		if (process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG) {
			appendFileSync(
				process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG!,
				`${new Date().toISOString()} [map-set] restored Map.prototype.set, TOOL_EXECUTES has ${TOOL_EXECUTES.size} entries: ${[...TOOL_EXECUTES.keys()].join(", ")}\n`,
				"utf-8",
			);
		}
	}

	// Pre-register aliases at session start. session_start fires after extensions have
	// loaded but before the agent loop begins. This means aliases are registered
	// before the first before_agent_start, giving them a chance to appear in turn 1's
	// tool list.
	// Defer Map.prototype.set restoration so later session_start handlers can
	// register tools before capture closes.
	pi.on("session_start", async () => {
		if (process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG) {
			appendFileSync(
				process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG!,
				`${new Date().toISOString()} [session_start] firing, TOOL_EXECUTES: ${[...TOOL_EXECUTES.keys()].join(", ")}\n`,
				"utf-8",
			);
		}
		// Keep capture active through later session_start handlers. pi-subagents
		// registers subagent_supervisor during its handler rather than its factory.
		// Deferring restoration one event-loop turn captures that tool without a
		// hardcoded alias or execute fallback.
		setImmediate(restoreMapSet);
		await registerAliasesForAllTools(pi);
		if (process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG) {
			appendFileSync(
				process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG!,
				`${new Date().toISOString()} [session_start] done, registered: ${[...registeredMcpAliases].join(", ")}\n`,
				"utf-8",
			);
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		anthropicRouteActive = isAnthropicTarget(ctx.model);
		await registerAliasesForAllTools(pi);
		// The pool is only a routing layer: Anthropic compatibility must be applied
		// before both pool and native Anthropic requests leave Pi.
		const isAnthropicRoute = isAnthropicTarget(ctx.model);
		syncAliasActivation(pi, isAnthropicRoute);
	});

	// Pi 0.87 introduced a header hook. Register through a narrow compatibility
	// cast so this extension remains loadable on older runtimes, where the hook
	// simply is not emitted. The payload hook below remains authoritative there.
	(pi.on as unknown as (event: string, handler: (event: { headers: Record<string, string | null> }) => void) => void)(
		"before_provider_headers",
		(event) => {
			if (!anthropicRouteActive) return;
			event.headers.accept = "application/json";
			event.headers["anthropic-dangerous-direct-browser-access"] = "true";
			event.headers["anthropic-beta"] = CLAUDE_CODE_BETAS.join(",");
			event.headers["user-agent"] = `claude-code/${CLAUDE_CODE_VERSION}`;
			event.headers["x-app"] = "cli";
		},
	);

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		anthropicRouteActive = isAnthropicTarget(model);
		// The pool forwards to Anthropic; it is not an exemption from Claude Code
		// compatibility. Restrict this to the explicitly supported Anthropic routes
		// so other providers remain completely untouched.
		if (!isAnthropicTarget(model)) {
			return undefined;
		}
		if (!isPlainObject(event.payload)) {
			return undefined;
		}

		writeDebugLog({ stage: "before", payload: event.payload });
		const disableFilter = process.env.PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER === "1";
		const transformed = transformPayload(event.payload as Record<string, unknown>, disableFilter);
		writeDebugLog({ stage: "after", payload: transformed });
		return transformed;
	});
}
