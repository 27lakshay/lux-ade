# 20 — Make live-provider and system-dependent acceptance explicit

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** complete (verified 2026-09-29)

**What to build:** Contributors and release reviewers can distinguish environment-dependent acceptance evidence from tests that could not run.

**Blocked by:** [02 — Separate correctness, load, package and environment-dependent suites](02-suite-selection.md); [04 — Produce trustworthy test reports and fixture timings](04-reports-and-fixture-timings.md)

## Acceptance criteria

- [x] Provide dedicated commands for maintained live-provider, installed-version, device and system cases with explicit prerequisite checks.
- [x] Ordinary deterministic gates ignore inherited live opt-ins and do not require credentials or special hardware.
- [x] An explicitly requested suite fails clearly on missing prerequisites; distinguish that state from a failed assertion and from a verified pass.
- [x] Reports identify executed requirements, known gaps and unexecuted requirements using existing requirement IDs where applicable; do not redefine product scope.
- [x] Use scratch resources and existing secret-storage conventions; logs and artifacts must not disclose credentials.
- [x] Validate prerequisite failures without credentials and record actual provisioned execution only when available and authorized. External prerequisites that remain missing stay pending.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.

## Comments

### 2026-09-29 — Local prerequisite reporting checkpoint (ticket remains open)

- Package, system and live Playwright setup now records invocation-bound prerequisite state.
  Missing opt-ins/candidates exit nonzero with `failureCategory: prerequisite-unavailable`;
  assertion failures keep their native outcome. Markers omit credentials and environment values.
- Native case summaries retain requirement IDs from suite and case titles. Actual global-setup
  failure emits no case inventory, so this does not yet enumerate unexecuted requirements.
- Actual absent-prerequisite runs for all three suites exited 1 with zero passed cases.
  Evidence: `test-results/ticket20-prerequisites/verified.json`, with native reports and logs alongside.
- Reporting/discovery regression checks passed (10 cases). A positive protocol run passed both
  isolation cases and retained a null prerequisite classification:
  `test-results/runs/protocol-b1787b4f-ee7a-49c3-b2fd-8a36edb2b4ea`.
- `pnpm check:static` passed all 25 stages:
  `test-results/runs/static-40d1102e-3582-455b-bd68-ba89b5fdb52c`.
  The preceding attempt caught a JavaScript test typing error; the final run includes its fix.
- Remaining: installed-provider/device commands, current-contract migration of historical live
  probes, discovery-backed unexecuted requirement evidence and full prerequisite checks.
  No credentials were used and no live provider, device or system acceptance was executed.
  Hosted proof remains pending under the user's instruction to keep working locally.

### 2026-09-29 — Selected inventory survives prerequisite failure

- Missing prerequisites now trigger native discovery only, preserving CLI selection and shards.
  `prerequisite-inventory.json` and `summary.json.unexecutedTests` retain selected cases with
  zero attempts and `native-discovery-only` evidence. They never enter executed/pass counts.
  Stateful UI/last-failed selection and failed discovery explicitly leave inventory unknown.
- Actual missing-prerequisite evidence retained under `test-results/ticket20-inventory/verified.json`:
  18 package, 1 system, 4 live cases unexecuted; all three commands exited 1 with no executed cases.
- The system case implements the existing R004 requirement (confirmed against the requirement
  register and reliability specification). Its title now carries R004. The adapter preserves
  F-series and R-series IDs. Regression observed red, green, red with R-series support removed,
  then restored green; all 11 focused reporting/discovery checks passed.
- Final `pnpm check:static` passed all 25 stages, including 303 JavaScript and 310 browser tests:
  `test-results/runs/static-09a843f5-4bda-4318-9a6b-3117ae263e92`.
- Installed-provider inspection confirmed four catalogued entry points. Codex still assumes an
  automatically opened workspace and omits `conversation.create.operation_id`; migrate before
  counting that check as current acceptance. Installed-provider/device commands and remaining
  live prerequisite work are still pending. No external acceptance, commit or push was performed.

### 2026-09-29 — Installed-provider command and current Codex contract

