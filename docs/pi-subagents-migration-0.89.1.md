# pi-subagents 0.89.1 migration candidate

**Status: activation of reviewed 0.89.1.** The image installer pins the exact
upstream object and a self-contained Monika patch. The prior 0.37.2 patch remains
in Git for rollback. Applying the new image to an existing deployment still
requires a deliberate checkout fast-forward and quiescence-gated replacement.

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
It exports the pinned Git object (not working-directory bytes) and writes
`CANDIDATE_SOURCE.json`. The source checkout is expected to come from a
separately reviewed Git clone; the script itself performs no network operation.
The destination parent must already exist, the destination must be new and
outside the source, and failed extraction leaves no published candidate.
`CANDIDATE_SOURCE.json` is the only added file; exclude it when comparing the
export with the upstream tree.

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
The first column names the old patch paths, including removed upstream files
and Monika-added files. The evidence column names their replacements where
applicable; these are not claims that the patch applies textually.

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
| `src/runs/background/result-claim.ts` | retain | Monika-added; no upstream counterpart. Exact identity/digest-bound claims remain an agentd custody contract. |
| `src/runs/background/result-watcher.ts` | adapt | Incorporate upstream unreadable-status and runner-death fixes without treating missing state as absence. |
| `src/runs/background/scheduled-runs.ts` | remove | Scheduled package runs remain outside Monika's current causal descendant and Stop Robot contract; revisit separately. |
| `src/runs/background/subagent-runner.ts` | adapt | Reconcile native session runner, launcher and artifact behavior with container roots and effects tracking. |
| `src/runs/background/subagent-wait.ts` | adapt | Migrate the implementation to upstream's single configurable wait tool; preserve historical result identity and claims. |
| `src/runs/background/top-level-async.ts` | adapt | Preserve agentd forced async and explicit delivery dispositions across upstream workflow lifecycle. |
| `src/runs/background/wait-tool.ts` | adapt | Prefer upstream `bg_wait`; accept historical `subagent_wait` records/alias during migration. |
| `src/runs/foreground/chain-execution.ts` | adapt | Removed upstream. Re-home target inheritance in `src/runs/foreground/subagent-executor.ts` and `src/workflows/`; do not restore the old chain engine. |
| `src/runs/foreground/execution.ts` | adapt | Reapply hard-kill/exit and target checks at the new foreground executor seam. |
| `src/runs/foreground/subagent-executor.ts` | adapt | Port launch contract and context/capability ceilings; do not bypass agentd for forum-originated work. |
| `src/runs/shared/dynamic-fanout.ts` | adapt | Test structured dynamic fanout through durable nested run keys and bounded concurrency. |
| `src/runs/shared/execution-target.ts` | retain | Monika-added; no upstream counterpart. Named local/SSH policy cannot infer relocation or fall back locally. |
| `src/runs/shared/parallel-utils.ts` | superseded | Prefer upstream parallel workflow primitives, adding only bounded agentd identity/provenance adapters. |
| `src/runs/shared/pi-args.ts` | adapt | Removed upstream. Re-home child environment isolation and invocation checks in `src/runs/shared/pi-spawn.ts` and the native child-session runtime, against image-owned Pi 1.6.0. |
| `src/shared/fork-context.ts` | adapt | Adopt upstream correct cwd/project-instruction behavior while preserving specialist/persona/memory seams. |
| `src/shared/launch-contract.ts` | adapt | Upstream contract is newer; keep Monika fields in an explicit versioned extension rather than shadowing upstream fields. |
| `src/shared/settings.ts` | adapt | Merge upstream configuration (`disabledFeatures`, wait naming, recovery) with image-owned settings and safe defaults. |
| `src/shared/types.ts` | adapt | Map upstream lifecycle receipts to Monika's execution/outcome/effects/delivery states; retain versioned artifact compatibility. |
| `src/tui/fleet-status.ts` | superseded | Use upstream fleet/status projections as the base; Monika's agentd/forum surfaces remain the operational authority. |
| `test/integration/async-execution.test.ts` | adapt | Removed/split upstream into `test/integration/async-execution.part-1.test.ts` through `async-execution.part-4.test.ts`; port launch registration, forced async, and exact lifecycle identity there. |
| `test/integration/fork-context-execution.test.ts` | adapt | Add upstream fork/cwd behavior while asserting persona and memory exclusion. |
| `test/integration/result-watcher.test.ts` | adapt | Cover unreadable status, runner death, retained receipts and agentd pending delivery. |
| `test/integration/top-level-async.test.ts` | adapt | Cover workflow scripts, drain, cancellation and canonical delivery. |
| `test/support/isolated-test-runner.mjs` | retain | Monika-added; compare with upstream `test/support/isolated-temp-root.mjs`. Keep fresh HOME/runtime/session/operator roots and prevent shared-fixture interference. |
| `test/unit/async-recovery-descriptor.test.ts` | adapt | Port recovery descriptors and prove child-writable artifacts cannot authorize resume. |
| `test/unit/async-resume.test.ts` | adapt | Test agentd-approved resume, completed-child reuse, stale evidence and no automatic topic wake. |
| `test/unit/chain-serializer.test.ts` | adapt | Validate only the supported migrated workflow/chain surface. |
| `test/unit/control-channel.test.ts` | adapt | Preserve scoped, symlink-safe cancellation controls and generation fencing. |
| `test/unit/execution-target.test.ts` | retain | Monika-added; no upstream counterpart. SSH target validation and local-no-fallback remain required. |
| `test/unit/fork-context.test.ts` | adapt | Assert upstream cwd/project context plus Monika child identity boundaries. |
| `test/unit/index-child-registration.test.ts` | adapt | Verify extension registration, child-only extensions and `bg_wait` activation. |
| `test/unit/native-supervisor-channel.test.ts` | adapt | Prove handoff stays within one canonical session/topic and survives restart passively. |
| `test/unit/notify.test.ts` | adapt | Normalize old and new notification forms without treating notification text as provenance. |
| `test/unit/package-manifest.test.ts` | adapt | Verify the exact candidate package/peer contract and no mutable dependency resolution. |
| `test/unit/pi-args.test.ts` | adapt | Removed upstream; cover invocation and roots through `test/unit/pi-spawn.test.ts` and native child-runtime tests. |
| `test/unit/preflight.test.ts` | adapt | Verify delivery disposition, target and capability preflight at the new seam. |
| `test/unit/result-claim.test.ts` | retain | Monika-added; no upstream counterpart. Keep exact claim/digest/custody tests. |
| `test/unit/scheduled-runs.test.ts` | remove | Scheduled execution is intentionally unsupported until it has an explicit agentd causal contract. |
| `test/unit/schemas.test.ts` | adapt | Test merged upstream and closed Monika target schemas. |
| `test/unit/subagent-wait.test.ts` | adapt | Test `bg_wait`, historical `subagent_wait`, and exact run-key settlement. |
| `test/unit/temp-paths.test.ts` | adapt | Preserve dedicated runtime/session/operator root containment under upstream path changes. |
| `test/unit/tool-description.test.ts` | adapt | Assert workflow and `bg_wait` guidance does not promise unsupported topic transfer or memory mutation. |
| `test/unit/wait-tool.test.ts` | retain | Monika-added; no upstream file. Test configurable wait naming and exact claim publication, alongside upstream wait tests. |

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

