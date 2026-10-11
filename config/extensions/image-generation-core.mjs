// Provider-neutral image generation primitives. This module has no Pi imports so
// protocol, validation, persistence, and publication boundaries can be tested
// with dependency-free node:test fixtures.

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { currentCanonicalForumTopic, uploadForumAttachment } from "./forum-attachments-core.mjs";

export const OPENAI_IMAGE_API = "monika-openai-image-generation";
export const GEMINI_IMAGE_API = "monika-gemini-image-generation";
export const OPENAI_IMAGE_MODEL_ID = "openai-image-generation";
export const GEMINI_IMAGE_MODEL_ID = "gemini-3.1-flash-image";
export const MAX_REFERENCE_COUNT = 4;
export const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
export const MAX_REFERENCE_TOTAL_BYTES = 12 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 100_000_000;

const MAX_PROMPT_CHARS = 12_000;
const MAX_RESPONSE_BYTES = 36 * 1024 * 1024;
const DEFAULT_OPENAI_ROUTING_MODEL = "gpt-5.6-luna";
const DEFAULT_GEMINI_WIRE_MODEL = "antigravity/gemini-3.1-flash-image";
const EMPTY_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const OPENAI_FORMATS = new Set(["png", "jpeg", "webp"]);
const OPENAI_SIZES = new Set(["auto", "1024x1024", "1536x1024", "1024x1536"]);
const OPENAI_QUALITIES = new Set(["auto", "low", "medium", "high"]);
const OPENAI_BACKGROUNDS = new Set(["auto", "opaque", "transparent"]);
const GEMINI_SIZES = new Set(["1K", "2K", "4K"]);
const MIME_EXTENSIONS = Object.freeze({ "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" });

