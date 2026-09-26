# ADE v1 delivery record

Status: active; requirements remain unverified until their full acceptance passes.
Type: delivery record

Updated: 2026-09-26. Branch: `codex/architecture-proposal`. No Git remote is
configured. This is a checkpoint, not a claim that the v1 register is complete.

## Scope baseline and daily-use gate

The baseline is commit `cada60a`, where `requirements.md` records exactly 107
V1 features, 10 deferred features and 23 exclusions across F001–F140. R001–R020
in the shared reliability spec also apply. No V1 disposition or acceptance has
been changed since that baseline. The local build branch is
`codex/architecture-proposal` in this checkout.

The first daily-use gate is a connected flow, not a substitute for each feature's
full acceptance in its owning spec:

| Slice and requirement IDs | Observable gate | Current gap |
|---|---|---|
| Runtime and profiles: F005, F007, F010, R005, R020 | Launch installed app without the checkout; switch isolated profiles; close/reopen while a shell and agent turn continue | Packaged app, one profile, shell and deterministic turns pass; installed multi-profile and real-agent continuity remain |
| Providers and conversations: F021, F025, F027, F031, F038, R001, R002 | Select each real primary agent and account; prompt, inspect tools, answer/decline, cancel and resume with truthful retry outcome | Codex/Claude single-account live prompts passed; Oh My Pi lacks configured account; profile-owned account registration and conversation pinning pass, but managed execution waits for native identity readback; full control flows remain |
| Workspaces and review: F061, F074 | Open a folder, inspect changed files and give agent feedback on a diff | Folder and anchored feedback pass; full F074 atomic admission, large diff handling and broader Git/worktree lifecycle remain |
| Terminal, service and browser: F081, F083, F085, F086, F091 | Keep one shell alive through UI reload; discover/start/stop a dev service and open its preview in the embedded browser | Shell, managed-service controls, listener and bounded log inspection, an on-demand HTTP health check, and browser preview with profile cookie persistence pass; configured health monitoring and persistent logs remain |
| Shared control: F101, F102, F103 | CLI and Electron target the same profile/workspace/conversation/terminal with structured outcomes | Local CLI subset works; public command coverage remains |

Each row needs running-app E2E evidence on the integrated revision before the
daily-use gate can pass. The full requirement acceptance remains unchanged.

## Integrated checkpoints

