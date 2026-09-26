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
| Runtime and profiles: F005, F007, F010, R005, R020 | Launch installed app without the checkout; switch isolated profiles; close/reopen while a shell and agent turn continue | Packaged multi-profile shell and deterministic turns pass; real-agent continuity and full isolation acceptance remain |
| Providers and conversations: F021, F025, F027, F031, F038, R001, R002 | Select each real primary agent and account; prompt, inspect tools, answer/decline, cancel and resume with truthful retry outcome | Codex/Claude single-account live ambient prompts passed; Oh My Pi lacks configured account; Claude and Codex managed identity pinning pass deterministic E2E but hosted two-account execution and full controls remain |
| Workspaces and review: F061, F074 | Open a folder, inspect changed files and give agent feedback on a diff | Folder and anchored feedback pass; full F074 atomic admission, large diff handling and broader Git/worktree lifecycle remain |
| Terminal, service and browser: F081, F083, F085, F086, F088, F090, F091 | Keep one shell alive through UI reload; discover/start/stop a dev service, run a workspace script and open a stable preview in the embedded browser | Shell, service/script controls, recurring HTTP health checks, listener and bounded log inspection, stable local preview, and browser profile cookies pass; full F086/F088/F090 acceptance remains |
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
| `acbe8d7` | Prompt warning deduplication | Repeated Quit while one send is unresolved produces one warning; the original send ID remains recoverable |
| `260aea8` | Managed Claude readiness and recurring service health | Separate native homes, identity drift and disable race fail closed; configured HTTP samples survive service lifecycle boundaries |
| `56cea4d` | CLI managed account controls | Explicit account selection; external Claude fixture verifies and sends through the selected native home |
| `edc4562` | Desktop managed Claude accounts | Inspect/Verify identity consent, profile-switch fence, explicit account selection and native login guidance |
| `2c2d710` | Durable managed-service output | Bounded run-fenced output survives daemon handoff and runtime loss; Electron shows monitored health and recorded output |
| `7733e9c` | Service capture consistency | Error state and test construction match durable output ownership; strict all-target Clippy passes |
| `4728251` | Managed Codex identity | Private file-backed native homes, fresh identity readback, connected-turn fences and hard-link rejection through real-daemon E2E |
| `f7d6d4f` | Codex account controls in Electron | Native login guidance, inspect/verify and explicit conversation binding through hidden Electron E2E |
| `724913c` | Packaged profile switch continuity | Two installed profiles retain distinct daemon, shell and conversation state across app reopen; startup selection race fenced |
| `7024beb` | Managed service peer wiring | Verified direct IPv4 peer URL injected per run; stopped/failed/restarted service boundaries through daemon and Electron E2E |
| `b995a60` | IPv6 peer wiring | Verified IPv6-only dependent service receives a managed loopback URL |
| `c787274` | Workspace scripts backend | Durable run membership, supervised PTY/output, stop and retirement across daemon handoff and crash E2E |
| `abf03a3` | Stable local service proxy | Runtime-owned HTTP/WebSocket URL, listener ownership proof, remap CAS, v9 migration and 100-asset E2E |
| `78ac24b` | Script session formatting | Rustfmt correction for the script backend |
| `207ec62` | Script and proxy CLI/Electron surfaces | Named script and URL/remap commands, hidden Electron run and preview E2E |
| `b365be1` | Packaged workspace scripts | Bundled pinned pnpm and Node launcher; Finder-like PATH and reopen E2E |

At `b365be1` on Apple M4/macOS 26.6.1, the integrated source suite passed
64/64 real-process E2Es, including an IPv6-only peer, script daemon handoff,
CLI/Electron script controls, local proxy takeover refusal, two-sided remapping
and 100/100 concurrent assets in 1408 ms. Type checking, Fallow and the
backend/desktop/CLI builds passed. Rust formatting and strict all-target
Clippy passed; the GPUI prototype build-only package remains usable. The
unsigned macOS app directory was rebuilt, and the packaged suite passed 5/5
with hidden windows, including a workspace script through bundled pnpm/Node
under a Finder-like `PATH`. The local ZIP was not regenerated. This checkpoint
does not close F088 or F090: route retirement/rebind recovery and broader
script discovery, exit status and escaped descendants remain. It also does not
close any other F-series or R-series requirement by implication.