class PublicImageError extends Error {
  constructor(message, code = "image_error") {
    super(message);
    this.name = "PublicImageError";
    this.code = code;
  }
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function abortReason(signal) {
  if (!signal?.aborted) return null;
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function isAbort(error, signal) {
  return Boolean(signal?.aborted || error?.name === "AbortError");
}

function safeErrorMessage(error) {
  if (error instanceof PublicImageError) return error.message;
  return "Image provider request failed";
}

function assistantImages(model, fields) {
  return {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    timestamp: Date.now(),
    ...fields,
  };
}

function readUInt24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function inspectPng(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function inspectJpeg(bytes) {
  if (bytes.length < 10 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (sof.has(marker)) {
      if (length < 7) break;
      return { mimeType: "image/jpeg", width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function inspectWebp(bytes) {
  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return null;
  const declared = bytes.readUInt32LE(4) + 8;
  if (declared > bytes.length || declared < 20) return null;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X" && bytes.length >= 30) {
    return { mimeType: "image/webp", width: readUInt24LE(bytes, 24) + 1, height: readUInt24LE(bytes, 27) + 1 };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { mimeType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { mimeType: "image/webp", width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

export function inspectImageBytes(value, claimedMimeType) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const metadata = inspectPng(bytes) ?? inspectJpeg(bytes) ?? inspectWebp(bytes);
  if (!metadata) throw new PublicImageError("Image bytes are not a valid PNG, JPEG, or WebP", "invalid_image");
  if (claimedMimeType && metadata.mimeType !== claimedMimeType.toLowerCase()) {
    throw new PublicImageError("Image MIME type does not match its byte signature", "invalid_image");
  }
  if (!Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) ||
      metadata.width <= 0 || metadata.height <= 0 || metadata.width > 65_535 || metadata.height > 65_535 ||
      metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
    throw new PublicImageError(`Image dimensions exceed the ${MAX_IMAGE_PIXELS.toLocaleString("en-US")} pixel limit`, "invalid_image");
  }
  return { ...metadata, sizeBytes: bytes.byteLength };
}

export function decodeGeneratedImage(data, claimedMimeType, maxBytes = MAX_OUTPUT_BYTES) {
  if (typeof data !== "string" || !data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) {
    throw new PublicImageError("Image provider returned invalid image data", "invalid_response");
  }
  if (data.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new PublicImageError(`Generated image exceeds the ${Math.trunc(maxBytes / 1024 / 1024)} MiB output limit`, "oversized_output");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new PublicImageError(`Generated image exceeds the ${Math.trunc(maxBytes / 1024 / 1024)} MiB output limit`, "oversized_output");
  }
  if (bytes.toString("base64").replace(/=+$/u, "") !== data.replace(/=+$/u, "")) {
    throw new PublicImageError("Image provider returned invalid image data", "invalid_response");
  }
  return { bytes, metadata: inspectImageBytes(bytes, claimedMimeType) };
}

export function validateGenerationControls(api, controls = {}) {
  const normalized = {
    format: cleanString(controls.format).toLowerCase() || undefined,
    size: cleanString(controls.size) || undefined,
    quality: cleanString(controls.quality).toLowerCase() || undefined,
    background: cleanString(controls.background).toLowerCase() || undefined,
  };
  if (api === OPENAI_IMAGE_API) {
    normalized.format ??= "png";
    normalized.size ??= "auto";
    normalized.quality ??= "auto";
    normalized.background ??= "auto";
    if (!OPENAI_FORMATS.has(normalized.format)) throw new PublicImageError("OpenAI image format must be png, jpeg, or webp", "unsupported_control");
    if (!OPENAI_SIZES.has(normalized.size)) throw new PublicImageError("OpenAI image size must be auto, 1024x1024, 1536x1024, or 1024x1536", "unsupported_control");
    if (!OPENAI_QUALITIES.has(normalized.quality)) throw new PublicImageError("OpenAI image quality must be auto, low, medium, or high", "unsupported_control");
    if (!OPENAI_BACKGROUNDS.has(normalized.background)) throw new PublicImageError("OpenAI image background must be auto, opaque, or transparent", "unsupported_control");
    if (normalized.background === "transparent" && normalized.format === "jpeg") {
      throw new PublicImageError("JPEG does not support a transparent background", "unsupported_control");
    }
    return normalized;
  }
  if (api === GEMINI_IMAGE_API) {
    if (normalized.format) throw new PublicImageError("Gemini image generation does not support selecting an output format", "unsupported_control");
    if (normalized.quality) throw new PublicImageError("Gemini image generation does not support the quality control", "unsupported_control");
    if (normalized.background) throw new PublicImageError("Gemini image generation does not support the background control", "unsupported_control");
    normalized.size ??= "1K";
    if (!GEMINI_SIZES.has(normalized.size)) throw new PublicImageError("Gemini image size must be 1K, 2K, or 4K", "unsupported_control");
    return normalized;
  }
  if (normalized.format || normalized.size || normalized.quality || normalized.background) {
    throw new PublicImageError("The selected image model has no declared format, size, quality, or background controls", "unsupported_control");
  }
  return normalized;
}

function requestHeaders(options = {}) {
  const supplied = options.headers ?? {};
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  const suppressed = new Set();
  for (const [name, value] of Object.entries(supplied)) {
    const lower = name.toLowerCase();
    suppressed.add(lower);
    for (const current of Object.keys(headers)) if (current.toLowerCase() === lower) delete headers[current];
    if (value !== null) headers[name] = value;
  }
  if (options.apiKey && !suppressed.has("authorization") && !suppressed.has("x-api-key")) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }
  return headers;
}

function endpoint(baseUrl, pathname) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new PublicImageError("Image provider endpoint is invalid", "configuration"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
    throw new PublicImageError("Image provider endpoint must use HTTPS", "configuration");
  }
  return new URL(pathname, url.origin).toString();
}

async function readJsonResponse(response, signal) {
  const type = response.headers?.get?.("content-type")?.toLowerCase() ?? "";
  if (type.includes("text/event-stream")) throw new PublicImageError("Streaming image responses are not supported", "invalid_response");
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new PublicImageError("Image provider response is too large", "invalid_response");
  const read = async () => {
    if (!response.body?.getReader) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new PublicImageError("Image provider response is too large", "invalid_response");
      return bytes;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new PublicImageError("Image provider response is too large", "invalid_response");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock?.(); }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  };
  const aborted = abortReason(signal);
  if (aborted) throw aborted;
  let onAbort;
  const abortPromise = new Promise((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  let bytes;
  try { bytes = await Promise.race([read(), abortPromise]); }
  finally { signal?.removeEventListener("abort", onAbort); }
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new PublicImageError("Image provider returned malformed JSON", "invalid_response"); }
}

function responseHeaders(response) {
  const headers = {};
  response.headers?.forEach?.((value, name) => { headers[name] = value; });
  return headers;
}

async function postJson(model, payload, options, pathname) {
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new PublicImageError("Image provider network implementation is unavailable", "configuration");
  const replacement = await options?.onPayload?.(payload, model);
  const aborted = abortReason(options?.signal);
  if (aborted) throw aborted;
  const finalPayload = replacement === undefined ? payload : replacement;
  const response = await fetchImpl(endpoint(model.baseUrl, pathname), {
    method: "POST",
    headers: requestHeaders(options),
    body: JSON.stringify(finalPayload),
    signal: options?.signal,
    redirect: "error",
  });
  if (!response || typeof response.status !== "number") throw new PublicImageError("Image provider returned an invalid HTTP response", "invalid_response");
  await options?.onResponse?.({ status: response.status, headers: responseHeaders(response) }, model);
  if (response.redirected) throw new PublicImageError("Image provider redirects are not accepted", "provider_error");
  if (!response.ok) {
    const kind = response.status === 401 || response.status === 403 ? "authentication" :
      response.status === 429 ? "quota" : "request";
    throw new PublicImageError(`Image provider ${kind} failed (HTTP ${response.status})`, "provider_error");
  }
  return readJsonResponse(response, options?.signal);
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const number = (value) => Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
  const inclusiveCache = number(raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens);
  const input = Math.max(0, number(raw.input_tokens ?? raw.promptTokenCount ?? raw.prompt_tokens) - inclusiveCache);
  const output = number(raw.output_tokens ?? raw.candidatesTokenCount ?? raw.completion_tokens);
  const cacheRead = inclusiveCache || number(raw.cachedContentTokenCount);
  const totalTokens = number(raw.total_tokens ?? raw.totalTokenCount) || input + output + cacheRead;
  if (totalTokens === 0) return undefined;
  return { input, output, cacheRead, cacheWrite: 0, totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function contextParts(context) {
  const input = Array.isArray(context?.input) ? context.input : [];
  const text = input.filter((part) => part?.type === "text").map((part) => part.text).join("\n\n").trim();
  const images = input.filter((part) => part?.type === "image");
  if (!text) throw new PublicImageError("An image prompt is required", "invalid_input");
  return { text, images };
}

export function buildOpenAIImageRequest(context, controls, routingModel = DEFAULT_OPENAI_ROUTING_MODEL) {
  const { text, images } = contextParts(context);
  const content = [{ type: "input_text", text }, ...images.map((image) => ({
    type: "input_image",
    image_url: `data:${image.mimeType};base64,${image.data}`,
  }))];
  const tool = {
    type: "image_generation",
    output_format: controls.format,
    size: controls.size,
    quality: controls.quality,
    background: controls.background,
    partial_images: 0,
  };
  return {
    model: routingModel,
    instructions: "Generate exactly one requested image with the image_generation tool. Do not answer with text unless image generation fails.",
    input: [{ type: "message", role: "user", content }],
    tools: [tool],
    tool_choice: { type: "image_generation" },
    stream: false,
    store: false,
    metadata: { operation: "image_generation" },
  };
}

export function buildGeminiImageRequest(context, controls) {
  const { text, images } = contextParts(context);
  return {
    contents: [{
      role: "user",
      parts: [{ text }, ...images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } }))],
    }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { imageSize: controls.size },
    },
  };
}

function openAIOutput(data, mimeType) {
  const output = Array.isArray(data?.output) ? data.output : [];
  const images = output.filter((item) => item?.type === "image_generation_call" && typeof item.result === "string")
    .map((item) => ({ type: "image", data: item.result, mimeType }));
  if (images.length !== 1) throw new PublicImageError("Image provider did not return exactly one image", "invalid_response");
  return images;
}

function geminiOutput(data) {
  const response = data?.response && typeof data.response === "object" ? data.response : data;
  const parts = Array.isArray(response?.candidates?.[0]?.content?.parts) ? response.candidates[0].content.parts : [];
  const images = parts.filter((part) => part?.inlineData && typeof part.inlineData.data === "string")
    .map((part) => ({ type: "image", data: part.inlineData.data, mimeType: cleanString(part.inlineData.mimeType).toLowerCase() }));
  if (images.length !== 1 || !images[0].mimeType) throw new PublicImageError("Image provider did not return exactly one typed image", "invalid_response");
  return { images, response };
}

export function createOpenAIImageImplementation({ routingModel = DEFAULT_OPENAI_ROUTING_MODEL } = {}) {
  return {
    async generateImages(model, context, options = {}) {
      try {
        const controls = validateGenerationControls(OPENAI_IMAGE_API, options.metadata?.monikaImageControls ?? {});
        const data = await postJson(model, buildOpenAIImageRequest(context, controls, routingModel), options, "/v1/responses");
        return assistantImages(model, {
          output: openAIOutput(data, `image/${controls.format}`),
          stopReason: "stop",
          responseId: cleanString(data?.id) || undefined,
          usage: normalizeUsage(data?.usage),
        });
      } catch (error) {
        if (isAbort(error, options.signal)) return assistantImages(model, { stopReason: "aborted", errorMessage: "Image generation aborted" });
        return assistantImages(model, { stopReason: "error", errorMessage: safeErrorMessage(error) });
      }
    },
  };
}

export function createGeminiImageImplementation({ wireModel = DEFAULT_GEMINI_WIRE_MODEL } = {}) {
  if (!/^[A-Za-z0-9._/-]+$/u.test(wireModel) || wireModel.split("/").includes("..")) {
    throw new PublicImageError("Gemini image routing model is invalid", "configuration");
  }
  return {
    async generateImages(model, context, options = {}) {
      try {
        const controls = validateGenerationControls(GEMINI_IMAGE_API, options.metadata?.monikaImageControls ?? {});
        const data = await postJson(
          model,
          buildGeminiImageRequest(context, controls),
          options,
          `/v1beta/models/${wireModel}:generateContent`,
        );
        const { images, response } = geminiOutput(data);
        return assistantImages(model, {
          output: images,
          stopReason: "stop",
          responseId: cleanString(response?.responseId) || undefined,
          usage: normalizeUsage(response?.usageMetadata),
        });
      } catch (error) {
        if (isAbort(error, options.signal)) return assistantImages(model, { stopReason: "aborted", errorMessage: "Image generation aborted" });
        return assistantImages(model, { stopReason: "error", errorMessage: safeErrorMessage(error) });
      }
    },
  };
}

function cloneDefined(target, source, keys) {
  for (const key of keys) if (source[key] !== undefined) target[key] = source[key];
  return target;
}

export function modelToProviderDefinition(model) {
  const base = cloneDefined({
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    input: [...model.input],
    cost: { ...model.cost },
  }, model, ["inputLimits", "headers"]);
  if (model.type === "image") return { ...base, type: "image", output: [...model.output] };
  if (model.type === "classifier") return { ...base, type: "classifier", contextWindow: model.contextWindow };
  return cloneDefined({
    ...base,
    type: "chat",
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }, model, ["thinkingLevelMap", "promptCache", "samplingParams", "samplingParamsByThinkingLevel", "compat"]);
}

function providerSnapshot(registry, provider) {
  return ["chat", "image", "classifier"].flatMap((type) =>
    [...(registry.getModelsOfType?.(type, provider) ?? [])].map(modelToProviderDefinition));
}

function imageDefinition(provider, id, name, api, baseUrl) {
  return { type: "image", id, name, api, baseUrl, input: ["text", "image"], output: ["image"], cost: { ...EMPTY_COST } };
}

export function installPoolImageProviders({ registerProvider, registry, env = process.env }) {
  const installed = [];
  const configurations = [
    {
      provider: "codex",
      id: OPENAI_IMAGE_MODEL_ID,
      api: OPENAI_IMAGE_API,
      name: "OpenAI image generation (pool native)",
      preferredChat: cleanString(env.MONIKA_IMAGE_OPENAI_ROUTING_MODEL) || DEFAULT_OPENAI_ROUTING_MODEL,
      implementation: createOpenAIImageImplementation({ routingModel: cleanString(env.MONIKA_IMAGE_OPENAI_ROUTING_MODEL) || DEFAULT_OPENAI_ROUTING_MODEL }),
    },
    {
      provider: "antigravity",
      id: GEMINI_IMAGE_MODEL_ID,
      api: GEMINI_IMAGE_API,
      name: "Gemini 3.1 Flash Image (pool native)",
      preferredChat: null,
      implementation: createGeminiImageImplementation({ wireModel: cleanString(env.MONIKA_IMAGE_GEMINI_WIRE_MODEL) || DEFAULT_GEMINI_WIRE_MODEL }),
    },
  ];
  for (const config of configurations) {
    const snapshot = providerSnapshot(registry, config.provider);
    const chatModels = snapshot.filter((model) => model.type === "chat");
    if (chatModels.length === 0) continue;
    const base = chatModels.find((model) => model.id === config.preferredChat) ?? chatModels[0];
    const models = snapshot.filter((model) => !(model.type === "image" && model.id === config.id));
    models.push(imageDefinition(config.provider, config.id, config.name, config.api, base.baseUrl));
    registerProvider(config.provider, { models, images: { [config.api]: config.implementation } });
    installed.push(`${config.provider}/${config.id}`);
  }
  return installed;
}

async function exactFile(path, maxBytes, label = "File") {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new PublicImageError(`${label} path is not a regular file`, "invalid_reference");
    if (info.size <= 0) throw new PublicImageError(`${label} is empty`, "invalid_reference");
    if (info.size > maxBytes) throw new PublicImageError(`${label} must be at most ${maxBytes / 1024 / 1024} MiB`, "invalid_reference");
    const bytes = await handle.readFile();
    if (bytes.byteLength !== info.size || bytes.byteLength > maxBytes) throw new PublicImageError(`${label} changed while it was read`, "invalid_reference");
    return bytes;
  } finally { await handle.close(); }
}

export async function readReferenceImages(paths, cwd) {
  if (paths === undefined) return [];
  if (!Array.isArray(paths)) throw new PublicImageError("reference_paths must be an array", "invalid_reference");
  if (paths.length > MAX_REFERENCE_COUNT) throw new PublicImageError(`At most ${MAX_REFERENCE_COUNT} reference images are allowed`, "invalid_reference");
  const images = [];
  let total = 0;
  for (const value of paths) {
    if (typeof value !== "string" || !value.trim()) throw new PublicImageError("Reference paths must be non-empty strings", "invalid_reference");
    const path = resolve(cwd, value.startsWith("@") ? value.slice(1) : value);
    const bytes = await exactFile(path, MAX_REFERENCE_BYTES, "Reference image");
    total += bytes.byteLength;
    if (total > MAX_REFERENCE_TOTAL_BYTES) throw new PublicImageError(`Reference images must total at most ${MAX_REFERENCE_TOTAL_BYTES / 1024 / 1024} MiB`, "invalid_reference");
    const metadata = inspectImageBytes(bytes);
    images.push({ type: "image", data: bytes.toString("base64"), mimeType: metadata.mimeType });
  }
  return images;
}

function parseModelReference(reference) {
  const value = cleanString(reference);
  const slash = value.indexOf("/");
  return slash > 0 ? { provider: value.slice(0, slash), id: value.slice(slash + 1) } : { provider: null, id: value };
}

export function selectImageModel(registry, { backend, model } = {}, env = process.env) {
  const models = [...(registry.getModelsOfType?.("image") ?? [])];
  const backendName = cleanString(backend).toLowerCase() || cleanString(env.MONIKA_IMAGE_DEFAULT_BACKEND).toLowerCase() || "openai";
  const providers = { openai: "codex", gemini: "antigravity" };
  if (!providers[backendName]) throw new PublicImageError("Image backend must be openai or gemini", "invalid_input");
  if (cleanString(model)) {
    const parsed = parseModelReference(model);
    const matches = models.filter((candidate) => candidate.id === parsed.id && (!parsed.provider || candidate.provider === parsed.provider));
    if (matches.length !== 1) throw new PublicImageError(matches.length ? "Image model reference is ambiguous" : "Requested image model is not registered", "unavailable");
    if (cleanString(backend) && matches[0].provider !== providers[backendName]) throw new PublicImageError("Image backend and model select different providers", "invalid_input");
    return matches[0];
  }
  const defaultId = backendName === "openai" ? OPENAI_IMAGE_MODEL_ID : GEMINI_IMAGE_MODEL_ID;
  const selected = models.find((candidate) => candidate.provider === providers[backendName] && candidate.id === defaultId);
  if (!selected) throw new PublicImageError(`The ${backendName} image backend is not registered`, "unavailable");
  return selected;
}

async function preflightOutputPath(outputPath, cwd) {
  if (!cleanString(outputPath)) return;
  const path = resolve(cwd, outputPath);
  try {
    await lstat(path);
    throw new PublicImageError("Image output path already exists; refusing to overwrite it", "output_exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try { await access(dirname(path), fsConstants.W_OK); }
  catch { throw new PublicImageError("Image output directory is unavailable or not writable", "output_error"); }
}

async function saveImage(bytes, metadata, cwd, outputPath, generationId, env) {
  const extension = MIME_EXTENSIONS[metadata.mimeType];
  let path;
  if (cleanString(outputPath)) {
    path = resolve(cwd, outputPath);
  } else {
    const root = env.MONIKA_IMAGE_TEMP_DIR ?? "/tmp/monika-generated-images";
    await mkdir(root, { recursive: true, mode: 0o700 });
    path = resolve(root, `generated-${generationId}${extension}`);
  }
  const handle = await open(path, "wx", 0o600).catch((error) => {
    if (error?.code === "EEXIST") throw new PublicImageError("Image output path already exists; refusing to overwrite it", "output_exists");
    throw error;
  });
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
  } catch (error) {
    await handle.close().catch(() => {});
    await import("node:fs/promises").then(({ unlink }) => unlink(path).catch(() => {}));
    throw error;
  }
  await handle.close();
  return path;
}

function generatedEntry(entries, generationId) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const data = entry?.data;
    if (entry?.type === "custom" && entry.customType === "monika.image.generated" && data?.version === 1 && data.generationId === generationId) return data;
  }
  return null;
}

function latestPublication(entries, generationId) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "custom" && entry.customType === "monika.image.publication" &&
        entry.data?.version === 1 && entry.data.generationId === generationId) return entry.data;
  }
  return null;
}

