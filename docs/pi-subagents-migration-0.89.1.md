# pi-subagents 0.89.1 migration candidate

**Status: experimental preparation only.** Monika production still installs the
reviewed and patched **0.37.2** source from `scripts/install-pi-subagents`.
This document records the first migration milestone; it does not authorize an
image change, runtime installation, or live restart.

## Candidate preparation

The exact upstream source is pinned to tag `v0.89.1`, commit
`533033f0e906e85fdb0e909ce27a7c499ffb6485`, tree
`d6c8cf1dbf40704d3d5f8b0530908e9f6aa6afce`. A prepared checkout must be a clean
local checkout at that exact object. The package manifest and lockfile are
verified by SHA-256:

- `package.json`: `4e325c3009651c542c3243a7c5525230c68cbb9790b5cc6c0f6e548848bb8d57`
- `package-lock.json`: `5fc39baec198a9b58887e7fabefed9dc8a4df7dcbf42839992263b9a1639776b`

Use the offline preparation command with an existing reviewed checkout:

```sh
scripts/prepare-pi-subagents-candidate \
  /path/to/clean/pi-subagents-v0.89.1 \
  /tmp/pi-subagents-candidate
```

The command never fetches, resolves a mutable branch/tag, runs npm, installs
production dependencies, writes `/opt/pi-subagents`, or changes runtime state.
It copies a dependency-free source candidate and writes
`CANDIDATE_SOURCE.json`. The source checkout is expected to come from a
separately reviewed clone or archive; the script itself performs no network
operation.

## Three-way compatibility inventory

The inventory compares upstream 0.37.2, Monika's 0.37.2 patch, and upstream
0.89.1. Categories mean:

- **superseded** — upstream now supplies the equivalent mechanism; port policy,
  not the old implementation;
- **adapt** — upstream changed the seam and Monika's behavior must be reapplied;
- **retain** — Monika-specific behavior remains authoritative;
- **remove** — no longer part of the supported Monika contract;
- **needs proof** — do not choose until a focused test demonstrates ownership
  and behavior.

Every file changed by `config/pi-subagents-0.37.2.patch` is listed below.
References are upstream 0.89.1 paths/symbol families, not claims that the local
patch can be applied textually.

