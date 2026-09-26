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

## Current state and next assignment

Execution order: finish the reviewed Discard safety slice before exposing it.
Then assign only work that closes the daily-use gate below. Queue other V1
requirements until that gate passes; keep the original V1 scope and E2E
acceptance. Use focused E2Es and affected static checks during implementation,
one full source suite per integrated checkpoint (repeat only for relevant
changes or failures), and packaged checks for package/installed-app changes or
delivery milestones. Do not reopen resolved issues without new failure evidence.
At each checkpoint, record criteria closed/remaining and observed time in
implementation, independent review, checks and packaging.

| Daily-use gate and IDs | Verified so far | Remaining before gate closes |
|---|---|---|
| Installed runtime/profiles: F005, F007, F010, R005, R020 | Packaged fixture profiles retain distinct daemon, shell and conversation state across reopen | Real-agent continuity and complete isolation acceptance in the installed flow |
| Primary providers/conversations: F021, F025, F027, F031, F038, R001, R002 | Live ambient Codex and Claude single-account prompts; deterministic managed-identity, prompt and answer recovery, approvals/questions, CLI answer/decline and cancel/resume E2Es | Real Oh My Pi account; two-account hosted execution; tools, answer/decline, cancel/resume and recovery across each primary provider |
| Workspace/review: F061, F074 | Folder selection and revision-anchored agent feedback E2Es | Full atomic feedback admission and large-diff flow in integrated app; remaining lifecycle acceptance |
| Shell/services/browser: F081, F083, F085, F086, F088, F090, F091 | Persistent shell, service/script controls, observed ports and health, stable profile browser preview | Complete F086/F088/F090 gate scenarios in one connected flow |
| Shared controls: F101, F102, F103 | Local CLI and Electron share named daemon commands and outcomes, including cancel/resume | Matching CLI coverage for the rest of the selected daily-use flow |

These are partial observations, not closed feature IDs. Each row still needs
integrated running-app evidence. Oh My Pi live-account acceptance currently
needs credentials; continue the other rows without substituting a fixture.
The one-file Discard ticket, shared cancel/resume control slice, and durable
answer-recovery slice are closed. F075/06-S06 and real-provider F021/F038
acceptance remain open. Active owner: coordinator on connected provider/account
daily-use acceptance; `/root/answer_cli_e2e` and
`/root/answer_recovery_audit` have finished, and no worker is running. Next
assignment: exercise available real Codex and Claude accounts through the
running app/CLI, record which approval, tool, cancel/resume, and recovery cases
are observable, then implement the first demonstrated daily-use failure.
Continue around the Oh My Pi credential blocker. Queue unrelated V1 slices and
preserve the final full V1 audit.

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
| `5455362` | Backend-only SQLite snapshot | Live draft-write capture, integrity and schema checks, offline restore E2E |
| `9901747` | Safe one-file Git Discard | Atomic local-APFS exchange, retained recovery file, 11 focused E2Es; final source suite 152 passed/one host skip; installed suite 6/6 |
| `a5bef38` | Shared cancel/resume controls | Electron and CLI share daemon turn control; focused 2/2, source 153 passed/one host skip, installed suite 6/6 |
| `a0a377a` | Browser recovery E2E race | First profile form reset is awaited before the next action |
| `ddb8536` | Backup limits and evidence | Explicit independently consistent backend scope and exclusions |
| `21b931b` | Explicit attachment reclaim | Durable tombstones, reference/race and backup-overlap E2E |
| `ced2af0` | Partial browser backup | Tabs and persistent cookies in a versioned, profile-bound Electron bundle; failure/retry E2E |
| `5afc3eb` | Registered backend bundle | Live profile capture with source identity, exclusions and packaged Python helper |
| `13b32c4` | E2E process ownership | Identity-checked shutdown of test-owned profile daemons and detached runtimes |
| `22b9fd4` | Restored execution and send fence | Schema-12 workspace/repository rebind flags and durable inherited-send hold |
| `854fff9` | Pending-send transfer and startup recovery | Verified profile-bound journal transfer; isolated startup failures exit without a native dialog |
| `315dc8f` | Registered backend restore | Registry-last new profile, private workspace remap, explicit crash resume and validation E2E |
| `6e3f0a5` | Restored path rebind | Core/lifecycle immutable source claims, public CLI/protocol, cross-store source and repeated-rebind E2E |
| `504a6b3` | Browser E2E profile switch race | Waits for the profile control to become enabled before a second switch |
| `1e1b36a` | Durable native answer reconciliation | Crash/lost-reply/no-delivery/conflict and CLI answer E2Es; focused 11/11, source 162 passed/one host skip, installed 6/6; independent review found no confirmed P1/P2 |

