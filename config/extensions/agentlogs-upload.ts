import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const URL_RE = /https?:\/\/\S+\/(?:app\/logs|s)\/[A-Za-z0-9_-]+/g;

function summarizeOutput(stdout: string, stderr: string): string {
	const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
	if (!combined) return "AgentLogs upload finished with no output.";

	const urls = combined.match(URL_RE);
	if (urls?.length) {
		return `AgentLogs upload complete:\n${urls[urls.length - 1]}`;
	}

	const lines = combined.split(/\r?\n/).filter(Boolean);
	return lines.slice(-8).join("\n");
}

export default function agentlogsUploadExtension(pi: ExtensionAPI) {
	pi.registerCommand("upload", {
		description: "Upload the current Pi session to AgentLogs",
		handler: async (args, ctx) => {
			const explicitTarget = args.trim();
			const sessionFile = explicitTarget || ctx.sessionManager.getSessionFile();

			if (!sessionFile) {
				ctx.ui.notify("No persisted Pi session file is available to upload.", "error");
				return;
			}

			ctx.ui.notify("Uploading session to AgentLogs...", "info");

			const result = await pi.exec("agentlogs-monika", ["pi", "upload", sessionFile], {
				cwd: ctx.cwd,
				timeout: 120_000,
				signal: ctx.signal,
			});

			const summary = summarizeOutput(result.stdout, result.stderr);
			if (result.code === 0) {
				ctx.ui.notify(summary, "success");
			} else {
				ctx.ui.notify(`AgentLogs upload failed with exit code ${result.code}:\n${summary}`, "error");
			}
		},
	});
}