| Patched file | Disposition | Evidence and migration intent |
|---|---|---|
| `package.json` | adapt | Upstream test/build scripts and Pi 1.2+ peer contract changed; preserve isolated test execution and package identity. |
| `src/agents/agents.ts` | adapt | `ChainStepConfig` and agent capability fields evolved; reapply named execution-target policy without duplicating upstream machine support. |
| `src/agents/chain-serializer.ts` | adapt | Upstream chain/workflow serialization changed; retain strict target validation only where Monika's launch contract needs it. |
| `src/api/preflight.ts` | adapt | Upstream preflight/launch contracts expanded; compose with agentd delivery disposition, target digest, and capability ceiling. |
| `src/extension/fanout-child.ts` | adapt | Upstream fanout child creation changed; preserve `PI_SUBAGENT_SESSION_ROOT` and per-run directory isolation. |
| `src/extension/index.ts` | adapt | Upstream registration, recovery and `bg_wait` activation changed; preserve auto-drain suppression and agentd event hooks. |
| `src/extension/rpc.ts` | adapt | Reconcile newer RPC capabilities with agentd's private loopback bridge and bounded public projections. |
| `src/extension/schemas.ts` | adapt | Rebase schemas around upstream workflow/target fields; keep closed named SSH targets and no caller-supplied credentials/commands. |
| `src/extension/tool-description.ts` | adapt | Update model guidance for upstream workflow and `bg_wait`; retain Monika context, provenance and SSH rules. |
| `src/intercom/native-supervisor-channel.ts` | adapt | Upstream session handoff and supervisor routing changed; never transfer ownership across forum topics. |
| `src/runs/background/async-execution.ts` | adapt | Port launch registration, durable launch identity and force-async policy onto the new workflow runner. |
| `src/runs/background/async-resume.ts` | adapt | Upstream resume is richer; agentd must approve resumability and keep authority outside child-writable artifacts. |
| `src/runs/background/async-status.ts` | adapt | Use upstream receipts/status while preserving agentd execution/outcome/effects/delivery projections. |
| `src/runs/background/control-channel.ts` | adapt | Port cancellation/control records to changed upstream run identities; agentd remains cancellation authority. |
| `src/runs/background/notify.ts` | adapt | Reconcile newer completion notices with canonical parent-session provenance; no fabricated public wake. |
| `src/runs/background/result-claim.ts` | retain | Monika's exact identity/digest-bound result claim is an agentd custody contract, not a UI feature. |
| `src/runs/background/result-watcher.ts` | adapt | Incorporate upstream unreadable-status and runner-death fixes without treating missing state as absence. |
| `src/runs/background/scheduled-runs.ts` | remove | Scheduled package runs remain outside Monika's current causal descendant and Stop Robot contract; revisit separately. |
| `src/runs/background/subagent-runner.ts` | adapt | Reconcile native session runner, launcher and artifact behavior with container roots and effects tracking. |
| `src/runs/background/subagent-wait.ts` | adapt | Migrate the implementation to upstream's single configurable wait tool; preserve historical result identity and claims. |
| `src/runs/background/top-level-async.ts` | adapt | Preserve agentd forced async and explicit delivery dispositions across upstream workflow lifecycle. |
| `src/runs/background/wait-tool.ts` | adapt | Prefer upstream `bg_wait`; accept historical `subagent_wait` records/alias during migration. |
| `src/runs/foreground/chain-execution.ts` | adapt | Upstream workflow chains changed; retain target inheritance and no cross-topic session ownership. |
| `src/runs/foreground/execution.ts` | adapt | Reapply hard-kill/exit and target checks at the new foreground executor seam. |
| `src/runs/foreground/subagent-executor.ts` | adapt | Port launch contract and context/capability ceilings; do not bypass agentd for forum-originated work. |
| `src/runs/shared/dynamic-fanout.ts` | adapt | Test structured dynamic fanout through durable nested run keys and bounded concurrency. |
| `src/runs/shared/execution-target.ts` | retain | Named local/SSH target policy is Monika-specific; upstream machine support cannot infer relocation or fall back locally. |
| `src/runs/shared/parallel-utils.ts` | superseded | Prefer upstream parallel workflow primitives, adding only bounded agentd identity/provenance adapters. |
| `src/runs/shared/pi-args.ts` | adapt | New runner/standalone compatibility needs validation against image-owned Pi 1.6.0 npm installation. |
| `src/shared/fork-context.ts` | adapt | Adopt upstream correct cwd/project-instruction behavior while preserving specialist/persona/memory seams. |
| `src/shared/launch-contract.ts` | adapt | Upstream contract is newer; keep Monika fields in an explicit versioned extension rather than shadowing upstream fields. |
| `src/shared/settings.ts` | adapt | Merge upstream configuration (`disabledFeatures`, wait naming, recovery) with image-owned settings and safe defaults. |
| `src/shared/types.ts` | adapt | Map upstream lifecycle receipts to Monika's execution/outcome/effects/delivery states; retain versioned artifact compatibility. |
| `src/tui/fleet-status.ts` | superseded | Use upstream fleet/status projections as the base; Monika's agentd/forum surfaces remain the operational authority. |
| `test/integration/async-execution.test.ts` | adapt | Port to the new runner and assert launch registration, forced async, and exact lifecycle identity. |
| `test/integration/fork-context-execution.test.ts` | adapt | Add upstream fork/cwd behavior while asserting persona and memory exclusion. |
| `test/integration/result-watcher.test.ts` | adapt | Cover unreadable status, runner death, retained receipts and agentd pending delivery. |
| `test/integration/top-level-async.test.ts` | adapt | Cover workflow scripts, drain, cancellation and canonical delivery. |
| `test/support/isolated-test-runner.mjs` | retain | Isolation is required regardless of upstream test harness; keep fresh HOME/runtime/session/operator roots. |
| `test/unit/async-recovery-descriptor.test.ts` | adapt | Port recovery descriptors and prove child-writable artifacts cannot authorize resume. |
| `test/unit/async-resume.test.ts` | adapt | Test agentd-approved resume, completed-child reuse, stale evidence and no automatic topic wake. |
| `test/unit/chain-serializer.test.ts` | adapt | Validate only the supported migrated workflow/chain surface. |
| `test/unit/control-channel.test.ts` | adapt | Preserve scoped, symlink-safe cancellation controls and generation fencing. |
| `test/unit/execution-target.test.ts` | retain | Monika SSH target validation and local-no-fallback policy remain required. |
| `test/unit/fork-context.test.ts` | adapt | Assert upstream cwd/project context plus Monika child identity boundaries. |
| `test/unit/index-child-registration.test.ts` | adapt | Verify extension registration, child-only extensions and `bg_wait` activation. |
| `test/unit/native-supervisor-channel.test.ts` | adapt | Prove handoff stays within one canonical session/topic and survives restart passively. |
| `test/unit/notify.test.ts` | adapt | Normalize old and new notification forms without treating notification text as provenance. |
| `test/unit/package-manifest.test.ts` | adapt | Verify the exact candidate package/peer contract and no mutable dependency resolution. |
| `test/unit/pi-args.test.ts` | adapt | Verify npm Pi 1.6.0 invocation and isolated root arguments. |
| `test/unit/preflight.test.ts` | adapt | Verify delivery disposition, target and capability preflight at the new seam. |
| `test/unit/result-claim.test.ts` | retain | Keep exact claim/digest/custody tests as Monika lifecycle invariants. |
| `test/unit/scheduled-runs.test.ts` | remove | Scheduled execution is intentionally unsupported until it has an explicit agentd causal contract. |
| `test/unit/schemas.test.ts` | adapt | Test merged upstream and closed Monika target schemas. |
| `test/unit/subagent-wait.test.ts` | adapt | Test `bg_wait`, historical `subagent_wait`, and exact run-key settlement. |
| `test/unit/temp-paths.test.ts` | adapt | Preserve dedicated runtime/session/operator root containment under upstream path changes. |
| `test/unit/tool-description.test.ts` | adapt | Assert workflow and `bg_wait` guidance does not promise unsupported topic transfer or memory mutation. |
| `test/unit/wait-tool.test.ts` | adapt | Test configurable wait name and compatibility normalization. |

