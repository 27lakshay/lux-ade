# Research: which reference repo applies to each remaining slice, and may it be copied?

Ticket: [08-reference-map](../issues/08-reference-map.md) · Researched 2026-09-27 · Research only. No code or repository was changed.

## Answer

- **All seven reference repos grant a permissive licence.** Five are MIT: Orca,
  t3code, OpenCode-v2, Oh My Pi and Ghostex. Two are Apache-2.0: Paseo and Herdr.
  First-party code from every repo may be copied with attribution. None is
  study-only as a whole.
- **Ghostex does have a licence grant.** Its `LICENSE` is only 7 lines because
  each paragraph sits on one line. It holds the copyright line, the full MIT
  permission text and the MIT warranty disclaimer, without the "MIT License"
  title. The README says "free and open source under the MIT License", and
  `apps/history-cli/Cargo.toml` declares `license = "MIT"`. The ticket's premise
  that only a copyright line exists is wrong.
- **Paseo's "portions" clause only carves out third-party components.**
  Everything Paseo wrote is Apache-2.0. The third-party components found are
  listed in the licence table below. Most are MIT; one is an Apache-2.0
  Playwright derivative. None of the files this map recommends is one of them.
- **Some files are study-only, whatever repo they sit in.** These are the
  vendored Ghostty shell-integration scripts, which carry GPLv3 headers, and
  everything under `t3code/.repos/` and `ghostex/.dependencies/`. Treat any file
  with a third-party header as study-only unless the protocol below records its
  own licence.
- **The most useful references split by what ADE still needs:**
  - Orca for fencing, incarnation and account-home edge cases.
  - Paseo for provider semantics, Oh My Pi and ACP, terminal size ownership and
    process reaping.
  - t3code for explicit browser targeting, client sync and budgets.
  - OpenCode-v2 for contract codegen and run coordination.
  - Herdr for Rust code, real-process tests and a JSON Schema drift check.
  - Ghostex for Rust code, with a terminal-scraping model ADE does not share.
- **Default to borrowing the pattern.** Most references are TypeScript with
  in-process ownership. ADE's daemon is Rust and uses durable intents with
  profile-owned state. Copy code only from Herdr and Ghostex (Rust), from pure
  algorithms, or into ADE's TypeScript client and Electron code.
- **Nothing tells a worker which reference was used.** I propose a four-field
  `References:` block on each slice's evidence, plus a static check. See the
  protocol section.

## Licence table

"Copy" means copying code into ADE, which is private (`package.json`
`"private": true`, no licence file). Both MIT and Apache-2.0 allow inclusion in
closed-source code under the conditions shown. This is a reading of the files,
not legal advice.

