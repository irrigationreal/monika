import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";

import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

const AGENTD_BASE_URL = (process.env.MONIKA_AGENTD_BASE_URL ?? "http://127.0.0.1:7724").replace(/\/+$/, "");
const HEARTBEAT_INTERVAL_MS = 30_000;
const PREPARED_LEASE_MAX_MS = 30_000;
const SHARED_STATE_KEY = Symbol.for("monika.session-ownership.shared-state");
const STATUS_KEY = "session-ownership";

type ConflictState = "active" | "interrupt_timeout" | "leased";
type GateMode = "switch" | "recovery";

interface ClaimSuccess {
	ok: true;
	state: "claimed";
	lease_token: string;
	expires_at: string;
	evicted_idle?: boolean;
}

interface HeartbeatSuccess {
	ok: true;
	expires_at: string;
}

interface ClaimConflict {
	ok: false;
	state: ConflictState;
	conversation?: {
		id: string;
		last_activity_at: string;
		started_at: string;
	};
	message?: string;
}

interface Lease {
	sessionId: string;
	sessionFile: string;
	claim: ClaimSuccess;
}

interface PreparedLease {
	lease: Lease;
	releaseTimer: ReturnType<typeof setTimeout>;
}

interface SharedState {
	clientId: string;
	prepared?: PreparedLease;
	/** Destination lease carried across the old runtime's /resume shutdown. */
	handoff?: PreparedLease;
	continueUnprotectedSessionId?: string;
}

type GateResult =
	| { kind: "claimed"; lease: Lease }
	| { kind: "cancel" }
	| { kind: "unprotected"; sessionId?: string };

type GateAction = "cancel" | "continue" | "force" | "refresh" | "retry" | "takeover";
type ProtectionState = "protected" | "blocked" | "unprotected";

class LeaseLostError extends Error {}

function getSharedState(): SharedState {
	const globals = globalThis as unknown as Record<symbol, unknown>;
	const existing = globals[SHARED_STATE_KEY] as SharedState | undefined;
	if (existing) return existing;

	const state: SharedState = {
		clientId: `pi-tui:${process.pid}:${randomUUID()}`,
	};
	globals[SHARED_STATE_KEY] = state;
	return state;
}

async function readCanonicalSessionId(sessionFile: string): Promise<string> {
	const handle = await open(sessionFile, "r");
	try {
		let text = "";
		const buffer = Buffer.alloc(4096);
		while (text.length < 1024 * 1024) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			text += buffer.toString("utf8", 0, bytesRead);
			const newline = text.indexOf("\n");
			if (newline !== -1) {
				text = text.slice(0, newline);
				break;
			}
		}

		const firstLine = text.trim();
		if (!firstLine) throw new Error("session file has no JSONL header");
		const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
		if (header.type !== "session" || typeof header.id !== "string" || !header.id) {
			throw new Error("session JSONL header has no canonical session id");
		}
		return header.id;
	} finally {
		await handle.close();
	}
}

function ownershipUrl(sessionId: string, operation: "claim" | "heartbeat" | "release"): string {
	return `${AGENTD_BASE_URL}/v1/pi/sessions/${encodeURIComponent(sessionId)}/ownership/${operation}`;
}

function expiryMs(expiresAt: string): number {
	const value = Date.parse(expiresAt);
	if (!Number.isFinite(value)) throw new Error("agentd returned an invalid lease expiry");
	return value;
}

async function releaseLease(lease: Lease): Promise<void> {
	try {
		await fetch(ownershipUrl(lease.sessionId, "release"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ lease_token: lease.claim.lease_token }),
			signal: AbortSignal.timeout(5000),
		});
	} catch {
		// Best effort. The server-side lease expires if agentd cannot be reached.
	}
}

function clearPreparedLease(shared: SharedState): Lease | undefined {
	const prepared = shared.prepared;
	if (!prepared) return undefined;
	clearTimeout(prepared.releaseTimer);
	shared.prepared = undefined;
	return prepared.lease;
}

function clearHandoffLease(shared: SharedState): Lease | undefined {
	const handoff = shared.handoff;
	if (!handoff) return undefined;
	clearTimeout(handoff.releaseTimer);
	shared.handoff = undefined;
	return handoff.lease;
}

function prepareLease(shared: SharedState, lease: Lease): void {
	const previous = clearPreparedLease(shared);
	const staleHandoff = clearHandoffLease(shared);
	if (previous) void releaseLease(previous);
	if (staleHandoff) void releaseLease(staleHandoff);

	const remainingMs = Math.max(0, expiryMs(lease.claim.expires_at) - Date.now());
	const releaseTimer = setTimeout(() => {
		if (shared.prepared?.lease === lease) shared.prepared = undefined;
		else if (shared.handoff?.lease === lease) shared.handoff = undefined;
		else return;
		void releaseLease(lease);
	}, Math.min(PREPARED_LEASE_MAX_MS, remainingMs));
	releaseTimer.unref?.();
	shared.prepared = { lease, releaseTimer };
}

