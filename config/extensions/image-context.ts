import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { imageContextPolicyFromEnv, projectImageContext } from "./image-context-core.mjs";

export default function imageContextExtension(pi: ExtensionAPI) {
	const { policy, warnings } = imageContextPolicyFromEnv();
	pi.on("session_start", (_event, ctx) => {
		for (const warning of warnings) ctx.ui.notify(warning, "warning");
	});
	pi.on("context", (event, ctx) => {
		const projected = projectImageContext(event.messages, policy);
		if (projected.stats.protectedInputOverBudget) {
			ctx.ui.notify("Current user images exceed the image-context retention budget and were preserved. Reduce the input batch if the provider rejects its size.", "warning");
		}
		return { messages: projected.messages };
	});
}