Answer-recovery checkpoint `1e1b36a`: the deterministic once-only answer and
CLI parity criteria in the implementation ticket close. Live provider
answer/decline and managed two-account acceptance remain. Implementation took
at least 18 minutes between the first and final static checks, with earlier
work unmetered. Independent review overlapped implementation and was not
separately timed; it completed three passes. Final focused checks took 9.8
seconds, the full source suite 4.7 minutes, and packaging plus installed
checks about 58 seconds. Intermediate affected checks followed safety edits;
the full source suite ran once after integration. Next slice will record
category timings from its start.

Discard checkpoint `9901747`: all three one-file ticket criteria pass through
9 protocol/CLI and 2 hidden Electron E2Es. Independent safety review found
no confirmed remaining byte-loss path after the APFS exchange and retained
recovery-file changes. The source suite passed 152 tests with one host skip;
the installed suite passed 6/6. Implementation and review time were not
recorded before the execution-process change. After code freeze, focused E2Es
took 31.9 seconds, the source suite about 4.4 minutes, and packaging plus
installed E2Es about 41 seconds. Earlier source runs were repeated after
safety-relevant edits.

Conversation-control checkpoint `a5bef38`: Electron and CLI cancel and resume
one running fixture turn through the same daemon. The local surface criterion
closes, but real-provider F021/F038 acceptance remains. Focused E2Es passed
2/2; typecheck, Fallow and build passed. The source suite passed 153 tests
with one host skip in 4.6 minutes; packaging and installed checks passed 6/6
in about 53 seconds. No test-owned ADE process remained. Observed checkpoint
elapsed about 8 minutes 13 seconds: source checks 4.6 minutes, packaging 53
seconds, focused/static checks under 10 seconds; the remaining roughly 2
minutes 40 seconds covers implementation, local review and coordination,
which were not timed separately. Separate category timers begin with the next
slice. No second integrated source run was needed.

At `854fff9`, `pnpm check` passes type checking, Fallow, builds and 103/103
source E2Es. The macOS package passes 6/6 packaged E2Es with hidden windows;
`cargo fmt --check` and strict Clippy pass through `scripts/cargo.mjs`. A
post-run process audit finds no `ade-daemon` or `ade-runtime` from this checkout.
The restored execution and send fences remain held until explicit rebind and
source-outcome reconciliation flows are implemented. R014/R015 are still partial.