async function claimSession(
	sessionId: string,
	clientId: string,
	options: { takeover?: boolean; force?: boolean },
	signal: AbortSignal,
): Promise<ClaimSuccess | ClaimConflict> {
	const response = await fetch(ownershipUrl(sessionId, "claim"), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_id: clientId, ...options }),
		signal,
	});
	const body = await response.json().catch(() => undefined) as ClaimSuccess | ClaimConflict | undefined;

	if (response.status === 200 && body?.ok === true && body.state === "claimed" && body.lease_token) {
		expiryMs(body.expires_at);
		return body;
	}
	if (
		response.status === 409
		&& body?.ok === false
		&& (body.state === "active" || body.state === "interrupt_timeout" || body.state === "leased")
	) {
		return body;
	}

	const detail = body && "message" in body && body.message ? `: ${body.message}` : "";
	throw new Error(`agentd returned HTTP ${response.status}${detail}`);
}

function conflictDiagnostics(conflict: ClaimConflict): string[] {
	const lines = [`Ownership state: ${conflict.state}`];
	if (conflict.message) lines.push(conflict.message);
	if (conflict.conversation) {
		lines.push(`Conversation: ${conflict.conversation.id}`);
		lines.push(`Started: ${conflict.conversation.started_at}`);
		lines.push(`Last activity: ${conflict.conversation.last_activity_at}`);
	}
	return lines;
}

async function showOwnershipGate(ctx: ExtensionContext, sessionFile: string, mode: GateMode = "switch"): Promise<GateResult> {
	const shared = getSharedState();

	return ctx.ui.custom<GateResult>((tui, theme, _keybindings, done) => {
		const container = new Container();
		let selectList: SelectList | undefined;
		let requestController: AbortController | undefined;
		let sessionId: string | undefined;
		let finished = false;

		const finish = (result: GateResult) => {
			if (finished) return;
			finished = true;
			requestController?.abort();
			done(result);
		};

		const rebuild = (title: string, details: string[], items?: SelectItem[]) => {
			container.clear();
			container.addChild(new DynamicBorder((text: string) => theme.fg("warning", text)));
			container.addChild(new Text(theme.fg("warning", theme.bold(title)), 1, 0));
			for (const line of details) container.addChild(new Text(theme.fg("text", line), 1, 0));

			selectList = undefined;
			if (items) {
				selectList = new SelectList(items, Math.min(items.length, 8), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});
				selectList.onSelect = (item) => void handleAction(item.value as GateAction);
				selectList.onCancel = () => finish({ kind: "cancel" });
				container.addChild(selectList);
				container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
			} else {
				container.addChild(new Text(theme.fg("dim", "Contacting agentd… • esc cancel"), 1, 0));
			}
			container.addChild(new DynamicBorder((text: string) => theme.fg("warning", text)));
			container.invalidate();
			tui.requestRender();
		};

		const exitItem = {
			value: "cancel",
			label: mode === "recovery" ? "Exit Pi" : "Return to current session",
			description: mode === "recovery" ? "Stop before another prompt or tool can write." : "Cancel /resume without changing ownership.",
		};

		const showConflict = (conflict: ClaimConflict) => {
			const ownershipActions = conflict.state === "leased"
				? []
				: conflict.state === "interrupt_timeout"
					? [{
						value: "force",
						label: "Force takeover",
						description: "Take ownership even though forum interruption timed out.",
					}]
					: [{
						value: "takeover",
						label: "Interrupt and take over",
						description: "Ask agentd to interrupt the active forum conversation, then claim it.",
					}];
			rebuild("Session is already owned", conflictDiagnostics(conflict), [
				...ownershipActions,
				{ value: "refresh", label: mode === "recovery" ? "Retry ownership" : "Refresh diagnostics", description: "Check ownership state again." },
				exitItem,
			]);
		};

		const showUnavailable = (error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			rebuild("SESSION OWNERSHIP PROTECTION IS UNAVAILABLE", [
				`Agentd: ${AGENTD_BASE_URL}`,
				`Diagnostic: ${message}`,
				"Continuing can allow two clients to write to the same Pi session.",
			], [
				{ value: "retry", label: "Retry ownership", description: "Try agentd again." },
				exitItem,
				{
					value: "continue",
					label: "⚠ CONTINUE WITHOUT PROTECTION ⚠",
					description: "Keep using the session despite the risk of concurrent writers.",
				},
			]);
		};

		const attemptClaim = async (options: { takeover?: boolean; force?: boolean }) => {
			requestController?.abort();
			requestController = new AbortController();
			rebuild(options.force ? "Forcing session takeover" : options.takeover ? "Interrupting current owner" : "Claiming session ownership", [
				`Session file: ${sessionFile}`,
			]);

			try {
				sessionId = await readCanonicalSessionId(sessionFile);
				const response = await claimSession(sessionId, shared.clientId, options, requestController.signal);
				if (response.ok) {
					finish({ kind: "claimed", lease: { sessionId, sessionFile, claim: response } });
					return;
				}
				showConflict(response);
			} catch (error) {
				if (requestController.signal.aborted || finished) return;
				showUnavailable(error);
			}
		};

		const handleAction = async (action: GateAction) => {
			switch (action) {
				case "cancel":
					finish({ kind: "cancel" });
					break;
				case "continue":
					finish({ kind: "unprotected", sessionId });
					break;
				case "force":
					await attemptClaim({ takeover: true, force: true });
					break;
				case "takeover":
					await attemptClaim({ takeover: true });
					break;
				case "refresh":
				case "retry":
					await attemptClaim({});
					break;
			}
		};

		queueMicrotask(() => void attemptClaim({}));

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (selectList) {
					selectList.handleInput(data);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.escape)) finish({ kind: "cancel" });
			},
		};
	});
}

