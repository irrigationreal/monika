import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	guessMimeType,
	resolveForumTopic,
	stripAt,
	uploadForumAttachmentPath,
} from "./forum-attachments-core.mjs";

export default function forumAttachmentsExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "forum_upload_attachment",
		label: "Upload Forum Attachment",
		description: "Upload a local file into the current forum topic and durably bind its structured reference to the next outward assistant message.",
		promptSnippet: "Upload local files to the current forum topic before returning them as attachments.",
		promptGuidelines: [
			"Use forum_upload_attachment when you need to return a generated file to the forum user as an attachment.",
			"A successful upload is recorded as structured session data. Do not repeat an attachment marker or URL in the final answer.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Local path to the file to upload. A leading @ is ignored." }),
			filename: Type.Optional(Type.String({ description: "Attachment filename to show in the forum. Defaults to the basename of path." })),
			mimeType: Type.Optional(Type.String({ description: "MIME type. Defaults to a guess from filename." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const topic = await resolveForumTopic({ cwd: ctx.cwd, sessionManager: ctx.sessionManager });
			if (!topic) {
				throw new Error("No canonical forum topic or .codex-forum/requester.json with topicId found in the current workspace");
			}

			const filePath = resolve(ctx.cwd, stripAt(params.path));
			const info = await stat(filePath);
			if (!info.isFile()) throw new Error(`${filePath} is not a file`);
			if (info.size <= 0) throw new Error(`${filePath} is empty`);

			const filename = params.filename?.trim() || basename(filePath);
			const mimeType = params.mimeType?.trim() || guessMimeType(filename);
			const { attachmentRef, refEntryId, legacyReference } = await uploadForumAttachmentPath({
				path: filePath,
				filename,
				mimeType,
				topicId: topic.topicId,
				sessionManager: ctx.sessionManager,
				signal,
			});

			return {
				content: [{
					type: "text",
					text: `Uploaded ${attachmentRef.filename} (${attachmentRef.sizeBytes} bytes). The structured attachment reference is recorded; do not include a marker in the final answer.`,
				}],
				details: { ...attachmentRef, refEntryId, legacyReference },
			};
		},
	});
}
