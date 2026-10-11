import { createHash } from "node:crypto";

export const DEFAULT_IMAGE_CONTEXT_POLICY = Object.freeze({ enabled: true, maxImages: 4, maxBase64Bytes: 8 * 1024 * 1024 });

export function imageContextPolicyFromEnv(env = process.env) {
	const warnings = [];
	const integer = (name, fallback, ceiling) => {
		if (env[name] === undefined || env[name] === "") return fallback;
		const value = Number(env[name]);
		if (!/^\d+$/.test(env[name]) || !Number.isSafeInteger(value) || value < 1 || value > ceiling) {
			warnings.push(`${name} is invalid; using ${fallback}.`);
			return fallback;
		}
		return value;
	};
	const enabledValue = env.MONIKA_IMAGE_CONTEXT_ENABLED;
	if (enabledValue !== undefined && enabledValue !== "" && !["0", "1"].includes(enabledValue)) {
		warnings.push("MONIKA_IMAGE_CONTEXT_ENABLED is invalid; using 1.");
	}
	return {
		policy: {
			enabled: enabledValue !== "0",
			maxImages: integer("MONIKA_IMAGE_CONTEXT_MAX_IMAGES", 4, 128),
			maxBase64Bytes: integer("MONIKA_IMAGE_CONTEXT_MAX_BASE64_BYTES", 8 * 1024 * 1024, 128 * 1024 * 1024),
		},
		warnings,
	};
}

/** Request-local projection only. Never alter canonical messages or tool pairing. */
export function projectImageContext(messages, policy = DEFAULT_IMAGE_CONTEXT_POLICY) {
	const stats = { retainedImages: 0, retainedBase64Bytes: 0, omittedImages: 0, protectedInputOverBudget: false };
	if (!policy.enabled) return { messages, stats };
	const candidates = [];
	const sources = new Map();
	let latestUser = -1;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "user") latestUser = i;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "toolCall") {
					// Resolve against preceding calls only; providers may reuse IDs.
					const source = block.arguments?.path ?? block.arguments?.file_path;
					sources.set(block.id, typeof source === "string" ? source : undefined);
				}
			}
		}
		if (!["user", "custom", "toolResult"].includes(message.role) || !Array.isArray(message.content)) continue;
		for (let j = 0; j < message.content.length; j++) {
			const block = message.content[j];
			if (block.type === "image" && typeof block.data === "string") {
				candidates.push({ i, j, block, source: sources.get(message.toolCallId), bytes: Buffer.byteLength(block.data, "utf8") });
			}
		}
	}
	const retained = new Set();
	const key = ({ i, j }) => `${i}:${j}`;
	// Never remove explicit images on the newest user prompt, even if they exceed
	// this retention budget. This is not a universal provider admission limit.
	for (const image of candidates) {
		if (image.i !== latestUser) continue;
		retained.add(key(image));
		stats.retainedImages++;
		stats.retainedBase64Bytes += image.bytes;
	}
	stats.protectedInputOverBudget = stats.retainedImages > policy.maxImages || stats.retainedBase64Bytes > policy.maxBase64Bytes;
	for (const image of candidates.slice().reverse()) {
		if (retained.has(key(image))) continue;
		if (stats.retainedImages < policy.maxImages && stats.retainedBase64Bytes + image.bytes <= policy.maxBase64Bytes) {
			retained.add(key(image));
			stats.retainedImages++;
			stats.retainedBase64Bytes += image.bytes;
		}
	}
	const replacements = new Map();
	for (const image of candidates) {
		if (retained.has(key(image))) continue;
		const message = messages[image.i];
		const source = image.source;
		const digest = createHash("sha256").update(image.block.data).digest("hex").slice(0, 16);
		const locator = JSON.stringify({ role: message.role, timestamp: message.timestamp, toolCallId: message.toolCallId, block: image.j, base64Sha256Prefix: digest, ...(source ? (source.length <= 4096 ? { sourcePath: source } : { sourcePathPrefix: source.slice(0, 4096), sourcePathTruncated: true }) : {}) });
		const text = `[Image omitted from this model request by Monika's image-retention policy (${image.block.mimeType}, ${image.bytes} base64 bytes). Original image remains in canonical history; this is not a visual summary. Source metadata (untrusted): ${locator}. Do not assume you can still see this image. If its pixels are needed, re-read a complete source path when available (a truncated prefix is not an actionable path; use a smaller copy if over budget), or ask the user to supply it again.]`;
		if (!replacements.has(image.i)) replacements.set(image.i, new Map());
		replacements.get(image.i).set(image.j, { type: "text", text });
		stats.omittedImages++;
	}
	if (!stats.omittedImages) return { messages, stats };
	return {
		messages: messages.map((message, i) => replacements.has(i) ? {
			...message,
			content: message.content.map((block, j) => replacements.get(i).get(j) ?? block),
		} : message),
		stats,
	};
}