At `7024beb` on macOS arm64, `pnpm check` passed type checking, Fallow,
builds and 54/54 real-process E2Es. Rust formatting, strict workspace Clippy
and the GPUI prototype build-only package passed. `pnpm package:mac` rebuilt
the unsigned app directory; `pnpm test:e2e:package` passed 4/4 with hidden
windows. The local ZIP was not regenerated. Packaged profile continuity uses a
deterministic provider fixture, not live accounts. Peer wiring currently covers
directly owned IPv4 listeners; descendant and IPv6 listeners, cross-profile
host claims and F088 stable URLs remain. No F-series or R-series requirement is
newly marked complete by this checkpoint.

At `f7d6d4f` on macOS arm64, `pnpm check` passed type checking, Fallow,
backend/desktop/CLI builds and 52/52 real-process E2Es. Rust formatting and
strict workspace Clippy passed, as did the GPUI prototype build-only package.
The rebuilt unsigned macOS app directory passed all 3 packaged E2Es with
hidden windows. The existing local ZIP predates this revision and was not
regenerated. Managed Codex checks are pinned to native 0.157.0 and an observed
experimental identity response; the fixture cannot prove hosted credential
selection, native logout or two real accounts. No requirement is newly marked
complete by this checkpoint.

At `2c2d710` on macOS arm64, `pnpm check` passed TypeScript type
checking, Fallow, backend/desktop/CLI builds and 50/50 real-process E2Es.
`node scripts/cargo.mjs fmt --all -- --check`, strict workspace Clippy,
and the GPUI prototype build-only package passed. `pnpm package:mac` rebuilt
the unsigned macOS app directory and `pnpm test:e2e:package` passed 3/3 with
the app hidden from the active macOS Space. The app directory is 2.4 GB; the
existing `Lux-ADE-local-verified.zip` was not regenerated by `package:mac` and
its old hash is not evidence for this revision. Fixture account turns establish
protocol isolation, not two hosted Claude accounts. No R-series or F-series
requirement is newly marked complete by this checkpoint.

At `260aea8` on macOS arm64, `pnpm check` passed type checking, Fallow,
backend/desktop builds and 42/42 real-process E2Es. Rust formatting and strict
Clippy passed; the GPUI prototype build-only package also passed. The Claude
tests use deterministic native CLI/SDK fixtures, so hosted two-account behavior
and native logout remain unverified. Service health samples are memory-only;
durable history and alerting remain open. The Electron Quit regression was red
before `acbe8d7` and green afterward, with the full send-recovery E2E passing.

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

The 52 main E2E cases and 3 packaged cases are narrow slices. No entire v1
domain or 140-item requirement
register is marked complete by this record.

Manual development smoke: `pnpm dev` created a managed Development profile,
Electron attached to its daemon and shell, and the first run registered this
checkout as a workspace. The test daemon/runtime were stopped through their
recorded identities. The local command guard refused recursive deletion of the
disposable `/tmp/ade-dev-smoke.DwLZ6c` directory, which remains.

## Active and next work

- After `235dece`, managed Codex inspection, verification and per-turn
  readback were added against an isolated native home and a version-gated
  app-server contract. Electron and CLI expose the account flow. Independent
  review found hard-link and connected-session gaps; these are fixed with
  fixture E2E for native file isolation, identity drift and Disable fencing.
  The combined 52-case source E2E suite and strict Rust Clippy pass. Actual
  hosted Codex two-account execution, native refresh/logout and the narrow
  readback-to-turn handoff race remain unproven. These slices do not close
  F025/F027/R012.
- Read-only Oh My Pi research found that ADE runs the project-local v18.3.0
  published CLI through its Bun bridge. That CLI can rotate among stored OAuth
  credentials and lacks verified exact-account status. A managed account needs
  a version-pinned isolated store, token-free SDK identity readback, effective
  credential-source and per-turn confirmation, plus a real OAuth run. The
  earlier live attempt reached provider execution but did not establish any
  managed-account identity contract.

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
- The account-readiness and service-health workers delivered separate slices
  in the shared checkout. Independent reviews found a late account-disable
  launch race and a health scheduler starvation case; both were repaired with
  real-process E2E. Root integrated the GPUI recipe compatibility and the
  repeated Quit warning regression. No worker assignment remains active.
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
  discovery and F086 persistent-log/history/alert acceptance remain open.
