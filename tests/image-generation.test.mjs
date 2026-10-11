import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GEMINI_IMAGE_API,
  GEMINI_IMAGE_MODEL_ID,
  MAX_OUTPUT_BYTES,
  OPENAI_IMAGE_API,
  OPENAI_IMAGE_MODEL_ID,
  createGeminiImageImplementation,
  createOpenAIImageImplementation,
  decodeGeneratedImage,
  formatImageToolResult,
  installPoolImageProviders,
  inspectImageBytes,
  readReferenceImages,
  runImageGeneration,
  validateGenerationControls,
} from "../config/extensions/image-generation-core.mjs";
import { currentCanonicalForumTopic, uploadForumAttachment } from "../config/extensions/forum-attachments-core.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const PNG_B64 = PNG.toString("base64");

function imageModel(provider, id, api) {
  return { type: "image", provider, id, name: id, api, baseUrl: "https://pool.example/v1", input: ["text", "image"], output: ["image"], cost: {} };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function sessionManager(seed = []) {
  const branch = [...seed];
  let id = 0;
  return {
    branch,
    getBranch: () => branch,
    appendCustomEntry(customType, data) {
      const entryId = `custom-${++id}`;
      branch.push({ type: "custom", id: entryId, customType, data });
      return entryId;
    },
  };
}

function forumSeed(topicId = "topic-1") {
  return [
    { type: "message", id: "user-1", message: { role: "user", content: "draw" } },
    { type: "custom", id: "provenance-1", customType: "monika.message.provenance", data: {
      version: 2, piMessageId: "user-1", messageKind: "user_prompt", topicId,
    } },
  ];
}

test("OpenAI native Responses request preserves controls, references, resolved auth, and operation identity", async () => {
  const calls = [];
  const implementation = createOpenAIImageImplementation({ routingModel: "gpt-5.6-luna-custom" });
  const model = imageModel("codex", OPENAI_IMAGE_MODEL_ID, OPENAI_IMAGE_API);
  const result = await implementation.generateImages(model, {
    input: [{ type: "text", text: "paint a fox" }, { type: "image", data: PNG_B64, mimeType: "image/png" }],
  }, {
    apiKey: "resolved-secret",
    headers: { "X-Pool": "yes" },
    metadata: { monikaImageControls: { format: "webp", size: "1536x1024", quality: "high", background: "opaque" } },
    onPayload(payload) { calls.push({ hookPayload: structuredClone(payload) }); },
    onResponse(response) { calls.push({ hookResponse: response }); },
    async fetch(url, init) {
      calls.push({ url, init, payload: JSON.parse(init.body) });
      return jsonResponse({ id: "resp-image", output: [{ type: "image_generation_call", result: PNG_B64 }], usage: { input_tokens: 4, output_tokens: 2 } });
    },
  });
  assert.equal(result.stopReason, "stop");
  assert.equal(result.model, OPENAI_IMAGE_MODEL_ID, "operation model identity must not be replaced by the routing chat model");
  assert.equal(calls[1].url, "https://pool.example/v1/responses");
  assert.equal(calls[1].init.headers.Authorization, "Bearer resolved-secret");
  assert.equal(calls[1].init.headers["X-Pool"], "yes");
  assert.equal(calls[1].payload.model, "gpt-5.6-luna-custom");
  assert.equal(calls[1].payload.stream, false);
  assert.equal(calls[1].payload.store, false);
  assert.deepEqual(calls[1].payload.metadata, { operation: "image_generation" });
  assert.deepEqual(calls[1].payload.tools[0], {
    type: "image_generation", output_format: "webp", size: "1536x1024", quality: "high", background: "opaque", partial_images: 0,
  });
  assert.equal(calls[1].payload.input[0].content[1].image_url, `data:image/png;base64,${PNG_B64}`);
  assert.equal(calls[2].hookResponse.status, 200);
});

test("Gemini native generateContent preserves image config and provider-owned authorization", async () => {
  const calls = [];
  const implementation = createGeminiImageImplementation({ wireModel: "antigravity/gemini-3.1-flash-image" });
  const model = imageModel("antigravity", GEMINI_IMAGE_MODEL_ID, GEMINI_IMAGE_API);
  const result = await implementation.generateImages(model, {
    input: [{ type: "text", text: "edit this" }, { type: "image", data: PNG_B64, mimeType: "image/png" }],
  }, {
    apiKey: "must-not-replace-header",
    headers: { Authorization: "Bearer resolved-oauth", "X-Route": "antigravity" },
    metadata: { monikaImageControls: { size: "4K" } },
    async fetch(url, init) {
      calls.push({ url, init, payload: JSON.parse(init.body) });
      return jsonResponse({ responseId: "gemini-response", candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_B64 } }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } });
    },
  });
  assert.equal(result.stopReason, "stop");
  assert.equal(calls[0].url, "https://pool.example/v1beta/models/antigravity/gemini-3.1-flash-image:generateContent");
  assert.equal(calls[0].init.headers.Authorization, "Bearer resolved-oauth");
  assert.equal(calls[0].payload.model, undefined);
  assert.deepEqual(calls[0].payload.generationConfig, { responseModalities: ["TEXT", "IMAGE"], imageConfig: { imageSize: "4K" } });
  assert.deepEqual(calls[0].payload.contents[0].parts[1], { inlineData: { mimeType: "image/png", data: PNG_B64 } });
});