| Commit | Slice | Evidence |
|---|---|---|
| `cada60a` | Architecture and v1 specs | 140-item register and domain acceptance recorded |
| `73896a9` | pnpm/Electron workspace | Running-app smoke |
| `da1e5b9` | Isolated daemon harness | Public protocol lifecycle E2E |
| `e1346cf` | Desktop daemon attachment | Renderer reload E2E; HMR manually kept daemon boot and shell PID |
| `16b697b` | Bounded xterm replay | Real PTY output/resize and overflow E2E |
| `252af3a` | Root provider lockfile | Frozen install, provider fixture suite, GPUI build-only packaging |
| `3dc2643` | xterm terminal surface | Electron terminal input/reload/alternate-screen E2E |
| `b2e9eac` | Local CLI and shared client | CLI/Electron shared terminal and endpoint-error E2E |
| `ccfc06b` | Electron conversation slice | Create/send/structured transcript/reload/approval E2E |
| `4678d37` | Native question form | Codex structured answer E2E |
| `f11e28a` | Local profile launcher | Two-profile isolation/restart and incompatible-owner E2E |
| `60fa747` | Electron profile selection | Two-daemon UI switch and catalog isolation E2E |
| `1083d5d` | Open local folder | Stable workspace selection and terminal E2E |
| `6827f07` | Renderer-reload drafts | Separate drafts and acknowledged-send clear E2E |
| `a6b6c5c` | Development first-run workspace | Managed profile auto-opens this checkout |
| `4ac53c1` | Uncertain prompt-send reconciliation | Dropped accepted reply, renderer reload and same-ID retry; one provider turn E2E |
| `0a52acf` | Incremental conversation feed | Missing revision triggers resnapshot; no idle transcript polling E2E |
| `b9d04da` | Diff-review feedback ticket | Bounded F074 implementation and E2E acceptance defined |
| `8ffdf3f` | Durable prompt-send intent | Electron crash/relaunch and lost prepare/send/complete replies; daemon request-ID conflicts E2E |
| `4e7d91c` | Local services and conversation selection | Real HTTP service across app closure; immediate new-conversation typing retained E2E |
| `814975c` | Packaged macOS app | Installed resources, bundled provider fixtures, incompatible owner and hidden E2E windows |
| `ae71d0b` | Local listener observation | Managed, unrelated, assigned, contested and stopped port states through real daemon E2E |
| `9ae5a3f` | Embedded browser slice ticket | Profile-partitioned preview and untrusted-page E2E contract defined |
| `4a19993` | Managed service inspection | Direct-process TCP evidence, bounded PTY output and runtime-loss fallback E2E |
| `438e90c` | Diff review feedback and hidden E2E close | Anchored feedback, stale/selection/retry guards and hidden uncertain-send close/reopen E2E |
| `05c3064` | Folder selection race | New conversation waits for the selected folder; integrated 31/31 E2E |
| `39cd32b` | CLI service inspection | Named listener and service-inspection JSON commands; real HTTP service E2E |
| `735dc3b` | Completed review retry | A completed feedback request reconciles its durable send intent before a new prompt |
| `6c0cdd4` | Profile browser preview | Profile-scoped tabs, untrusted pages, blocked downloads and managed service preview through real Electron E2E |
| `68c41ae` | Desktop service observation | Shows managed and unrelated listener evidence, bounded output and unverified health in Electron |
| `509594a` | Profile browser persistence | Moves browser storage into Electron user data; restart and legacy migration E2E |
| `1004fa0` | Prompt close reconciliation | Quit completes accepted sends; unavailable daemon keeps the original retry intent |
| `3a283a7` | Browser migration refusal | A conflicting session leaves the previous profile browser, client and saved default usable |
| `66396aa` | Managed service HTTP health | Bounded loopback probe reports HTTP status, timeout and uncertain ownership separately from TCP evidence |
| `7447924` | Packaged E2E cleanup | Retries a transient daemon admission refusal during test-owned shutdown |

At source revision `66396aa` on macOS arm64, `pnpm check` passed TypeScript
type checking, Fallow, backend and desktop/CLI builds, and 36/36 real-process
E2Es in `e2e/specs/`. The rebuilt package passed `pnpm test:e2e:package` 3/3
with the `7447924` E2E cleanup fix; the browser cookie isolation/restart/migration
case passed in the rebuilt packaged app. The first packaged run encountered a
retriable daemon admission refusal only in test-owned teardown; the helper now
retries it, and the full packaged gate passed on rerun. The earlier
provider/new-draft scenario passed 5/5 repeated runs before this revision.
`node scripts/cargo.mjs fmt --all -- --check` and strict
Clippy passed. `pnpm --filter ade-claude-adapter test` passed 9/9 legacy bridge
cases; `pnpm --filter ade-omp-bridge test` passed 37 with 3 live-only skips.
`PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH" bash scripts/run.sh
--build-only` built and packaged the GPUI prototype; its GUI startup was not
verified. Build output is local and unsigned.

