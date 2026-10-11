import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

export function stripAt(path) {
  return path.startsWith("@") ? path.slice(1) : path;
}

export async function readForumRequester(cwd) {
  try {
    const raw = await readFile(resolve(cwd, ".codex-forum/requester.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.topicId === "string" && parsed.topicId.trim()
      ? { topicId: parsed.topicId.trim() }
      : null;
  } catch {
    return null;
  }
}

export function currentCanonicalForumTopic(entries) {
  if (!Array.isArray(entries)) return null;
  let latestUserId = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message?.role === "user") {
      latestUserId = entry.id;
      break;
    }
  }
  if (!latestUserId) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const data = entry?.data;
    if (entry?.type !== "custom" || entry.customType !== "monika.message.provenance" ||
        data?.piMessageId !== latestUserId || data?.messageKind !== "user_prompt") continue;
    const topicId = typeof data.topicId === "string" ? data.topicId.trim() : "";
    if (topicId) return { topicId, provenanceEntryId: entry.id };
    const origins = Array.isArray(data.executionOrigins) ? data.executionOrigins : [];
    const canonical = origins.findLast?.((origin) =>
      origin?.originKind === "forum" && typeof origin.topicId === "string" && origin.topicId.trim());
    if (canonical) return { topicId: canonical.topicId.trim(), provenanceEntryId: entry.id };
  }
  return null;
}

export async function resolveForumTopic({ cwd, sessionManager, allowRequesterFallback = true }) {
  const canonical = currentCanonicalForumTopic(sessionManager?.getBranch?.() ?? []);
  if (canonical) return canonical;
  return allowRequesterFallback ? readForumRequester(cwd) : null;
}

export function guessMimeType(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

function forumConfiguration(env) {
  return {
    apiBase: (env.MONIKA_FORUM_API_BASE_URL ?? env.CODEX_FORUM_API_BASE_URL ?? "http://127.0.0.1:4310/api").replace(/\/$/, ""),
    token: env.CODEX_FORUM_INTERNAL_API_TOKEN ?? env.MONIKA_FORUM_INTERNAL_API_TOKEN ?? "",
  };
}

export async function uploadForumAttachment({
  topicId,
  bytes,
  filename,
  mimeType,
  sessionManager,
  signal,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error("Forum attachment is empty");
  if (typeof fetchImpl !== "function") throw new Error("Forum attachment upload is unavailable");
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), filename);
  const { apiBase, token } = forumConfiguration(env);
  const headers = {};
  if (token) headers["x-internal-token"] = token;
  const response = await fetchImpl(`${apiBase}/agent/topics/${encodeURIComponent(topicId)}/pending-attachments`, {
    method: "POST",
    headers,
    body: form,
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Forum attachment upload failed: ${response.status} ${text}`.trim());
  }
  const result = await response.json();
  if (!result || typeof result.id !== "string" || typeof result.filename !== "string" ||
      typeof result.mimeType !== "string" || !Number.isSafeInteger(result.sizeBytes) || result.sizeBytes <= 0 ||
      typeof result.expiresAt !== "string") {
    throw new Error("Forum attachment upload returned malformed metadata");
  }
  const sha256 = typeof result.sha256 === "string" && /^[a-f0-9]{64}$/u.test(result.sha256)
    ? result.sha256
    : createHash("sha256").update(bytes).digest("hex");
  const attachmentRef = {
    version: 1,
    pendingAttachmentId: result.id,
    topicId,
    filename: result.filename,
    mimeType: result.mimeType,
    sizeBytes: result.sizeBytes,
    sha256,
    expiresAt: result.expiresAt,
  };
  const refEntryId = sessionManager.appendCustomEntry("monika.forum.attachment.ref", attachmentRef);
  return { attachmentRef, refEntryId, legacyReference: result.reference };
}

export async function uploadForumAttachmentPath({ path, filename, mimeType, ...options }) {
  const bytes = await readFile(path);
  return uploadForumAttachment({
    ...options,
    bytes,
    filename: filename?.trim() || basename(path),
    mimeType: mimeType?.trim() || guessMimeType(filename?.trim() || basename(path)),
  });
}