- Electron profile creation/switching works in local development. Packaged E2E
  now verifies two isolated profiles, daemon boot identities and persistent shell
  PIDs across app reopen. Real-agent continuity and full F005/F007 remain.
- Workspace opening works for local folders; repository and worktree lifecycle
  acceptance remains.
- Drafts survive renderer reload, send-reply loss and an Electron process crash,
  and clear after acknowledged send. Normal Quit now reconciles accepted sends;
  when the owning daemon cannot confirm one, ADE retains the original intent.
  Recall/stash, transfer, conflicting clients and daemon-crash acceptance remain.
- Conversation pagination, native attachments/context, queues,
  broader approval forms, and live Oh My Pi verification remain.
- Account registration creates separate profile-owned native homes and pins a
  provider-matched account to each conversation. Managed Claude now probes
  native identity in a sanitized home, pins it on verification, reprobes before
  launch and fences disable during a delayed launch. Real-daemon E2E proves
  these boundaries with CLI/SDK fixtures. Hosted two-account execution,
  native logout/refresh and other managed providers remain open for F025/F027/R012.
- Full account management, extensible providers/plugins, worktrees, full dev-service
  health/logs and browser features, notifications, remote hosts, unified catalogs/history, customization,
  operations and reliability acceptance remain in the v1 register.
- Managed service peer URLs now resolve from verified, directly owned IPv4 or
  IPv6 loopback listeners and stay tied to the dependent run. The daemon and
  hidden Electron E2E cover stopped peers, failed launch, a changed peer and
  daemon handoff. Descendant listeners and cross-profile claims remain open.
- A runtime-owned local/private F088 URL proxies HTTP/WebSocket traffic to a
  verified managed listener, survives daemon handoff and requires explicit
  identity-and-port-fenced remapping. Real-process E2E covers port takeover,
  slow clients, v9-shaped service identity migration and 100 concurrent assets.
  Identity-fenced route retirement now persists removal before closing its
  listener, rejects preaccepted idle requests and frees route quota. CLI and
  Electron expose retirement; E2E covers stale retirement, failed persistence,
  handoff and repeated create/retire cycles. Rebind and corrupt-registry recovery,
  wider URL discovery and the D09 public exposure policy remain.
- F090 root package scripts and checked-in `.ade/scripts.json` recipes now run
  under supervised processes with retained output, stop/retire controls, exit
  outcomes and daemon handoff. CLI, Electron and packaged Finder-like launch
  pass E2E, including non-JavaScript recipes and two profile daemons. Nested
  manifests, other package managers, supervisor-loss recovery, output saturation
  and escaped descendants remain outside this slice.
- Commits `0156d39`, `be11f21` and `03ef208` add the recipe/outcome and
  route-retirement slices. The integrated source suite passes 66/66, the
  packaged suite 5/5, strict Clippy and Rust formatting pass, and the GPUI
  legacy build succeeds. These do not close F088 or F090.
- Commit `8dc089d` fixes the real-process E2E fixture's detached-runtime
  cleanup. An unexpected daemon exit first left its original runtime answering
  after fixture teardown; the same behavioral assertion passes after the fix.
  Startup failure after runtime launch also reaps the verified instance. Cleanup
  confirms both PID and socket exit before deleting fixture data, with bounded
  retries and retained diagnostics on uncertainty. On macOS 26.6.1 (Apple M4),
  `pnpm exec playwright test e2e/specs/daemon-lifecycle.spec.ts --repeat-each=3`
  passes 9/9 and `pnpm check` passes 68/68 with type checking, Fallow and builds.
  An earlier full run timed out because fixture RPC left a silent socket close
  pending; its close path now rejects, and the final integrated run passes.
  This improves test reliability; it does not close product requirement R006.
- Next daily-use work: Oh My Pi managed native accounts, real-agent
  account/control acceptance, proxy recovery, and browser
  ownership and backup/retention coordination. Continue
  through the full V1 register afterward.
- Deterministic provider fixtures are evidence for protocol behavior. They do
  not establish live-account compatibility or quality.

See each domain `issues/` ticket for slice-specific acceptance and limits.