| Requirement slice | Implementation commit | Reproducible acceptance | Result and evidence |
|---|---|---|---|
| R001/R002/F036, partial | `8ffdf3f` | `pnpm check` on macOS arm64 | Pass: `e2e/specs/daemon-send-intent.spec.ts`, `desktop-send-recovery.spec.ts`; Electron SIGKILL/relaunch, lost replies and one provider turn. Daemon SIGKILL boundaries remain. |
| F031/F036, partial | `4e7d91c` | `pnpm check` on macOS arm64 | Pass: `e2e/specs/desktop-conversation-switch.spec.ts`; new-conversation typing survives catalog catch-up. |
| F085/F086, partial | `4e7d91c` | `pnpm check` on macOS arm64 | Pass: `e2e/specs/desktop-services.spec.ts`; real HTTP process survives UI closure and stops. Listener discovery/readiness remain. |
| F005/F007/R020/01-S16, partial | `814975c` | `pnpm package:mac`, `pnpm test:e2e:package` on macOS arm64 | Pass: `e2e/packaged/macos.spec.ts`, local `.app` and ZIP; provider fixtures are not live accounts. |
| F085, partial | `ae71d0b` | `pnpm build:backend`, focused real-daemon E2E on macOS arm64 | Pass: `e2e/specs/listener-discovery.spec.ts`; assigned and verified ports are distinct, unrelated PID stays unknown. UI and broader host attribution remain. |
| F086, partial | `4a19993` | `pnpm check` on macOS arm64 | Pass: `e2e/specs/service-inspection.spec.ts`; direct-process TCP observation is separate from application health, logs are bounded PTY tail, runtime loss is unavailable. UI, health probes and persistent logs remain. |
| F074/R010/R011, partial | `438e90c` | `pnpm check` and final focused review E2E on macOS arm64 | Pass: `e2e/specs/desktop-review-feedback.spec.ts`; stale diff, selection race, ordinary draft, definite rejection and same-ID uncertain recovery. Atomic validate/send and large diff acceptance remain. |
| Hidden E2E close | `438e90c` | `pnpm check` on macOS arm64 | Pass: `e2e/specs/desktop-send-recovery.spec.ts`; hidden ADE closes with uncertain send, reopens and retries original ID. Normal close guard was subsequently covered by `1004fa0`. |
| F085/F086/F102, partial | `39cd32b` | CLI typecheck/build and focused real-daemon/Electron E2E on macOS arm64 | Pass: `e2e/specs/desktop-services.spec.ts`; named listener/inspection output, bounded log tail, honest TCP evidence and structured usage errors. Full feature acceptance remains. |
| F091/F092, partial | `6c0cdd4`, `509594a` | `pnpm check`, `pnpm test:e2e:package`, and packaged browser restart E2E on arm64 | Pass: `e2e/specs/desktop-browser.spec.ts` and managed service preview path; live cookie isolation and persistence across restart, legacy storage migration, metadata restart, bridge/popup/permission/download denial and exact tab identity. A signed build of the old storage code also lost cookies; moving session storage under Electron user data fixed this. Full requirements and R015 cleanup/backup coordination remain open. |
| F085/F086, partial | `68c41ae` | `pnpm check` on macOS arm64 | Pass: `e2e/specs/desktop-services.spec.ts`; Electron shows managed TCP observation, unrelated listener with unknown workspace, bounded output and explicit unverified application health. HTTP health, persistent logs and full host visibility remain. |
| R001/R002/R005/F036, partial | `1004fa0` | `pnpm check` and focused 7/7 real-process E2E on macOS arm64 | Pass: `e2e/specs/desktop-send-recovery.spec.ts`; normal Quit reconciles an accepted prompt through its owning profile and original request ID, including an inactive profile. Unavailable daemon preserves the pending intent and warns; the original manual Retry path remains covered. Daemon crash boundaries and full draft acceptance remain open. |
| F091/F092/R014/R015, partial | `3a283a7` | `pnpm check` and packaged browser E2E on macOS arm64 | Pass: conflicting legacy/destination storage refuses a profile switch while previous client, browser cookies and saved default remain usable. Managed backup, retention, multi-process ownership and interrupted migration recovery remain open in `08-browser-devices/issues/02-browser-session-lifecycle.md`. |
| F086, partial | `66396aa` | `pnpm check`, Rust fmt and strict Clippy on macOS arm64 | Pass: `e2e/specs/service-inspection.spec.ts` checks explicit loopback HTTP 200/503/302, timeout, invalid targets and stop race; `desktop-services.spec.ts` checks on-demand healthy/stopped states in Electron. HTTP probe timeout bounds the socket exchange, not full inspection. Continuous configured health, durable logs and full F086 acceptance remain open. |

The packaged `.app` is about 2.5 GB unpacked and the local ZIP is 790 MB at
`dist/electron/Lux-ADE-local-verified.zip`, SHA-256
`b1cebe36556d35f6b6e73cb137ef95a964213146f11928bbfdd39284ba1f517d`.
Oh My Pi uses about 1.5 GB unpacked and Claude about 515 MB. The package is
unsigned; signing and notarization remain release work.

