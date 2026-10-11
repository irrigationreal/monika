import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	formatImageToolResult,
	installPoolImageProviders,
	runImageGeneration,
} from "./image-generation-core.mjs";

export default function imageGenerationExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		installPoolImageProviders({
			registerProvider: (provider: string, config: ProviderConfig) => pi.registerProvider(provider, config),
			registry: ctx.modelRegistry,
			env: process.env,
		});
	});

	pi.registerTool({
		name: "generate_image",
		label: "Generate Image",
		description:
			"Generate exactly one image through a registered image model, validate and save it locally, and automatically attach it when the current canonical turn came from the forum. Use retry_generation_id after a publication failure to publish the already-saved bytes without generating again.",
		promptSnippet:
			"Generate images with generate_image. Its result contains only saved-file metadata, never image base64. Do not use a chat model or shell HTTP client for native image generation.",
		promptGuidelines: [
			"Use generate_image for image creation or reference-based editing. It generates one image and does not retry or fall back to a different provider.",
			"Omit backend for the configured default (OpenAI by default), or set backend to openai or gemini. An explicit model may be provider-qualified.",
			"OpenAI supports png/jpeg/webp, documented pixel sizes, quality, and background controls. Gemini supports only 1K/2K/4K size; omit unsupported controls.",
			"If forum publication fails, call generate_image again with only retry_generation_id from the error. Do not regenerate the prompt.",
		],
		parameters: Type.Object({
			prompt: Type.Optional(Type.String({ description: "Image-generation or editing prompt. Required unless retry_generation_id is supplied." })),
			backend: Type.Optional(Type.String({ description: "Explicit backend: openai or gemini." })),
			model: Type.Optional(Type.String({ description: "Explicit registered image model ID, optionally provider-qualified (provider/model)." })),
			reference_paths: Type.Optional(Type.Array(Type.String(), {
				description: "Local PNG/JPEG/WebP reference paths (maximum 4, 8 MiB each, 12 MiB total).",
				maxItems: 4,
			})),
			format: Type.Optional(Type.String({ description: "OpenAI output format: png, jpeg, or webp." })),
			size: Type.Optional(Type.String({ description: "OpenAI: auto/1024x1024/1536x1024/1024x1536. Gemini: 1K/2K/4K." })),
			quality: Type.Optional(Type.String({ description: "OpenAI quality: auto, low, medium, or high." })),
			background: Type.Optional(Type.String({ description: "OpenAI background: auto, opaque, or transparent." })),
			output_path: Type.Optional(Type.String({ description: "Optional local output path. Existing files are never overwritten; default is a mode-0600 temporary inspection file." })),
			retry_generation_id: Type.Optional(Type.String({ description: "Retry forum publication of a durably recorded saved image without calling the image provider again." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await runImageGeneration(params, {
				registry: ctx.modelRegistry,
				sessionManager: ctx.sessionManager,
				cwd: ctx.cwd,
				signal,
				env: process.env,
			});
			return formatImageToolResult(result);
		},
	});
}
