#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const DEFAULT_TASK_FILE = "/task/prompt.md";
const DEFAULT_SYSTEM_PROMPT_FILE = "/task/system.md";
const DEFAULT_OUTPUT_DIR = "/outputs";
const DEFAULT_WORKSPACE = "/workspace";
const DEFAULT_SCRATCH = "/scratch";
const DEFAULT_TIMEOUT_SECONDS = 1800;
const TIMEOUT_EXIT_CODE = 124;
const TERMINATION_GRACE_MS = 5000;

function usage() {
  console.log(`agent-runner

Usage:
  agent-runner check
  agent-runner run [task text]

Environment:
  RUNNER_TASK_FILE             Prompt file (default: ${DEFAULT_TASK_FILE})
  RUNNER_SYSTEM_PROMPT_FILE    Optional system prompt addendum (default: ${DEFAULT_SYSTEM_PROMPT_FILE})
  RUNNER_OUTPUT_DIR            Output directory (default: ${DEFAULT_OUTPUT_DIR})
  RUNNER_WORKSPACE             Working directory for pi (default: ${DEFAULT_WORKSPACE})
  RUNNER_SCRATCH_DIR           Scratch root (default: ${DEFAULT_SCRATCH})
  RUNNER_EXPECT                Output validation: text or json (default: text)
  RUNNER_TIMEOUT_SECONDS       Max pi runtime in seconds; 0 disables timeout (default: ${DEFAULT_TIMEOUT_SECONDS})
  RUNNER_SAVE_SESSION          Save a pi session under <output>/sessions when true (default: false)
  RUNNER_NO_TOOLS              Disable all pi tools when true (default: false)
  RUNNER_NO_EXTENSIONS         Disable extension discovery when true (default: false)
  RUNNER_NO_SKILLS             Disable skill discovery when true (default: false)
  RUNNER_NO_PROMPT_TEMPLATES   Disable prompt-template discovery when true (default: false)
  RUNNER_NO_CONTEXT_FILES      Disable context-file discovery when true (default: false)
  PI_MODEL                     Optional pi model selector
  PI_TOOLS                     Optional comma-separated pi tool allowlist
  PI_SESSION_DIR               Session directory when RUNNER_SAVE_SESSION=true (default: <output>/sessions)
`);
}

function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseTimeoutSeconds(value) {
  if (value == null || value === "") return DEFAULT_TIMEOUT_SECONDS;
  if (!/^\d+$/.test(value)) {
    throw new Error("RUNNER_TIMEOUT_SECONDS must be a non-negative integer number of seconds");
  }
  return Number(value);
}

async function ensureDirs({ outputDir, scratchDir, sessionDir }) {
  await mkdir(outputDir, { recursive: true });
  await mkdir(path.join(outputDir, "artifacts"), { recursive: true });
  if (sessionDir) await mkdir(sessionDir, { recursive: true });
  await mkdir(scratchDir, { recursive: true });
  await mkdir(path.join(scratchDir, "home"), { recursive: true });
  await mkdir(path.join(scratchDir, "tmp"), { recursive: true });
  await mkdir(path.join(scratchDir, "cache"), { recursive: true });
}

async function resolveTask(cliArgs, taskFile) {
  if (cliArgs.length > 0) return cliArgs.join(" ").trim();
  if (existsSync(taskFile)) return (await readFile(taskFile, "utf8")).trim();
  return "";
}

async function maybeRead(file) {
  if (!file || !existsSync(file)) return "";
  return readFile(file, "utf8");
}

function signalChild(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already exited.
    }
  }
}

function spawnAndCapture(command, args, options = {}) {
  const timeoutSeconds = options.timeoutSeconds ?? 0;
  let child;
  let timedOut = false;
  let settled = false;
  let timeoutTimer;
  let killTimer;

  const cleanupSignalHandlers = [];

  return new Promise((resolve, reject) => {
    child = spawn(command, args, {
      ...options,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    const terminate = (signal = "SIGTERM") => {
      if (settled) return;
      signalChild(child, signal);
      if (!killTimer) {
        killTimer = setTimeout(() => signalChild(child, "SIGKILL"), TERMINATION_GRACE_MS);
      }
    };

    const forwardSignal = (signal) => {
      terminate(signal);
    };

    for (const signal of ["SIGTERM", "SIGINT"]) {
      const handler = () => forwardSignal(signal);
      process.on(signal, handler);
      cleanupSignalHandlers.push(() => process.off(signal, handler));
    }

    if (timeoutSeconds > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate("SIGTERM");
      }, timeoutSeconds * 1000);
    }

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", (error) => {
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      cleanupSignalHandlers.forEach((cleanup) => cleanup());
      reject(error);
    });

    child.on("close", (code, signal) => {
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      cleanupSignalHandlers.forEach((cleanup) => cleanup());
      resolve({ code: timedOut ? TIMEOUT_EXIT_CODE : code, signal, stdout, stderr, timedOut });
    });
  });
}