test("adapters make one request, reject missing/SSE results, sanitize failures, and pass through abort", async () => {
  const model = imageModel("codex", OPENAI_IMAGE_MODEL_ID, OPENAI_IMAGE_API);
  for (const fixture of [
    { response: jsonResponse({ output: [] }), message: /exactly one image/ },
    { response: new Response("data: secret\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }), message: /Streaming image responses/ },
    { response: new Response("private upstream body", { status: 503 }), message: /HTTP 503/ },
  ]) {
    let calls = 0;
    const result = await createOpenAIImageImplementation().generateImages(model, { input: [{ type: "text", text: "fox" }] }, {
      metadata: { monikaImageControls: {} },
      fetch: async () => { calls += 1; return fixture.response; },
    });
    assert.equal(calls, 1);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, fixture.message);
    assert.doesNotMatch(result.errorMessage, /private upstream body|secret/);
  }

  const controller = new AbortController();
  let abortCalls = 0;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const pending = createOpenAIImageImplementation().generateImages(model, { input: [{ type: "text", text: "fox" }] }, {
    signal: controller.signal,
    metadata: { monikaImageControls: {} },
    fetch: async (_url, init) => {
      abortCalls += 1;
      markStarted();
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    },
  });
  await started;
  controller.abort();
  const aborted = await pending;
  assert.equal(abortCalls, 1);
  assert.equal(aborted.stopReason, "aborted");
});

test("mixed provider registration retains chat/classifier/image metadata while adding native images", () => {
  const models = {
    codex: {
      chat: [{ provider: "codex", id: "chat-1", name: "Chat", api: "openai-responses", baseUrl: "https://pool.example/v1", input: ["text"], cost: { input: 1 }, reasoning: true, contextWindow: 123, maxTokens: 45, promptCache: { short: 300 }, compat: { supportsStore: false } }],
      classifier: [{ type: "classifier", provider: "codex", id: "judge", name: "Judge", api: "judge-api", baseUrl: "https://pool.example/v1", input: ["text"], cost: {}, contextWindow: 99 }],
      image: [{ type: "image", provider: "codex", id: "existing-image", name: "Existing", api: "existing-api", baseUrl: "https://pool.example/v1", input: ["text"], output: ["image"], cost: {} }],
    },
    antigravity: {
      chat: [{ provider: "antigravity", id: "gemini-chat", name: "Gemini", api: "openai-completions", baseUrl: "https://pool.example/v1", input: ["text", "image"], cost: {}, reasoning: false, contextWindow: 100, maxTokens: 20 }],
      classifier: [], image: [],
    },
  };
  const registry = { getModelsOfType(type, provider) { return models[provider]?.[type] ?? []; } };
  const calls = [];
  const installed = installPoolImageProviders({ registerProvider: (provider, config) => calls.push({ provider, config }), registry, env: {} });
  assert.deepEqual(installed, [`codex/${OPENAI_IMAGE_MODEL_ID}`, `antigravity/${GEMINI_IMAGE_MODEL_ID}`]);
  assert.equal(calls.length, 2);
  const codex = calls[0].config.models;
  const { provider: _chatProvider, ...chatDefinition } = models.codex.chat[0];
  assert.deepEqual(codex.find((entry) => entry.id === "chat-1"), { ...chatDefinition, type: "chat" });
  const { provider: _classifierProvider, ...classifierDefinition } = models.codex.classifier[0];
  assert.deepEqual(codex.find((entry) => entry.id === "judge"), classifierDefinition);
  assert.ok(codex.some((entry) => entry.id === "existing-image"));
  assert.equal(codex.find((entry) => entry.id === OPENAI_IMAGE_MODEL_ID).type, "image");
  assert.ok(calls[0].config.images[OPENAI_IMAGE_API]);
});

test("format/size/quality/background capabilities reject unsupported combinations", () => {
  assert.deepEqual(validateGenerationControls(OPENAI_IMAGE_API, {}), { format: "png", size: "auto", quality: "auto", background: "auto" });
  assert.throws(() => validateGenerationControls(OPENAI_IMAGE_API, { format: "jpeg", background: "transparent" }), /transparent/);
  assert.throws(() => validateGenerationControls(GEMINI_IMAGE_API, { quality: "high" }), /does not support/);
  assert.throws(() => validateGenerationControls(GEMINI_IMAGE_API, { size: "1024x1024" }), /1K, 2K, or 4K/);
});

test("reference inputs and generated output enforce count, byte, signature, and pixel bounds", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "image-bounds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "one.png"), PNG);
  const refs = await readReferenceImages(["one.png"], root);
  assert.equal(refs[0].mimeType, "image/png");
  await assert.rejects(() => readReferenceImages(["one.png", "one.png", "one.png", "one.png", "one.png"], root), /At most 4/);
  await writeFile(path.join(root, "large.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(() => readReferenceImages(["large.png"], root), /at most 8 MiB/);
  const padded = Buffer.concat([PNG, Buffer.alloc(7 * 1024 * 1024)]);
  await writeFile(path.join(root, "padded-a.png"), padded);
  await writeFile(path.join(root, "padded-b.png"), padded);
  await assert.rejects(() => readReferenceImages(["padded-a.png", "padded-b.png"], root), /total at most 12 MiB/);
  assert.throws(() => inspectImageBytes(Buffer.from("not an image")), /valid PNG/);
  assert.throws(() => inspectImageBytes(PNG, "image/jpeg"), /does not match/);
  const tooManyPixels = Buffer.from(PNG);
  tooManyPixels.writeUInt32BE(20_000, 16);
  tooManyPixels.writeUInt32BE(20_000, 20);
  assert.throws(() => inspectImageBytes(tooManyPixels), /pixel limit/);
  assert.throws(() => decodeGeneratedImage(Buffer.alloc(32).toString("base64"), "image/png", 16), /exceeds/);
  assert.throws(() => decodeGeneratedImage(Buffer.alloc(MAX_OUTPUT_BYTES + 1).toString("base64"), "image/png"), /exceeds/);
});

test("canonical forum topic must belong to the latest user message", () => {
  const old = forumSeed("old-topic");
  old.push({ type: "message", id: "cli-user", message: { role: "user", content: "CLI continuation" } });
  assert.equal(currentCanonicalForumTopic(old), null, "stale requester provenance must not publish a CLI continuation");
  old.push({ type: "custom", id: "new-provenance", customType: "monika.message.provenance", data: {
    piMessageId: "cli-user", messageKind: "user_prompt", executionOrigins: [{ originKind: "forum", topicId: "new-topic" }],
  } });
  assert.equal(currentCanonicalForumTopic(old).topicId, "new-topic");
});

test("shared forum upload posts bytes and appends the structured ref before returning", async () => {
  const sessions = sessionManager();
  const calls = [];
  const result = await uploadForumAttachment({
    topicId: "topic/one",
    bytes: PNG,
    filename: "result.png",
    mimeType: "image/png",
    sessionManager: sessions,
    env: { MONIKA_FORUM_API_BASE_URL: "https://forum.example/api/", CODEX_FORUM_INTERNAL_API_TOKEN: "token" },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.body.get("file").name, "result.png");
      return jsonResponse({ id: "pending-1", filename: "result.png", mimeType: "image/png", sizeBytes: PNG.length, expiresAt: "2099-01-01T00:00:00.000Z", reference: "legacy" });
    },
  });
  assert.equal(calls[0].url, "https://forum.example/api/agent/topics/topic%2Fone/pending-attachments");
  assert.equal(calls[0].init.headers["x-internal-token"], "token");
  assert.equal(sessions.branch.at(-1).customType, "monika.forum.attachment.ref");
  assert.equal(result.refEntryId, sessions.branch.at(-1).id);
  assert.match(result.attachmentRef.sha256, /^[a-f0-9]{64}$/u);
});

