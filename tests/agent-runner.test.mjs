import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(REPO_ROOT, "bin", "agent-runner.mjs");
const WRAPPER = path.join(REPO_ROOT, "scripts", "agent-runner");
const ISOLATION_FLAGS = [
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      encoding: "utf8",
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function fixture(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function makeCaptureExecutable(file, envName) {
  await fs.writeFile(file, `#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.writeFileSync(process.env.${envName}, JSON.stringify({ args: process.argv.slice(2), shutdownSaveMode: process.env.PI_STATEFUL_MEMORY_SHUTDOWN_SAVE_MODE, gitConfigGlobal: process.env.GIT_CONFIG_GLOBAL }));\nprocess.stdout.write("OK\\n");\n`);
  await fs.chmod(file, 0o755);
}

test("agent-runner preserves full resource discovery by default", async (t) => {
  const root = await fixture(t, "monika-agent-runner-default-");
  const binDir = path.join(root, "bin");
  const outputDir = path.join(root, "outputs");
  const scratchDir = path.join(root, "scratch");
  const capture = path.join(root, "pi-args.json");
  await fs.mkdir(binDir);
  await makeCaptureExecutable(path.join(binDir, "pi"), "FAKE_PI_CAPTURE");

  const result = await run(process.execPath, [RUNNER, "run", "Return OK."], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_PI_CAPTURE: capture,
      RUNNER_OUTPUT_DIR: outputDir,
      RUNNER_SCRATCH_DIR: scratchDir,
      RUNNER_WORKSPACE: root,
      RUNNER_TIMEOUT_SECONDS: "5",
      PI_MODEL: "",
      PI_TOOLS: "",
      RUNNER_NO_EXTENSIONS: "",
      RUNNER_NO_SKILLS: "",
      RUNNER_NO_PROMPT_TEMPLATES: "",
      RUNNER_NO_CONTEXT_FILES: "",
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const captured = JSON.parse(await fs.readFile(capture, "utf8"));
  const args = captured.args;
  assert.equal(captured.shutdownSaveMode, "disabled");
  for (const flag of ISOLATION_FLAGS) assert.ok(!args.includes(flag), `${flag} enabled by default`);
  const metadata = JSON.parse(await fs.readFile(path.join(outputDir, "result.json"), "utf8"));
  assert.equal(metadata.ok, true);
  assert.equal(metadata.timedOut, false);
});

test("agent-runner maps opt-in resource isolation environment flags to Pi", async (t) => {
  const root = await fixture(t, "monika-agent-runner-isolated-");
  const binDir = path.join(root, "bin");
  const capture = path.join(root, "pi-args.json");
  await fs.mkdir(binDir);
  await makeCaptureExecutable(path.join(binDir, "pi"), "FAKE_PI_CAPTURE");

  const result = await run(process.execPath, [RUNNER, "run", "Return OK."], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_PI_CAPTURE: capture,
      RUNNER_OUTPUT_DIR: path.join(root, "outputs"),
      RUNNER_SCRATCH_DIR: path.join(root, "scratch"),
      RUNNER_WORKSPACE: root,
      RUNNER_TIMEOUT_SECONDS: "5",
      PI_MODEL: "",
      PI_TOOLS: "",
      RUNNER_NO_EXTENSIONS: "1",
      RUNNER_NO_SKILLS: "true",
      RUNNER_NO_PROMPT_TEMPLATES: "yes",
      RUNNER_NO_CONTEXT_FILES: "on",
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const captured = JSON.parse(await fs.readFile(capture, "utf8"));
  const args = captured.args;
  assert.equal(captured.shutdownSaveMode, "disabled");
  for (const flag of ISOLATION_FLAGS) assert.ok(args.includes(flag), `${flag} was not forwarded`);
});

test("runner preserves explicit global Git config while HOME is disposable", async (t) => {
  const root = await fixture(t, "monika-agent-runner-git-config-");
  const binDir = path.join(root, "bin");
  const capture = path.join(root, "pi-args.json");
  const gitConfig = path.join(root, "operator.gitconfig");
  await fs.mkdir(binDir);
  await fs.writeFile(gitConfig, "[user]\n\tname = Runner Test\n");
  await makeCaptureExecutable(path.join(binDir, "pi"), "FAKE_PI_CAPTURE");

  const result = await run(process.execPath, [RUNNER, "run", "Return OK."], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_PI_CAPTURE: capture,
      GIT_CONFIG_GLOBAL: gitConfig,
      RUNNER_OUTPUT_DIR: path.join(root, "outputs"),
      RUNNER_SCRATCH_DIR: path.join(root, "scratch"),
      RUNNER_WORKSPACE: root,
      RUNNER_TIMEOUT_SECONDS: "5",
      PI_MODEL: "",
      PI_TOOLS: "",
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const captured = JSON.parse(await fs.readFile(capture, "utf8"));
  assert.equal(captured.gitConfigGlobal, gitConfig);
});

test("save-session runner requests durable archival with a real session path", async (t) => {
  const root = await fixture(t, "monika-agent-runner-save-session-");
  const binDir = path.join(root, "bin");
  const capture = path.join(root, "pi-args.json");
  await fs.mkdir(binDir);
  await makeCaptureExecutable(path.join(binDir, "pi"), "FAKE_PI_CAPTURE");

  const result = await run(process.execPath, [RUNNER, "run", "Return OK."], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_PI_CAPTURE: capture,
      RUNNER_OUTPUT_DIR: path.join(root, "outputs"),
      RUNNER_SCRATCH_DIR: path.join(root, "scratch"),
      RUNNER_WORKSPACE: root,
      RUNNER_TIMEOUT_SECONDS: "5",
      RUNNER_SAVE_SESSION: "1",
      PI_MODEL: "",
      PI_TOOLS: "",
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const captured = JSON.parse(await fs.readFile(capture, "utf8"));
  assert.equal(captured.shutdownSaveMode, "durable");
  assert.ok(captured.args.includes("--session-dir"));
  assert.ok(!captured.args.includes("--no-session"));
});

test("wrapper maps resource isolation options to runner environment", async (t) => {
  const root = await fixture(t, "monika-agent-runner-wrapper-");
  const testRepo = path.join(root, "repo");
  const testWrapper = path.join(testRepo, "scripts", "agent-runner");
  const fakeDocker = path.join(root, "fake-docker");
  const capture = path.join(root, "docker-args.json");
  const task = path.join(root, "prompt.md");
  const outputDir = path.join(root, "outputs");
  await fs.mkdir(path.dirname(testWrapper), { recursive: true });
  await fs.copyFile(WRAPPER, testWrapper);
  await makeCaptureExecutable(fakeDocker, "FAKE_DOCKER_CAPTURE");
  await fs.writeFile(task, "Return OK.\n");

  const result = await run("bash", [
    testWrapper,
    "run",
    "--task", task,
    "--workspace", root,
    "--output-dir", outputDir,
    "--cleanup", "never",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
  ], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AGENT_RUNNER_DOCKER: fakeDocker,
      FAKE_DOCKER_CAPTURE: capture,
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const captured = JSON.parse(await fs.readFile(capture, "utf8"));
  const args = captured.args;
  const expectedEnv = [
    "RUNNER_NO_EXTENSIONS=1",
    "RUNNER_NO_SKILLS=1",
    "RUNNER_NO_PROMPT_TEMPLATES=1",
    "RUNNER_NO_CONTEXT_FILES=1",
  ];
  for (const value of expectedEnv) assert.ok(args.includes(value), `${value} was not passed to Docker`);

  const scratchMount = args.find((arg) => arg.endsWith(":/scratch"));
  assert.ok(scratchMount?.startsWith(`${testRepo}/runner-runtime/scratch/`));
});

test("cleanup always preserves caller-owned explicit output and removes runner scratch", async (t) => {
  const root = await fixture(t, "monika-agent-runner-cleanup-");
  const testRepo = path.join(root, "repo");
  const testWrapper = path.join(testRepo, "scripts", "agent-runner");
  const fakeDocker = path.join(root, "fake-docker");
  const capture = path.join(root, "docker-args.json");
  const task = path.join(root, "prompt.md");
  const outputDir = path.join(root, "caller-output");
  const sentinel = path.join(outputDir, "sentinel.txt");
  await fs.mkdir(path.dirname(testWrapper), { recursive: true });
  await fs.mkdir(outputDir);
  await fs.copyFile(WRAPPER, testWrapper);
  await makeCaptureExecutable(fakeDocker, "FAKE_DOCKER_CAPTURE");
  await fs.writeFile(task, "Return OK.\n");
  await fs.writeFile(sentinel, "keep me\n");

  const result = await run("bash", [
    testWrapper, "run", "--task", task, "--workspace", root,
    "--output-dir", outputDir, "--cleanup", "always",
  ], {
    cwd: testRepo,
    env: { ...process.env, AGENT_RUNNER_DOCKER: fakeDocker, FAKE_DOCKER_CAPTURE: capture },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(await fs.readFile(sentinel, "utf8"), "keep me\n");
  const args = JSON.parse(await fs.readFile(capture, "utf8")).args;
  const scratchMount = args.find((arg) => arg.endsWith(":/scratch"));
  assert.ok(scratchMount);
  await assert.rejects(fs.access(scratchMount.slice(0, -":/scratch".length)));
});