- Added `pnpm test:providers:installed`, with `--list` and explicit provider selection. It
  checks selected executables and workspace dependencies before launching any check. Missing
  prerequisites exit 1, retain the reason and mark selected providers unexecuted. Correctness
  retries are refused. Ordinary deterministic selection remains separate.
- Migrated Codex loopback to the debug backend and existing scratch file secret-store convention.
  Workspace opening and conversation creation/disconnect/resume now use current contracts.
  All original streaming, context, duplicate-send and exact-resume assertions remain.
  Python probes handle SIGTERM through their cleanup paths; Codex always attempts runtime and
  HTTP-fixture cleanup even if daemon teardown fails.
- All four installed providers passed independently against isolated local HTTP fixtures, then
  the default aggregate command passed all four stages: `providers-installed-793a9337-667b-41cc-afe8-3cda2dfdb59b`.
  Aggregate measured wall time: 5.424s; no speedup claim or hosted-auth proof.
  `test-results/ticket20-installed/verified.json` records both aggregate and individual runs.
  OpenCode/OMP retain native JUnit; legacy Python scripts retain command outcomes and assertion
  JSON in logs, not invented native case counts.
- Codex first failed on the missing disconnect operation ID. After correction it passed;
  removing only that ID reproduced the contract failure, and restoring it passed again.
  Red/green logs are retained under `test-results/ticket20-installed/`.
- `pnpm check:static` passed all 25 stages:
  `test-results/runs/static-b1ab2ff2-ae6d-434e-95df-cea6178e7857`.
  New prerequisite tests exercised the real command's failure report and rejected directories
  posing as executables. `pnpm test:providers:installed --list` validated the package script.
- Ticket remains open for device commands and live-provider prerequisite/current-contract work.
  No real credentials, hosted provider calls, hardware acceptance, commit or push was used.

### 2026-09-29 — Device command and sidebar regression found by the gate

- Added `pnpm test:e2e:devices` and `:only`. The first builds backend/SDK/CLI prerequisites;
  the latter checks existing build files before fixture launch. Missing files and directories
  masquerading as build files are rejected. Native discovery proves the selected six spec files
  are exactly the existing device subset, still included by ordinary protocol acceptance.
- Actual device run: `devices-49de5702-57da-4ed4-a59e-a78918a9bbf7`, 28 passed, one F098 known-gap
  skip, zero correctness retries, 29.731s report wall time. `acceptanceScope` records F098/F099/F100,
  real daemon with scripted device tools, physical-device proof unexecuted, display/application
  input a known gap. Evidence: `test-results/ticket20-devices/verified.json`.
- The static gate exposed a sidebar restoration defect under browser concurrency: the centre
  returned at 751.546875px instead of 752px. An isolated repeated probe passed, while concurrent
  execution reproduced it. Captured geometry showed saved widths unchanged at 260/340px but
  drawn widths 260.1875/340.265625px. Pixel conversion used an earlier gutter measurement.
- Final correction measures the actual row minus gutters and restores sidebar percentages from
  that space, including fractional drift. A permanent gutter-transition regression preserves
  exact saved sidebar and centre widths. It failed with the old settling behavior, passed with
  the correction, failed when the correction was removed, then passed after restoration.
  The intermediate half-pixel-only correction did not fix concurrency; that failure is retained.
- Final concurrent browser run: `browser-61870f57-c764-40e5-96fc-2330e5ec77dd`, all 311 passed.
  Scratch built Electron run: `desktop-d96b07a2-018c-4c48-8d90-5f399af4ae18`, all eight passed
  (seven maintained cases plus a temporary sidebar verification). Exact geometry and focus passed;
  the restored screenshot was inspected. Temporary diagnostic specs were removed; their source
  and evidence remain under `test-results/ticket20-sidebar-diagnosis/`.
- Final `pnpm check:static` passed all 25 stages:
  `static-39850e10-70b5-49ea-9a1f-5af2c719caa9`. Original assertions, timeouts, and concurrency
  remain intact; no correctness retries were introduced. `git diff --check` passed.
- Ticket stays open. Live-provider Python probes still need current lifecycle contracts and
  stronger isolation from inherited ADE settings; no paid/provider-authentication run was made.
  Physical-device and hosted proof remain pending. No commit or push was made.

