export const REMOTE_ATOMIC_WRITE_SCRIPT = `set -eu
p="$1"; expected="$2"
parent=$(dirname -- "$p"); name=$(basename -- "$p")
[ -d "$parent" ] || exit 64
physical=$(readlink -f -- "$parent"); lexical=$(realpath -ms -- "$parent")
[ "$physical" = "$lexical" ] || exit 65
exec {parentfd}<"$parent"; parentcap="/proc/$$/fd/$parentfd"; held=$(readlink -f -- "$parentcap")
[ "$held" = "$lexical" ] || exit 65
[ ! -L "$parentcap/$name" ] || exit 66
tmp=$(mktemp "$parentcap/.monika-write.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT HUP INT TERM
base64 -d > "$tmp"
actual=$(sha256sum "$tmp" | awk '{print $1}'); [ "$actual" = "$expected" ] || exit 68
mv -f -- "$tmp" "$parentcap/$name"; trap - EXIT HUP INT TERM
[ "$(readlink -f -- "$parent")" = "$(readlink -f -- "$parentcap")" ] || { rm -f -- "$parentcap/$name"; exit 67; }
`;

export const REMOTE_FIND_SCRIPT = `set +e
search="$1"; root="$5"
if [ -n "$root" ]; then
  root=$(readlink -f -- "$root") || exit 64
  exec {searchfd}<"$search" || exit 64
  search="/proc/$$/fd/$searchfd"
  resolved=$(readlink -f -- "$search") || exit 64
  case "$resolved" in "$root"|"$root/"*) ;; *) exit 65 ;; esac
fi
cd -- "$search" || exit 70
rg --files --hidden -g "$2" | head -n "$3" | head -c "$4"
codes=("\${PIPESTATUS[@]}")
code="\${codes[0]}"
[ "$code" -eq 0 ] || [ "$code" -eq 1 ] || [ "$code" -eq 141 ] || exit "$code"
exit 0
`;

export const REMOTE_GREP_SCRIPT = `set +e
search="$5"; root="$9"
if [ -n "$root" ]; then
  root=$(readlink -f -- "$root") || exit 64
  exec {searchfd}<"$search" || exit 64
  search="/proc/$$/fd/$searchfd"
  resolved=$(readlink -f -- "$search") || exit 64
  case "$resolved" in "$root"|"$root/"*) ;; *) exit 65 ;; esac
  if [ -d "$search" ]; then cd -- "$search" || exit 70; search=.; fi
fi
args=(rg --json --line-number --color=never --hidden)
[ "$1" = 1 ] && args+=(--ignore-case)
[ "$2" = 1 ] && args+=(--fixed-strings)
[ -n "$3" ] && args+=(--glob "$3")
[ "$6" -gt 0 ] && args+=(--context "$6")
args+=(-- "$4" "$search")
"\${args[@]}" | {
  matches=0
  while IFS= read -r line; do
    case "$line" in
      *'"type":"match"'*) [ "$matches" -lt "$7" ] || break; matches=$((matches + 1)) ;;
    esac
    printf '%s\n' "$line"
  done
} | head -c "$8"
codes=("\${PIPESTATUS[@]}")
code="\${codes[0]}"
[ "$code" -eq 0 ] || [ "$code" -eq 1 ] || [ "$code" -eq 141 ] || exit "$code"
exit 0
`;

export class RelocateError extends Error {
	constructor(message, kind = "unknown") {
		super(message);
		this.name = "RelocateError";
		this.kind = kind;
	}
}

function assertRemote(remote) {
	if (!remote || /\s/.test(remote) || remote.includes("/")) {
		throw new RelocateError(
			'Invalid SSH target. Use "user@host", an SSH config alias, or "user@host:/absolute/path".',
			"validation",
		);
	}
}

