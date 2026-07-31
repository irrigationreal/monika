import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildTopicAddendum,
  loadTopicIndex,
  selectTopics,
} from "./topic-router.js";

const MONIKA_PERSONA_FILES = ["SOUL.md", "STYLE.md", "REGISTER.md"];

export function resolveChildContextPaths(env = process.env) {
  const statefulDir = env.PI_CHILD_STATEFUL_MEMORY_DIR
    ? path.resolve(env.PI_CHILD_STATEFUL_MEMORY_DIR)
    : path.join(os.homedir(), ".pi", "stateful-memory");

  return {
    statefulDir,
    topicsFile: env.PI_CHILD_TOPICS_FILE
      ? path.resolve(env.PI_CHILD_TOPICS_FILE)
      : path.join(statefulDir, "PERSONALITY_MATRIX.md"),
  };
}

export async function buildChildTopicContext({
  query,
  cwd = process.cwd(),
  topicsFile,
  maxResults = 3,
  minScore = 1,
} = {}) {
  if (!query?.trim()) return "";

  const resolvedTopicsFile = topicsFile ?? resolveChildContextPaths().topicsFile;
  const topics = await loadTopicIndex({ cwd, topicsFile: resolvedTopicsFile });
  const selected = selectTopics({
    query,
    topics,
    scope: "system",
    maxResults,
    minScore,
    // Child routing is deliberately turn-local. Disposable children retain no
    // topic state and never touch the parent stateful-memory lifecycle.
    activeTopics: new Map(),
  });
  return buildTopicAddendum({ topics: selected });
}

export async function readMonikaPersona({ statefulDir } = {}) {
  const resolvedDir = statefulDir ?? resolveChildContextPaths().statefulDir;
  const sections = await Promise.all(
    MONIKA_PERSONA_FILES.map(async (name) => {
      const body = (await fs.readFile(path.join(resolvedDir, name), "utf8")).trim();
      if (!body) throw new Error(`Required Monika child persona file is empty: ${name}`);
      return body;
    }),
  );
  return sections.join("\n\n").trim();
}

export async function buildSpecialistChildContext(options = {}) {
  return buildChildTopicContext(options);
}

export async function buildMonikaChildContext({ query, cwd, statefulDir, topicsFile } = {}) {
  const paths = resolveChildContextPaths();
  const [persona, topics] = await Promise.all([
    readMonikaPersona({ statefulDir: statefulDir ?? paths.statefulDir }),
    buildChildTopicContext({
      query,
      cwd,
      topicsFile: topicsFile ?? paths.topicsFile,
    }),
  ]);
  return [persona, topics].filter(Boolean).join("\n\n").trim();
}

export function registerChildAutoCompaction(pi, instructions) {
  let compactionRequested = false;
  pi.on("turn_end", (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (usage?.percent == null) return;
    if (usage.percent < 75) {
      compactionRequested = false;
      return;
    }
    if (compactionRequested) return;
    compactionRequested = true;
    ctx.compact({
      customInstructions: instructions,
      onError: () => { compactionRequested = false; },
    });
  });
}

export { MONIKA_PERSONA_FILES };