async function recoverGeneratedImage(data) {
  if (!data || typeof data.path !== "string" || !Number.isSafeInteger(data.sizeBytes) ||
      !/^[a-f0-9]{64}$/u.test(data.sha256 ?? "") || !MIME_EXTENSIONS[data.mimeType]) {
    throw new PublicImageError("Generated image recovery metadata is invalid", "recovery_error");
  }
  const bytes = await exactFile(data.path, MAX_OUTPUT_BYTES, "Saved generated image");
  if (bytes.byteLength !== data.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== data.sha256) {
    throw new PublicImageError("Saved generated image no longer matches its durable metadata", "recovery_error");
  }
  const metadata = inspectImageBytes(bytes, data.mimeType);
  return { bytes, metadata };
}

function publicationError(error, signal) {
  if (isAbort(error, signal)) throw (abortReason(signal) ?? error);
  if (error instanceof PublicImageError) return error.message;
  if (/Forum attachment upload failed: (401|403)\b/u.test(error?.message ?? "")) return "Forum image publication authentication failed";
  if (/Forum attachment upload failed: 4\d\d\b/u.test(error?.message ?? "")) return "Forum rejected image publication";
  return "Forum image publication failed";
}

async function publishGenerated({ record, bytes, metadata, sessionManager, signal, env, upload = uploadForumAttachment }) {
  if (!record.topicId) return { published: false, refEntryId: null };
  try {
    const uploaded = await upload({
      topicId: record.topicId,
      bytes,
      filename: basename(record.path),
      mimeType: metadata.mimeType,
      sessionManager,
      signal,
      env,
    });
    sessionManager.appendCustomEntry("monika.image.publication", {
      version: 1, generationId: record.generationId, state: "published", refEntryId: uploaded.refEntryId,
    });
    return { published: true, refEntryId: uploaded.refEntryId };
  } catch (error) {
    const message = publicationError(error, signal);
    sessionManager.appendCustomEntry("monika.image.publication", {
      version: 1, generationId: record.generationId, state: "failed", error: message,
    });
    throw new PublicImageError(`${message}. Saved output ${record.path} is recoverable with retry_generation_id=${record.generationId}`, "publication_error");
  }
}