| Repo | Licence and holder (evidence) | Manifest licence fields | Parts under a different licence | Verdict |
|---|---|---|---|---|
| Orca | MIT, © 2026 Lovecast Inc. (`LICENSE`, 21 lines) | Root `package.json` has no `license` field; `author` is `stablyai` | None found by header search in `src/` | **Copy with attribution.** Keep the copyright and permission notice. |
| Paseo | Apache-2.0, © 2025–present Mohamed Boudra. The `LICENSE` preamble says third-party components keep their own licences and everything else is Apache-2.0 | Root, `packages/desktop` and `plugin-examples/modal-ui`: `Apache-2.0`. `packages/expo-two-way-audio`: `MIT` | See the Paseo portions list below | **Copy with attribution**, under Apache §4: ship the licence text, keep notices, and mark changed files. There is no `NOTICE` file, so §4(d) adds nothing. |
| t3code | MIT, © 2026 T3 Tools Inc. (`LICENSE`) | Root `package.json` is `private`, with no `license` field | `.repos/effect-smol`, `.repos/alchemy-effect` (upstream checkouts with their own licences); CC0 notification sounds in `third-party-licenses.config.json` | **Copy with attribution**, from `apps/` and `packages/` only. `.repos/` is not t3code's code. |
| OpenCode-v2 | MIT, © 2025 opencode (`LICENSE`, plus `packages/ui` and `packages/http-recorder`) | Root `package.json`: `MIT` | `packages/codemode/test/LICENSE.test262` and `LICENSE.wpt` (test corpora) | **Copy with attribution.** |
| Oh My Pi | MIT, © 2025 Mario Zechner, © 2025–2026 Can Bölük, © 2026 Stencil Labs (`LICENSE`; per-package `LICENSE` files are MIT) | Root `package.json` and `Cargo.toml`: `MIT`; crates use `license.workspace` | `crates/pi-builtins` began as a copy of brush (MIT); `crates/pi-shell/NOTICE` adapts RTK (MIT). `THIRD-PARTY-NOTICES.txt` lists LGPL `sharp-libvips`, which is not vendored | **Copy with attribution.** Carry the extra upstream notice for pi-builtins or pi-shell code. |
| Herdr | Apache-2.0 (`LICENSE` is the plain Apache text, with no copyright line filled in) | `Cargo.toml`: `license = "Apache-2.0"`, repository `github.com/herdrdev/herdr` | `CHANGELOG.md` 0.8.0 (2026-08-03): "Relicensed Herdr from AGPL-3.0-or-later to Apache-2.0". The snapshot is 0.9.1. `vendor/portable-pty` is MIT (Wez Furlong); `vendor/libghostty-vt` is MIT, **but** its `src/shell-integration/{bash/ghostty.bash, zsh/.zshenv, zsh/ghostty-integration}` say GPLv3 | **Copy with attribution** from `src/` and `tests/` at 0.8.0 or later. Never copy from pre-0.8.0 history (AGPL). The GPLv3 shell-integration files are **study-only**. Credit "Herdr contributors" plus the repository URL, because no holder is named. |
| Ghostex | MIT permission and disclaimer text, © 2026 Mohamad Yahia (maddada). Unlabelled, but word-for-word MIT | Root `package.json` is `private`, with no `license` field; `apps/history-cli/Cargo.toml`: `MIT`; README: "MIT License" | `.dependencies/` (Ghostty, fonts, blob-decoder), including the same GPLv3 Ghostty shell-integration files. The README credits Termux (GPLv3), VS Code, code-server, cmux and others; "termux" appears only in README, CHANGELOG and AGENTS.md, not in source | **Copy with attribution** from `server/`, `packages/` and `apps/`. `.dependencies/` is **study-only** unless its own licence is recorded. |

### Paseo's third-party portions

These are the Paseo files that carry a third-party origin. Everything else in
Paseo is Apache-2.0 under the `LICENSE` preamble.

| Path | Origin and licence stated in the file or manifest |
|---|---|
| `packages/expo-two-way-audio/` | MIT, © 2023 Cantab Research Ltd. |
| `packages/highlight/src/astro/` | MIT, © 2026 Zulfazli; adapted from `@fazelstudio/codemirror-lang-astro@0.2.0` |
| `packages/highlight/src/{nix,svelte,csharp}/` | Generated Lezer parsers "taken from" `@replit/codemirror-lang-*`. The file states no licence. |
| `packages/app/src/terminal/local-links/terminal-local-link-{parsing,provider}.ts` | "Adapted from MIT-licensed upstream", © Microsoft (VS Code) |
| `packages/desktop/src/login-shell-env.ts` | Adapted from VS Code `shellEnv.ts`, MIT |
| `packages/desktop/src/features/browser-automation/aria-snapshot-script.ts` | Adapted from Playwright, © Microsoft, Apache-2.0 |
| `packages/app/src/assets/acp-provider-icons.ts` | "Vendored ACP provider SVG assets". No licence stated; these are other vendors' marks, so do not copy. |
| `patches/*.patch` | Diffs against npm packages, under those packages' licences |

## Remaining slices

The daily-use gate in `.scratch/ade-v1/progress.md` still needs these slices:

1. **Browser mutations through public controls**, the next assignment: open,
   navigate and close with durable request identity and owner fencing
   (F095, F101, F102).
2. **Generated SDK contracts** (F103).
3. **Terminal input/viewport ownership and incarnation** (F083).
4. **Managed-account isolation and runtime claims in the installed flow**
   (F025, F027, F005/F007).
5. **Native questions and crash/lost-reply recovery for each primary provider**
   (F038, R001, R002).
6. **Oh My Pi as the third primary provider** (F021). It is blocked on a real
   account, but the adapter can proceed against fixtures.
