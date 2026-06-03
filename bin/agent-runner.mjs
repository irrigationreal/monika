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
  PI_MODEL                     Optional pi model selector
  PI_TOOLS                     Optional comma-separated pi tool allowlist
  PI_SESSION_DIR               Session directory (default: <output>/sessions)
`);
}

async function ensureDirs({ outputDir, scratchDir, sessionDir }) {
  await mkdir(outputDir, { recursive: true });
  await mkdir(path.join(outputDir, "artifacts"), { recursive: true });
  await mkdir(sessionDir, { recursive: true });
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

function spawnAndCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

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

    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
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
  const sessionDir = process.env.PI_SESSION_DIR || path.join(outputDir, "sessions");
  const expect = (process.env.RUNNER_EXPECT || "text").toLowerCase();

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
  };

  const args = ["--print", "--session-dir", sessionDir];

  if (process.env.PI_MODEL?.trim()) args.push("--model", process.env.PI_MODEL.trim());
  if (process.env.PI_TOOLS?.trim()) args.push("--tools", process.env.PI_TOOLS.trim());

  const systemPrompt = (await maybeRead(systemPromptFile)).trim();
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);

  args.push(task);

  const result = await spawnAndCapture("pi", args, { cwd: workspace, env });
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
