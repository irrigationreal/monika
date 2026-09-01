# Agent Runner

Runner mode runs one-off, non-interactive Pi jobs using the Monika runtime image.
It is meant for disposable tasks: mount a prompt, mount an optional workspace,
inject narrow credentials, write results to `/outputs`, then throw the container
away.

The runner intentionally keeps the useful Monika/Pi runtime available by default:
bundled tools, browser/search-capable packages, extensions, memstore, and persona
files are present just like the normal image. Restriction knobs exist for jobs that
need less capability, but they are not a sandbox boundary. Isolation belongs in the
platform layer: read-only mounts, narrow secrets, network policy, resource limits,
and container/Kata/runtime isolation.

## Quick start

Build the normal Monika image from the repository root:

```bash
docker build -f Containerfile -t monika:dev .
```

Run a basic prompt:

```bash
scripts/agent-runner run \
  --task runner/examples/basic/prompt.md \
  --env-file runner-runtime/secrets/model.env \
  --keep-output
```

A Docker env file should contain provider credentials and optional model/search
configuration, for example:

```env
ANTHROPIC_API_KEY=sk-...
BRAVE_SEARCH_API_KEY=...
PI_MODEL=anthropic/claude-sonnet-4-5
```

Do not quote values in Docker `--env-file` files; Docker treats quotes as literal
characters.

## Filesystem contract

Inside a runner container:

| Path | Purpose |
|---|---|
| `/task` | Read-only task input, usually `prompt.md` and optional `system.md`. |
| `/workspace` | Mounted files/repos, read-only by default. |
| `/scratch` | Writable disposable home/cache/tmp area. |
| `/outputs` | Fresh per-run output directory. |
| `/data` | Optional isolated memstore persistence. |

Use `runner-runtime/` for local secrets, run outputs, scratch space, and isolated
memory profiles. It is gitignored. Do not mount the active `runtime/` memory used
by Monika into arbitrary runner jobs unless you intentionally want cross-contamination.

## Output contract

The container's stdout is the canonical automation result. Runner and Monika
startup diagnostics are sent to stderr in runner mode.

Each run writes:

| Path | Purpose |
|---|---|
| `/outputs/result.json` | Structured metadata: success, exit code, timing, timeout, validation, paths. |
| `/outputs/stdout.txt` | Captured stdout. |
| `/outputs/stderr.txt` | Captured stderr. |
| `/outputs/artifacts/` | Task-specific files the prompt asks the agent to create. |
| `/outputs/sessions/` | Optional Pi session logs when `--save-session` is used. |

Generated output directories are deleted on success by default. Use `--keep-output`,
`--output-dir`, or `--cleanup never` when you want to preserve successful run data.
Failed runs are preserved by default.

## Runtime behavior

Runner mode invokes Pi non-interactively and disables Pi session persistence by
default:

```text
pi --print --no-session ...
```

The stateful-memory extension still loads in this mode: persona, recall enrichment,
and explicit memory tools remain available. Automatic shutdown archival is disabled,
so unrelated one-shot jobs never collide under an `ephemeral` origin. Explicit
`remember` operations still persist to the isolated memstore selected for the run.

If you need a Pi JSONL session for debugging/audit and want the completed transcript
archived automatically, opt in:

```bash
scripts/agent-runner run --task prompt.md --save-session
```

With `--save-session`, stateful-memory submits the persisted Pi session path as the
archive origin and waits for that exact memstore save job to finish durably before Pi
exits. Save failure or the bounded durability timeout is reported as an extension
shutdown error rather than treated as a completed archive.

Runner mode also disables `agentd` by default because `agentd` is useful for the
interactive/forum runtime, not for a short-lived foreground job. You can override
that with an explicit Docker env override if you are testing agentd-specific behavior.

## Timeout and cleanup

The default Pi runtime timeout is 1800 seconds:

```bash
scripts/agent-runner run --task prompt.md --timeout 1800
```

Use `0` for no runner-managed timeout:

```bash
scripts/agent-runner run --task prompt.md --timeout 0
```

On timeout the runner terminates Pi, writes `result.json` with `timedOut: true`,
and exits nonzero with code `124`.

## Capability controls

By default, runner mode keeps normal Monika/Pi capabilities available. This is the
point of using the Monika runner rather than a sterile Pi wrapper.

For model-only tasks, disable all tools:

```bash
scripts/agent-runner run --task prompt.md --no-tools
```

For constrained read-only-style repo analysis, pass an explicit tool allowlist:

```bash
scripts/agent-runner run \
  --task runner/examples/repo-mounted/prompt.md \
  --workspace /path/to/repo \
  --tools read,grep,find,ls
```

Tool allowlists are capability/reproducibility controls, not complete containment.
If shell or write tools are available, the agent can perform broad side effects
within the mounted filesystem and network environment.

Pi extensions, skills, prompt templates, and context files remain enabled by default.
For a workload that needs a more sterile resource set, disable discovery explicitly:

```bash
scripts/agent-runner run \
  --task runner/examples/basic/prompt.md \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-context-files
```