At `504a6b3`, `pnpm check` passes type checking, Fallow, builds and 111/111
source E2Es. `pnpm package:mac` and 6/6 packaged E2Es pass. The first source
run had a pre-existing browser-test race: it asserted a second switch after
the active-profile label appeared while the first switch was still in progress.
The focused rerun and full source rerun pass after waiting for the profile
control to re-enable. Rust formatting, strict Clippy, Python compilation and
`git diff --check` pass; a post-run process audit finds no daemon or runtime
from this checkout. Independent review found no remaining P1/P2 in the
rebind paths. F061/R014 remain partial because cross-profile physical claims,
absolute paths in restored script/service configuration, a rebind crash case,
and the path check/use race are not resolved.

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
| F092/R014/R015, partial | `487b907` | `pnpm check`, `pnpm package:mac`, `pnpm test:e2e:package`, and `ADE_E2E_BROWSER_APP="$PWD/dist/electron/mac-arm64/Lux ADE.app" pnpm exec playwright test e2e/specs/desktop-browser.spec.ts` on macOS arm64 | Pass: 84/84 source and 6/6 packaged E2Es, plus 2/2 browser E2Es in the packaged app. `browser-migration-recovery.spec.ts` kills Electron at six fresh/legacy storage boundaries, checks cookie/tab and retained source recovery, rejects wrong owners, requires explicit confirmation for ownerless old sessions, and refuses a moved runtime home before browser writes. Backup/restore, retention, a cross-process lease and successful runtime-home relocation remain open. |
| F092/R015, partial | `13f3e45` | `pnpm check`, final browser/profile E2E suite, `pnpm package:mac`, `pnpm test:e2e:package`, and packaged browser E2E on macOS arm64 | Pass: 85/85 source E2Es, 13/13 final browser/profile E2Es, 6/6 packaged E2Es and 2/2 packaged browser E2Es. A profile-home advisory lease refuses a second Electron browser writer and recovers after the first process is killed. The package contains the lease helper. Managed backup/restore, retention and successful profile-home relocation remain open. |
| F050, history-export slice | `eeda9db` | CLI typecheck/build and `pnpm exec playwright test e2e/specs/history-export.spec.ts e2e/specs/local-cli.spec.ts` on macOS arm64 | Pass: 6/6 E2Es, including 222 native-fixture messages across public history pages, no-overwrite, and rejection of a changed second page with no partial output. Managed backup/restore and live-provider proof remain open. |
| F050/R014, backend snapshot slice | `5455362`, `a0a377a` | `python3 -m py_compile scripts/managed_backup.py`, focused backup E2E and final `pnpm check` on macOS arm64 | Pass: 89/89 real-process E2Es, typecheck, Fallow and builds. Backup E2E restores public state, rejects corrupt/future schemas, resets account verification, and prevents stable routes or Worktrunk ownership from crossing profiles. Browser, pending sends, registry and runtime binding are excluded; this is not a complete profile backup. |
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

## Earlier work and open acceptance history

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
  handoff and repeated create/retire cycles. Rebind recovery now retains a
  blocked route's original URL and route ID when its port is occupied, while
  unrelated routes remain available. A corrupt registry starts in explicit
  recovery mode; the CLI can inspect, retry a fenced bind, or archive and reset
  after digest confirmation. Real-process E2E covers restore, stale retries,
  duplicate IDs, oversized and nonregular files, and FIFO refusal. Electron
  now exposes blocked-route inspection, identity-fenced retry or retirement,
  and reviewed corrupt-registry archive/reset; real-process E2E covers those
  controls. Wider URL discovery, backup restore and the D09 public exposure
  policy remain.
- F090 root package scripts and checked-in `.ade/scripts.json` recipes now run
  under supervised processes with retained output, stop/retire controls, exit
  outcomes and daemon handoff. CLI, Electron and packaged Finder-like launch
  pass E2E, including non-JavaScript recipes and two profile daemons. Nested
  manifests, other package managers, supervisor-loss recovery and escaped
  descendants remain outside this slice. Spool saturation now reports
  incomplete output independently of a verified successful exit; real-process
  E2E overflows the 1 MiB spool and confirms the result stays successful.
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
- Commits `6d8f573`, `0b4810a`, and `9ea80aa` add F090 output-coverage
  reporting and F088 fail-closed proxy recovery with CLI repair commands.
  The recovery E2E initially raced the asynchronous runtime-stop acknowledgement
  under the integrated suite; it now waits for the exact detached runtime PID
  before taking the saved ports. On macOS 26.6.1 (Apple M4), `pnpm check`
  passes type checking, Fallow, builds, and 70/70 real-process source E2Es.
  `pnpm package:mac` and the packaged suite pass 5/5 with the app hidden from
  the active Space. Rust formatting, strict workspace Clippy, and the GPUI
  prototype build-only package pass. F088, F090 and R006 remain open for the
  limitations above.
