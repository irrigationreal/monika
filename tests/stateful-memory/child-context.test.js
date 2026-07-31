import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildMonikaChildContext,
  buildSpecialistChildContext,
} from "../../config/extensions/stateful-memory/child-context.js";
import specialistExtension, { SPECIALIST_MEMORY_BOUNDARY } from "../../config/extensions/stateful-memory/specialist-child-context.js";
import monikaExtension from "../../config/extensions/stateful-memory/monika-child-context.js";
import { registerReadonlyRecallTools } from "../../config/extensions/stateful-memory/readonly-recall.js";
import subagentGuidance, { SUBAGENT_GUIDANCE } from "../../config/extensions/subagent-guidance.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const AGENTS_DIR = path.join(REPO_ROOT, "config", "agents");
const FORBIDDEN_PROFILE_NAMES = ["SLEEP.md", "WAKE.md", "FACTS.md", "OBSERVATIONS.md"];
const READONLY_MEMORY_TOOLS = ["recall", "recall_session"];
const MUTATING_MEMORY_TOOLS = [
  "remember", "remember_session", "correct_observation", "retract_observation", "sleep",
];

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "monika-child-context-"));
  const topicsDir = path.join(dir, "persona_topics");
  await fs.mkdir(topicsDir);
  await fs.writeFile(path.join(dir, "PERSONALITY_MATRIX.md"), `---\n{"topics":[{"id":"literature","file":"persona_topics/literature.md","triggers":["poetry","novel","writing"],"scope":["system"],"priority":2}]}\n---\n# Router\n`);
  await fs.writeFile(path.join(topicsDir, "literature.md"), "# Literature\n\nTOPIC_SENTINEL: precise prose craft.\n");
  await fs.writeFile(path.join(dir, "SOUL.md"), "# Soul\n\nSOUL_SENTINEL stable identity.\n");
  await fs.writeFile(path.join(dir, "STYLE.md"), "# Style\n\nSTYLE_SENTINEL warm and direct.\n");
  await fs.writeFile(path.join(dir, "REGISTER.md"), "# Register\n\nREGISTER_SENTINEL written craft.\n");
  await fs.writeFile(path.join(dir, "SLEEP.md"), "SLEEP_AUTOBIOGRAPHY_SENTINEL\n");
  await fs.writeFile(path.join(dir, "WAKE.md"), "WAKE_AUTOBIOGRAPHY_SENTINEL\n");
  await fs.writeFile(path.join(dir, "FACTS.md"), "FACTS_MEMORY_SENTINEL\n");
  await fs.writeFile(path.join(dir, "OBSERVATIONS.md"), "OBSERVATIONS_MEMORY_SENTINEL\n");
  return dir;
}

function extensionHarness(extension) {
  const handlers = new Map();
  const tools = [];
  const toolSpecs = [];
  const commands = [];
  extension({
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.push(tool.name); toolSpecs.push(tool); },
    registerCommand(name) { commands.push(name); },
  });
  return { handlers, tools, toolSpecs, commands };
}