### 2026-09-29 — Live Python contract and isolation checkpoint

- Both Python probes now open a scratch workspace explicitly and supply operation IDs for
  lifecycle effect commands. The shared environment helper isolates ADE sockets, profiles,
  runtime state and file secrets while retaining native provider credential discovery for
  explicitly authorized live runs. Raw native error text is excluded from shared output.
- Missing opt-ins or executables fail with prerequisite-unavailable and selected providers
  unexecuted. Authentication readiness remains explicitly unverified. Added the handoff
  package command; its --help invocation passed without launching providers.
- Three maintained Python tests passed: inherited profile/mock isolation, missing executable
  prerequisites and both public commands refusing absent opt-ins without disclosing a fixture
  credential. The new stage is assigned to the JavaScript CI group; the gate caught its initial
  missing assignment before execution, and that assignment was corrected.
- The maintained Codex loopback check now also executes the migrated basic live probe in a
  separate process. Removing only conversation.create's operation ID failed the check;
  restoration passed: providers-installed-a4b0a894-efc1-44aa-ae17-bddf4836706e.
  All three model requests used a local HTTP fixture, including one for the live probe.
- Both Codex and Claude handoff assertions passed against local HTTP fixtures with three real
  daemon boots and two model requests. These establish local contract/continuity behavior,
  not hosted authentication. The temporary fixture driver and logs are retained as evidence.
- Final pnpm check:static passed all 26 stages, including 311 browser tests:
  static-516351d8-5d91-4e81-956b-df8a80df32e1. git diff --check passed.
  Evidence: test-results/ticket20-live-migration/verified.json.
- Ticket remains open for remaining live suite entry points/reporting and product-surface gaps.
  Hosted authentication, physical-device acceptance and hosted CI proof remain pending.
  No paid provider calls, commit, push or remote action was performed.

### 2026-09-29 — Complete installed CLI selection and persisted live outcomes

- Inspected both provider live.test.mjs files: OpenCode tests queued admission/recovery;
  OMP tests empty-session negotiation and unconfigured startup. Neither sends model prompts.
  Both now run through test:providers:installed with explicit prerequisites and native JUnit.
  Discovery assigns them to installed-provider acceptance; deterministic gates still exclude them.
  OpenCode receives an allowlisted environment and scratch HOME instead of inherited credentials.
- Expanded installed run passed all four stages, including two OpenCode and three OMP native
  cases with no skips: providers-installed-e94c3717-8a97-4ceb-b834-d65cdd8c90ec, wall 8.975s.
  The added coverage makes this incomparable with the earlier loopback-only timing.
- Handoff now persists selected/unexecuted providers, partial outcomes and final status in a
  unique report. Both local fixture handoffs passed with a persisted summary:
  live-handoff-c4ecedab-0922-4036-b02c-c89774eeb63c. Missing-opt-in tests verify that both
  commands persist exactly their reported prerequisite failure and omit fixture credentials.
- SIGTERM during a real Codex request to the local HTTP fixture exited 130 and persisted
  interrupted status: live-provider-b3538764-1b03-4e85-bdf8-bd609ea88e8b. The driver and logs
  are retained under test-results/ticket20-installed-live-reports/verified.json.
- Final pnpm check:static passed all 26 stages:
  static-29c67d55-22df-40c7-aa6e-4f678e6ac34a. git diff --check passed.
- Verified a remaining product gap against tab-content.tsx: only terminal tabs render content;
  conversation tabs return null. Existing live desktop specs still require composer/transcript
  controls. Their assertions remain intact; these cases cannot count as verified UI acceptance.
  Ticket stays open for remaining prerequisite/reporting gaps. Hosted/provider-authentication
  and physical-device acceptance remain pending; no paid calls, commit or push occurred.

### 2026-09-29 — Device runtime prerequisites and live desktop gaps

- Device setup now verifies runnable Python 3, which its scripted tools invoke through /bin/sh.
  The actual command with Python absent exited 1 as prerequisite-unavailable, retaining all 29
  selected cases as unexecuted: devices-e253cf3a-d2e7-48bf-bcdd-ea02fa75a831.
  Missing/incompatible Python and incomplete build outputs have maintained regression coverage.