These options map directly to Pi's matching isolation flags. They are independent,
so a job can disable only the resource categories it does not need. In particular,
`--no-extensions` disables bundled stateful-memory and other ambient extensions;
it is an opt-in compatibility control, not the runner default.

### Browser and search

The image is browser/search-capable. Search credentials can be provided through the
env file, for example `BRAVE_SEARCH_API_KEY` or `TAVILY_API_KEY`.

If a job must not use browser/search tools, use an explicit `--tools` allowlist that
excludes them. Fine-grained browser/search disable is only meaningful when enforced
through Pi's actual tool set; hiding a token while leaving shell/network tools enabled
is not a security boundary.

## Task and persona/system prompt contract

The primary task comes from `--task`, mounted under `/task`:

```bash
scripts/agent-runner run --task runner/examples/basic/prompt.md
```

Pass a system prompt addendum with `--system`:

```bash
scripts/agent-runner run \
  --task runner/examples/repo-mounted/prompt.md \
  --system runner/examples/repo-mounted/system.md \
  --workspace /path/to/repo
```

Runner mode uses the bundled Monika/Pi runtime by default. For simple automation
tasks, you often do not want the full Monika conversational register. Use `--system`
to provide focused operating instructions, for example:

```md
You are running as a focused one-off repository analysis agent.
Be concise and neutral. Do not use Monika's conversational persona.
Treat /workspace as input material and write durable results under /outputs/artifacts.
```

This is an addendum to Pi's system prompt. It is the supported v1 way to steer
persona/register for runner jobs without changing the bundled image.

## Credentials and model configuration

The supported headless auth path for runner mode is provider environment variables,
usually through `--env-file`:

| Provider family | Common env var |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI-compatible | `OPENAI_API_KEY` |
| Gemini | `GEMINI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

Select a model with `PI_MODEL`:

```env
PI_MODEL=anthropic/claude-sonnet-4-5
```

Mount a model catalog when needed:

```bash
scripts/agent-runner run \
  --task prompt.md \
  --models-json runtime/secrets/models.json \
  --env-file runner-runtime/secrets/model.env
```

`--auth-json` can mount Pi auth state into the container, but mounted Pi OAuth auth
is not yet a complete supported headless auth mechanism for every provider. Prefer
explicit provider env vars for PR-ready runner jobs. OAuth extraction for headless
runner mode is tracked separately and should be implemented deliberately so tokens
are resolved, refreshed, and logged safely.

## Optional isolated memory

Mount isolated memstore state with:

```bash
scripts/agent-runner run --task prompt.md --memory-dir runner-runtime/memory/repo-review
```

Do not mount Monika's active live memstore into unrelated one-off jobs. Use a separate
memory profile per job family if persistent memory is needed. `--memory-dir` controls
storage persistence only; it does not imply transcript archival. Add `--save-session`
when automatic durable archival is intended.

## Wrapper reference

```text
scripts/agent-runner run --task PATH [options]

Options:
  --task PATH              Prompt file to mount at /task/<name> (required)
  --system PATH            Optional system prompt/persona addendum file
  --workspace PATH         Workspace/repo to mount at /workspace (default: current directory)
  --workspace-writable     Mount workspace read-write instead of read-only
  --env-file PATH          Docker env-file containing model/search credentials
  --models-json PATH       Mount a pi models.json as /runtime/secrets/models.json
  --auth-json PATH         Mount a pi auth.json as /runtime/secrets/auth.json
  --memory-dir PATH        Mount isolated memstore data at /data
  --output-dir PATH        Use/preserve explicit output directory
  --keep-output            Preserve generated output directory on success
  --cleanup MODE           on-success (default), always, or never
  --expect MODE            text (default) or json
  --timeout SECONDS        Max pi runtime; 0 disables timeout (default: 1800)
  --save-session           Save a pi session under /outputs/sessions (default: off)
  --no-tools               Disable all pi tools
  --tools LIST             Comma-separated pi tool allowlist, e.g. read,grep,find,ls
  --no-extensions          Disable Pi extension discovery
  --no-skills              Disable Pi skill discovery
  --no-prompt-templates    Disable Pi prompt-template discovery
  --no-context-files       Disable Pi context-file discovery
  --image IMAGE            Runner image (default: monika:dev)
  --extra-docker-arg ARG   Pass an extra argument to docker run; can be repeated
```

## Examples

```text
runner/examples/
  basic/prompt.md                 Minimal prompt-only run.
  repo-mounted/prompt.md          Repo analysis prompt for a mounted workspace.
  repo-mounted/system.md          Neutral one-off agent system addendum.
  browser-research/prompt.md      Research-style task prompt.
  job-specs/default.json          Illustrative future job contract; not consumed by the wrapper.
```

## Security posture

Runner mode is not a sandbox boundary. It is a well-behaved container contract for
one-off agent jobs.

Use the platform layer for real containment:

- read-only workspaces by default
- narrow per-run secrets
- no live Monika runtime/memory mounts for arbitrary jobs
- timeout and resource limits
- network policy or egress controls
- container/Kata/runtime isolation for hostile or reckless workloads

The runner's `--no-tools` and `--tools` options are still useful, but they are controls
on agent capability and reproducibility, not substitutes for platform isolation.