function parseFrontmatter(raw) {
  const block = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  return new Map(block.split("\n").map((line) => {
    const index = line.indexOf(":");
    return index < 0 ? [line.trim(), ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
}

test("specialist child gets routed topic context without persona or autobiographical memory", async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const prompt = await buildSpecialistChildContext({
    query: "Review the poetry and writing implementation",
    cwd: dir,
    topicsFile: path.join(dir, "PERSONALITY_MATRIX.md"),
  });
  assert.match(prompt, /TOPIC_SENTINEL/);
  for (const sentinel of ["SOUL_SENTINEL", "STYLE_SENTINEL", "REGISTER_SENTINEL", "AUTOBIOGRAPHY_SENTINEL", "MEMORY_SENTINEL"]) {
    assert.doesNotMatch(prompt, new RegExp(sentinel));
  }
});

test("specialist prompt forbids shell and filesystem bypass of the memory boundary", async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const previous = process.env.PI_CHILD_TOPICS_FILE;
  process.env.PI_CHILD_TOPICS_FILE = path.join(dir, "PERSONALITY_MATRIX.md");
  t.after(() => { if (previous == null) delete process.env.PI_CHILD_TOPICS_FILE; else process.env.PI_CHILD_TOPICS_FILE = previous; });
  const harness = extensionHarness(specialistExtension);
  const result = await harness.handlers.get("before_agent_start")(
    { prompt: "mechanical task", systemPrompt: "base" },
    { cwd: dir },
  );
  assert.match(result.systemPrompt, new RegExp(SPECIALIST_MEMORY_BOUNDARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.systemPrompt, /Do not access memstore/);
  assert.match(result.systemPrompt, /shell or filesystem tools/);
});

test("monika delegate context includes only stable persona trio plus routed topic", async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const prompt = await buildMonikaChildContext({
    query: "Help revise this novel's writing",
    cwd: dir,
    statefulDir: dir,
    topicsFile: path.join(dir, "PERSONALITY_MATRIX.md"),
  });
  for (const sentinel of ["SOUL_SENTINEL", "STYLE_SENTINEL", "REGISTER_SENTINEL", "TOPIC_SENTINEL"]) {
    assert.match(prompt, new RegExp(sentinel));
  }
  for (const sentinel of ["SLEEP_AUTOBIOGRAPHY_SENTINEL", "WAKE_AUTOBIOGRAPHY_SENTINEL", "FACTS_MEMORY_SENTINEL", "OBSERVATIONS_MEMORY_SENTINEL"]) {
    assert.doesNotMatch(prompt, new RegExp(sentinel));
  }
});

test("specialists expose no memory while Monika gets read-only recall without persistence lifecycle", () => {
  const specialist = extensionHarness(specialistExtension);
  assert.deepEqual([...specialist.handlers.keys()], ["before_agent_start", "turn_end"]);
  assert.deepEqual(specialist.tools, []);
  assert.deepEqual(specialist.commands, []);

  const monika = extensionHarness(monikaExtension);
  assert.deepEqual([...monika.handlers.keys()], ["before_agent_start", "turn_end"]);
  assert.deepEqual(monika.tools.sort(), READONLY_MEMORY_TOOLS);
  assert.deepEqual(monika.commands, []);
  for (const forbidden of MUTATING_MEMORY_TOOLS) assert.equal(monika.tools.includes(forbidden), false);
});

test("read-only recall executes only bounded search and show operations", async () => {
  const calls = [];
  const fakeClient = {
    async connect() { calls.push(["connect"]); },
    async search(query, options) {
      calls.push(["search", query, options]);
      return { entries: Array.from({ length: 9 }, (_, index) => ({
        id: index + 1, title: `Session ${index + 1}`, body: "# Date: 2026-01-01\nbody",
        snippet: "snippet", created_at: "2026-01-01", depth: 2, tags: [],
      })) };
    },
    async searchObservations(query, options) {
      calls.push(["searchObservations", query, options]);
      return { observations: [] };
    },
    async show(id) {
      calls.push(["show", id]);
      return { entry: { id, title: "Session", body: "# Date: 2026-01-01\nremembered text", created_at: "2026-01-01", depth: 2, tags: [] } };
    },
  };
  const harness = extensionHarness((pi) => registerReadonlyRecallTools(pi, {
    configLoader: async () => ({
      recallSessionResults: 999,
      recallObservationResults: 999,
      recallSearchMaxBytes: 999_999,
      recallMaxSessionChars: 999_999,
    }),
    clientFactory: () => fakeClient,
  }));
  const recall = harness.toolSpecs.find((tool) => tool.name === "recall");
  const recalled = await recall.execute("call-1", { query: "memory" }, null, null, { cwd: "/tmp" });
  assert.equal(recalled.details.entries.length, 5, "project config cannot exceed the hard session-result ceiling");
  assert.equal(calls.find(([name]) => name === "searchObservations")[2].limit, 3);
  const recallSession = harness.toolSpecs.find((tool) => tool.name === "recall_session");
  const shown = await recallSession.execute("call-2", { id: 7 }, null, null, { cwd: "/tmp" });
  assert.match(shown.content[0].text, /remembered text/);
  assert.deepEqual(calls.map(([name]) => name), ["connect", "search", "searchObservations", "connect", "show"]);
  assert.deepEqual(harness.tools.sort(), READONLY_MEMORY_TOOLS);
});

test("children restore bounded auto compaction without persistence hooks", () => {
  const harness = extensionHarness(monikaExtension);
  const requests = [];
  harness.handlers.get("turn_end")({}, {
    getContextUsage: () => ({ percent: 76 }),
    compact: (options) => requests.push(options),
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0].customInstructions, /delegated task/);
  harness.handlers.get("turn_end")({}, {
    getContextUsage: () => ({ percent: 20 }),
    compact: (options) => requests.push(options),
  });
  harness.handlers.get("turn_end")({}, {
    getContextUsage: () => ({ percent: 76 }),
    compact: (options) => requests.push(options),
  });
  assert.equal(requests.length, 2);
});

test("parent delegation guidance selects roles, modes, identity, and memory boundaries", () => {
  const harness = extensionHarness(subagentGuidance);
  assert.deepEqual([...harness.handlers.keys()], ["before_agent_start"]);
  assert.match(SUBAGENT_GUIDANCE, /benefits materially from Monika's voice/);
  assert.match(SUBAGENT_GUIDANCE, /writing, brainstorming, critique/);
  assert.match(SUBAGENT_GUIDANCE, /foreground/);
  assert.match(SUBAGENT_GUIDANCE, /parallel writers over overlapping files/);
  assert.match(SUBAGENT_GUIDANCE, /no durable-memory mutation API/);
  assert.match(SUBAGENT_GUIDANCE, /must not circumvent that boundary/);
});

test("agent profiles explicitly isolate extensions, memory files, memory tools, and model tiers", async () => {
  const files = (await fs.readdir(AGENTS_DIR)).filter((name) => name.endsWith(".md"));
  assert.deepEqual(files.sort(), ["context-builder.md", "monika-delegate.md", "oracle.md", "planner.md", "researcher.md", "reviewer.md", "scout.md", "worker.md"]);

  for (const file of files) {
    const raw = await fs.readFile(path.join(AGENTS_DIR, file), "utf8");
    const frontmatter = parseFrontmatter(raw);
    assert.equal(frontmatter.get("inheritProjectContext"), "true", file);
    assert.equal(frontmatter.get("inheritSkills"), "false", file);
    assert.equal(frontmatter.get("memory"), undefined, file);
    assert.ok(frontmatter.has("extensions"), `${file} must explicitly control normal extensions`);
    assert.match(frontmatter.get("subagentOnlyExtensions") ?? "", /stateful-memory\/(specialist|monika)-child-context\.js/, file);
    for (const field of ["extensions", "subagentOnlyExtensions"]) {
      const configured = frontmatter.get(field);
      if (!configured) continue;
      for (const runtimePath of configured.split(",").map((value) => value.trim())) {
        const sourcePath = runtimePath.replace(/^\/app\/\.pi\/agent\//, `${path.join(REPO_ROOT, "config")}/`);
        assert.equal(await fs.stat(sourcePath).then(() => true, () => false), true, `${file}: missing ${runtimePath}`);
      }
    }
    for (const forbidden of [...FORBIDDEN_PROFILE_NAMES, ...MUTATING_MEMORY_TOOLS]) {
      assert.doesNotMatch(raw, new RegExp(`(?:^|[,\\s])${forbidden.replace(".", "\\.")}(?:$|[,\\s])`, "m"), `${file}: ${forbidden}`);
    }
    const expectedModel = ["scout.md", "researcher.md", "context-builder.md"].includes(file)
      ? "codex/gpt-5.6-terra"
      : "codex/gpt-5.6-sol";
    assert.equal(frontmatter.get("model"), expectedModel, file);
    if (file !== "monika-delegate.md") {
      for (const tool of READONLY_MEMORY_TOOLS) assert.doesNotMatch(raw, new RegExp(`(?:^|[,\\s])${tool}(?:$|[,\\s])`, "m"), `${file}: ${tool}`);
    }
  }

  const monika = await fs.readFile(path.join(AGENTS_DIR, "monika-delegate.md"), "utf8");
  assert.match(monika, /monika-child-context\.js/);
  assert.doesNotMatch(monika, /specialist-child-context\.js/);
  for (const tool of READONLY_MEMORY_TOOLS) assert.match(monika, new RegExp(`(?:^|[,\\s])${tool}(?:$|[,\\s])`, "m"));
  assert.match(monika, /^I am Monika operating in a bounded delegated context\./m);
  assert.match(monika, /benefits materially from my voice/);
  assert.match(monika, /writing, brainstorming, critique/);
  assert.match(monika, /never write to memstore/);
});