export async function runImageGeneration(input, {
  registry,
  sessionManager,
  cwd,
  signal,
  env = process.env,
  upload,
} = {}) {
  const retryGenerationId = cleanString(input?.retry_generation_id);
  if (retryGenerationId) {
    const branch = sessionManager.getBranch();
    const record = generatedEntry(branch, retryGenerationId);
    if (!record) throw new PublicImageError("No recoverable generated image has that retry_generation_id", "recovery_error");
    if (latestPublication(branch, retryGenerationId)?.state === "published") {
      throw new PublicImageError("That generated image is already published", "recovery_error");
    }
    const topic = currentCanonicalForumTopic(branch);
    if (!topic || topic.topicId !== record.topicId) {
      throw new PublicImageError("Image publication recovery requires a current forum turn in the original topic", "recovery_error");
    }
    const { bytes, metadata } = await recoverGeneratedImage(record);
    const publication = await publishGenerated({ record, bytes, metadata, sessionManager, signal, env, upload });
    return { record, metadata, publication, recovered: true };
  }

  const prompt = cleanString(input?.prompt);
  if (!prompt) throw new PublicImageError("An image prompt is required", "invalid_input");
  if (prompt.length > MAX_PROMPT_CHARS) throw new PublicImageError(`Image prompt exceeds ${MAX_PROMPT_CHARS} characters`, "invalid_input");
  const model = selectImageModel(registry, input, env);
  const controls = validateGenerationControls(model.api, input);
  await preflightOutputPath(input.output_path, cwd);
  const references = await readReferenceImages(input.reference_paths, cwd);
  const result = await registry.generateImages(model, {
    input: [{ type: "text", text: prompt }, ...references],
  }, {
    signal,
    metadata: { monikaImageControls: controls },
  });
  if (result?.stopReason === "aborted" || signal?.aborted) throw (abortReason(signal) ?? new DOMException("Aborted", "AbortError"));
  if (result?.stopReason !== "stop") throw new PublicImageError("Image provider did not complete generation", "provider_error");
  const imageBlocks = Array.isArray(result.output) ? result.output.filter((block) => block?.type === "image") : [];
  if (imageBlocks.length !== 1) throw new PublicImageError("Image provider did not return exactly one image", "invalid_response");
  const { bytes, metadata } = decodeGeneratedImage(imageBlocks[0].data, imageBlocks[0].mimeType);
  const generationId = randomUUID();
  let path;
  let warning;
  try {
    path = await saveImage(bytes, metadata, cwd, input.output_path, generationId, env);
  } catch {
    if (!cleanString(input.output_path)) {
      throw new PublicImageError("Image was generated but local custody failed; do not automatically regenerate", "output_error");
    }
    try { path = await saveImage(bytes, metadata, cwd, undefined, generationId, env); }
    catch { throw new PublicImageError("Image was generated but both requested and temporary storage failed; do not automatically regenerate", "output_error"); }
    warning = "Requested output path could not be saved; image retained in temporary custody instead";
  }
  const topic = currentCanonicalForumTopic(sessionManager.getBranch());
  const record = {
    version: 1,
    generationId,
    path,
    mimeType: metadata.mimeType,
    sizeBytes: bytes.byteLength,
    width: metadata.width,
    height: metadata.height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    provider: model.provider,
    model: model.id,
    backend: model.api === OPENAI_IMAGE_API ? "openai" : model.api === GEMINI_IMAGE_API ? "gemini" : "other",
    topicId: topic?.topicId ?? null,
    ...(warning ? { warning } : {}),
    createdAt: new Date().toISOString(),
  };
  sessionManager.appendCustomEntry("monika.image.generated", record);
  const publication = await publishGenerated({ record, bytes, metadata, sessionManager, signal, env, upload });
  return { record, metadata, publication, recovered: false, usage: result.usage };
}

export function formatImageToolResult(result) {
  const { record, metadata, publication, recovered } = result;
  const action = recovered ? (publication.published ? "Recovered and published" : "Recovered") : "Generated";
  const publicationText = publication.published ? " It was attached to the current forum response." : "";
  return {
    content: [{ type: "text", text: `${action} image at ${record.path} (${metadata.mimeType}, ${metadata.width}x${metadata.height}, ${record.sizeBytes} bytes).${publicationText}${record.warning ? ` Warning: ${record.warning}.` : ""}` }],
    details: {
      generationId: record.generationId,
      path: record.path,
      mimeType: metadata.mimeType,
      sizeBytes: record.sizeBytes,
      width: metadata.width,
      height: metadata.height,
      sha256: record.sha256,
      provider: record.provider,
      model: record.model,
      backend: record.backend,
      forumPublished: publication.published,
      recovered,
    },
    ...(result.usage ? { usage: result.usage } : {}),
  };
}
