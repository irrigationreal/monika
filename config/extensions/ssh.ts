/**
 * SSH Remote Execution Example
 *
 * Demonstrates delegating tool operations to a remote machine via SSH.
 * When --ssh is provided, read/write/edit/bash run on the remote.
 *
 * Usage:
 *   pi -e ./ssh.ts --ssh user@host
 *   pi -e ./ssh.ts --ssh user@host:/remote/path
 *
 * Requirements:
 *   - SSH key-based auth (no password prompts)
 *   - bash on remote
 *
 * Docs: ~/.pi/agent/extensions/SSH.md
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Runtime-owned plain ESM helper is copied beside this extension.
// @ts-ignore no declaration file is needed in the Pi extension loader.
import {
	ATOMIC_WRITE_SCRIPT,
	LOCKED_MKDIR_SCRIPT,
	STARTUP_PROBE_SCRIPT,
	appendEffectsRecord,
	assertLockedDescriptorBinding,
	buildPositionalSshArgv,
	buildPositionalSshInput,
	effectsRecord,
	loadLockedDescriptor,
	lockedInputDecision,
	mutationId,
	parseCompletionTrailer,
	redactLockedError,
	runLockedSsh,
	runSshArgv,
	withBoundedReadRetry,
} from "./ssh-lock.mjs";
// Runtime-owned plain ESM helpers keep relocate parsing, locking, and state
// transitions testable without loading Pi or contacting a real SSH host.
// @ts-ignore no declaration file is needed in the Pi extension loader.
import {
	createAsyncReadWriteLock,
	executeRelocateRequest,
	parseRelocateTarget,
	REMOTE_ATOMIC_WRITE_SCRIPT,
	REMOTE_FIND_SCRIPT,
	REMOTE_GREP_SCRIPT,
	updateSshUiBestEffort,
} from "./ssh-relocate.mjs";
import {
	type BashOperations,
	createBashTool,
	createLocalBashOperations,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
const DEFAULT_LS_LIMIT = 500;
const DEFAULT_LS_MAX_BYTES = 50 * 1024;
const DEFAULT_FIND_LIMIT = 1000;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_MAX_BYTES = 50 * 1024;
const GREP_MAX_LINE_LENGTH = 500;
const REMOTE_SEARCH_TIMEOUT_MS = 30_000;
const REMOTE_SEARCH_MAX_BYTES = 4 * 1024 * 1024;
const REMOTE_AGENTS_MAX_BYTES = 256 * 1024;
const SSH_CONTROL_TIMEOUT_MS = 30_000;
const SSH_SEARCH_INPUT_MAX_BYTES = 32 * 1024;

function sshFailureOutcome(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/timed? out|timeout/i.test(message)) return "timeout";
	if (/aborted|cancelled|canceled/i.test(message)) return "cancelled";
	if (/invalid|too long|exceeds.*limit/i.test(message)) return "invalid_input";
	if (/not available|unavailable|command not found|dependency/i.test(message)) return "dependency";
	if (/ssh|connection|transport|socket|resolve hostname/i.test(message)) return "transport";
	return "tool_execution";
}

function getCliFlagValue(name: string): string | undefined {
	const longName = `--${name}`;
	const prefix = `${longName}=`;
	for (let i = 0; i < process.argv.length; i += 1) {
		const arg = process.argv[i];
		if (arg === longName) {
			const next = process.argv[i + 1];
			if (next && !next.startsWith("-")) {
				return next;
			}
		}
		if (arg.startsWith(prefix)) {
			return arg.slice(prefix.length);
		}
	}
	return undefined;
}

function getCliFlagBoolean(name: string): boolean | undefined {
	const longName = `--${name}`;
	const prefix = `${longName}=`;
	for (let i = 0; i < process.argv.length; i += 1) {
		const arg = process.argv[i];
		if (arg === longName) return true;
		if (arg.startsWith(prefix)) {
			const value = arg.slice(prefix.length).toLowerCase();
			if (value === "true") return true;
			if (value === "false") return false;
		}
	}
	return undefined;
}

function truncateToBytes(input: string, maxBytes: number): { text: string; truncated: boolean } {
	const buf = Buffer.from(input, "utf-8");
	if (buf.length <= maxBytes) {
		return { text: input, truncated: false };
	}
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) {
		end -= 1;
	}
	return { text: buf.slice(0, end).toString("utf-8"), truncated: true };
}

function truncateLine(line: string, maxChars = GREP_MAX_LINE_LENGTH): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}

/** Run fixed reviewed shell source with every variable value passed positionally. */
async function sshExecScript(
	remote: string,
	script: string,
	args: Array<string | number> = [],
	options: { sshOptions?: string[]; signal?: AbortSignal; timeoutMs?: number; stdin?: string | Buffer; onData?: (chunk: Buffer) => void } = {},
): Promise<Buffer> {
	try {
		const result = await runSshArgv(
			buildPositionalSshArgv(options.sshOptions ?? SSH_OPTIONS, remote),
			{
				signal: options.signal,
				timeoutMs: options.timeoutMs,
				stdin: buildPositionalSshInput(script, args, options.stdin),
				onData: options.onData,
			},
		);
		return result.stdout;
	} catch (error: any) {
		const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8") : "";
		if (error?.timedOut) throw new Error(`SSH command timed out after ${options.timeoutMs ?? 0}ms`);
		if (error?.outputLimitExceeded) throw new Error("SSH command exceeded the output byte limit");
		if (error?.aborted) throw new Error("SSH command aborted");
		throw new Error(`SSH failed (${error?.code ?? "unknown"}): ${stderr}`);
	}
}

/** SSH options for relocate validation — accepts new host keys automatically. */
const RELOCATE_SSH_OPTIONS = [
	"-o", "BatchMode=yes",
	"-o", "ConnectTimeout=10",
	"-o", "StrictHostKeyChecking=accept-new",
];

/**
 * Validate an SSH connection before switching. Returns a structured result
 * so the caller can report specific failure reasons.
 */
