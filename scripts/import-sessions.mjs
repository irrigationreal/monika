#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const { MemstoreClient } = await import(
  path.join(repoRoot, "config/extensions/stateful-memory/memstore-client.js")
);
const { readSessionJsonl } = await import(
  path.join(repoRoot, "config/extensions/stateful-memory/session-utils.js")
);
const { slugifyKeywords } = await import(
  path.join(repoRoot, "config/extensions/stateful-memory/memory-store.js")
);

const importRoot = process.argv[2] || process.env.MONIKA_IMPORT_SESSIONS || "/import/sessions";
const maxChars = Number(process.env.MONIKA_IMPORT_MAX_CHARS || 200000);
const dryRun = process.argv.includes("--dry-run");

function determineSessionTags(text) {
  const tags = new Set();
  const lc = text.toLowerCase();
  if (lc.includes("zeta") || lc.includes("novel") || lc.includes("fiir") || lc.includes("kalte")) tags.add("zeta-directive");
  if (lc.includes("vesper") || lc.includes("mls") || lc.includes("e2ee")) tags.add("vesper");
  if (lc.includes("nixos") || lc.includes("stanza") || lc.includes("shadowsea") || lc.includes("hetzner")) tags.add("infrastructure");
  if (lc.includes("monika-core") || lc.includes("gateway") || lc.includes("aroz") || lc.includes("monika")) tags.add("monika");
  if (lc.includes("music") || lc.includes("demucs") || lc.includes("midi") || lc.includes("piano")) tags.add("creative");
  if (lc.includes("security") || lc.includes("cve") || lc.includes("vulnerability") || lc.includes("exploit") || lc.includes("xss")) tags.add("security");
  if (tags.size === 0) tags.add("general");
  tags.add("historical-import");
  return [...tags];
}

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      yield fullPath;
    }
  }
}

async function readSessionHeader(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const firstLine = raw.split("\n").find(Boolean);
  if (!firstLine) return {};
  try {
    const parsed = JSON.parse(firstLine);
    return parsed?.type === "session" ? parsed : {};
  } catch {
    return {};
  }
}

function dateFromFilename(filePath) {
  const base = path.basename(filePath);
  const match = base.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_/);
  if (!match) return null;
  return match[1]
    .replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
}

async function waitForQueue(client) {
  for (;;) {
    const status = await client.queueStatus();
    const depth = status?.queue_depth ?? 0;
    if (depth === 0) return;
    process.stdout.write(`\r[memstore-import] waiting for queue: ${depth}   `);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const files = [];
for await (const file of walk(importRoot)) files.push(file);

console.log(`[memstore-import] found ${files.length} JSONL session(s) under ${importRoot}`);
if (dryRun) {
  for (const file of files) console.log(path.relative(importRoot, file));
  process.exit(0);
}

const client = new MemstoreClient({ socketPath: process.env.MEMSTORE_SOCKET || "/tmp/memstore.sock" });
await client.connect();

let submitted = 0;
let skipped = 0;
for (const file of files) {
  const transcript = await readSessionJsonl(file, { maxChars });
  if (!transcript || transcript.length < 200) {
    skipped += 1;
    continue;
  }

  const header = await readSessionHeader(file);
  const date = header.timestamp || dateFromFilename(file) || new Date().toISOString();
  const rel = path.relative(importRoot, file);
  const body = `# Date: ${new Date(date).toISOString()}\n\n${transcript}`;
  const origin = `historical-session:${rel}`;
  const tags = determineSessionTags(transcript);
  const title = slugifyKeywords(transcript, 8);

  await client.submitSave({ body, origin, tags, title, depth: 2 });
  submitted += 1;

  if (submitted % 25 === 0) {
    console.log(`[memstore-import] submitted ${submitted}/${files.length}`);
    await waitForQueue(client);
  }
}

await waitForQueue(client);
client.close();
console.log(`\n[memstore-import] done: submitted=${submitted}, skipped=${skipped}`);