export default function sessionOwnershipExtension(pi: ExtensionAPI) {
	const shared = getSharedState();
	let currentLease: Lease | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let expiryTimer: ReturnType<typeof setTimeout> | undefined;
	let heartbeatController: AbortController | undefined;
	let heartbeatRunning = false;
	let heartbeatWarningShown = false;
	let protectionState: ProtectionState = "blocked";
	let recoveryPromise: Promise<void> | undefined;

	const stopHeartbeat = () => {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		if (expiryTimer) clearTimeout(expiryTimer);
		heartbeatTimer = undefined;
		expiryTimer = undefined;
		heartbeatController?.abort();
		heartbeatController = undefined;
		heartbeatRunning = false;
	};

	const setUnprotected = (ctx: ExtensionContext) => {
		stopHeartbeat();
		currentLease = undefined;
		protectionState = "unprotected";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "ownership: ⚠ UNPROTECTED ⚠"));
		ctx.ui.notify("Continuing without session ownership protection. Concurrent writers can corrupt this session.", "error");
	};

	const recoverOwnership = (ctx: ExtensionContext, lease: Lease): Promise<void> => {
		if (recoveryPromise) return recoveryPromise;
		protectionState = "blocked";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "ownership: EXPIRED — INPUT BLOCKED"));
		recoveryPromise = (async () => {
			const result = await showOwnershipGate(ctx, lease.sessionFile, "recovery");
			if (result.kind === "claimed") {
				startHeartbeat(ctx, result.lease);
				if (result.lease.claim.evicted_idle) ctx.ui.notify("Claimed session after evicting an idle owner.", "warning");
				return;
			}
			if (result.kind === "unprotected") {
				await releaseLease(lease);
				setUnprotected(ctx);
				return;
			}
			ctx.shutdown();
		})().finally(() => {
			recoveryPromise = undefined;
		});
		return recoveryPromise;
	};

	const scheduleExpiry = (ctx: ExtensionContext, lease: Lease) => {
		if (expiryTimer) clearTimeout(expiryTimer);
		const delay = Math.max(0, expiryMs(lease.claim.expires_at) - Date.now());
		expiryTimer = setTimeout(() => {
			if (currentLease !== lease || protectionState !== "protected") return;
			if (!ctx.isIdle()) ctx.abort();
			void recoverOwnership(ctx, lease);
		}, delay);
		expiryTimer.unref?.();
	};

	function startHeartbeat(ctx: ExtensionContext, lease: Lease) {
		stopHeartbeat();
		currentLease = lease;
		protectionState = "protected";
		heartbeatWarningShown = false;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("success", "ownership: protected"));
		scheduleExpiry(ctx, lease);

		const heartbeat = async () => {
			if (heartbeatRunning || currentLease !== lease || protectionState !== "protected") return;
			heartbeatRunning = true;
			const controller = new AbortController();
			heartbeatController = controller;
			try {
				const response = await fetch(ownershipUrl(lease.sessionId, "heartbeat"), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ lease_token: lease.claim.lease_token }),
					signal: controller.signal,
				});
				if (!response.ok) {
					if (response.status === 409) throw new LeaseLostError("agentd reports that the lease was lost");
					throw new Error(`heartbeat returned HTTP ${response.status}`);
				}
				const body = await response.json().catch(() => undefined) as HeartbeatSuccess | undefined;
				if (body?.ok !== true || typeof body.expires_at !== "string") throw new Error("heartbeat response has no expiry");
				expiryMs(body.expires_at);
				lease.claim.expires_at = body.expires_at;
				heartbeatWarningShown = false;
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("success", "ownership: protected"));
				scheduleExpiry(ctx, lease);
			} catch (error) {
				if (controller.signal.aborted || currentLease !== lease) return;
				if (error instanceof LeaseLostError || Date.now() >= expiryMs(lease.claim.expires_at)) {
					if (!ctx.isIdle()) ctx.abort();
					await recoverOwnership(ctx, lease);
					return;
				}
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "ownership: heartbeat failed (lease still valid)"));
				if (!heartbeatWarningShown) {
					heartbeatWarningShown = true;
					ctx.ui.notify(`Session ownership heartbeat failed; writes will be blocked if the lease expires: ${error instanceof Error ? error.message : String(error)}`, "warning");
				}
			} finally {
				if (heartbeatController === controller) heartbeatController = undefined;
				heartbeatRunning = false;
			}
		};

		heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);
		heartbeatTimer.unref?.();
	}

	const releaseCurrentLease = async (ctx: ExtensionContext) => {
		const lease = currentLease;
		currentLease = undefined;
		stopHeartbeat();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (lease) await releaseLease(lease);
	};

	pi.on("session_before_switch", async (event, ctx) => {
		if (ctx.mode !== "tui" || event.reason !== "resume" || !event.targetSessionFile) return;

		const result = await showOwnershipGate(ctx, event.targetSessionFile);
		if (result.kind === "cancel") return { cancel: true };
		if (result.kind === "unprotected") {
			if (result.sessionId) shared.continueUnprotectedSessionId = result.sessionId;
			return;
		}

		prepareLease(shared, result.lease);
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;

		const sessionId = ctx.sessionManager.getSessionId();
		if (shared.handoff?.lease.sessionId === sessionId || shared.prepared?.lease.sessionId === sessionId) {
			const prepared = clearHandoffLease(shared) ?? clearPreparedLease(shared);
			if (!prepared) return;
			startHeartbeat(ctx, prepared);
			if (prepared.claim.evicted_idle) ctx.ui.notify("Claimed session after evicting an idle owner.", "warning");
			return;
		}
		if (shared.continueUnprotectedSessionId === sessionId) {
			shared.continueUnprotectedSessionId = undefined;
			setUnprotected(ctx);
			return;
		}

		const result = await showOwnershipGate(ctx, sessionFile);
		if (result.kind === "claimed") {
			startHeartbeat(ctx, result.lease);
			if (result.lease.claim.evicted_idle) ctx.ui.notify("Claimed session after evicting an idle owner.", "warning");
			return;
		}
		if (result.kind === "unprotected") {
			setUnprotected(ctx);
			return;
		}

		// session_start cannot cancel startup. Graceful shutdown keeps editor focus
		// away from an unclaimed session.
		ctx.shutdown();
	});

	pi.on("input", async (_event, ctx) => {
		if (ctx.mode !== "tui" || protectionState !== "blocked" || !currentLease) return;
		await recoverOwnership(ctx, currentLease);
		return protectionState === "blocked" ? { action: "handled" as const } : { action: "continue" as const };
	});

	pi.on("tool_call", async (_event, ctx) => {
		if (ctx.mode !== "tui" || protectionState !== "blocked" || !currentLease) return;
		await recoverOwnership(ctx, currentLease);
		if (protectionState === "blocked") return { block: true, reason: "Session ownership lease expired; tool writes are blocked." };
	});

	pi.on("user_bash", async (_event, ctx) => {
		if (ctx.mode !== "tui" || protectionState !== "blocked" || !currentLease) return;
		await recoverOwnership(ctx, currentLease);
		if (protectionState === "blocked") {
			return { result: { output: "Session ownership lease expired; shell writes are blocked.", exitCode: 1, cancelled: true, truncated: false } };
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		await releaseCurrentLease(ctx);

		// Move a successful /resume destination out of the prepared slot before
		// releasing every lease still prepared by this runtime. Its bounded timer
		// remains armed until the replacement runtime consumes the handoff.
		const prepared = shared.prepared;
		const isResumeHandoff = event.reason === "resume" && prepared?.lease.sessionFile === event.targetSessionFile;
		if (isResumeHandoff) {
			shared.prepared = undefined;
			shared.handoff = prepared;
		}
		const orphan = clearPreparedLease(shared);
		if (orphan) await releaseLease(orphan);
		if (!isResumeHandoff) {
			const staleHandoff = clearHandoffLease(shared);
			if (staleHandoff) await releaseLease(staleHandoff);
		}
	});
}
