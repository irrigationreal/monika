import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const ID = /^[0-9a-f-]{36}$/;
const ALLOWED_TYPES = new Set(["transcript", "status", "usage", "error", "interruption"]);
const MAX_EVENT_BYTES = 16 * 1024;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class VoiceRecords {
  constructor({ dir, maxAgeMs, maxFiles, maxTotalBytes } = {}) {
    if (!dir || !path.isAbsolute(dir)) throw new Error("VOICE_STATE_DIR must be an absolute path");
    this.dir = dir;
    this.maxAgeMs = positiveInteger(maxAgeMs, 7 * 24 * 60 * 60 * 1000);
    this.maxFiles = positiveInteger(maxFiles, 50);
    this.maxTotalBytes = positiveInteger(maxTotalBytes, 20 * 1024 * 1024);
    this.mutations = Promise.resolve();
  }

  mutate(operation) {
    const result = this.mutations.then(operation, operation);
    this.mutations = result.catch(() => {});
    return result;
  }

  async initialize() {
    await this.mutate(async () => {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(this.dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("voice state path must be a real directory");
      await fs.chmod(this.dir, 0o700);
      await this.pruneUnlocked();
    });
  }

  file(id) {
    if (!ID.test(id)) return null;
    return path.join(this.dir, `${id}.jsonl`);
  }

  async inventory() {
    const entries = [];
    for (const name of await fs.readdir(this.dir)) {
      if (!name.endsWith(".jsonl") || !ID.test(name.slice(0, -6))) continue;
      const file = path.join(this.dir, name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      entries.push({ id: name.slice(0, -6), file, size: stat.size, created_at: stat.birthtime.toISOString(), mtimeMs: stat.mtimeMs });
    }
    return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  async pruneUnlocked(now = Date.now(), { protectId = null, extraBytes = 0 } = {}) {
    const entries = await this.inventory();
    if (protectId) entries.sort((left, right) => Number(right.id === protectId) - Number(left.id === protectId) || right.mtimeMs - left.mtimeMs);
    let retainedBytes = 0;
    let retainedFiles = 0;
    for (const entry of entries) {
      const effectiveSize = entry.size + (entry.id === protectId ? extraBytes : 0);
      const expired = now - entry.mtimeMs > this.maxAgeMs && entry.id !== protectId;
      const overCount = retainedFiles >= this.maxFiles;
      const overBytes = retainedBytes + effectiveSize > this.maxTotalBytes;
      if (expired || overCount || overBytes) await fs.unlink(entry.file);
      else {
        retainedFiles += 1;
        retainedBytes += effectiveSize;
      }
    }
  }

  async prune(now = Date.now()) {
    return this.mutate(() => this.pruneUnlocked(now));
  }

  async create() {
    return this.mutate(async () => {
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const line = JSON.stringify({ type: "voice_session", version: 1, id, created_at: createdAt, experimental: true, canonical: false }) + "\n";
      if (Buffer.byteLength(line) > this.maxTotalBytes) throw new Error("record has reached the retention byte limit");
      await fs.writeFile(this.file(id), line, { flag: "wx", mode: 0o600 });
      await this.pruneUnlocked(Date.now(), { protectId: id });
      return { id, created_at: createdAt };
    });
  }

  async append(id, input) {
    const file = this.file(id);
    if (!file) return false;
    if (!input || typeof input !== "object" || Array.isArray(input) || !ALLOWED_TYPES.has(input.type)) throw new Error("unsupported record event type");
    const event = { ...input, at: new Date().toISOString() };
    delete event.id;
    const line = JSON.stringify(event);
    const lineBytes = Buffer.byteLength(line) + 1;
    if (lineBytes > MAX_EVENT_BYTES) throw new Error("record event is too large");
    return this.mutate(async () => {
      let stat;
      try { stat = await fs.lstat(file); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      if (stat.size + lineBytes > this.maxTotalBytes) throw new Error("record has reached the retention byte limit");
      await this.pruneUnlocked(Date.now(), { protectId: id, extraBytes: lineBytes });
      try { stat = await fs.lstat(file); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      await fs.appendFile(file, `${line}\n`, { encoding: "utf8", mode: 0o600 });
      return true;
    });
  }

  async list() {
    return this.mutate(async () => {
      await this.pruneUnlocked();
      return (await this.inventory()).map(({ id, size, created_at }) => ({ id, size, created_at }));
    });
  }

  async read(id) {
    const file = this.file(id);
    if (!file) return null;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxTotalBytes) return null;
      return await fs.readFile(file);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(id) {
    const file = this.file(id);
    if (!file) return false;
    return this.mutate(async () => {
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) return false;
        await fs.unlink(file);
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    });
  }
}