async function validateSshTarget(remote: string, remoteCwd?: string, signal?: AbortSignal): Promise<{
	success: boolean;
	remoteCwd: string;
	hostname?: string;
	error?: string;
	errorKind?: "host_key" | "auth" | "refused" | "timeout" | "path" | "dependency" | "unknown";
}> {
	try {
		// Test basic connectivity
		const controlOptions = { sshOptions: RELOCATE_SSH_OPTIONS, signal, timeoutMs: SSH_CONTROL_TIMEOUT_MS };
		const echoResult = await sshExecScript(remote, "printf '%s\\n' __relocate_ok__\n", [], controlOptions);
		if (!echoResult.toString().includes("__relocate_ok__")) {
			return { success: false, remoteCwd: "", error: "Unexpected response from host", errorKind: "unknown" };
		}

		// Get remote cwd. Connectivity has already succeeded, so failure while
		// resolving an explicitly requested cwd is a path error, not an unknown
		// transport error.
		let cwd: string;
		try {
			cwd = await resolveRemoteCwd(remote, remoteCwd, RELOCATE_SSH_OPTIONS, signal);
		} catch (error: any) {
			if (remoteCwd) {
				return { success: false, remoteCwd, error: `Remote path does not exist or is not accessible: ${remoteCwd}`, errorKind: "path" };
			}
			throw error;
		}

		// Verify cwd exists
		try {
			await sshExecScript(remote, "test -d \"$1\"\n", [cwd], controlOptions);
		} catch {
			return { success: false, remoteCwd: cwd, error: `Remote path does not exist: ${cwd}`, errorKind: "path" };
		}

		// Relocated find/grep depend on a pre-provisioned ripgrep. Fail during
		// relocation rather than attempting first-use downloads or local fallback.
		try {
			await sshExecScript(remote, "command -v rg >/dev/null\nrg --version | head -n 1\n", [], controlOptions);
		} catch {
			return { success: false, remoteCwd: cwd, error: "Required remote dependency rg is unavailable. Install ripgrep on the target and retry.", errorKind: "dependency" };
		}

		// Get hostname for display
		let hostname: string | undefined;
		try {
			hostname = (await sshExecScript(remote, "hostname\n", [], controlOptions)).toString().trim();
		} catch { /* non-fatal */ }

		return { success: true, remoteCwd: cwd, hostname };
	} catch (error: any) {
		const msg: string = error?.message ?? String(error);
		if (msg.includes("Host key verification failed")) {
			return { success: false, remoteCwd: "", error: "Host key verification failed — the host's SSH key has CHANGED (possible security issue). Manually verify and update known_hosts.", errorKind: "host_key" };
		}
		if (msg.includes("Permission denied")) {
			return { success: false, remoteCwd: "", error: `Authentication failed for ${remote}. Check SSH keys and authorized_keys on the target.`, errorKind: "auth" };
		}
		if (msg.includes("Connection refused")) {
			return { success: false, remoteCwd: "", error: `Connection refused by ${remote}. Is sshd running on the target?`, errorKind: "refused" };
		}
		if (msg.includes("timed out") || msg.includes("Connection timed out")) {
			return { success: false, remoteCwd: "", error: `Connection timed out for ${remote}. Host may be unreachable.`, errorKind: "timeout" };
		}
		if (msg.includes("Could not resolve hostname")) {
			return { success: false, remoteCwd: "", error: `Could not resolve hostname in ${remote}. Check the address.`, errorKind: "unknown" };
		}
		return { success: false, remoteCwd: "", error: msg, errorKind: "unknown" };
	}
}

function parseSshArg(arg: string): { remote: string; remoteCwd?: string } {
	const parsed = parseRelocateTarget(arg);
	if (parsed.kind !== "remote") {
		throw new Error("SSH startup target must name a remote host.");
	}
	return { remote: parsed.remote, remoteCwd: parsed.remoteCwd };
}

async function resolveRemoteCwd(remote: string, remoteCwd: string | undefined, options?: string[], signal?: AbortSignal): Promise<string> {
	const controlOptions = { sshOptions: options, signal, timeoutMs: SSH_CONTROL_TIMEOUT_MS };
	if (!remoteCwd) return (await sshExecScript(remote, "pwd -P\n", [], controlOptions)).toString().trim();
	return (await sshExecScript(remote, "set -eu\ntarget=\"$1\"\ncase \"$target\" in '~') target=\"$HOME\" ;; '~/'*) target=\"$HOME/${target#~/}\" ;; esac\ncd -- \"$target\"\npwd -P\n", [remoteCwd], controlOptions)).toString().trim();
}