- **Production pin:** the activation installer selects exact 0.89.1 source.
  Existing containers are not modified by checkout or PR changes; replacement
  remains gated on application quiescence.
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

## Activation acceptance

The staged source and agentd compatibility changes merged before the activation
PR. Image-owned configuration prefers `bg_wait`, disables automatic resume and
scheduling, and retains workflow scripts. The activation adds a durable
controller stop observer, independent child-effects settlement, scoped nested
resume, and dedicated configured fork-session placement.

The disposable workflow canary exercises real Pi/agentd parallel and conditional
children, exact awaited claims, canonical origin capture, Stop Robot, unchanged
canonical bytes after restart, and safe drain. With
`SUBAGENTS_CANARY_FORUM_IMAGE=<forum-image>`, it also imports the canonical parent
twice into an ephemeral forum database and proves that one topic is created and
child sessions are excluded. It uses a strict local synthetic provider, not pool
credentials or live state.

The SSH canary uses a separate disposable sshd, generated keys and read-only
registry descriptors. Real locked tools read and write remotely; an interrupted
mutation retains unknown effects and no local fallback. This exposed and fixed
both the three-file startup attestation mismatch and the locked tool-factory
operations-wrapper regression. The image smoke additionally exercises these
operations against the shipped Pi SDK, not a fake tool factory.

Upstream environmental failures remain distinguished from compatibility claims;
passing focused/image canaries do not imply that an unmodified upstream suite
is universally green on every host.

## Initial compatibility findings

Initial throwaway-container baselines on Node 26.13.0: agentd passed all 248
tests. Unmodified upstream unit tests reported 4,435 passing, 15 failing and 16
skipped. Fourteen failures involve pane allocation-directory permissions and
one involves a root/non-root filesystem fixture; their environmental causes
still require isolated reproduction, not blanket exclusion. These numbers do
not validate the candidate integration.

Direct source comparison and scanner probes identified mandatory port seams:

- Upstream uses `PI_SUBAGENTS_TEMP_ROOT`, not Monika's runtime-root variable.
- Upstream recovery records under `async-subagent-launches/` and nested
  `.launches/` must not become agentd pseudo-runs.
- Workflow coordinators have a different proof shape and use the host PID;
  coordinator exit must never stand in for child-process settlement.
- Workflow stop uses an in-process controller. Writing detached-runner control
  files alone does not prove cancellation of a workflow.
- Upstream maintenance must not delete pending results or evidence protected by
  agentd's custody/retention policy.
- Notifications now include `details.runs`; upstream `awaitedByWorkflow` is not
  the same thing as Monika's `deliveryDisposition: "awaited"`.
- `bg_wait` migration also touches trace privacy, direct-only codemode tools,
  provider smoke fixtures and analytics, not only model instructions.

These findings are acceptance inputs for later slices, not fixes shipped by
this preparation milestone.
