# Agent Runner

Generic one-off task runner examples and profiles for the Monika/pi runtime image.

Runner mode is for disposable, non-interactive agent jobs. It reuses the bundled pi runtime, browser/search tooling, and memstore support, but it is not Monika automation and it should not mount Monika's active runtime state.

## Filesystem contract

Inside a runner container:

| Path | Purpose |
|---|---|
| `/task` | Read-only task input, usually `prompt.md` and optional `system.md`. |
| `/workspace` | Read-only mounted files/repos by default. |
| `/scratch` | Writable disposable home/cache/tmp area. |
| `/outputs` | Fresh per-run output directory. |
| `/data` | Optional isolated memstore persistence. |

The automation-facing result is stdout. `/outputs` is for per-run evidence, artifacts, metadata, and sessions.

## Runtime state

Use `runner-runtime/` for local secrets, run outputs, scratch space, and isolated memory profiles. It is gitignored. Do not mount the active `runtime/` memory used by Monika unless you intentionally want cross-contamination.