7. **Service URL discovery and script-supervisor recovery**
   (F086, F088, F090). These are queued after the gate.

## Slice-to-reference table

All paths are relative to `/Users/lakshyakumar/work/ade-evaluation-2026-09-24/`.
I checked that all 125 cited file paths exist. "Pattern" means reimplementing the
behaviour in ADE's own ownership model. "Code" means a copy or port is
reasonable. Most rows name tests because their cases double as E2E scenarios for
ADE.

### Daily-use gate

| Slice | Repo | Paths | Borrow | Caveats |
|---|---|---|---|---|
| 1. Browser mutations with owner fencing | Orca | `orca/src/main/browser/browser-client-page-command-executor.ts`, `…-executor-fencing.test.ts`, `…-command-admission.ts`, `agent-browser-bridge-tab-routing.test.ts` | **Pattern.** Fencing cases: close racing an in-flight create, retire every retained page before fencing, in-flight old-authority creates released on transition, stay fail-closed when revocation throws, never change the active tab when an explicit page ID is given | TypeScript in Electron main with in-memory authority. ADE needs the fence in the daemon's durable request record, and the owner in the profile-bound socket added in `7dc1c84`. |
| | t3code | `t3code/apps/server/src/mcp/PreviewAutomationBroker.ts`, `….test.ts` | **Pattern.** Atomic host registration with response correlation; explicit multi-tab targeting while a default tab stays; announce a replacement stream before delivering requests | Effect-TS broker. It has no durable request identity, so ADE adds the idempotency layer. |
| | Paseo | `paseo/packages/desktop/src/features/browser-automation/service.ts`, `service.test.ts` | **Pattern.** CDP session queueing and dialog handling behind one service | Electron-owned, and the daemon cannot see it. Its `aria-snapshot-script.ts` sibling is Playwright-derived (Apache-2.0). |
| 2. Generated SDK contracts | Herdr | `herdr/src/api/schema.rs`, `herdr/src/api/schema/tests.rs`, `herdr/docs/next/api/herdr-api.schema.json` | **Code.** Rust types derive `schemars` JSON Schema. A committed artifact is checked by `generated_protocol_schema_artifact_is_current`, and `HERDR_UPDATE_API_SCHEMA=1` regenerates it. | This is the closest match to a Rust daemon feeding a TS client. The check is a Rust unit test; ADE must run it as a static contract-drift check, not a `#[test]`. Tickets [04](../issues/04-wire-typing.md) and [09](../issues/09-schema-tool.md) choose the tool. |
| | OpenCode-v2 | `opencode-v2/packages/httpapi-codegen/README.md`, `…/test/generate.test.ts`, `opencode-v2/packages/client/test/contract-identity.test.ts`, `opencode-v2/packages/client/script/build.ts` | **Pattern.** Its README states the generator rules: commit the output, regenerate in CI, fail on a diff, track owned files in a manifest, reject ambiguous or lossy schemas, and use one stable `ClientError` | The source of truth is Effect `HttpApi` in TypeScript. ADE's is Rust, so only the rules carry over. |
| | Paseo | `paseo/packages/protocol/codegen/README.md` | **Pattern.** Ahead-of-time validation generation for WebSocket outbound messages | TypeScript-first protocol |
| 3. Terminal input/viewport ownership and incarnation | Paseo | `paseo/packages/server/src/terminal/terminal-size-ownership.ts`, `….test.ts` | **Code** (small, pure). Only the latest claimant can resize; ownership transfers when a new claimant reports the current size | Port to Rust in `ade-daemon`. Input ownership is not covered and needs its own rule. |
| | Orca | `orca/src/main/runtime/orca-runtime-terminal-handle-incarnation.test.ts`, `orca/src/shared/pty-incarnation.ts` | **Pattern.** Cases: a reused PTY ID with a new incarnation invalidates the handle; a delayed predecessor callback cannot resurrect the replacement; null-to-known is the same PTY | These are TypeScript in-process handles. ADE needs incarnation on the public command and on stream frames. |
| | Herdr | `herdr/tests/multi_client.rs`, `herdr/tests/detach_reattach.rs` | **Code** (test harness shape). Real-binary tests: geometry follows meaningful client activity, a crashed client does not affect survivors, detached output keeps the last size | Rust, real processes, close to ADE's E2E-only rule. Herdr is a terminal multiplexer without durable intents. |
| 4. Managed-account isolation and claims | Orca | `orca/src/main/codex-accounts/runtime-home-per-account-homes.test.ts`, `…/runtime-home-system-default-mirror-readback.test.ts`, `orca/src/main/claude-accounts/runtime-auth-service-readback-identity.test.ts`, `…/claude-account-service-reauth-rollback.test.ts` | **Pattern.** Per-account native homes, readback of identity after writing, and rollback of a failed re-auth | Electron main owns the homes and uses keychain paths. ADE's daemon owns them. Treat the test cases as E2E scenarios, not code. |
| | t3code | `t3code/apps/server/src/provider/Drivers/ClaudeHome.ts`, `ClaudeHome.test.ts`, `CodexHomeLayout.test.ts` | **Pattern** or small **code** for the home-layout rules | Effect-TS. Path rules are portable; process launch is not. |
| 5. Native questions and crash/lost-reply recovery | Paseo | `paseo/packages/server/src/server/agent/providers/codex-async-questions.test.ts`, `…/claude/agent.interrupt-restart-regression.test.ts` | **Pattern.** Asynchronous question admission apart from settlement; interrupt then restart without a duplicate turn | In-process agent objects. ADE must add durable answer intents, which it already has from `1e1b36a`. |
| | Ghostex | `ghostex/server/src/session_chat_codex_async_answer.rs`, `ghostex/server/src/session_chat_question_liveness.rs` | **Pattern.** Check the question is still live before delivery; fall back to an ordinary message when it is not | Rust, but Ghostex drives agents by reading and typing into the terminal screen. ADE uses native structured protocols, so only the liveness idea transfers. |
| 6. Oh My Pi provider | Oh My Pi | `oh-my-pi/docs/rpc.md`, `oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts`, `…/rpc-session-settle.ts`, `oh-my-pi/python/omp-rpc/tests/test_client.py` | **Code** for wire types (the authoritative protocol); **pattern** for settlement | This is the provider itself, so it is the protocol source of truth. Pin the OMP version ADE supports. |
| | Paseo | `paseo/packages/server/src/server/agent/providers/omp/protocol-session.ts`, `protocol-session.test.ts`, `rpc-ui-permission-mapper.test.ts` | **Pattern.** Readiness and v2 negotiation, cold-start timeout, rejecting a peer that does not confirm v2, and mapping permissions to UI | A TypeScript adapter; ADE's is Rust. It is the best edge-case list for an OMP adapter. |
| 7. URL discovery and script supervisor recovery | Orca | `orca/src/main/ports/advertised-url-watcher.ts`, `….test.ts` | **Code** (pure parser). Strip CSI/OSC, guard cursor moves and find URLs in PTY output | Port to Rust. Low risk. |
| | Paseo | `paseo/packages/server/src/server/managed-processes/managed-processes.ts`, `….test.ts` | **Pattern.** Reap only a validated leftover; never kill a reused PID; keep the record when inspection fails | Matches ADE's R006 rule of no exit without evidence. It needs daemon-owned durable records. |
| | Ghostex | `ghostex/server/src/portless/tests.rs` | **Code** (Rust). Stable slugs across renames, collision suffixes, and a route sync that replaces stale routes under a lock | Ghostex delegates proxying to launchd "portless". ADE owns its proxy (`abf03a3`). |
| | t3code | `t3code/apps/server/src/preview/PortScanner.test.ts` | **Pattern** | TypeScript; advisory scanning only |