test("generation saves mode-0600 metadata, uploads before ref/publication, and recovery does not regenerate", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "image-flow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = sessionManager(forumSeed());
  const model = imageModel("codex", OPENAI_IMAGE_MODEL_ID, OPENAI_IMAGE_API);
  let generations = 0;
  const registry = {
    getModelsOfType(type) { return type === "image" ? [model] : []; },
    async generateImages() {
      generations += 1;
      return { stopReason: "stop", output: [{ type: "image", data: PNG_B64, mimeType: "image/png" }] };
    },
  };
  const sequence = [];
  const failingUpload = async () => { sequence.push("upload-failed"); throw new Error("Forum attachment upload failed: 503 private body"); };
  let generationId;
  await assert.rejects(async () => {
    await runImageGeneration({ prompt: "fox" }, {
      registry, sessionManager: sessions, cwd: root, env: { MONIKA_IMAGE_TEMP_DIR: root }, upload: failingUpload,
    });
  }, (error) => {
    assert.doesNotMatch(error.message, /private body/);
    const match = error.message.match(/retry_generation_id=([0-9a-f-]+)/u);
    assert.ok(match);
    generationId = match[1];
    return true;
  });
  assert.equal(generations, 1);
  const generated = sessions.branch.find((entry) => entry.customType === "monika.image.generated");
  assert.equal(generated.data.generationId, generationId);
  assert.equal((await stat(generated.data.path)).mode & 0o777, 0o600);
  assert.deepEqual(sessions.branch.slice(-2).map((entry) => entry.customType), ["monika.image.generated", "monika.image.publication"]);
  assert.equal(sessions.branch.at(-1).data.state, "failed");
  assert.equal(JSON.stringify(sessions.branch).includes(PNG_B64), false, "canonical custom entries must never contain image base64");

  const successfulUpload = async ({ sessionManager: manager }) => {
    sequence.push("upload-success");
    const refEntryId = manager.appendCustomEntry("monika.forum.attachment.ref", { version: 1, pendingAttachmentId: "pending-1" });
    sequence.push("ref-appended");
    return { refEntryId };
  };
  const originalBranch = [...sessions.branch];
  sessions.branch.push({ type: "message", id: "cli-later", message: { role: "user", content: "CLI" } });
  await assert.rejects(() => runImageGeneration({ retry_generation_id: generationId }, {
    registry, sessionManager: sessions, cwd: root, env: {}, upload: successfulUpload,
  }), /original topic/);
  sessions.branch.push({ type: "custom", customType: "monika.message.provenance", data: {
    piMessageId: "cli-later", messageKind: "user_prompt", topicId: "other-topic",
  } });
  await assert.rejects(() => runImageGeneration({ retry_generation_id: generationId }, {
    registry, sessionManager: sessions, cwd: root, env: {}, upload: successfulUpload,
  }), /original topic/);
  sessions.branch.splice(0, sessions.branch.length, ...originalBranch);
  assert.equal(generations, 1);
  const recovered = await runImageGeneration({ retry_generation_id: generationId }, {
    registry, sessionManager: sessions, cwd: root, env: { MONIKA_IMAGE_TEMP_DIR: root }, upload: successfulUpload,
  });
  assert.equal(generations, 1, "publication recovery must not call the image model");
  assert.equal(recovered.recovered, true);
  assert.deepEqual(sequence, ["upload-failed", "upload-success", "ref-appended"]);
  assert.deepEqual(sessions.branch.slice(-2).map((entry) => entry.customType), ["monika.forum.attachment.ref", "monika.image.publication"]);
  await assert.rejects(() => runImageGeneration({ retry_generation_id: generationId }, {
    registry, sessionManager: sessions, cwd: root, env: {}, upload: successfulUpload,
  }), /already published/);
  assert.equal(generations, 1);
  const rendered = formatImageToolResult(recovered);
  assert.equal(JSON.stringify(rendered).includes(PNG_B64), false);
  assert.equal(JSON.stringify(rendered).includes("session"), false);
});