Separate opt-in live check on this Mac: Codex CLI 0.153.4 reached `ready` and
returned the expected answer in 5.9 seconds; Claude Code 2.1.282 did so in
2.86 seconds. Oh My Pi reached `error` after 2.85 seconds. This Mac has no
`~/.pi/agent/auth.json` and no common provider API key in the environment;
the failure may have another cause and needs a configured-account rerun.
The repeatable command is `pnpm test:e2e:live codex claude omp`.

The 36 main E2E cases and 3 packaged cases are narrow slices. No entire v1
domain or 140-item requirement
register is marked complete by this record.

Manual development smoke: `pnpm dev` created a managed Development profile,
Electron attached to its daemon and shell, and the first run registered this
checkout as a workspace. The test daemon/runtime were stopped through their
recorded identities. The local command guard refused recursive deletion of the
disposable `/tmp/ade-dev-smoke.DwLZ6c` directory, which remains.

## Active and next work

- The `client_connection` worker began the browser slice but its tool access
  failed with a 401; root finished and integrated the slice. An independent
  read-only Claude Code review identified browser lifecycle and security gaps,
  which root fixed before integrated E2E. Earlier,
  `client_connection` delivered the F074 daily-use slice;
  `service_daily_flow` delivered the F085/F086 daemon slices and independently
  reviewed review-feedback races; `package_macos` reviewed daemon attribution,
  runtime-loss and identity boundaries. Root integrated, fixed hidden E2E
  teardown and ran source/package checks. All shared this checkout; no worker
  worktree was created.
- For this checkpoint, `service_health` implemented the F086 one-shot HTTP
  probe and real-daemon E2E. `browser_retention_audit` independently reviewed
  browser lifecycle and the health probe; its stop-race and replacement-listener
  findings were repaired before integration. Root added the Electron controls,
  browser switch guard and combined acceptance. Both workers completed in this
  shared checkout; no worker worktree or active assignment remains.
- Send-intent review closed altered/rejected/aborted request-ID dispatch,
  delayed prepare and accepted-message ID reuse holes. Concurrent completion
  across separate draft reads and daemon-crash boundary acceptance remain.
  No R001/R002/R010 criterion is closed.
- Managed-service CLI/Electron control passes a real HTTP process E2E through
  full app closure and restart, with an invalid recipe error. Daemon
  `listener.list` reports partial local TCP observation and conservative direct
  process attribution; `service.inspect` adds bounded PTY output and execution
  state without calling a TCP listener application-ready. An explicit HTTP
  loopback check now samples application response separately. F085 full host
  discovery and F086 configured monitoring/persistent-log acceptance remain open.
- Electron profile creation/switching works in local development; the packaged
  app bundles the profile launcher. Installed multi-profile continuity remains.
- Workspace opening works for local folders; repository and worktree lifecycle
  acceptance remains.
- Drafts survive renderer reload, send-reply loss and an Electron process crash,
  and clear after acknowledged send. Normal Quit now reconciles accepted sends;
  when the owning daemon cannot confirm one, ADE retains the original intent.
  Recall/stash, transfer, conflicting clients and daemon-crash acceptance remain.
- Conversation pagination, native attachments/context, queues,
  broader approval forms, and live Oh My Pi verification remain.
- Account registration creates separate profile-owned native homes and pins a
  provider-matched account to each conversation. A real-daemon E2E proves
  persistence, v8 migration, redirect rejection and fail-closed launch when
  ambient Claude credentials exist. Native authentication/readback, readiness,
  logout fencing and two live-account execution remain open for F025/F027/R012.
- Full account management, extensible providers/plugins, worktrees, full dev-service
  health/logs and browser features, notifications, remote hosts, unified catalogs/history, customization,
  operations and reliability acceptance remain in the v1 register.
- Next daily-use work: configured service health/persistent logs, browser
  ownership and backup/retention coordination, and real-agent account/control acceptance. Continue
  through the full V1 register afterward.
- Deterministic provider fixtures are evidence for protocol behavior. They do
  not establish live-account compatibility or quality.

See each domain `issues/` ticket for slice-specific acceptance and limits.