async function runCheck() {
  const result = await spawnAndCapture("pi", ["--version"], { env: process.env });
  if (result.code !== 0) {
    throw new Error(`pi --version failed with code ${result.code ?? "null"}`);
  }
}

async function runTask(cliArgs) {
  const startedAt = new Date();
  const taskFile = process.env.RUNNER_TASK_FILE || DEFAULT_TASK_FILE;
  const systemPromptFile = process.env.RUNNER_SYSTEM_PROMPT_FILE || DEFAULT_SYSTEM_PROMPT_FILE;
  const outputDir = process.env.RUNNER_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;
  const workspace = process.env.RUNNER_WORKSPACE || DEFAULT_WORKSPACE;
  const scratchDir = process.env.RUNNER_SCRATCH_DIR || DEFAULT_SCRATCH;
  const expect = (process.env.RUNNER_EXPECT || "text").toLowerCase();
  const timeoutSeconds = parseTimeoutSeconds(process.env.RUNNER_TIMEOUT_SECONDS);
  const saveSession = envFlag("RUNNER_SAVE_SESSION", false);
  const sessionDir = saveSession
    ? process.env.PI_SESSION_DIR || path.join(outputDir, "sessions")
    : null;
  const noTools = envFlag("RUNNER_NO_TOOLS", false);
  const noExtensions = envFlag("RUNNER_NO_EXTENSIONS", false);
  const noSkills = envFlag("RUNNER_NO_SKILLS", false);
  const noPromptTemplates = envFlag("RUNNER_NO_PROMPT_TEMPLATES", false);
  const noContextFiles = envFlag("RUNNER_NO_CONTEXT_FILES", false);
  const tools = process.env.PI_TOOLS?.trim() || "";

  if (noTools && tools) {
    throw new Error("RUNNER_NO_TOOLS and PI_TOOLS cannot both be set");
  }

  await ensureDirs({ outputDir, scratchDir, sessionDir });

  const task = await resolveTask(cliArgs, taskFile);
  if (!task) {
    throw new Error(`No task provided. Pass task text or mount a prompt at ${taskFile}.`);
  }

  const env = {
    ...process.env,
    HOME: path.join(scratchDir, "home"),
    TMPDIR: path.join(scratchDir, "tmp"),
    XDG_CACHE_HOME: path.join(scratchDir, "cache"),
    // Runner archival is explicit. Default no-session jobs keep persona, recall,
    // and memory tools without writing an untraceable `ephemeral` transcript.
    PI_STATEFUL_MEMORY_SHUTDOWN_SAVE_MODE: saveSession ? "durable" : "disabled",
  };

  const args = ["--print"];
  if (saveSession) {
    args.push("--session-dir", sessionDir);
  } else {
    args.push("--no-session");
  }

  if (process.env.PI_MODEL?.trim()) args.push("--model", process.env.PI_MODEL.trim());
  if (noTools) args.push("--no-tools");
  if (tools) args.push("--tools", tools);
  if (noExtensions) args.push("--no-extensions");
  if (noSkills) args.push("--no-skills");
  if (noPromptTemplates) args.push("--no-prompt-templates");
  if (noContextFiles) args.push("--no-context-files");

  const systemPrompt = (await maybeRead(systemPromptFile)).trim();
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);

  args.push(task);

  const result = await spawnAndCapture("pi", args, { cwd: workspace, env, timeoutSeconds });
  const finishedAt = new Date();

  await writeFile(path.join(outputDir, "stdout.txt"), result.stdout, "utf8");
  await writeFile(path.join(outputDir, "stderr.txt"), result.stderr, "utf8");

  let validation = { ok: true, expect };
  if (expect === "json") {
    try {
      JSON.parse(result.stdout);
    } catch (error) {
      validation = {
        ok: false,
        expect,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } else if (expect !== "text") {
    validation = { ok: false, expect, error: "RUNNER_EXPECT must be 'text' or 'json'" };
  }

  const ok = result.code === 0 && validation.ok;
  await writeFile(
    path.join(outputDir, "result.json"),
    JSON.stringify(
      {
        ok,
        exitCode: result.code,
        signal: result.signal,
        timedOut: result.timedOut,
        timeoutSeconds,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        model: process.env.PI_MODEL || null,
        workspace,
        taskFile,
        systemPromptFile: existsSync(systemPromptFile) ? systemPromptFile : null,
        stdoutPath: path.join(outputDir, "stdout.txt"),
        stderrPath: path.join(outputDir, "stderr.txt"),
        artifactDir: path.join(outputDir, "artifacts"),
        sessionDir,
        tools: noTools ? "none" : tools || null,
        validation,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  if (!ok) process.exit(result.code || 1);
}

async function main() {
  const [subcommand = "run", ...rest] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(subcommand)) return usage();
  if (subcommand === "check") return runCheck();
  if (subcommand === "run") return runTask(rest);
  throw new Error(`Unknown subcommand: ${subcommand}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