- Commits `5f175ec`, `5c6709e` and `7665267` add desktop service URL
  recovery and managed Oh My Pi account inspection, identity pinning,
  per-turn drift fencing, private-home launch and desktop/CLI controls.
  The Oh My Pi login command uses a private working directory, clears
  ambient variables and requires the pinned 18.3.0 CLI. Integrated
  source type checking, Fallow, builds and 72/72 real-process E2Es pass.
  In two earlier full runs, the browser E2E still observed the previous URL
  after requesting a redirect; it now waits for the preceding load to finish,
  and the full rerun passes. The macOS package build and 6/6 packaged E2Es
  pass, including native account inspection through bundled resources.
  Rust formatting, strict workspace Clippy and the legacy GPUI build-only
  package pass as well.
  Hosted Oh My Pi
  OAuth, credential refresh/logout and native fallback behavior remain
  unverified. F021/F025/F027/R012 and F088 remain open.
- At that checkpoint, the planned next work was real-agent account/control
  acceptance, browser ownership and backup/retention coordination. The
  current execution order is recorded in the Current state section above.
- The recurring pending-prompt Quit alert now has a durable local recovery
  path. Electron fsyncs the exact send intent and dispatch state before each
  network handoff, reopens offline with the original profile and request ID
  visible, and retries without a second provider turn. Quit finishes once
  that record is safe, even when the daemon cannot reconcile immediately;
  missing or unsafe records still block it. Real-process E2Es cover crashes
  before draft save, prepare and dispatch, plus a lost completion reply,
  offline reopen and reconnect. A separate review-feedback E2E exposed a
  daemon response that omits empty attachments; desktop now normalizes it
  before journaling a later send. `pnpm check` passes type checking, Fallow,
  builds and 75/75 source E2Es. `pnpm package:mac` and 6/6 packaged E2Es
  pass with hidden windows. A deliberate one-line reversion of the close
  decision reproduced the Quit failure; restoring it passed. The older
  visible ADE processes have not been inspected for pending prompts or
  restarted, so they may still show the alert until they load this build.
  F036 and the wider V1 register remain open.
- Commit `487b907` adds profile ownership for Electron browser session storage
  and recovers interrupted fresh creation and legacy migration after process
  death. A wrong owner refuses selection; a pre-manifest ownerless session
  requires an explicit in-app warning and confirmation before adoption.
  `browser-migration-recovery.spec.ts` passes 9/9 through real Electron and
  ADE processes, including six SIGKILL boundaries. Integrated `pnpm check`
  passes 84/84 source E2Es; the macOS package passes 6/6 packaged E2Es and
  2/2 packaged browser E2Es. The profile-home relocation scenario currently
  fails at the runtime launcher's stale absolute binding before browser
  writes. F092/R014/R015 remain partial: managed backup/restore, retention,
  cross-process session ownership and successful home relocation are not yet
  implemented or verified.
- Commit `13f3e45` adds a crash-released browser profile lease. A second
  Electron process refuses the live owner's profile; after the owner is
  killed, it can select the same profile. Unexpected lease loss closes the
  browser views and surfaces an error. The source suite passes 85/85, the
  final browser/profile rerun 13/13, and the macOS package passes 6/6
  packaged E2Es plus 2/2 packaged browser E2Es. F092/R014/R015 still need
  managed backup/restore, retention and successful profile-home relocation.
- Commit `8c75551` accepts the current schema-v10 profile store during
  runtime adoption and rejects a future schema before writing its binding.
  The real-process E2E restores a conversation through a second runtime home.
  Commit `eeda9db` adds complete paginated conversation history export through
  the CLI, with no overwrite and no published partial file on a later-page
  revision mismatch. F050/R014 still require a managed profile backup and
  restore across all owners.
- Commit `5455362` adds an independently consistent backend snapshot with
  verified checksums and schema versions. Restore requires a new target,
  resets accounts to unverified, excludes live service routes, and drops
  source Worktrunk removal authority. The focused real-process E2E passes.
  An initial integrated `pnpm check` had 88/89 source E2Es pass; an existing
  browser recovery E2E raced its first profile form reset. Commit `a0a377a`
  waits for that reset. Its focused rerun passes 5/5, and final `pnpm check`
  passes 89/89 with type checking, Fallow and builds. F050/R014 still require
  coordinated browser, pending-send, registry and runtime data; R015/F138 need durable attachment upload
  leases before unreferenced-blob cleanup is safe.