/** Parse the model-facing overloaded target without allowing ambiguous host/port/IPv6 forms. */
export function parseRelocateTarget(target) {
	if (target === undefined) return { kind: "status" };
	if (typeof target !== "string") throw new RelocateError("Relocate target must be a string.", "validation");
	const value = target.trim();
	if (!value) throw new RelocateError("Relocate target must not be empty. Omit target to inspect status.", "validation");
	if (value === "local") return { kind: "local" };

	// Bracketed IPv6 is unambiguous: user@[2001:db8::1]:/path.
	const ipv6 = value.match(/^(?:([^@\s]+)@)?(\[[^\]\s]+\])(?::(.+))?$/);
	if (ipv6) {
		const remote = `${ipv6[1] ? `${ipv6[1]}@` : ""}${ipv6[2]}`;
		const remoteCwd = ipv6[3];
		if (remoteCwd !== undefined && !/^(?:\/|~(?:\/|$))/.test(remoteCwd)) {
			throw new RelocateError("Remote paths must be absolute or start with ~/.", "validation");
		}
		return { kind: "remote", remote, remoteCwd };
	}

	const firstColon = value.indexOf(":");
	const lastColon = value.lastIndexOf(":");
	if (firstColon !== lastColon) {
		throw new RelocateError("IPv6 SSH targets must use brackets, for example user@[2001:db8::1]:/home/user.", "validation");
	}
	const remote = firstColon === -1 ? value : value.slice(0, firstColon);
	const remoteCwd = firstColon === -1 ? undefined : value.slice(firstColon + 1);
	assertRemote(remote);
	if (remoteCwd !== undefined && !/^(?:\/|~(?:\/|$))/.test(remoteCwd)) {
		throw new RelocateError(
			"Remote paths must be absolute or start with ~/. Configure non-default SSH ports in ~/.ssh/config.",
			"validation",
		);
	}
	return { kind: "remote", remote, remoteCwd };
}

/** Fair async read/write lock: routed tools may overlap; context transitions are exclusive. */
export function createAsyncReadWriteLock() {
	let readers = 0;
	let writer = false;
	const queue = [];

	const drain = () => {
		if (writer || queue.length === 0) return;
		if (queue[0].kind === "write") {
			if (readers > 0) return;
			writer = true;
			const item = queue.shift();
			item.resolve(() => {
				writer = false;
				drain();
			});
			return;
		}
		while (queue[0]?.kind === "read") {
			readers += 1;
			const item = queue.shift();
			item.resolve(() => {
				readers -= 1;
				if (readers === 0) drain();
			});
		}
	};

	const acquire = (kind) => new Promise((resolve) => {
		queue.push({ kind, resolve });
		drain();
	});
	const run = async (kind, task) => {
		const release = await acquire(kind);
		try {
			return await task();
		} finally {
			release();
		}
	};
	return {
		withRead: (task) => run("read", task),
		withWrite: (task) => run("write", task),
	};
}

/** UI feedback is presentation only and can never change an operation outcome. */
export function updateSshUiBestEffort(ctx, {
	statusKey = "ssh",
	statusText,
	tone = "accent",
	notification,
	notificationLevel = "info",
} = {}) {
	if (!ctx || ctx.hasUI === false) return { warnings: 0 };
	let warnings = 0;
	if (statusText !== undefined) {
		let rendered = statusText;
		if (ctx.mode === "tui") {
			try {
				rendered = ctx.ui.theme.fg(tone, statusText);
			} catch {
				warnings += 1;
			}
		}
		try {
			ctx.ui.setStatus(statusKey, rendered);
		} catch {
			warnings += 1;
		}
	}
	if (notification) {
		try {
			ctx.ui.notify(notification, notificationLevel);
		} catch {
			warnings += 1;
		}
	}
	return { warnings };
}

function stateLabel(state) {
	if (state.resolvedSsh) return "remote";
	if (state.sshRequired) return "ssh_unavailable";
	return "local";
}

function details(operation, state, stateChanged, uiWarnings = 0) {
	return {
		version: 1,
		operation,
		state: stateLabel(state),
		stateChanged,
		uiWarnings,
	};
}

function validationFailureMessage(validation, current) {
	const lines = [
		`RELOCATE FAILED — staying on current context (${current}).`,
		`Error: ${validation.error ?? "SSH target validation failed."}`,
	];
	if (validation.errorKind === "auth") {
		lines.push("", "To fix: ensure the SSH public key is authorized on the target.");
	} else if (validation.errorKind === "host_key") {
		lines.push("", "To fix: verify the host identity, then update known_hosts and retry.");
	} else if (validation.errorKind === "refused") {
		lines.push("", "To fix: check that sshd is running on the target.");
	} else if (validation.errorKind === "path") {
		lines.push("", "To fix: use an existing absolute remote path or a path beginning with ~/.");
	} else if (validation.errorKind === "dependency") {
		lines.push("", "To fix: provision the required search dependency on the remote target, then retry.");
	}
	return lines.join("\n");
}