test("optional output path never overwrites an existing file and CLI generation skips forum publication", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "image-save-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "existing.png");
  await writeFile(output, "keep");
  await chmod(output, 0o644);
  const sessions = sessionManager([{ type: "message", id: "cli", message: { role: "user", content: "CLI" } }]);
  const model = imageModel("codex", OPENAI_IMAGE_MODEL_ID, OPENAI_IMAGE_API);
  let uploads = 0;
  let generations = 0;
  const registry = {
    getModelsOfType: (type) => type === "image" ? [model] : [],
    generateImages: async () => { generations += 1; return { stopReason: "stop", output: [{ type: "image", data: PNG_B64, mimeType: "image/png" }] }; },
  };
  await assert.rejects(() => runImageGeneration({ prompt: "fox", output_path: output }, {
    registry, sessionManager: sessions, cwd: root, env: {}, upload: async () => { uploads += 1; },
  }), /refusing to overwrite/);
  assert.equal(await readFile(output, "utf8"), "keep");
  assert.equal(generations, 0, "pre-existing output must not charge generation");

  const result = await runImageGeneration({ prompt: "fox" }, {
    registry, sessionManager: sessions, cwd: root, env: { MONIKA_IMAGE_TEMP_DIR: root }, upload: async () => { uploads += 1; },
  });
  assert.equal(result.publication.published, false);
  assert.equal(uploads, 0);
});