- Deterministic provider fixtures are evidence for protocol behavior. They do
  not establish live-account compatibility or quality.

See each domain `issues/` ticket for slice-specific acceptance and limits.

- Commit `fbd7ba0` suppresses native Electron error dialogs for isolated E2E
  profiles. The startup `showErrorBox` was already suppressed when
  `ADE_E2E_USER_DATA_DIR` was set; pending-send and draft-close dialogs were
  the remaining native paths. The focused recovery/startup tests pass 12/12.
  An orphan runtime from an older diagnostics test was stopped after its PID,
  instance, and data directory were verified. The separate prototype
  daemon/runtime pair has an active terminal and was left running.
- Commit `0f3e0bc` adds inherited working-directory and Git-common identity
  checks to review and Worktrunk workers, plus a removal-target check. Six
  real-process E2Es cover replacement at the worker handoff. The committed
  revision passes `pnpm check` (123/123 source E2Es), `pnpm package:mac`,
  packaged E2Es (6/6), Rust formatting, and strict Clippy. The test runs left
  no new ADE processes. This narrows a path replacement race but does not
  close it: Git/Worktrunk can reopen Git metadata or a removal path after the
  final worker check, and provider, PTY, service, and script launches still
  need execution-bound identities. F061/R007/R014 remain open.
- Commit `a3a9f77` adds bounded read-only workspace browse, recursive name
  search and text/raster preview through the daemon and Electron. It rejects
  parent traversal, outside symlinks, replaced roots and delayed results for a
  prior workspace selection. `pnpm check` passes 126/126 source E2Es;
  `pnpm package:mac` and `pnpm test:e2e:package` pass 6/6 packaged E2Es.
  Rust formatting, workspace all-target strict Clippy, desktop typecheck/build
  and the final focused Electron rerun pass. No test-owned ADE process remains.
  Scans over 10,000 directory names or 1,000 search entries report incomplete
  without further pagination; non-UTF-8 names fail the request. F071/F073 and
  R011/R016 remain open.
- Commit `6f40428` replaces the first slice's terminating scan limits with
  expiring, workspace-bound continuation cursors. A 10,025-entry listing and
  1,225-match recursive search complete without duplicate or missing results;
  a no-match search advances after 1,000 names. Real-process E2Es also cover
  cursor replay, cross-workspace misuse, eviction, idle descriptor cleanup,
  active and visited path changes, and hidden Electron continuation. The
  committed revision on arm64 macOS 26.6.1 passes `pnpm check` (135/135 source
  E2Es, one host-filesystem skip), `pnpm package:mac` and 6/6 packaged E2Es.
  Rust formatting and all-target strict Clippy pass. No test-owned daemon or
  runtime remains. F071/F073 stay open for broad performance, mutation and
  preview isolation acceptance; the search depth/visited limits are explicit.
- Commit `da930c7` exposes reviewed stage, unstage and commit in the CLI and
  Electron Changes view. CLI mutations require an explicit reusable request ID.
  Electron fsyncs a profile/workspace-bound Git intent before admission and
  recovers its receipt after SIGKILL/relaunch. Public-protocol, CLI, and hidden
  Electron E2Es cover stale tokens, changed request payloads, failed hooks,
  delayed workspace selection, dropped replies, and crash recovery. `pnpm
  check` passes 141 source E2Es with one host-filesystem skip; a rebuild and
  focused Electron rerun pass 3/3 after the last UI race fix. Rust formatting
  and strict Clippy pass. `pnpm package:mac` and 6/6 packaged E2Es pass.
  Test-owned daemon/runtime processes exit after both suites; the pre-existing ADE Prototype.app daemon/runtime pair under
  `Documents/Codex` was left untouched. The E2E startup failure also exits
  without a native modal. The interrupted Git ID archive has no prune control
  and fails closed at 16 MiB. F075 and F078 remain open.