function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string, signal?: AbortSignal): ReadOperations {
	const toRemote = (p: string) => resolveRemotePath(remoteCwd, localCwd, p);
	const options = { signal, timeoutMs: SSH_CONTROL_TIMEOUT_MS };
	return {
		readFile: (p) => sshExecScript(remote, "cat -- \"$1\"\n", [toRemote(p)], options),
		access: (p) => sshExecScript(remote, "test -r \"$1\"\n", [toRemote(p)], options).then(() => {}),
		detectImageMimeType: async (p) => {
			try {
				const r = await sshExecScript(remote, "file --mime-type -b -- \"$1\"\n", [toRemote(p)], options);
				const m = r.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(remote: string, remoteCwd: string, localCwd: string, signal?: AbortSignal): WriteOperations {
	const toRemote = (p: string) => resolveRemotePath(remoteCwd, localCwd, p);
	const options = { signal, timeoutMs: SSH_CONTROL_TIMEOUT_MS };
	return {
		writeFile: async (p, content) => {
			// File content travels over stdin, never argv. This avoids Linux's
			// per-argument E2BIG ceiling when edit retransmits a complete file.
			const data = Buffer.from(content);
			const b64 = data.toString("base64");
			const digest = createHash("sha256").update(data).digest("hex");
			await sshExecScript(remote, REMOTE_ATOMIC_WRITE_SCRIPT, [toRemote(p), digest], { ...options, stdin: b64 });
		},
		mkdir: (dir) => sshExecScript(remote, "mkdir -p -- \"$1\"\n", [toRemote(dir)], options).then(() => {}),
	};
}

function createRemoteEditOps(remote: string, remoteCwd: string, localCwd: string, signal?: AbortSignal): EditOperations {
	const r = createRemoteReadOps(remote, remoteCwd, localCwd, signal);
	const w = createRemoteWriteOps(remote, remoteCwd, localCwd, signal);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createRemoteBashOps(remote: string, remoteCwd: string, localCwd: string): BashOperations {
	const toRemote = (p: string) => resolveRemotePath(remoteCwd, localCwd, p);
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			// Bash input is intentionally shell source, but transporting it as a
			// positional value prevents the SSH login shell from evaluating it.
			const script = `set +e\ncd -- "$1" || exit 70\nif [ -z "$GNUPGHOME" ] && [ -d "$HOME/.config/gnupg" ]; then export GNUPGHOME="$HOME/.config/gnupg"; fi\ntmp=$(mktemp); trap 'rm -f -- "$tmp"' EXIT HUP INT TERM\ncat > "$tmp"\nbash -l "$tmp"\nexit $?\n`;
			try {
				await sshExecScript(remote, script, [toRemote(cwd)], {
					signal,
					timeoutMs: timeout ? timeout * 1000 : undefined,
					stdin: command,
					onData,
				});
				return { exitCode: 0 };
			} catch (error: any) {
				const match = error.message.match(/^SSH failed \((\d+)\):/);
				if (match) return { exitCode: Number(match[1]) };
				throw error;
			}
		},
	};
}

function normalizePosixPath(input: string): string {
	return path.posix.normalize(input.replace(/\\/g, "/"));
}

function isPathWithin(parent: string, candidate: string): boolean {
	const relative = path.posix.relative(normalizePosixPath(parent), normalizePosixPath(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative));
}

function resolveRemotePath(remoteCwd: string, localCwd: string, inputPath: string | undefined): string {
	const rawPath = inputPath === undefined || inputPath === "" ? "." : inputPath;
	const normalizedRemoteCwd = normalizePosixPath(remoteCwd);
	const normalizedLocalCwd = normalizePosixPath(localCwd);
	if (rawPath === ".") return normalizedRemoteCwd;
	if (path.posix.isAbsolute(rawPath)) {
		const normalizedRawPath = normalizePosixPath(rawPath);
		if (isPathWithin(normalizedLocalCwd, normalizedRawPath)) {
			const relative = path.posix.relative(normalizedLocalCwd, normalizedRawPath);
			return relative ? path.posix.join(normalizedRemoteCwd, relative) : normalizedRemoteCwd;
		}
		return normalizedRawPath;
	}
	return path.posix.join(normalizedRemoteCwd, rawPath);
}

async function remoteLs(
	remote: string,
	remoteCwd: string,
	localCwd: string,
	path: string | undefined,
	limit: number | undefined,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
	const resolvedPath = resolveRemotePath(remoteCwd, localCwd, path);
	const deadline = Date.now() + SSH_CONTROL_TIMEOUT_MS;
	try {
		await sshExecScript(remote, "test -e \"$1\"\n", [resolvedPath], boundedOptions(deadline, signal));
	} catch {
		throw new Error(`Path not found: ${resolvedPath}`);
	}
	try {
		await sshExecScript(remote, "test -d \"$1\"\n", [resolvedPath], boundedOptions(deadline, signal));
	} catch {
		throw new Error(`Not a directory: ${resolvedPath}`);
	}
	const rawEntries = (await sshExecScript(remote, "LC_ALL=C ls -A -p -- \"$1\"\n", [resolvedPath], boundedOptions(deadline, signal)))
		.toString()
		.trim();
	const entries = rawEntries.length ? rawEntries.split("\n") : [];
	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	const effectiveLimit = limit ?? DEFAULT_LS_LIMIT;
	let entryLimitReached = false;
	let limitedEntries = entries;
	if (entries.length > effectiveLimit) {
		entryLimitReached = true;
		limitedEntries = entries.slice(0, effectiveLimit);
	}
	let output = limitedEntries.length ? limitedEntries.join("\n") : "(empty directory)";
	const details: Record<string, unknown> = {};
	const notices: string[] = [];
	if (entryLimitReached) {
		notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
		details.entryLimitReached = effectiveLimit;
	}
	if (Buffer.byteLength(output, "utf-8") > DEFAULT_LS_MAX_BYTES) {
		output = output.slice(0, DEFAULT_LS_MAX_BYTES);
		notices.push(`${DEFAULT_LS_MAX_BYTES / 1024}KB limit reached`);
		details.truncation = { truncated: true };
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}
	return { content: [{ type: "text", text: output }], details: Object.keys(details).length ? details : undefined };
}

function boundedOptions(deadline: number, signal?: AbortSignal): { signal?: AbortSignal; timeoutMs: number } {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new Error(`SSH command timed out after ${REMOTE_SEARCH_TIMEOUT_MS}ms`);
	return { signal, timeoutMs: remaining };
}

function joinRemotePath(base: string, childPath: string): string {
	if (childPath.startsWith("/")) return childPath;
	return path.posix.join(base, childPath);
}

async function remoteFind(
	remote: string,
	remoteCwd: string,
	localCwd: string,
	pattern: string,
	searchDir: string | undefined,
	limit: number | undefined,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
	if (Buffer.byteLength(pattern, "utf8") > SSH_SEARCH_INPUT_MAX_BYTES) throw new Error("Find pattern exceeds the SSH search input limit");
	const searchPath = resolveRemotePath(remoteCwd, localCwd, searchDir);
	const deadline = Date.now() + REMOTE_SEARCH_TIMEOUT_MS;
	try {
		await sshExecScript(remote, "test -e \"$1\"\n", [searchPath], boundedOptions(deadline, signal));
	} catch {
		throw new Error(`Path not found: ${searchPath}`);
	}
	try {
		await sshExecScript(remote, "test -d \"$1\"\n", [searchPath], boundedOptions(deadline, signal));
	} catch {
		throw new Error(`Not a directory: ${searchPath}`);
	}
	const effectiveLimit = Math.max(1, limit ?? DEFAULT_FIND_LIMIT);
	const producerLimit = effectiveLimit + 1;
	const rawBuffer = await sshExecScript(
		remote,
		REMOTE_FIND_SCRIPT,
		[searchPath, pattern, producerLimit, REMOTE_SEARCH_MAX_BYTES, ""],
		boundedOptions(deadline, signal),
	);
	const producerLimitReached = rawBuffer.length >= REMOTE_SEARCH_MAX_BYTES;
	const rawOutput = rawBuffer.toString().trim();
	if (!rawOutput) {
		return { content: [{ type: "text", text: "No files found matching pattern" }], details: { outcome: "no_match", backend: "relocated_ssh" } };
	}
	const entries = rawOutput.split("\n").filter((line) => line.trim().length > 0);
	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	const resultLimitReached = entries.length > effectiveLimit;
	const limitedEntries = entries.slice(0, effectiveLimit);
	let output = limitedEntries.join("\n");
	const details: Record<string, unknown> = { outcome: "success", backend: "relocated_ssh" };
	const notices: string[] = [];
	if (resultLimitReached) {
		notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
		details.resultLimitReached = effectiveLimit;
	}
	if (producerLimitReached) {
		notices.push("Remote producer byte limit reached; results are incomplete");
		details.incomplete = true;
	}
	const truncation = truncateToBytes(output, DEFAULT_MAX_BYTES);
	if (truncation.truncated) {
		output = truncation.text;
		notices.push(`${DEFAULT_MAX_BYTES / 1024}KB limit reached`);
		details.truncation = { truncated: true, producerBounded: true };
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
	return { content: [{ type: "text", text: output }], details };
}

function formatGrepJson(
	rawBuffer: Buffer,
	searchPath: string,
	isDirectory: boolean,
	effectiveLimit: number,
	contextValue: number,
	producerLimitReached: boolean,
	backend: "relocated_ssh" | "locked_ssh",
): { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown>; isError?: boolean } {
	const effectiveBase = isDirectory ? searchPath : path.posix.dirname(searchPath);
	const outputLines: string[] = [];
	const pendingContext: string[] = [];
	let matchCount = 0;
	let matchLimitReached = false;
	let linesTruncated = false;
	let malformedEvent = false;
	const renderEvent = (event: any, match: boolean): string | null => {
		const eventPath = event.data?.path?.text;
		const lineNumber = event.data?.line_number;
		const text = event.data?.lines?.text;
		if (typeof eventPath !== "string" || typeof lineNumber !== "number" || typeof text !== "string") return null;
		const absolutePath = joinRemotePath(effectiveBase, eventPath);
		let displayPath = path.posix.basename(searchPath);
		if (isDirectory) {
			const relative = path.posix.relative(searchPath, absolutePath);
			if (relative && !relative.startsWith("..")) displayPath = relative;
		}
		const clean = text.replace(/\r/g, "").replace(/\n$/, "").replace(/\n/g, " ↩ ");
		const truncated = truncateLine(clean, GREP_MAX_LINE_LENGTH);
		if (truncated.wasTruncated) linesTruncated = true;
		return match
			? `${displayPath}:${lineNumber}: ${truncated.text}`
			: `${displayPath}-${lineNumber}- ${truncated.text}`;
	};
	for (const line of rawBuffer.toString("utf8").split("\n")) {
		if (!line.trim()) continue;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			malformedEvent = true;
			continue;
		}
		if (event.type === "context") {
			const rendered = renderEvent(event, false);
			if (!rendered) continue;
			if (matchCount === 0) {
				pendingContext.push(rendered);
				while (pendingContext.length > contextValue) pendingContext.shift();
			} else {
				outputLines.push(rendered);
			}
			continue;
		}
		if (event.type !== "match") continue;
		if (matchCount >= effectiveLimit) {
			matchLimitReached = true;
			break;
		}
		const rendered = renderEvent(event, true);
		if (!rendered) continue;
		matchCount += 1;
		if (matchCount === 1) outputLines.push(...pendingContext);
		outputLines.push(rendered);
	}
	if (matchCount === 0) {
		if (producerLimitReached || malformedEvent) {
			return {
				content: [{ type: "text", text: "Remote grep output was truncated before a complete match could be decoded." }],
				isError: true,
				details: { outcome: "tool_execution", backend, incomplete: true },
			} as any;
		}
		return { content: [{ type: "text", text: "No matches found" }], details: { outcome: "no_match", backend } };
	}
	let output = outputLines.join("\n");
	const details: Record<string, unknown> = { outcome: "success", backend };
	const notices: string[] = [];
	if (matchLimitReached) {
		notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
		details.matchLimitReached = effectiveLimit;
	}
	if (producerLimitReached || malformedEvent) {
		notices.push("Remote producer byte limit reached; results are incomplete");
		details.incomplete = true;
	}
	const truncation = truncateToBytes(output, DEFAULT_MAX_BYTES);
	if (truncation.truncated) {
		output = truncation.text;
		notices.push(`${DEFAULT_MAX_BYTES / 1024}KB limit reached`);
		details.truncation = { truncated: true, producerBounded: true };
	}
	if (linesTruncated) {
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		details.linesTruncated = true;
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
	return { content: [{ type: "text", text: output }], details };
}

async function remoteGrep(
	remote: string,
	remoteCwd: string,
	localCwd: string,
	params: {
		pattern: string;
		path?: string;
		glob?: string;
		ignoreCase?: boolean;
		literal?: boolean;
		context?: number;
		limit?: number;
	},
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
	if (Buffer.byteLength(params.pattern, "utf8") > SSH_SEARCH_INPUT_MAX_BYTES) throw new Error("Grep pattern exceeds the SSH search input limit");
	if (params.glob && Buffer.byteLength(params.glob, "utf8") > SSH_SEARCH_INPUT_MAX_BYTES) throw new Error("Grep glob exceeds the SSH search input limit");
	const searchPath = resolveRemotePath(remoteCwd, localCwd, params.path);
	const deadline = Date.now() + REMOTE_SEARCH_TIMEOUT_MS;
	let isDirectory = false;
	try {
		await sshExecScript(remote, "test -d \"$1\"\n", [searchPath], boundedOptions(deadline, signal));
		isDirectory = true;
	} catch {
		try {
			await sshExecScript(remote, "test -e \"$1\"\n", [searchPath], boundedOptions(deadline, signal));
		} catch {
			throw new Error(`Path not found: ${searchPath}`);
		}
	}
	const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const contextValue = params.context && params.context > 0 ? params.context : 0;
	const rawBuffer = await sshExecScript(remote, REMOTE_GREP_SCRIPT, [
		params.ignoreCase ? 1 : 0,
		params.literal ? 1 : 0,
		params.glob ?? "",
		params.pattern,
		searchPath,
		contextValue,
		effectiveLimit + 1,
		REMOTE_SEARCH_MAX_BYTES,
		"",
	], boundedOptions(deadline, signal));
	return formatGrepJson(rawBuffer, searchPath, isDirectory, effectiveLimit, contextValue, rawBuffer.length >= REMOTE_SEARCH_MAX_BYTES, "relocated_ssh");

}

type LockedState = "locked-pending" | "locked-verified" | "locked-failed";

function registerLockedSsh(pi: ExtensionAPI, descriptorPath: string): void {
	const fallbackCwd = process.cwd();
	const evidencePath = process.env.PI_SUBAGENT_EFFECTS_EVIDENCE_PATH;
	let state: LockedState = "locked-pending";
	let failure = "SSH target verification is pending.";
	let descriptor: any;
	try {
		const loaded = loadLockedDescriptor(descriptorPath, {
			extensionPath: fileURLToPath(import.meta.url),
			expectedCodeDigest: process.env.PI_SUBAGENT_SSH_LOCK_CODE_DIGEST,
		});
		descriptor = assertLockedDescriptorBinding(loaded, process.env.PI_SUBAGENT_EXECUTION_TARGET_NAME, process.env.PI_SUBAGENT_EXECUTION_TARGET_DIGEST);
		appendEffectsRecord(evidencePath, { version: 1, ts: Date.now(), phase: "startup", effects_state: "none" });
	} catch (error) {
		state = "locked-failed";
		failure = redactLockedError(error).error;
	}

	const blockedResult = () => ({
		content: [{ type: "text" as const, text: JSON.stringify({ error: "ssh_lock_not_verified", state, detail: failure }) }],
		isError: true,
		details: { backend: "locked_ssh", outcome: "dependency" },
	});
	const lockedFailureResult = (error: unknown) => {
		const redacted = redactLockedError(error);
		return {
			content: [{ type: "text" as const, text: JSON.stringify(redacted) }],
			isError: true,
			details: { backend: "locked_ssh", outcome: sshFailureOutcome(redacted.error) },
		};
	};
	const remotePath = (input: string | undefined): string => {
		const raw = input === undefined || input === "" ? "." : input;
		if (raw === ".") return descriptor.cwd;
		if (path.posix.isAbsolute(raw)) {
			const local = normalizePosixPath(fallbackCwd);
			const normalized = normalizePosixPath(raw);
			if (isPathWithin(local, normalized)) return path.posix.join(descriptor.cwd, path.posix.relative(local, normalized));
			return normalized;
		}
		return path.posix.join(descriptor.cwd, raw);
	};
	const runRead = (script: string, args: string[], options: Record<string, unknown> = {}) =>
		withBoundedReadRetry(() => runLockedSsh(descriptor, script, args, { timeoutMs: SSH_CONTROL_TIMEOUT_MS, ...options }));
	const pathGuard = `set -eu\np="$1"; root="$2"\ncase "$p" in /*) ;; *) exit 64;; esac\ncr=$(readlink -f -- "$root")\nexec {targetfd}<"$p" || exit 64; cp="/proc/$$/fd/$targetfd"; resolved=$(readlink -f -- "$cp")\ncase "$resolved" in "$cr"|"$cr/"*) ;; *) exit 65;; esac\n`;
	const readOps: ReadOperations = {
		readFile: async (p) => (await runRead(`${pathGuard}cat -- "$cp"\n`, [remotePath(p), descriptor.allowedRoot])).stdout,
		access: async (p) => { await runRead(`${pathGuard}test -r "$cp"\n`, [remotePath(p), descriptor.allowedRoot]); },
		detectImageMimeType: async (p) => {
			try {
				const result = await runRead(`${pathGuard}file --mime-type -b -- "$cp"\n`, [remotePath(p), descriptor.allowedRoot]);
				const mime = result.stdout.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : null;
			} catch { return null; }
		},
	};
	const writeFile = async (p: string, content: string | Buffer) => {
		const id = mutationId();
		appendEffectsRecord(evidencePath, effectsRecord("intent", "write", id));
		const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
		const digest = createHash("sha256").update(data).digest("hex");
		try {
			await runLockedSsh(descriptor, ATOMIC_WRITE_SCRIPT, [remotePath(p), descriptor.allowedRoot, digest], { stdin: data.toString("base64") });
			appendEffectsRecord(evidencePath, effectsRecord("settled", "write", id, "confirmed"));
		} catch (error) {
			appendEffectsRecord(evidencePath, effectsRecord("settled", "write", id, "unknown"));
			throw Object.assign(new Error("ssh_transport_ambiguous"), { cause: error, completion: "unknown", effects_state: "unknown" });
		}
	};
	const writeOps: WriteOperations = {
		writeFile,
		mkdir: async (dir) => {
			const id = mutationId();
			appendEffectsRecord(evidencePath, effectsRecord("intent", "mkdir", id));
			// Walk one component at a time through held directory capabilities.
			// A racing symlink can make the operation fail, but cannot redirect a
			// later mkdir outside allowedRoot.
			try {
				await runLockedSsh(descriptor, LOCKED_MKDIR_SCRIPT, [remotePath(dir), descriptor.allowedRoot]);
				appendEffectsRecord(evidencePath, effectsRecord("settled", "mkdir", id, "confirmed"));
			} catch (error) {
				appendEffectsRecord(evidencePath, effectsRecord("settled", "mkdir", id, "unknown"));
				throw Object.assign(new Error("ssh_transport_ambiguous"), { cause: error, completion: "unknown", effects_state: "unknown" });
			}
		},
	};
	const editOps: EditOperations = { readFile: readOps.readFile, access: readOps.access, writeFile };
	const bashOps: BashOperations = {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const id = mutationId();
			const token = mutationId().replaceAll("-", "");
			appendEffectsRecord(evidencePath, effectsRecord("intent", "bash", id));
			const script = `set +e\ncd -- "$1" || exit 70\ntmp=$(mktemp); trap 'rm -f -- "$tmp"' EXIT HUP INT TERM\ncat > "$tmp"\nbash -l "$tmp"\ncode=$?\nprintf '\\n__MONIKA_SSH_COMPLETE_${token}__:%s\\n' "$code"\nexit 0\n`;
			try {
				const result = await runLockedSsh(descriptor, script, [remotePath(cwd)], { signal, timeoutMs: timeout ? timeout * 1000 : undefined, stdin: command });
				const parsed = parseCompletionTrailer(result.stdout.toString("utf8"), token);
				if (parsed.completion !== "known") throw Object.assign(new Error("ssh_transport_ambiguous"), parsed);
				if (parsed.output) onData(Buffer.from(parsed.output));
				if (result.stderr.length) onData(result.stderr);
				appendEffectsRecord(evidencePath, effectsRecord("settled", "bash", id, "confirmed", { exitCode: parsed.exitCode }));
				return { exitCode: parsed.exitCode };
			} catch (error) {
				appendEffectsRecord(evidencePath, effectsRecord("settled", "bash", id, "unknown"));
				throw Object.assign(new Error("ssh_transport_ambiguous"), { cause: error, completion: "unknown", effects_state: "unknown" });
			}
		},
	};

	const localRead = createReadTool(fallbackCwd);
	const localWrite = createWriteTool(fallbackCwd);
	const localEdit = createEditTool(fallbackCwd);
	const localLs = createLsTool(fallbackCwd);
	const localFind = createFindTool(fallbackCwd);
	const localGrep = createGrepTool(fallbackCwd);
	const localBash = createBashTool(fallbackCwd);
	const withLockedBackend = async (promise: Promise<any>) => {
		try {
			const result = await promise;
			if (!result || typeof result !== "object") return result;
			const prior = result.details && typeof result.details === "object" ? result.details : {};
			return { ...result, details: { backend: "locked_ssh", outcome: result.isError ? "tool_execution" : "success", ...prior } };
		} catch (error) {
			return {
				content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
				isError: true,
				details: { backend: "locked_ssh", outcome: sshFailureOutcome(error) },
			};
		}
	};
	pi.registerTool({ ...localRead, execute: (id, params, signal, onUpdate) => state === "locked-verified" ? withLockedBackend(createReadTool(fallbackCwd, readOps).execute(id, params, signal, onUpdate)) : Promise.resolve(blockedResult()) });
	pi.registerTool({ ...localWrite, execute: (id, params, signal, onUpdate) => state === "locked-verified" ? withLockedBackend(createWriteTool(fallbackCwd, writeOps).execute(id, params, signal, onUpdate)) : Promise.resolve(blockedResult()) });
	pi.registerTool({ ...localEdit, execute: (id, params, signal, onUpdate) => state === "locked-verified" ? withLockedBackend(createEditTool(fallbackCwd, editOps).execute(id, params, signal, onUpdate)) : Promise.resolve(blockedResult()) });
	pi.registerTool({ ...localBash, execute: (id, params, signal, onUpdate) => state === "locked-verified" ? withLockedBackend(createBashTool(fallbackCwd, bashOps).execute(id, params, signal, onUpdate)) : Promise.resolve(blockedResult()) });
	pi.registerTool({ ...localLs, async execute(_id, params, signal) {
		if (state !== "locked-verified") return blockedResult();
		const typed = params as { path?: string; limit?: number };
		try {
			const result = await runRead(`${pathGuard}LC_ALL=C ls -A -p -- "$cp"\n`, [remotePath(typed.path), descriptor.allowedRoot], { signal, timeoutMs: SSH_CONTROL_TIMEOUT_MS });
			const entries = result.stdout.toString().trim().split("\n").filter(Boolean).sort((a: string, b: string) => a.localeCompare(b)).slice(0, typed.limit ?? DEFAULT_LS_LIMIT);
			return { content: [{ type: "text" as const, text: entries.join("\n") || "(empty directory)" }], details: { backend: "locked_ssh", outcome: "success" } };
		} catch (error) { return lockedFailureResult(error); }
	} });
	pi.registerTool({ ...localFind, async execute(_id, params, signal) {
		if (state !== "locked-verified") return blockedResult();
		const typed = params as { pattern: string; path?: string; limit?: number };
		if (Buffer.byteLength(typed.pattern, "utf8") > SSH_SEARCH_INPUT_MAX_BYTES) return lockedFailureResult(new Error("Find pattern exceeds the SSH search input limit"));
		const effectiveLimit = Math.max(1, typed.limit ?? DEFAULT_FIND_LIMIT);
		try {
			const result = await runRead(
				REMOTE_FIND_SCRIPT,
				[remotePath(typed.path), typed.pattern, String(effectiveLimit + 1), String(REMOTE_SEARCH_MAX_BYTES), descriptor.allowedRoot],
				{ signal, timeoutMs: REMOTE_SEARCH_TIMEOUT_MS },
			);
			const entries = result.stdout.toString().trim().split("\n").filter(Boolean);
			const limited = entries.slice(0, effectiveLimit);
			const output = limited.join("\n");
			return {
				content: [{ type: "text" as const, text: output || "No files found matching pattern" }],
				details: { backend: "locked_ssh", outcome: output ? "success" : "no_match", ...(entries.length > effectiveLimit ? { resultLimitReached: effectiveLimit } : {}) },
			};
		} catch (error) { return lockedFailureResult(error); }
	} });
	pi.registerTool({ ...localGrep, async execute(_id, params, signal) {
		if (state !== "locked-verified") return blockedResult();
		const typed = params as { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number };
		if (Buffer.byteLength(typed.pattern, "utf8") > SSH_SEARCH_INPUT_MAX_BYTES || (typed.glob && Buffer.byteLength(typed.glob, "utf8") > SSH_SEARCH_INPUT_MAX_BYTES)) {
			return lockedFailureResult(new Error("Grep pattern or glob exceeds the SSH search input limit"));
		}
		const effectiveLimit = Math.max(1, typed.limit ?? DEFAULT_GREP_LIMIT);
		const searchPath = remotePath(typed.path);
		try {
			const kind = await runRead(
				`${pathGuard}if [ -d "$cp" ]; then printf d; else printf f; fi\n`,
				[searchPath, descriptor.allowedRoot],
				{ signal, timeoutMs: REMOTE_SEARCH_TIMEOUT_MS },
			);
			const isDirectory = kind.stdout.toString() === "d";
			const result = await runRead(REMOTE_GREP_SCRIPT, [
				typed.ignoreCase ? "1" : "0", typed.literal ? "1" : "0", typed.glob ?? "", typed.pattern,
				searchPath, String(Math.max(0, typed.context ?? 0)), String(effectiveLimit + 1),
				String(REMOTE_SEARCH_MAX_BYTES), descriptor.allowedRoot,
			], { signal, timeoutMs: REMOTE_SEARCH_TIMEOUT_MS });
			return formatGrepJson(
				result.stdout,
				searchPath,
				isDirectory,
				effectiveLimit,
				Math.max(0, typed.context ?? 0),
				result.stdout.length >= REMOTE_SEARCH_MAX_BYTES,
				"locked_ssh",
			);
		} catch (error) { return lockedFailureResult(error); }
	} });

	pi.on("session_start", async (_event, ctx) => {
		if (state === "locked-failed") return;
		try {
			const result = await runLockedSsh(descriptor, STARTUP_PROBE_SCRIPT, [descriptor.cwd, descriptor.allowedRoot], { timeoutMs: SSH_CONTROL_TIMEOUT_MS });
			const [hostname, cwd, allowedRoot, ...extra] = result.stdout.toString("utf8").trimEnd().split("\n");
			if (extra.length || hostname !== descriptor.hostname || cwd !== descriptor.cwd || allowedRoot !== descriptor.allowedRoot || !isPathWithin(allowedRoot, cwd)) throw new Error("locked_probe_mismatch");
			state = "locked-verified";
			updateSshUiBestEffort(ctx, { statusText: `SSH locked: ${descriptor.name}` });
		} catch (error) {
			state = "locked-failed";
			failure = redactLockedError(error).error;
			updateSshUiBestEffort(ctx, { statusText: `SSH locked failed: ${descriptor.name}`, tone: "error" });
		}
	});
	pi.on("input", async () => lockedInputDecision(state));
	pi.on("tool_call", async () => state === "locked-verified" ? undefined : ({ block: true, reason: failure } as any));
	pi.on("user_bash", (event) => state === "locked-verified" ? { operations: createRemoteBashOpsLocked(bashOps) } : { operations: createRemoteBashOpsLocked({ exec: async () => { throw new Error("ssh_lock_not_verified"); } } as BashOperations) });
	pi.on("before_agent_start", async (event) => {
		if (state !== "locked-verified") throw new Error("ssh_lock_not_verified");
		return { systemPrompt: event.systemPrompt.replace(`Current working directory: ${event.systemPromptOptions?.cwd ?? fallbackCwd}`, `Current working directory: ${descriptor.cwd} (locked SSH target: ${descriptor.name})`) };
	});
}

function createRemoteBashOpsLocked(ops: BashOperations): BashOperations { return ops; }

export default function (pi: ExtensionAPI) {
	const lockedDescriptor = process.env.MONIKA_SSH_LOCK_DESCRIPTOR?.trim();
	if (lockedDescriptor) {
		registerLockedSsh(pi, lockedDescriptor);
		return;
	}
	pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });
	pi.registerFlag("ssh-debug", { description: "Enable SSH debug status output", type: "boolean" });
	pi.registerFlag("ssh-verify", {
		description: "Verify a remote path exists and list it on connect",
		type: "string",
	});

	const fallbackCwd = process.cwd();
	const toolMetadataCwd = fallbackCwd;
	const localRead = createReadTool(toolMetadataCwd);
	const localWrite = createWriteTool(toolMetadataCwd);
	const localEdit = createEditTool(toolMetadataCwd);
	const localFind = createFindTool(toolMetadataCwd);
	const localGrep = createGrepTool(toolMetadataCwd);
	const localLs = createLsTool(toolMetadataCwd);
	const localBash = createBashTool(toolMetadataCwd);
	const localBashOperations = createLocalBashOperations();

	// Resolved lazily on session_start (CLI flags not available during factory)
	let resolvedSsh: { remote: string; remoteCwd: string } | null = null;
	let sshRequired = false;
	let sshDebug = false;
	let sshError: Error | null = null;
	let remoteHost: string | null = null;
	let remoteAgentsContent: string | null = null;
	const routingLock = createAsyncReadWriteLock();

	const getSsh = () => resolvedSsh;
	const requireSsh = () => {
		if (!resolvedSsh && sshRequired) {
			const details = sshError ? ` (${sshError.message})` : "";
			throw new Error(`SSH mode was requested but is not available${details}.`);
		}
		return resolvedSsh;
	};
	const getSessionCwd = (ctx?: { cwd?: string }) => ctx?.cwd ?? fallbackCwd;
	const mapRemotePath = (ssh: { remoteCwd: string }, localRoot: string, p: string | undefined) => resolveRemotePath(ssh.remoteCwd, localRoot, p);
	const setDebugStatus = (ctx: any, message: string) => {
		if (!sshDebug) return;
		updateSshUiBestEffort(ctx, { statusKey: "ssh-debug", statusText: message });
	};
	const registerRoutedTool = (tool: any) => {
		const execute = tool.execute.bind(tool);
		tool.execute = (...args: any[]) => routingLock.withRead(async () => {
			const backend = resolvedSsh ? "relocated_ssh" : "local";
			try {
				const result = await execute(...args);
				if (!result || typeof result !== "object") return result;
				const prior = result.details && typeof result.details === "object" ? result.details : {};
				return { ...result, details: { backend, outcome: result.isError ? "tool_execution" : "success", ...prior } };
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
					isError: true,
					details: { backend, outcome: sshFailureOutcome(error) },
				};
			}
		});
		pi.registerTool(tool);
	};

	registerRoutedTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = requireSsh();
			if (sshDebug && ctx) {
				const sessionCwd = getSessionCwd(ctx);
				const path = (params as { path: string }).path;
				const targetPath = ssh ? mapRemotePath(ssh, sessionCwd, path) : path;
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} read: ${targetPath}`);
			}
			if (ssh) {
				const sessionCwd = getSessionCwd(ctx);
				const tool = createReadTool(sessionCwd, {
					operations: createRemoteReadOps(ssh.remote, ssh.remoteCwd, sessionCwd, signal),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return createReadTool(getSessionCwd(ctx)).execute(id, params, signal, onUpdate);
		},
	});

	registerRoutedTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = requireSsh();
			if (sshDebug && ctx) {
				const sessionCwd = getSessionCwd(ctx);
				const path = (params as { path: string }).path;
				const targetPath = ssh ? mapRemotePath(ssh, sessionCwd, path) : path;
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} write: ${targetPath}`);
			}
			if (ssh) {
				const sessionCwd = getSessionCwd(ctx);
				const tool = createWriteTool(sessionCwd, {
					operations: createRemoteWriteOps(ssh.remote, ssh.remoteCwd, sessionCwd, signal),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return createWriteTool(getSessionCwd(ctx)).execute(id, params, signal, onUpdate);
		},
	});

	registerRoutedTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = requireSsh();
			if (sshDebug && ctx) {
				const sessionCwd = getSessionCwd(ctx);
				const path = (params as { path: string }).path;
				const targetPath = ssh ? mapRemotePath(ssh, sessionCwd, path) : path;
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} edit: ${targetPath}`);
			}
			if (ssh) {
				const sessionCwd = getSessionCwd(ctx);
				const tool = createEditTool(sessionCwd, {
					operations: createRemoteEditOps(ssh.remote, ssh.remoteCwd, sessionCwd, signal),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return createEditTool(getSessionCwd(ctx)).execute(id, params, signal, onUpdate);
		},
	});

	registerRoutedTool({
		...localFind,
		async execute(id, params, _signal, _onUpdate, ctx) {
			const ssh = requireSsh();
			const { pattern, path: searchPath, limit } = params as {
				pattern: string;
				path?: string;
				limit?: number;
			};
			if (sshDebug && ctx) {
				const sessionCwd = getSessionCwd(ctx);
				const targetPath = ssh ? resolveRemotePath(ssh.remoteCwd, sessionCwd, searchPath) : searchPath ?? ".";
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} find: ${targetPath} :: ${pattern}`);
			}
			if (ssh) {
				return remoteFind(ssh.remote, ssh.remoteCwd, getSessionCwd(ctx), pattern, searchPath, limit, _signal);
			}
			return createFindTool(getSessionCwd(ctx)).execute(id, params, _signal, _onUpdate);
		},
	});

	registerRoutedTool({
		...localGrep,
		async execute(id, params, _signal, _onUpdate, ctx) {
			const ssh = requireSsh();
			const typed = params as {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			};
			if (sshDebug && ctx) {
				const sessionCwd = getSessionCwd(ctx);
				const targetPath = ssh ? resolveRemotePath(ssh.remoteCwd, sessionCwd, typed.path) : typed.path ?? ".";
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} grep: ${targetPath} :: ${typed.pattern}`);
			}
			if (ssh) {
				return remoteGrep(ssh.remote, ssh.remoteCwd, getSessionCwd(ctx), typed, _signal);
			}
			return createGrepTool(getSessionCwd(ctx)).execute(id, params, _signal, _onUpdate);
		},
	});

	registerRoutedTool({
		...localLs,
		async execute(id, params, signal, _onUpdate, ctx) {
			const ssh = requireSsh();
			const { path, limit } = params as { path?: string; limit?: number };
			if (sshDebug && ctx) {
				const sessionCwd = getSessionCwd(ctx);
				const targetPath = ssh ? resolveRemotePath(ssh.remoteCwd, sessionCwd, path) : path ?? ".";
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} ls: ${targetPath}`);
			}
			if (ssh) {
				return remoteLs(ssh.remote, ssh.remoteCwd, getSessionCwd(ctx), path, limit, signal);
			}
			return createLsTool(getSessionCwd(ctx)).execute(id, params, _signal, _onUpdate);
		},
	});

	registerRoutedTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = requireSsh();
			if (sshDebug && ctx) {
				const sessionCwd = getSessionCwd(ctx);
				const { command, cwd } = params as { command: string; cwd: string };
				const targetCwd = ssh ? mapRemotePath(ssh, sessionCwd, cwd) : cwd;
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} bash: ${targetCwd} :: ${command}`);
			}
			if (ssh) {
				const sessionCwd = getSessionCwd(ctx);
				const tool = createBashTool(sessionCwd, {
					operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, sessionCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return createBashTool(getSessionCwd(ctx)).execute(id, params, signal, onUpdate);
		},
	});

	// ── Relocate tool ──────────────────────────────────────────────────────
	// Switches the execution context mid-session. All tools (bash, read, write,
	// edit, grep, find, ls) will route to the new target after a successful
	// Relocation is an explicit state machine. Status inspections share the
	// routing read lock; transitions are exclusive with all routed tools.
	const relocateSchema = Type.Object({
		target: Type.Optional(Type.String({ description: 'SSH target: "user@host", an SSH config alias, "user@host:/absolute/path", bracketed IPv6, or "local". Omit to inspect status.' })),
	});
	const getRelocateState = () => ({ resolvedSsh, sshRequired, sshError, remoteHost, remoteAgentsContent });
	const commitRelocateState = (next: any) => {
		resolvedSsh = next.resolvedSsh;
		sshRequired = next.sshRequired;
		sshError = next.sshError;
		remoteHost = next.remoteHost;
		remoteAgentsContent = next.remoteAgentsContent;
	};
	const loadRemoteAgents = async (remote: string, cwd: string, signal?: AbortSignal) => {
		const agentsPath = `${cwd}/AGENTS.md`;
		const options = { sshOptions: RELOCATE_SSH_OPTIONS, signal, timeoutMs: SSH_CONTROL_TIMEOUT_MS };
		await sshExecScript(remote, "test -f \"$1\" -a -r \"$1\"\n", [agentsPath], options);
		const content = await sshExecScript(remote, "head -c \"$2\" -- \"$1\"\n", [agentsPath, REMOTE_AGENTS_MAX_BYTES + 1], options);
		if (content.length > REMOTE_AGENTS_MAX_BYTES) throw new Error(`Remote AGENTS.md exceeds ${REMOTE_AGENTS_MAX_BYTES} bytes`);
		return content.toString("utf8");
	};

	pi.registerTool({
		name: "relocate",
		description: "Inspect or switch execution context via SSH. Remote transitions validate connectivity and required search dependencies before atomically routing read/write/edit/bash/grep/find/ls. Omit target for status; use local to return to container execution.",
		label: "Relocate",
		parameters: relocateSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const request = parseRelocateTarget((params as { target?: string }).target);
			const run = () => executeRelocateRequest({
				request,
				getState: getRelocateState,
				commitState: commitRelocateState,
				validateTarget: (remote: string, cwd?: string) => validateSshTarget(remote, cwd, signal),
				loadRemoteAgents: (remote: string, cwd: string) => loadRemoteAgents(remote, cwd, signal),
				updateUi: (value: any) => updateSshUiBestEffort(ctx, value),
			});
			return request.kind === "status" ? routingLock.withRead(run) : routingLock.withWrite(run);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Resolve SSH config now that CLI flags are available
		const arg = (pi.getFlag("ssh") as string | undefined) ?? getCliFlagValue("ssh");
		sshRequired = Boolean(arg);
		const cliDebug = getCliFlagBoolean("ssh-debug");
		sshDebug = Boolean((pi.getFlag("ssh-debug") as boolean | undefined) ?? cliDebug);
		const sshVerify = (pi.getFlag("ssh-verify") as string | undefined) ?? getCliFlagValue("ssh-verify");
		if (arg) {
			try {
				const parsed = parseSshArg(arg);
				const validation = await validateSshTarget(parsed.remote, parsed.remoteCwd);
				if (!validation.success) throw new Error(validation.error ?? "SSH validation failed");
				if (sshVerify) {
					await sshExecScript(parsed.remote, "test -d \"$1\"\n", [sshVerify]);
					const listing = (await sshExecScript(parsed.remote, "LC_ALL=C ls -a -- \"$1\"\n", [sshVerify])).toString().trim();
					updateSshUiBestEffort(ctx, { notification: `SSH verify: ${sshVerify}\n${listing || "(empty directory)"}` });
				}
				resolvedSsh = { remote: parsed.remote, remoteCwd: validation.remoteCwd };
				sshError = null;
				remoteHost = validation.hostname ?? null;
				try {
					remoteAgentsContent = (await loadRemoteAgents(parsed.remote, validation.remoteCwd)).trim() || null;
				} catch {
					remoteAgentsContent = null;
				}
				if (sshDebug) {
					updateSshUiBestEffort(ctx, {
						statusKey: "ssh-debug",
						statusText: `SSH debug: ${remoteHost ?? "unknown"}`,
						notification: `SSH debug: connected to ${remoteHost ?? "unknown"} (${resolvedSsh.remote}:${resolvedSsh.remoteCwd})`,
					});
				}
				updateSshUiBestEffort(ctx, {
					statusText: `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`,
					notification: `SSH mode: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`,
				});
			} catch (error) {
				sshError = error instanceof Error ? error : new Error(String(error));
				if (sshDebug) updateSshUiBestEffort(ctx, { statusKey: "ssh-debug", statusText: "SSH debug: failed", tone: "error" });
				updateSshUiBestEffort(ctx, {
					statusText: "SSH: unavailable",
					tone: "error",
					notification: `SSH requested but failed: ${sshError.message}`,
					notificationLevel: "error",
				});
			}
		}

	});

	// Handle every user ! command through the same routing fence as registered
	// tools, including commands selected while the current context is local.
	pi.on("user_bash", (_event) => {
		const localCwd = (_event as { cwd?: string }).cwd ?? fallbackCwd;
		const operations: BashOperations = {
			exec: (...args) => routingLock.withRead(async () => {
				const current = requireSsh();
				if (current) return createRemoteBashOps(current.remote, current.remoteCwd, localCwd).exec(...args);
				return localBashOperations.exec(...args);
			}),
		};
		return { operations };
	});

	pi.on("context", async (event) => {
		if (!remoteAgentsContent) return;
		const marker = "[Remote AGENTS.md]";
		const alreadyInjected = event.messages.some((message) => {
			if (message.role !== "user" || !Array.isArray(message.content)) return false;
			return message.content.some((item) => item.type === "text" && item.text?.includes(marker));
		});
		if (alreadyInjected) return;
		const injected = {
			role: "user" as const,
			content: [{ type: "text" as const, text: `${marker}\n${remoteAgentsContent}` }],
			timestamp: Date.now(),
		};
		return { messages: [injected, ...event.messages] };
	});

	// Replace local cwd with remote cwd in system prompt
	pi.on("before_agent_start", async (event) => {
		const ssh = getSsh();
		const sessionCwd = event.systemPromptOptions?.cwd ?? fallbackCwd;
		let modified = event.systemPrompt;
		if (ssh) {
			modified = modified.replace(
				`Current working directory: ${sessionCwd}`,
				`Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote})`,
			);
		}
		if (sshDebug) {
			if (ssh) {
				const hostInfo = remoteHost ?? "unknown";
				modified += `\nSSH debug: remote=${ssh.remote} host=${hostInfo} cwd=${ssh.remoteCwd} localCwd=${sessionCwd}`;
			} else if (sshRequired) {
				modified += "\nSSH debug: requested but not connected";
			} else {
				modified += "\nSSH debug: not requested";
			}
		}
		if (modified !== event.systemPrompt) {
			return { systemPrompt: modified };
		}
	});
}