### Source grounding

The candidate checkout was inspected at the pinned tag, not at a moving branch.
The relevant 0.89.1 source seams are:

- `src/runs/background/async-execution.ts`, `async-resume.ts`,
  `result-watcher.ts`, and `subagent-runner.ts` for launch, recovery, status,
  and process lifecycle;
- `src/runs/background/wait-tool.ts` and `subagent-wait.ts` for the configurable
  `bg_wait` contract;
- `src/runs/shared/dynamic-fanout.ts`, `parallel-utils.ts`, and the workflow
  runner for structured orchestration;
- `src/shared/fork-context.ts`, `launch-contract.ts`, and `types.ts` for child
  context and durable descriptors;
- `src/api/preflight.ts`, `src/extension/schemas.ts`, and
  `src/extension/rpc.ts` for launch validation and host integration;
- `docs/workflows.md` and `docs/configuration.md` for workflow sandbox,
  `autoResume`, `disabledFeatures`, wait naming, and host-command policy.

The inventory deliberately distinguishes these upstream mechanisms from Monika
policy in `services/agentd/src/subagent-lifecycle.mjs`,
`message-provenance.mjs`, `subagent-cancellation.mjs`, `session-resolution.mjs`,
and `subagent-retention.mjs`. Those agentd modules are not replaced by an
upstream status file or notification string.

### Agentd contract inventory

The package migration must not make agentd a passive consumer of arbitrary upstream
state. These existing contracts remain the integration seams:

| Contract | Current source | Required candidate proof |
|---|---|---|
| Runtime roots and force-async policy | `services/agentd/src/server.mjs` (`PI_SUBAGENT_*`, `PI_SUBAGENTS_FORCE_ASYNC`) | New runner receives the same isolated roots; forum-owned nested leaves remain async. |
| Durable lifecycle projection | `services/agentd/src/subagent-lifecycle.mjs` (`SubagentLifecycle`, `scanLifecycleSnapshot`) | Upstream status/receipt formats map without losing active, uncertain or pending delivery work. |
| Result custody and settlement | `services/agentd/src/message-provenance.mjs`, `subagent-lifecycle.mjs` | Claims remain exact run-key/result-digest matches and settle only with canonical Pi provenance. |
| Cancellation and drain | `subagent-cancellation.mjs`, `server.mjs` | Stop fences dispatch generation and reaches nested descendants; drain blocks new launches/completion wakes. |
| Quiescence | `server.mjs`, `deploy-blockers.mjs` | Active, uncertain and effects-unknown work remains a blocker; pending delivery alone does not claim a live process. |
| Session path authority | `session-resolution.mjs` | A known canonical path selects one session; child paths cannot redirect topic ownership. |
| Forum projection | `services/forum/packages/server/src` and `docs/forum.md` | One topic remains one canonical parent session; workflow child sessions never become forum sessions. |
| SSH effects | `config/extensions/ssh.ts`, `ssh-lock.mjs`, `ssh-relocate.mjs` | Remote timeout/error remains effects-unknown; no local fallback or upstream machine inference. |
| Passive startup | `server.mjs` recovery and `subagent-lifecycle.mjs` | Startup inventories/reconciles only; it must not wake parents, consume results, or create follow-ups. |
| Retention | `subagent-retention.mjs` | Resumable, pending, uncertain, custody and effects evidence remains protected. |

