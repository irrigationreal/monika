import assert from "node:assert/strict";
import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VoiceRecords } from "../src/records.mjs";

async function fixture(t, limits) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "voice-records-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const records = new VoiceRecords({ dir, ...limits });
  await records.initialize();
  return records;
}

function totalBytes(entries) {
  return entries.reduce((total, entry) => total + entry.size, 0);
}

test("record retention is enforced by count and age at every create", async (t) => {
  const records = await fixture(t, { maxFiles: 2, maxAgeMs: 1000, maxTotalBytes: 1024 * 1024 });
  const expired = await records.create();
  await utimes(records.file(expired.id), new Date(0), new Date(0));
  await records.create();
  assert.equal((await records.inventory()).some((entry) => entry.id === expired.id), false);

  for (let index = 0; index < 8; index += 1) {
    await records.create();
    assert.equal((await records.inventory()).length <= 2, true);
  }
});

test("concurrent creates are serialized and never leave more than maxFiles", async (t) => {
  const records = await fixture(t, { maxFiles: 3, maxAgeMs: 60_000, maxTotalBytes: 1024 * 1024 });
  await Promise.all(Array.from({ length: 20 }, () => records.create()));
  assert.equal((await records.inventory()).length, 3);
});

test("concurrent appends enforce aggregate bytes and protect the appended record when possible", async (t) => {
  const maxTotalBytes = 900;
  const records = await fixture(t, { maxFiles: 10, maxAgeMs: 60_000, maxTotalBytes });
  const created = await Promise.all([records.create(), records.create(), records.create()]);
  await Promise.allSettled(Array.from({ length: 12 }, (_, index) => records.append(created[index % created.length].id, {
    type: "transcript",
    role: "user",
    text: `event-${index}-${"x".repeat(120)}`,
  })));
  const inventory = await records.inventory();
  assert.equal(inventory.length <= 10, true);
  assert.equal(totalBytes(inventory) <= maxTotalBytes, true);
});

test("an event that would exceed its record byte limit is rejected without changing the file", async (t) => {
  const records = await fixture(t, { maxFiles: 5, maxAgeMs: 60_000, maxTotalBytes: 500 });
  const created = await records.create();
  const before = (await stat(records.file(created.id))).size;
  await assert.rejects(records.append(created.id, { type: "transcript", text: "x".repeat(600) }), /record has reached the retention byte limit/);
  assert.equal((await stat(records.file(created.id))).size, before);
});
