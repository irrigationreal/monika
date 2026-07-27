import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRelevantExcerpt,
  joinWithinBudget,
  selectDiverseSessionEntries,
  truncateCharactersSafe,
} from "../../config/extensions/stateful-memory/recall-utils.js";

test("session result diversity prefers trunk sessions and limits delegates", () => {
  const entries = [
    { id: 1, depth: 3, tags: ["delegate"] },
    { id: 2, depth: 2, tags: [], origin: "/app/.pi/agent/sessions/forks/legacy.jsonl" },
    { id: 3, depth: 2, tags: ["project"] },
    { id: 4, depth: 2, tags: ["project"] },
    { id: 5, depth: 2, tags: ["project"] },
    { id: 6, depth: 2, tags: ["project"] },
  ];
  assert.deepEqual(
    selectDiverseSessionEntries(entries, 5).map((entry) => entry.id),
    [1, 3, 4, 5, 6],
  );
});

test("delegate sessions fill results when they are the only matches", () => {
  const entries = Array.from({ length: 6 }, (_, index) => ({
    id: index + 1,
    depth: 3,
    tags: ["delegate"],
  }));
  assert.equal(selectDiverseSessionEntries(entries, 5).length, 5);
});

test("relevant excerpt is bounded and starts near a query match", () => {
  const body = `${"opening filler ".repeat(500)}MLS convergence decision${" trailing detail".repeat(500)}MLS convergence followup`;
  const excerpt = buildRelevantExcerpt(body, {
    query: "Vesper MLS convergence",
    maxChars: 3000,
  });
  assert.ok(excerpt.text.includes("MLS convergence decision"));
  assert.ok(excerpt.text.length <= 3000);
  assert.equal(excerpt.truncated, true);
  assert.ok(excerpt.nextOffset > 0);
});

test("case folding before a match does not corrupt source offsets", () => {
  const body = `İ${"filler ".repeat(200)}needle and context`;
  const excerpt = buildRelevantExcerpt(body, { query: "needle", maxChars: 2500 });
  assert.equal(excerpt.sourceRanges[0].start, body.indexOf("needle") - 900);
  assert.ok(excerpt.text.includes("needle and context"));
});

test("excerpt matching tolerates Porter-style surface-form differences", () => {
  const body = `${"filler ".repeat(500)}We decide the architecture here.${" tail".repeat(500)}`;
  const excerpt = buildRelevantExcerpt(body, { query: "decisions", maxChars: 2500 });
  assert.ok(excerpt.text.includes("We decide the architecture here."));
});

test("query continuation preserves the tail of a partially emitted match window", () => {
  const body = `${"before ".repeat(300)}needle${" after-match context".repeat(300)}`;
  const first = buildRelevantExcerpt(body, { query: "needle", maxChars: 1000 });
  assert.ok(first.nextOffset > 0);
  const second = buildRelevantExcerpt(body, {
    query: "needle",
    offset: first.nextOffset,
    maxChars: 1000,
  });
  assert.equal(second.sourceRanges[0].start, first.nextOffset);
  assert.ok(second.text.includes("after-match context"));
});

test("match caps expose a continuation offset instead of falsely reporting completion", () => {
  const body = `${"needle ".repeat(100)}${"distant gap ".repeat(500)}needle later`;
  const excerpt = buildRelevantExcerpt(body, { query: "needle", maxChars: 12000 });
  assert.equal(excerpt.truncated, true);
  assert.ok(excerpt.nextOffset > 0);
});

test("offset paginates a transcript when no query is supplied", () => {
  const body = "0123456789".repeat(500);
  const first = buildRelevantExcerpt(body, { maxChars: 1000 });
  const second = buildRelevantExcerpt(body, { offset: first.nextOffset, maxChars: 1000 });
  assert.equal(first.text.length, 1000);
  assert.equal(second.text, body.slice(1000, 2000));
});

test("pagination never splits an astral Unicode code point", () => {
  const body = `${"a".repeat(999)}😀${"b".repeat(2000)}`;
  const first = buildRelevantExcerpt(body, { maxChars: 1000 });
  const second = buildRelevantExcerpt(body, { offset: first.nextOffset, maxChars: 1000 });
  assert.equal(first.text, "a".repeat(999));
  assert.ok(second.text.startsWith("😀"));
  assert.ok(!first.text.includes("�") && !second.text.includes("�"));
});

test("full retrieval requires the explicit flag and still respects Pi's output ceiling", () => {
  const body = "x".repeat(100000);
  assert.equal(buildRelevantExcerpt(body, { maxChars: 8000 }).text.length, 8000);
  const full = buildRelevantExcerpt(body, { full: true });
  assert.ok(Buffer.byteLength(full.text, "utf8") <= 45 * 1024);
  assert.equal(full.truncated, true);
  assert.ok(full.nextOffset > 0);
});

test("compact character truncation preserves astral Unicode", () => {
  const value = `${"a".repeat(796)}😀tail`;
  const truncated = truncateCharactersSafe(value, 800);
  assert.ok(!truncated.includes("�"));
  assert.ok(!/[\uD800-\uDBFF]$/.test(truncated.slice(0, -3)));
});

test("enrichment sections obey a hard aggregate budget", () => {
  const joined = joinWithinBudget(["a".repeat(400), "b".repeat(400)], 600);
  assert.ok(joined.length <= 600);
  assert.ok(joined.includes("(truncated)"));
  assert.ok(joinWithinBudget(["long section"], 5).length <= 5);
  const unicode = joinWithinBudget(["界".repeat(1000)], 100);
  assert.ok(Buffer.byteLength(unicode, "utf8") <= 100);
});