## Staged validation matrix

| Stage | Test | Pass condition | Runtime policy |
|---|---|---|---|
| A | Candidate preparation script; exact commit/tree/package-lock checks | Clean 0.89.1 source copies with attestation; dirty/wrong objects fail | No npm, Docker, credentials or runtime writes |
| B | Upstream unit/integration tests in candidate checkout | Upstream suite passes with isolated HOME/temp roots | Candidate only; no production pin change |
| C | Monika patch compile/test port | Agentd package tests and candidate-specific tests pass | Ephemeral roots only |
| D | Context/capability matrix | Scout excludes persona/memory; delegate has bounded recall; nested ceilings and inactive-tool behavior are deterministic | No live session or memstore |
| E | Wait migration | `bg_wait` works; old `subagent_wait` history/alias remains readable; claims settle exactly once | No topic transfer |
| F | Workflow behavior | Parallel, conditional, structured, retry, drain-stop, partial output, cancellation and resume all produce durable run keys and explainable outcomes | Disposable runtime; workflow host commands only through an explicit reviewed contract |
| G | Recovery/crash matrix | Passive startup does not wake/consume; explicit reopen/recovery reconciles status corruption and process death without duplicate work | Kill/recreate throwaway agentd only |
| H | Forum contract | One topic maps to one parent session; child sessions never project; completion and follow-up parent links are exactly once | Ephemeral forum DB/attachments |
| I | SSH/effects matrix | Named remote target is async-only, no local fallback, ambiguous mutation is effects-unknown and blocks deployment | Test target only; no live mutation |
| J | Full candidate image smoke | Candidate image starts and representative research/planning/implementation-review workflows succeed | Ephemeral memstore and forum; never mount live DB |
| K | Production gate | Reviewers disposition the full diff; old pin remains rollback option until live canary evidence | Quiescence-gated deployment only; no in-session restart |

## Migration design decisions

- **Production pin:** remains 0.37.2 until all stages pass and a later PR updates
  the image installer. This milestone changes no runtime pin.
- **Authority:** upstream owns child execution mechanics; agentd owns durable
  custody, deployment interpretation, effects uncertainty, canonical settlement,
  and forum delivery.
- **Wait naming:** migrate the preferred tool to `bg_wait`; retain historical
  `subagent_wait` normalization/compatibility so old sessions do not break.
- **Workflows:** test and adopt ordinary scripts if they improve real Monika
  work. Schedules, external runners, pane placement and mission loops require
  separate causal/effects contracts rather than blanket rejection.
- **Recovery:** passive startup inventories and reconciles only. It never wakes a
  parent, consumes a result, transfers a topic, or invents a continuation.
  Explicit recovery may reuse completed child receipts only after agentd proves
  identity, target, workspace and effects state.
- **Cleanup:** upstream artifact cleanup must not remove resumable runs, pending
  results, uncertain/effects-unknown evidence, canonical session files, or
  custody/settlement records. Retention remains conservative and agentd-owned.
- **Context:** adopt upstream project/cwd correctness without changing Monika's
  specialist versus identity-bearing seams or granting children memory mutation.
- **Security:** retain explicit tool/context boundaries and workflow evaluator
  isolation for predictability and auditability; do not impose blanket OS/network
  confinement on the high-agency runtime without a concrete use case.

## Next milestone

The next PR should port the Monika patch in serial slices: package/test harness,
launch and context contracts, lifecycle/custody integration, wait/workflow
execution, then agentd/forum validation. Each slice gets a fresh candidate test
and a throwaway runtime probe before the next slice. Do not update
`Containerfile`, `config/settings.json`, or the production installer to 0.89.1
until the candidate has passed the full matrix.