### Open v1 domains

| Domain | Repo | Paths | Borrow | Caveats |
|---|---|---|---|---|
| Providers: ACP, provider plugins, skills dispatch (F022–F024, F028) | Paseo | `paseo/packages/server/src/server/agent/providers/generic-acp-agent.ts`, `generic-acp-agent.test.ts`, `paseo/packages/plugin/src/server/provider.ts` | **Pattern.** A generic ACP peer, and a provider contract with admission separate from settlement | Milestone D owns the provider contract. TypeScript. |
| | t3code | `t3code/apps/server/src/provider/Drivers/ClaudeSkills.test.ts` | **Pattern** | |
| Account switching in a conversation (F026) | Ghostex | `ghostex/server/src/accounts/switch_progress.rs` | **Pattern** | Rust; terminal-driven model |
| Conversations: queue and steer (F034, F035) | Oh My Pi | `oh-my-pi/packages/coding-agent/test/agent-session-queued-steer-delivery.test.ts` | **Pattern** | In-process harness; ADE must not assume external providers ack steering |
| | Ghostex | `ghostex/server/src/session_chat_queue.rs` | **Pattern** or **code** (Rust) | Screen-driven delivery |
| | t3code | `t3code/apps/web/src/queuedMessageStore.test.ts` | **Pattern** | Client-side queue; ADE's queue must be daemon-durable (F034 restart case) |
| Conversations: rewind and compaction (F039, F040) | Orca | `orca/src/main/claude/claude-structured-rewind.test.ts`, `orca/src/main/claude/claude-structured-compaction.test.ts` | **Pattern** | |
| | Ghostex | `ghostex/server/src/session_chat_rewind_tests.rs` | **Pattern** (Rust) | |
| | OpenCode-v2 | `opencode-v2/packages/core/test/session-compaction.test.ts` | **Pattern** | OpenCode owns the model loop; ADE only observes native compaction |
| Conversations: import, search, snooze, attachments (F032, F042, F043, F046) | t3code | `t3code/apps/server/src/project/AgentSessionImporter.test.ts`, `…/orchestration/decider.snoozed.test.ts`, `…/attachmentStore.test.ts` | **Pattern.** Idempotent import; snooze as attention state only | Event-sourced decider; ADE uses SQLite store transactions |
| | Paseo | `paseo/packages/server/src/server/agent-history-search.test.ts` | **Pattern** | |
| Plugins (F051–F060, R013) | Orca | `orca/src/main/plugins/plugin-worker-supervision.integration.test.ts`, `plugin-install.test.ts`, `orca/src/shared/plugins/plugin-manifest.test.ts`, `orca/src/main/plugins/plugin-command-registry.test.ts`, `plugin-secrets-store.test.ts` | **Pattern.** Restart backoff then errored state, manifest rejection before activation, per-activation registration cleanup, namespaced secrets | Orca workers are Electron utility processes. ADE plugin hosts are daemon-owned and must lease old workers. |
| | OpenCode-v2 | `opencode-v2/packages/core/src/plugin.ts`, `opencode-v2/packages/core/test/plugin-failure.test.ts` | **Pattern.** Activation cleanup | In-process plugins. Its restart boundary does not prove provider sessions survive (see architecture §11). |
| Workspaces (F062–F070) | Orca | `orca/src/main/runtime/worktree-terminal-mutation-lock.test.ts` | **Pattern** | Already cited in the architecture |
| | Paseo | `paseo/packages/server/src/server/workspace-archive-service.test.ts`, `workspace-create-worktree-source.e2e.test.ts` | **Pattern.** Remove only on last reference, keep sibling-referenced directories, skip teardown while blocked | ADE removal also needs confirmed authority and quarantine (F069) |
| | t3code | `t3code/apps/server/src/project/WorktreeSetupTracker.test.ts`, `t3code/apps/server/src/checkpointing/CheckpointStore.ts`, `CheckpointStore.test.ts` | **Pattern.** Setup stages stream without stepping back; Git-backed checkpoints | Setup progress is in memory; ADE's hooks must be durable and recoverable |
| | Ghostex | `ghostex/server/src/repository_clone.rs` | **Code** (Rust, 8 tests) for clone into a path | Check the never-overwrite rule (F062) |
| Files and Git (F071, F073, F075, F078) | Paseo | `paseo/packages/server/src/server/file-explorer/service.ts`, `service.posix.test.ts` | **Pattern.** Symlink and permission cases | |
| | t3code | `t3code/apps/server/src/git/GitManager.test.ts`, `t3code/apps/server/src/sourceControl/SourceControlProviderRegistry.test.ts` | **Pattern.** Forge registry per provider | PR features in the registry are excluded (F076/F077) |
| | Orca | `orca/src/main/browser/doc-preview-protocol.test.ts` | **Pattern.** Untrusted preview isolation (F073, R016) | Electron protocol handler |
| Terminals, services and browser devices (F092–F100) | Orca | `orca/src/main/browser/browser-cookie-import.test.ts`, `browser-session-registry.persistence.test.ts`, `browser-screencast-stream.test.ts`, `orca/src/main/emulator/emulator-session-registry.test.ts`, `simctl-simulator-devices.test.ts`, `orca/src/main/computer/computer-provider-lifecycle.test.ts` | **Pattern.** `__Host-` cookie rules, bounded import errors, simulator discovery | This is the broadest device coverage, all Electron-main TypeScript |
| | t3code | `t3code/apps/server/src/device/DeviceMultiHost.test.ts` | **Pattern.** Device identity across hosts (F129, R017) | |
| API and orchestration (F104–F107) | OpenCode-v2 | `opencode-v2/packages/core/src/session/inbox.ts`, `run-coordinator.ts`, `subagent-job.ts`, `opencode-v2/packages/core/test/session-run-coordinator.test.ts` | **Pattern.** Join concurrent resumes per key; a wake does not force a successor; clean up after a defect | Architecture §11: do not copy its retry assumptions to an external provider that is still running |
| | Herdr | `herdr/src/api/wait.rs`, `herdr/tests/cli/agent_wait.rs` | **Code** (Rust). A bounded wait that returns at once when already satisfied and times out otherwise | Status comes from terminal detection, not native events |
| Notifications and activity (F114, F117) | Orca | `orca/src/main/notifications/notification-delivery-service.test.ts`, `announced-notification-registry.test.ts` | **Pattern.** Dedupe what has already been announced | |
| | Paseo | `paseo/packages/server/src/server/agent-attention-policy.test.ts` | **Code** (small, pure). Suppress only for a present, focused, non-stale client | |
| | t3code | `t3code/apps/server/src/orchestration/ActivityPayloadProjection.test.ts` | **Pattern** | |
| Remote and SSH (F121–F127) | Orca | `orca/src/main/ssh/orcad-remote-deploy.test.ts`, `orcad-remote-rollback.test.ts`, `remote-install-coexistence.test.ts` | **Pattern.** Install compatible artifacts beside existing ones, and roll back | Orca's remote daemon model is closest to F124 |
| | Herdr | `herdr/src/remote/host.rs`, `herdr/src/remote/restart_policy.rs`, `herdr/tests/remote_attach.rs` | **Code** (Rust) for the SSH attach and restart policy | |
| | t3code | `t3code/apps/server/src/auth/PairingGrantStore.test.ts`, `t3code/packages/ssh/src/tunnel.test.ts` | **Pattern.** Pairing grants and revocation (F122) | |
| MCP and skills (F131, F132) | OpenCode-v2 | `opencode-v2/packages/core/test/mcp.test.ts`, `mcp-oauth.test.ts`, `skill-discovery.test.ts` | **Pattern** | Recheck against the current MCP spec version (architecture §13) |
| | Orca | `orca/src/main/skills/skill-bundle-install-service.test.ts` | **Pattern.** Bundle install that keeps externally owned files | |
| | t3code | `t3code/apps/server/src/mcp/McpSessionRegistry.test.ts` | **Pattern** | |
| Reliability and operations (R003–R019, F136–F138) | t3code | `t3code/packages/client-runtime/src/state/threads-sync.test.ts`, `t3code/apps/server/src/orchestration/LiveStreamBudget.ts`, `LiveStreamBudget.test.ts`, `t3code/apps/server/src/resourceTelemetry/ResourceTelemetry.test.ts` | **Pattern.** Cursor consistency (R010), byte budgets (R009), resource telemetry (F136) | ADE's durable change feed is still an open gap (map "Out of scope") |
| | Orca | `orca/src/shared/pty-liveness-verdict.ts`, `pty-liveness-verdict.test.ts`, `orca/config/docker/daemon-shutdown-descendants/README.md`, `orca/src/main/daemon/daemon-stream-backpressure.test.ts`, `orca/src/main/observability/redactor.test.ts`, `orca/src/main/memory/memory-snapshot-buckets.test.ts`, `orca/src/shared/workspace-cleanup.test.ts` | **Pattern.** Uncertain liveness (R006), escaped descendants, backpressure (R009), redaction (R018), no double-counted memory (F136), cleanup (F138) | |
| | Herdr | `herdr/tests/live_handoff.rs` | **Code** (Rust test shape). Handoff carries PTY master fds over SCM_RIGHTS, and unknown pane exit preserves the session | This is the closest Rust analogue to ADE's compatible-daemon handoff (R005) |
| | OpenCode-v2 | `opencode-v2/packages/core/src/session/execution/restart.ts`, `opencode-v2/packages/core/src/file-retention.ts` | **Pattern** | Volatile fanout, not a durable feed (architecture §11) |