- Provisioned scripted-device acceptance passed 28 cases with the existing F098 known-gap skip,
  zero correctness retries: devices-44a9b677-d3fe-4cc3-b1b1-d3248d71dc4a, wall 26.741s.
  No physical-device proof is claimed.
- Live desktop setup now checks installed Codex/Claude/Node, debug backend, desktop outputs,
  Claude SDK files and the existing CLAUDE_CONFIG_DIR required by its packaged case before
  launch. Executable lookup is shared with the installed-provider prerequisite checks and
  does not launch candidate binaries. No account authentication is inferred from these checks.
- Native Playwright initially rejected importing the executable helper from a module with
  top-level await. A native-command regression reproduced the failure; extracting the shared
  lookup into a module without runner execution fixed it. The earlier failure remains retained.
- F010 case titles and report metadata now retain the current unbuilt composer/transcript gap.
  An actual missing-opt-in run retained all four F010 cases unexecuted and the known gap:
  live-8361caea-8221-4a95-8e18-efc1ecc58a8a. Existing UI assertions remain unchanged.
- Final pnpm check:static passed all 26 stages:
  static-aa4d07e7-d7a9-4397-9c40-1c0bfb4bda7c. git diff --check passed.
  Evidence: test-results/ticket20-final-prerequisites/verified.json.
- Ticket remains open for final isolation/acceptance audit. Hosted CI, authenticated provider
  and physical-device execution remain pending. No commit, push or paid call occurred.

### 2026-09-29 — Live daemon isolation and shared-report privacy

- The built-desktop live daemon helper inherited ADE secret-store and mock settings. A new
  maintained headless regression in ops/live-fixture-isolation.spec.ts set an invalid inherited
  secret-store name and observed startup refusal. It now uses the existing scratch file secret
  store and strips inherited ADE settings, preserving only native provider binary overrides
  and native authentication discovery. Electron also receives filtered ADE state and a scratch
  profile registry. Packaged release behavior is documented separately; release daemons refuse
  the test file store, so no test-only backend is forced into that path.
- The real-process regression failed on the behavioral assertion before the fix, passed after
  the fix, failed when only the environment correction was removed, and passed on restoration:
  protocol-23737435-be0b-4718-98aa-8f755a008cd4. No provider process/model request was needed.
- System setup now checks backend/SDK/CLI builds before disk fixtures can start. Device setup
  uses the same file checks. Package setup rejects directories posing as executable files.
  Both maintained prerequisite regressions passed without launching binaries or mounting disks.
- Packaged live failures no longer attach raw daemon logs or copy native provider error text
  into shared artifacts. The pass/fail assertions are unchanged. Authenticated execution of
  these cases remains unverified; code inspection is not counted as hosted privacy proof.
- Final pnpm check:static passed all 26 stages, including 311 JavaScript and 311 browser tests:
  static-a3a1400e-a703-4aac-9e91-d8efa81dfdd8. git diff --check passed. An earlier typecheck
  rejected an explicit .ts import extension; the final run includes its corrected import.
  Evidence: test-results/ticket20-isolation/verified.json.
- Remaining audit: per-probe requirement mappings and the complete ticket evidence matrix.
  Hosted CI, provider authentication, system-volume and physical-device proof remain pending.
  No commit, push, paid call or system disk mount occurred.

### 2026-09-29 — Runtime cleanup correction and remaining handoff failure

- Process audit found a surviving runtime at the old live probe's removed scratch socket.
  The prior interruption report proved exit code 130 but did not prove supervisor cleanup.
  Verified binary/socket/PID ownership, stopped that runtime with SIGTERM and confirmed exit;
  unrelated worktrees and app processes were untouched. Earlier evidence now notes this limit.
- Python cleanup previously returned after runtime.stop acknowledgement and removed its socket
  before process exit. It now retains captured PIDs, waits for exit, rejects a missing/replaced
  endpoint while the owned process lives and keeps ownership records on uncertainty.
  Live probes and the maintained Codex check retain scratch diagnostics on unconfirmed cleanup.