test("post-generation save collision retains temporary custody and sanitizes total storage failure", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "image-custody-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "race.png");
  const model = imageModel("codex", OPENAI_IMAGE_MODEL_ID, OPENAI_IMAGE_API);
  const sessions = sessionManager([]);
  const registry = {
    getModelsOfType: (type) => type === "image" ? [model] : [],
    async generateImages() {
      await writeFile(output, "racer");
      return { stopReason: "stop", output: [{ type: "image", data: PNG_B64, mimeType: "image/png" }] };
    },
  };
  const result = await runImageGeneration({ prompt: "fox", output_path: output }, {
    registry, sessionManager: sessions, cwd: root, env: { MONIKA_IMAGE_TEMP_DIR: root },
  });
  assert.notEqual(result.record.path, output);
  assert.deepEqual(await readFile(result.record.path), PNG);
  assert.equal((await stat(result.record.path)).mode & 0o777, 0o600);
  assert.match(formatImageToolResult(result).content[0].text, /temporary custody/);
  assert.equal(sessions.branch.at(-1).customType, "monika.image.generated");
  assert.equal(await readFile(output, "utf8"), "racer");
  await rm(output);
  const blocked = path.join(root, "blocked");
  await writeFile(blocked, "not a directory");
  await assert.rejects(() => runImageGeneration({ prompt: "fox", output_path: output }, {
    registry, sessionManager: sessions, cwd: root, env: { MONIKA_IMAGE_TEMP_DIR: blocked },
  }), (error) => {
    assert.match(error.message, /both requested and temporary storage failed/);
    assert.doesNotMatch(error.message, /ENOTDIR|blocked/);
    return true;
  });
});