## Protocol proposal: recording which reference a slice consulted

This fills the map's "Reference-repo usage protocol" gap. It costs one block per
slice and one static check.

1. **Record a `References:` block** in each slice's evidence: the worker result
   and the checkpoint paragraph in `progress.md`. Use one line per reference:
   `<repo>@<snapshot> <path> — studied | pattern | copied → <ADE file>`.
   Write `References: none` when no reference was used.
   `<snapshot>` is the revision in architecture §11 or, for Herdr, Ghostex and
   Oh My Pi, the revision read at consult time.
2. **Mark copied code in the ADE file.** Every `copied` entry needs a header in
   the destination file:
   `Portions adapted from <repo> <path>@<snapshot>, <licence>, © <holder>. Changed: <one line>.`
   For Apache-2.0 sources (Paseo, Herdr), the "Changed" line satisfies §4(b).
3. **Keep one notices file for shipped code.** The first `copied` entry creates
   an ADE third-party notices file listing each source, licence and holder. Its
   location is a user decision, raised in the questions below. Packaging must
   ship it, because both licences require the notice in copies.
4. **Refuse by rule, not judgement.** A worker must not copy from `.repos/`,
   `.dependencies/`, `vendor/` or `patches/`. It must not copy from a file whose
   header names a third party, unless the entry records that file's own
   licence. GPL-marked files are never copied.