- Three real-process regressions prove delayed exit, absent endpoint with a live owner and
  retained diagnostics. Observed red before the correction, green afterward, red when only
  exit verification was removed, then restored green. Installed-provider aggregate, basic live
  CLI against a local HTTP fixture and interruption checks passed with the corrected cleanup.
- Basic reports map selected provider scenarios to F021 (F038 for approval probes); daemon
  handoff reports map to R005. Both explicitly leave full requirement acceptance unverified.
  Requirement mappings were checked against the register and owning specifications.
- A later handoff fixture run failed its Codex assertion. A diagnostic reproduction failed
  for Claude at the full-agent-equality assertion: the only differing field was descendants;
  native thread identity was present. Runtime describe documents descendants as last observed,
  updated periodically. This observation does not prove whether the original Codex failure had
  the same cause. Passing diagnostic runs do not erase either failure; assertions remain intact.
- Final pnpm check:static passed all 27 stages:
  static-c57c969a-b76b-4afe-8f49-60078960c86d. git diff --check passed.
  Evidence: test-results/ticket20-runtime-cleanup/verified.json. Ticket remains open pending
  handoff diagnosis and the final evidence matrix. Hosted/provider-authentication, system-volume
  and physical-device proof remain pending. No commit, push or paid call occurred.

### 2026-09-29 — Maintained native handoff and final infrastructure verification

- The runtime publishes its descendant inventory every 200 ms. A real Codex failure showed
  the exact agent snapshot change from zero descendants before restart to three afterward.
  The probe now waits for the native thread and a populated inventory before its baseline.
  It preserves exact agent, runtime and native-thread comparisons and all message assertions.
- Added `test:providers:handoff`, with real Codex/Claude CLIs, scratch native homes and local
  HTTP streams held until the restarted daemon reports its inventory. The default installed
  command includes it as a fifth stage. Individual provider selection remains individual.
  The fixture makes two local model requests across three daemon boots; hosted authentication
  remains unverified.
- The initial diagnostic reproduced the failure. Removing only the readiness fix made the
  maintained test fail in samples 2 and 6 of twelve diagnostic runs. Restoration passed;
  twelve concurrent validations with the fix also passed. These independent diagnostic runs
  do not add correctness retries to any runner. Evidence retains the failures.
- A report containing only skips previously claimed success. Its maintained regression failed
  before the correction and when only the correction was removed; restoration passed.
  An actual one-case Playwright probe recorded zero passes and one skip and exited 1:
  protocol-821c30b7-09a7-48f7-82ba-db9411012446. The temporary probe was removed.
- Missing native Codex now exits 1 before handoff startup and identifies both providers as
  unexecuted. The full installed run passed all five stages in 10.863s:
  providers-installed-43631659-eb0e-4073-baa4-100a7ac58844. Its coverage differs from earlier
  four-stage runs, so this is not a speed comparison.
- `pnpm check:static` passed all 27 stages in 76.719s:
  static-6a320bae-a9b2-446f-a59d-c32d8f59c78e. Discovery owns the maintained fixture.
  No daemon/runtime processes from this worktree remained after validation.
  `test-results/ticket20-handoff/verified.json` records reports, regressions and timings.

| Surface | Verified local evidence | Pending acceptance |
| --- | --- | --- |
| Installed providers | Codex, Claude, OpenCode, OMP and joint handoff; local HTTP and real CLIs | Hosted account authentication and complete F021/R005 requirements |
| Live Python commands | Current contracts, isolated state, persisted outcomes, interruption and PID exit; missing opt-in fails | Authenticated provider runs, full F021/F038/R005 coverage |
| Live desktop | Native executable/build preflight and selected F010 inventory; missing prerequisites fail | Composer/transcript implementation and authenticated desktop execution |
| Devices | Real daemon, scripted simulator/Android tools, 28 passes and one known gap; Python/build preflight | Physical devices/mobile SDKs; F098 application input gap |
| System | Explicit opt-in/build preflight and unexecuted R004 inventory | Provisioned system-volume execution |
| Packaged live | Executable preflight, isolated ADE state and private error reporting | Built signed bundle/keychain and authenticated desktop execution |

The infrastructure acceptance criteria are complete. External and product acceptance above
remains pending; this completion does not declare those requirements or the overhaul verified.