/** Testable semantic state machine used by the extension's relocate tool. */
export async function executeRelocateRequest({
	request,
	getState,
	commitState,
	validateTarget,
	loadRemoteAgents,
	updateUi,
}) {
	const safeUpdateUi = (value) => {
		try {
			return updateUi(value) ?? { warnings: 0 };
		} catch {
			return { warnings: 1 };
		}
	};
	const state = getState();
	if (request.kind === "status") {
		if (state.resolvedSsh) {
			const host = state.remoteHost ? ` (hostname: ${state.remoteHost})` : "";
			return {
				content: [{ type: "text", text: `Current context: ${state.resolvedSsh.remote}:${state.resolvedSsh.remoteCwd}${host}\nAll tools are routing to this target via SSH.` }],
				details: details("status", state, false),
			};
		}
		if (state.sshRequired) {
			const reason = state.sshError ? ` Reason: ${state.sshError.message}` : "";
			return {
				content: [{ type: "text", text: `Current context: SSH unavailable.${reason}\nRemote execution was requested, so routed tools remain blocked rather than falling back to local execution.` }],
				details: details("status", state, false),
			};
		}
		return {
			content: [{ type: "text", text: "Current context: local (container-local execution).\nAll tools operate on the container filesystem." }],
			details: details("status", state, false),
		};
	}

	if (request.kind === "local") {
		const previous = state.resolvedSsh;
		const next = { resolvedSsh: null, sshRequired: false, sshError: null, remoteHost: null, remoteAgentsContent: null };
		commitState(next);
		const ui = safeUpdateUi({ statusText: "", notification: "Relocated to local execution" });
		return {
			content: [{ type: "text", text: `Relocated to local execution (container).${previous ? ` Disconnected from ${previous.remote}.` : ""}` }],
			details: details("local", next, Boolean(previous) || state.sshRequired, ui?.warnings ?? 0),
		};
	}

	const validation = await validateTarget(request.remote, request.remoteCwd);
	if (!validation.success) {
		const current = state.resolvedSsh ? `${state.resolvedSsh.remote}:${state.resolvedSsh.remoteCwd}` : state.sshRequired ? "ssh unavailable" : "local";
		safeUpdateUi({
			statusText: "SSH: validation failed",
			tone: "error",
			notification: `Relocate failed: ${validation.error ?? "validation failed"}`,
			notificationLevel: "error",
		});
		throw new RelocateError(validationFailureMessage(validation, current), validation.errorKind ?? "unknown");
	}

	let remoteAgentsContent = null;
	try {
		remoteAgentsContent = await loadRemoteAgents(request.remote, validation.remoteCwd);
	} catch (error) {
		if (/abort|cancel/i.test(error instanceof Error ? error.message : String(error))) {
			throw new RelocateError("Relocation aborted before the routing state was committed.", "cancelled");
		}
		remoteAgentsContent = null;
	}
	const previous = state.resolvedSsh ? `${state.resolvedSsh.remote}:${state.resolvedSsh.remoteCwd}` : state.sshRequired ? "ssh unavailable" : "local";
	const next = {
		resolvedSsh: { remote: request.remote, remoteCwd: validation.remoteCwd },
		sshRequired: true,
		sshError: null,
		remoteHost: validation.hostname ?? null,
		remoteAgentsContent: remoteAgentsContent?.trim() ? remoteAgentsContent : null,
	};
	commitState(next);
	const ui = safeUpdateUi({
		statusText: `SSH: ${next.resolvedSsh.remote}:${next.resolvedSsh.remoteCwd}`,
		notification: `Relocated to ${next.resolvedSsh.remote}:${next.resolvedSsh.remoteCwd}`,
	});
	const lines = [
		`Relocated: ${previous} → ${next.resolvedSsh.remote}:${next.resolvedSsh.remoteCwd}`,
		`Hostname: ${validation.hostname ?? "unknown"}`,
		`All tools (bash, read, write, edit, grep, find, ls) now operate on ${next.resolvedSsh.remote}.`,
	];
	if (next.remoteAgentsContent) lines.push("", "Remote AGENTS.md found and loaded into context.");
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: details("remote", next, true, ui?.warnings ?? 0),
	};
}