5. **Coordinator check at integration.** This is a static contract check, so it
   is allowed under the E2E-only rule. The check:
   - greps the merge diff for `Portions adapted from`;
   - requires a matching `copied` line in the slice's `References:` block, and
     the reverse;
   - fails when a `copied` line has no licence or names a study-only path.

   The worker's result schema in [ticket 02](../issues/02-workflow-harness.md)
   gains a `references` array with the same four fields, so the coordinator
   reads it without parsing prose.

## What is uncertain or was skipped

- **Snapshot revisions were not re-read.** This session refuses `git` outside
  its own worktree. The revisions in architecture §11 (Orca `b7a4fee7`, Paseo
  `c356394`, t3code `e4eb9977`, OpenCode-v2 `2c369a2`) are unverified against the
  current checkouts. None is recorded for Herdr, Ghostex or Oh My Pi. The
  protocol's first use should record them.
- **Relevance comes from reading test titles and file heads.** I did not run any
  reference test. "Prefer files with tests" was applied, but test quality was not
  audited.
- **Two licence facts rest on statements in the files, not upstream checks.**
  - Paseo's vendored Lezer parsers (`packages/highlight/src/{nix,svelte,csharp}`)
    state no licence. Upstream `@replit/codemirror-lang-*` is believed to be MIT,
    but I did not check it.
  - Ghostex's README credits projects such as Termux (GPLv3) for mobile terminal
    components. I found no Termux or vvterm source outside docs, but I did not
    audit `apps/mobile`.
- **Herdr names no copyright holder.** The Apache appendix template is unfilled.
  Attribution to "Herdr contributors" plus the repository URL is a reasonable
  reading, not a stated requirement.
- **The domain rows are coarse.** They name 1–3 references per domain, not one
  per feature. Slices outside the daily-use gate should refresh this map when
  they start. The upstream trees move quickly, and Orca alone has thousands of
  test files.
- **This is not legal advice.** A counsel review is worth doing before the first
  Apache-2.0 copy ships in a packaged build.

### Questions for the user (non-blocking)

1. **Where does ADE's third-party notices file live?** I recommend
   `THIRD-PARTY-NOTICES.md` at the repo root, bundled into the macOS app
   resources.
2. **Should copying from Apache-2.0 sources (Paseo, Herdr) need your approval,
   given the patent-termination clause and change-notice duty?** I recommend no
   approval, but the coordinator reports each such copy.
