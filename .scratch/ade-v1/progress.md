# ADE v1 delivery record

Status: active on the daily-use gate; requirements remain unverified until their full acceptance passes.
Type: delivery record

Updated: 2026-09-27. Branch: `codex/architecture-proposal`. No Git remote is
configured. This is a checkpoint, not a claim that the v1 register is complete.

## Parallel build: overnight coordinator log (2026-09-27)

The build now runs as a Claude coordinator plus Workflow workers, following
the [parallel build map](../parallel-build/README.md). The user was asleep and
delegated every decision below; the ones that need confirmation are listed first.

**Confirmed by the user (2026-09-27, morning)**

- Slices merged per round was the stop condition while E2E was paused
  ([ticket 15 amendment](../parallel-build/issues/15-handoff-order.md)). With
  headless E2E back, the stop condition returns to accepted features.
- Backup restore now accepts each versioned database one schema behind the
  current one (`329f27c`); recorded in D15.
- Browser mutations from the CLI now send `operation_id`. A new CLI needs a
  daemon from the same build for those commands; the old `request_id` is still
  accepted by the daemon. Recorded in `docs/compatibility.md`.
- Four legacy Rust tests are ignored because their fixtures predate fail-closed
  path binding or the current schema ladder (`9e10380`); they stay ignored,
  because E2E will cover their behaviour.
- D03 is decided (the roster is in `decisions.md`), and the next step is option C:
  headless backend E2E rounds while the user designs the UI in Pen.

**Phase 0 (foundation), all merged green under `pnpm check:static`**

| Commit | Change |
|---|---|
| `38cae93` | Rules: test policy, ownership rules, reference protocol, operation tiers |
| `ec7d344` | Removed the GPUI client (about 17,000 Rust lines) at your instruction |
| `9e10380` | `check:static` gate, worker bootstrap, sccache, 18 legacy tests repaired |
| `840a4db`–`c4c5833` | Hot files split into per-domain modules: desktop main 1,669 → 243 lines, renderer 1,284 → 317, CLI 1,181 → 239, `sessions.rs` 3,606 → 648, `store.rs` 3,765 → 76 |
| `1274277`–`9a1d1fa`, `9628aef`, `fe5e5f6` | `window.adeHost` per-domain namespaces and a quit-guard registry; the Schemars → JSON Schema → TS types and Ajv pipeline (`@ade/contracts`, `pnpm contract:check`); the shared receipt module with forward-only transitions |

**Phase 1 (trial round), merged green at `329f27c`**

Ten domain workers typed 102 daemon operations (43 queries, 22 idempotent commands, 37 effect commands) with contract
types and declared tiers. Pure-receipt tables for worktrees, terminals, Git and
browser operations moved onto `receipts.rs`. In-process tests grew from 87 to
153. Wall time: about 23 minutes of worker time, plus about 25 minutes of
coordinator merging.

**Phase 2 round A, merged green at `a1d4219`** (219 in-process tests)

| Slice | Result | Requirements advanced |
|---|---|---|
| outbox-daemon | `draft.send.list` and `draft.send.acknowledge`, `review.operation.list` and `review.operation.acknowledge` | R001, R002, R005, F036, F075 |
| sdk-sync-core | Feed catch-up moved from the renderer into `@ade/client/sync`, a Node-free reducer with loading, current and stale states; one shared page limit | R010 |
| backup-rust | Rust backup gains attachment integrity checks, a test-gated pause hook, a destination guard, the pre-schema-12 rejection and lifecycle recovery fields; `browser_lease.py` deleted | F050, R014 |
| browser-crash | Browser mutations reconcile against the owner's real tabs after an owner or daemon crash, settled with evidence or reported unknown | F095, F101, F102 |
| terminal-ownership | Input, resize and detach fenced by stream incarnation, with one explicit viewport owner | F083 |
| runtime-replay | Replay overflow reported as degraded output, not a fake exit; reserved receipt capacity for cancel and settlement | R004, R008 |
| runtime-descendants | Process-tree liveness verdict with TERM-to-KILL escalation, PID-reuse checks and quarantine when emptiness is unproven | R006 |
| session-lease | Leases reconciled against the runtime before new admission after a daemon restart | R005, R006 |
| service-ports | The actual listener verified to belong to the service's process tree; bind failure reported explicitly | F085–F089 |

The coordinator fixed one review blocker: a terminal stop could be dropped
while the process-tree lock was busy (`a1d4219`).

**Phase 2 round B, merged green at `6a098f9`** (333 in-process tests)

| Slice | Result | Requirements advanced |
|---|---|---|
| client-outbox | `@ade/client/outbox` holds only unadmitted operations; desktop recovery after admission uses the daemon list and acknowledge operations | F036, F075, F103, R001, R002, R005 |
| host-resources | Host-level claim registry shared by profiles (device and inode identity, shared and exclusive claims, quarantine); worktree create and remove take claims | Architecture §5, F061–F069 foundation |
| runtime-contracts | Typed daemon-to-runtime protocol (`ade_core::runtime_protocol`) | R020 foundation |
| activity-feed | Durable activity records written in the same transaction as their event; deduplicated desktop notifications | F114, F117 |
| mcp-catalog | Profile MCP catalog with credential references and workspace and provider scope resolution | F131 |
| skill-catalog | Pinned skill bundles with provenance; read-only discovery of external skills | F132 |
| plugin-registry | Pinned plugin installs with activation-generation fencing and namespaced state; no plugin host yet | F051, F059 |
| orchestration | Child conversations with parent links, messages and non-blocking waits (`ade child ...`) | F104, F106, F107 |
| history-search | FTS5 search index as a recoverable projection; combined history | F041, F043 |
| diagnostics | Resource visibility and a redacted diagnostics export (redaction adapted from Orca, MIT) | F136, F137 |

Known gaps from round B:
- Legacy E2E `desktop-send-recovery` assertions will fail by design after the
  outbox change; the evidence file lists them for the UI-phase E2E rewrite.
- New stores (plugins database and artifacts, skill bundles) are not yet in
  backups; round C adds them.

**Phase 2 round C, merged green at `5a95b2c`** (439 in-process tests)

| Slice | Result | Requirements advanced |
|---|---|---|
| backup-coverage | Backup format 3 covers plugin database and artifacts and verifies skill blobs; the history index is rebuilt after restore; the host registry is excluded with a reason; format 2 still restores | F050, F059, R014 |
| worktree-lifecycle | Managed creation with naming defaults, supervised setup and teardown hooks, archive and cleanup that protect dirty, locked, active and uncertain trees | F063, F066, F067, F069 |
| checkpoints | Checkpoints as private Git refs; restore refuses to overwrite unsaved changes (adapted from t3code, MIT) | F070 |
| session-import | Read-only import of native Claude Code and Codex sessions with provenance, searchable | F042 |
| usage-analytics | Provider-reported tokens, cost and limits recorded per turn; unreported figures marked unavailable (adapted from t3code, MIT) | F049, F030 |
| browser-diagnostics | Bounded, redacted console and network capture and recording for an explicitly owned tab | F096, F097 |
| remote-bootstrap | Remote host registry, pinned host keys, SSH bootstrap that reports missing backend artifacts, pairing and revocation | F122, F124 |
| remote-transport | `@ade/client/remote` over an SSH-forwarded socket; a disconnect reports unknown and never falls back to local | F121, F125 |
| retention | Scheduled receipt pruning, blob and log retention with a preview-then-apply generation | F138 |
| parallel-runs | Sibling runs across providers or accounts with a group identity and diff comparison | F105 |

Coordinator fix: the retention sweep was deleting unreferenced uploads older
than 24 hours, a guess about abandonment. It now keeps them; explicit reclaim
still removes them (`5a95b2c`). Legacy E2E `native-control.spec.ts:39` expects
backup format 2 and needs a one-line update when E2E returns.

**Phase 2 round D, merged green at `2d42c18`** (593 in-process tests)

| Slice | Result | Requirements advanced |
|---|---|---|
| worktree-carry-adopt | Carry uncommitted changes through Git plumbing with verification; fetched PR refs as sources; explicit ignored-resource rules | F064, F065, F068 |
| repo-clone-publish | Clone and publish through the system `git`, with exact partial-failure reporting | F062 |
| plugin-host | `packages/plugin-host` Node process over stdio JSON-RPC, supervised with backoff and fenced by activation generation | F057 |
| plugin-hooks | Durable after-commit hook outbox with effect IDs; lost deliveries become unknown, never replayed | F058 |
| provider-capabilities | Revisioned capability records per adapter, readiness, presets validated against capabilities, quota visibility | F027, F028, F029, F030 |
| generic-adapters | Generic ACP adapter and a custom-executable adapter; capabilities come from the agent's own handshake | F022, F024 |
| conversation-controls | Steering, rewind, compaction and snoozing, each exposed only where the provider supports it natively | F035, F039, F040, F046 |
| browser-profiles-context | Named browser profiles, bookmark and history import from unencrypted sources only, design context capture | F092, F093, F094 |
| devices | Screen and accessibility permission state, iOS simulators through `simctl`, Android through `adb` (adapted from Orca, MIT) | F098, F099, F100 |
| placement | Explicit execution host on work items; placement on an unavailable host fails instead of running locally | F126, F127, F129 |

Coordinator fix: carrying changes with source cleanup could lose the staged
version of a file that also had unstaged edits. Cleanup now keeps the source
in that case (`2d42c18`). The carry Git steps are verified only statically; the
worker could not run Git outside its tree, and the first E2E pass must run a
carry end to end.

**Phase 2 round E, merged green at `350dfa3`** (685 in-process tests)

| Slice | Result | Requirements advanced |
|---|---|---|
| provider-plugins | One provider interface for bundled, generic and plugin providers; plugin workers speak a documented JSON-RPC (`docs/provider-worker-protocol.md`); sessions stay leased to their worker version | F023, F021, F024 |
| slash-commands | Native slash commands and skills listed per conversation and invoked in native form, or reported unavailable | F037 |
| context-attachments | Typed context nodes (file ranges, diff hunks, terminal and log ranges, browser captures) with per-provider mapping | F032, F033 |
| account-switching | Explicit account switch where the provider supports it; otherwise a new native session with transferred context | F026 |
| api-parity | Typed `call(op, request)` in `@ade/client`; every operation has CLI and SDK exposure, enforced by a new `check:static` step | F101, F102, F103 |
| resource-claims | HostResources claims for service ports and simulators or emulators | Architecture §5 |
| browser-automation | Click, type, bounded evaluate, wait and screenshot on an explicit owner and tab (adapted from Paseo, Apache-2.0) | F095 |
| plugin-dev-reload | Development-mode plugins reload by activation generation with bounded drain; active provider sessions stay leased | F139 |
| runtime-crash-recovery | After a runtime restart, attempts are classified settled, orphaned or unknown from evidence, never replayed; the rules are in architecture section 4 | R005, R006 |
| draft-stash | Draft history, recall and named stash with revision checks | F036 |

**Boot smoke (not an E2E spec, not committed).** A real daemon and runtime
started on a scratch profile. Through the CLI, 15 read paths answered correctly:
status, workspace open, conversations, provider capabilities, MCP, skills,
plugins, activity, history search, resources, diagnostics, retention preview,
remote hosts, devices and hooks. Six runtimes left by worker checks in removed
worktrees were found and stopped.

**Integration audit and fixes, merged green at `317687a`** (708 in-process tests)

Each slice was checked only in isolation, so eight read-only reviewers audited
the merged code for bugs where slices meet. They reported 40 findings. Each
serious finding went to an independent skeptic: 19 of 20 were confirmed. Eight
fix workers fixed all 19, each with review. The confirmed defects were:

- a late runtime control reply read as the reply to the next command (blocker);
- a quarantined restart attempt settled by `service.stop` without stopping its
  processes (blocker);
- a terminal stop with an unverified process tree reported as exited;
- a worktree lease dropped although the provider stop was unconfirmed;
- `git`, `lsof` and provider-shutdown calls made while holding the global
  Sessions lock;
- a refused steer or compaction that could never settle;
- a quarantined claim deleted by an unrelated lease after a restart;
- carry cleanup able to overwrite live edits in the source;
- plugin hosts re-activated with stale settings;
- the client's SSH forward ignoring the pinned host key;
- stale execution placements surviving host removal;
- restored profiles inheriting the source's runtime incarnations and live
  queued prompts, which the restored daemon would auto-send;
- an online backup deadline that large profiles could never meet;
- a refused Git mutation leaving a desktop outbox record behind.

One fix introduced a new race, in which a provider attached during a failure
could leak without a lease. The coordinator closed it (`317687a`). The boot
smoke passed all 15 read paths again afterwards. The 20 minor findings are in
[the audit record](audit-2026-09-27.md).

**Minor audit findings, merged green** (725 in-process tests)

Eight workers traced all 20 minor findings in the current code, confirmed each
one and fixed it; every fix was reviewed with no blockers. Highlights:
- a replayed slash-command invocation no longer reports `queued` for a
  cancelled prompt;
- answer forms no longer vanish from live updates while an answer is uncertain;
- worktree removal checks physical identity again before deleting;
- a killed `git push` settles as unknown, not "not pushed";
- a shared lease can no longer land inside an unbound creation claim.
The final boot smoke passed all 15 read paths.

**Where the build stops, and what is next**

The backend and CLI now have a first implementation for most v1 feature
families. Nothing is accepted: every acceptance criterion in the register is an
E2E observation, and E2E is paused. The natural next steps need you:
1. **UI phase.** Designs go in Pen first (see project memory). The renderer
   still has the prototype panes on the new per-domain bridge.
2. **E2E return.** Update the legacy assertions each evidence file lists, add
   the E2E each slice names under "needs E2E later", and run a carry end to end
   first.
3. **Live accounts.** Real Oh My Pi and real two-account checks.
4. **Open decisions:** D03 (the additional provider roster; the generic-adapters
   evidence has a proposal), D15 (restore range), and the items under "Needs your
   confirmation" above.

Additional additive wire values introduced by the audit fixes, which no current
client matches exhaustively: `ControlOutcome::Refused` and
`CommandInvokeOutcome::Cancelled`. After an unconfirmed provider stop, a
conversation now shows status `interrupted` instead of `error`.

## Headless E2E, round 1 (2026-09-27, option C)

The protocol E2E harness (`e2e/protocol/`) starts a real daemon and runtime for
each test and fails any test that leaves a process behind. Ten workers proved
the riskiest backend areas and fixed the product bugs they found. The merged
suite passes 205 specs in 54 seconds with 6 workers; 13 are `fixme` for named
gaps. `check:static` passes with 732 in-process tests.

**Accepted in the register (24 features plus R014):** F031, F034, F035, F038,
F041, F042, F049, F051, F057, F058, F063, F064, F065, F066, F068, F069, F070,
F085, F086, F101, F102, F103, F105 and R014. Reviews held back acceptances whose
criteria were not all proven: R001 and R002, F067 (streamed hook status), F083
(authenticated commands), and F087–F090 (claim timing, secret configuration,
remote routing).

Product bugs fixed along the way include:
- carry cleanup never ran, because it used a `git ls-files` option that does
  not exist;
- carry read-back failed after deleting a carried file;
- a link rule under a `node_modules/`-style ignore left trees dirty.

**Found outside their areas; round 2 inputs:**
- The SDK maps unknown daemon error codes to `daemon` and drops recovery
  hints (`host_resource_conflict`, `needs_rebind` and the `lifecycle_*` codes);
  the CLI inherits this.
- Resuming the queue of an interrupted conversation does not dispatch its
  queued prompt.
- A single agent message over 1 MiB fails the conversation.
- A turn lost to a runtime crash is recorded as `turn_interrupted` or
  `operation_unknown` depending on timing.
- Conversations cannot yet launch plugin providers (F023) or generic adapters
  (F024).
- Services have no way to mark configuration values secret (F089).
- A decision is pending on link rules that Git does not ignore: keep refusing
  them, or remove ADE-created links at teardown. None of these is E2E-verified;
each evidence file under `evidence/phase2-*.md` lists what needs E2E later.

## Scope baseline and daily-use gate

The baseline is commit `cada60a`, where `requirements.md` records exactly 107
V1 features, 10 deferred features and 23 exclusions across F001–F140. R001–R020
in the shared reliability spec also apply. No V1 disposition or acceptance has
been changed since that baseline. The local build branch is
`codex/architecture-proposal` in this checkout.

## Current state and next assignment

The user explicitly resumed the broader build on 2026-09-27. The daily-use
gate is still open; other v1 work stays queued until it passes. The three
bounded product dependency corrections are committed and verified. The final
full v1 acceptance audit remains required. Use focused E2Es and affected
static checks during implementation, one full source suite per integrated
checkpoint, and packaged checks for changed packaging or installed behavior.

| Daily-use gate and IDs | Verified | Remaining before gate closes |
|---|---|---|
| Installed runtime/profiles: F005, F007, F010, R005, R020 | Packaged fixture profiles retain distinct daemon, shell and conversation state across reopen; source and packaged desktop E2Es each keep ambient real Codex and Claude turns alive after the last window closes, then show one completed prompt on reopen with the same daemon/runtime/native thread; ambient real Codex and Claude runs also survive compatible daemon handoff | Complete managed-account isolation and runtime-claim acceptance in the installed flow |
| Primary providers/conversations: F021, F025, F027, F031, F038, R001, R002 | Live ambient Codex and Claude prompts, file-reading tools, turn cancel/resume, and native write approvals with exact retry/conflict; Codex native cancel and Claude decline prevent the write. Deterministic managed-identity, prompt/answer recovery, questions and CLI/Electron E2Es; packaged two-account Codex fixture turns retain distinct homes, credentials, and conversations across reopen; installed ambient real Codex and explicit pre-existing native Claude config retain turns through app closure; an unknown Codex item retains safe metadata and ordering across profile and desktop restart | Real Oh My Pi account; real managed two-account execution; native questions and crash/lost-reply recovery across each primary provider; complete F031 multi-provider acceptance |
| Workspace/review: F061, F074 | Both closed: Git projects and ordinary folders reopen with stable identity; missing/replaced paths warn and execution fails closed; large paged diffs, multi-note feedback, durable history/search and uncertain-send recovery | None for these IDs |
| Shell/services/browser: F081, F083, F085, F086, F088, F090, F091 | Persistent shell; CLI attaches a real TTY, resizes, sends large input and detaches without stopping it; CLI now creates a second terminal with a durable same-ID receipt, stops exactly that shell and retires only its terminal in source and installed E2Es; service/script controls, observed ports and health, stable profile browser preview; one script-to-service-to-stable-URL flow survives app reopen and fails closed after stop | F083 input/viewport ownership and incarnation cases; broader F086/F088/F090 feature acceptance, including URL discovery and script supervisor recovery, remains queued after the daily-use gate |
| Shared controls: F101, F102, F103 | Local CLI and Electron share named daemon commands and outcomes, including terminal lifecycle/attachment, cancel/resume, paged diffs and durable review feedback; the installed CLI discovers and targets two GUI-created managed profiles, survives GUI close, cold-starts the chosen daemon without developer tools, and leaves the GUI default unchanged; caller-owned prompt retry IDs reconcile a lost daemon reply without a second fixture provider turn; CLI worktree create/remove and terminal create expose caller-owned IDs and durable receipt lookup with strict same-ID conflict; CLI and daemon read the exact live Electron browser owner and tab and open, navigate and close explicitly targeted tabs with request IDs, durable owner receipts and structured lookup; those receipts reconcile after orderly owner and daemon restart with no duplicate tab; a headless client uses generated types to observe a GUI-created conversation, send, answer and reconcile a malformed reply without duplicating a turn | Full browser automation and abrupt owner-crash recovery; generated contracts for the remaining daily-use commands and daemon-side validation; matching CLI coverage for the rest of the selected flow; broader crash phases and live-provider retry evidence |

Blockers: a real Oh My Pi account is unavailable; the user chose to keep
real two-account verification pending rather than authenticate two ADE-managed
Claude homes now. Fixtures are not live-account proof. Active worker ownership:
none. Next assignment: abrupt browser owner/daemon crash reconciliation and
agent automation through the public operation path, then expand generated SDK
contracts across the remaining daily-use commands. F095/F101–F103 remain
partial; the tested controls are subsets of their acceptance.
The remaining rows are partial evidence, not closed feature IDs. F075/06-S06
and unrelated v1 work remain queued.

## Integrated checkpoints

Live-provider R005 evidence, 2026-09-27: at revision `d583652` on macOS arm64,
`ADE_TEST_DAEMON=$PWD/target/debug/ade-daemon python3 scripts/test_agent_handoff_live.py --run`
passed for ambient authenticated Codex
and Claude. The procedure restarted the compatible daemon while each provider
was streaming, retained the same runtime instance, provider PID/run and native
thread, and observed one user prompt plus the expected completed response.
Provider PIDs 21322 and 24068 exited after test cleanup. This uses real
providers but no ADE-managed account or Electron renderer, so R005 remains
partial; the E2E procedure is in `scripts/test_agent_handoff_live.py`.

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
| `8f70037` | Native negative approval choices | Real Codex cancel and Claude decline, live accept/retry/conflict; CLI/Electron fixture choices, focused 3/3, source 162 passed/one host skip, installed 6/6 |
| `b4f1005`, `cdfdcfa` | F074 paged diff and review admission | 166 source E2Es passed/one host skip; installed 6/6; strict Clippy and rustfmt pass; 5 MiB later-page send, stale edit, crash recovery and stale cursor E2Es |
| `75fbeda` | F074 structured feedback and history | 170 source E2Es passed/one host skip; installed 6/6; multi-note/range, stale edit, history search, uncertain send and pre-dispatch crash E2Es |
| `8aa913a` | F061 live folder/project identity | Git and ordinary folder registration, stable reopen, missing/replaced warning and unrelated-binding refusal E2Es |
| `3279394` | CLI review parity | Named paged diff, feedback search and durable same-ID feedback send E2E |
| `16d4ce2` | Connected daily service flow | Workspace build script feeds managed HTTP service through stable URL and browser preview across app reopen; stopped URL returns 503 |
| `b41d78c` | Direct Git worktree lifecycle | No product wt dependency; create/list/adopt/remove E2E protects external, dirty, locked and active trees; F063/F065/F069 wording corrected |
| `eb96b56` | Project toolchain resolution | Monorepo-root declarations, exact installed tool versions and Finder-style discovery; real npm/pnpm/Yarn/Bun E2Es |
| `ccb0bad` | Native Rust control | Installed profile startup/restart, browser lease and backend-only backup/restore without Python; packaged interrupted-restore recovery E2E |
| `3365033` | Account and background continuity evidence | Packaged two Codex fixture accounts keep separate native credentials and sessions through headless turns and reopen; source desktop keeps one provider tool active while closed and renders its result once |
| `c95efa8` | Provider daemon handoff evidence | Compatible daemon replacement retains the running fixture tool, runtime and native session without a second dispatch |
| `a979b98` | CLI terminal attachment | Real PTY resize, 70,000-byte paste, Ctrl-] detach and signal TTY restoration; same shell PID remains alive |
| `9434098` | Safe unfamiliar native item fallback | Unknown Codex item metadata and message order survive cold profile and desktop restart; private reasoning and unknown payload fields are excluded |
| `fbd7f39` | Managed-profile CLI targeting | Repository CLI discovers and selects two GUI-created profiles by ID, isolates their workspace/conversation state, and leaves GUI selection unchanged |
| `1d45a52` | Structured CLI E2E errors | Playwright child Node commands no longer mix conflicting color settings into JSON stderr; affected focused 8/8 and full source 183 passed/one host skip |
| `0b400c3` | Installed macOS CLI | App bundle includes `ade` and its client closure; stripped-PATH symlink invocation, GUI profile isolation and cold CLI daemon start; packaged 9/9 |
| `dfc82fe` | Caller-owned CLI prompt retry | Dropped accepted daemon reply, same-ID retry across compatible handoff, one Codex fixture dispatch, payload and target conflicts |
| `95a58c0` | Real desktop provider continuity | Ambient authenticated Codex and Claude turns keep one prompt, native thread and daemon/runtime identity after the last window closes and reopens; opt-in live E2E 2/2 |
| `630ba33` | CLI worktree retry and receipt | Caller-owned IDs for create/remove, named operation lookup, same-ID retry and changed-target conflict E2E |
| `23ee13e` | Packaged native provider discovery | Finder-style PATH resolves installed Codex/Claude from host tool locations; opt-in live installed E2E proves both turns active after last-window close and complete once after reopen |
| `c5e341b` | Retry-safe CLI terminal lifecycle | Installed and source CLI create, inspect, stop and retire one selected terminal; caller-owned creation receipt survives a lost reply; schema-16 backup and restore gates agree |
| `7dc1c84` | Profile-bound browser owner reads | Electron owner socket, daemon forwarder and named CLI owner/list/inspect; stale owner, closed tab and profile-switch race E2Es; source 189 passed/one host skip, packaged 9/9 |
| `5445e35` | Retry-safe browser mutations | Public daemon/CLI open, navigate, close and receipt lookup; durable Electron owner receipts, same-ID conflict/unknown fencing, 513-action E2E, backup coordination; source 191 passed/one host skip, packaged 9/9 |
| `542b0fa` | Generated headless daily-use client | Selected wire manifest and dependency-free generator, typed catalog/conversation/send/answer/feed, conservative delivery status, GUI-created conversation and malformed-reply E2E; source 192 passed/one host skip, packaged 9/9 |
| `0a5d4eb` | Browser receipt restart acceptance | Real Electron owner and managed daemon orderly restart retain the original mutation receipt, reject a same-ID new-owner action and preserve one tab; focused E2E and typecheck passed |

Browser restart checkpoint, 2026-09-27: no full feature ID closes. The
running-app E2E now restarts both the Electron owner and managed daemon with
the same profile. `browser.operation` recovers the durable original result,
while a request using that ID against the new owner fails and leaves one tab.
This covers orderly restart; abrupt owner death and uncertain in-flight
effects remain. Focused E2E and affected typecheck passed. Approximate time:
implementation 8 minutes, review 2 minutes, checks 2 minutes, packaging
0 minutes. The previous full source and packaged suites remain the latest
integrated checkpoint because only E2E coverage changed.

Headless client checkpoint, 2026-09-27: no full feature ID closes.
F103 has a verified framework-independent client path for a GUI-created
conversation, typed feed/catalog/snapshot, prompt send and native answer.
The real daemon omitted empty message attachments, so the generated schema was
corrected from E2E evidence. A reviewer found that the first error mapping
could label a post-provider error as rejected; the final transport marks
post-send daemon, malformed-reply and lost-connection outcomes unknown unless
the daemon explicitly proves pre-admission rejection. Native answer delivery
before daemon death and a corrupt prompt ack exercise that rule. Generation
drift is checked in client build/typecheck. The Rust daemon does not consume
the manifest, and other daily-use commands/providers need contracts and E2E
coverage. Final source acceptance: 192/193 passed with one host skip;
packaged acceptance: 9/9. Approximate time: implementation 25 minutes,
review 8 minutes, source checks 7 minutes, packaging and installed checks
2 minutes. Next focus stays on the open daily-use gate.

Browser mutation checkpoint, 2026-09-27: no full feature ID closes.
F095 still needs agent browser automation beyond navigation, F101/F102 need
full daily-use control parity, and F103 needs generated headless contracts.
The daemon keeps an in-memory in-flight/unknown journal; Electron keeps durable
per-request receipts, and `browser.operation` can query them when the daemon
has no local record. Source E2Es cover direct retry and unknown owner replies;
installed E2Es cover the CLI mutation path. The reviewer found and we fixed a
permanent 512-receipt limit and a tab-file ledger coupling; a later full run
found backup capture rejecting an already-admitted open, which was fixed by
joining the existing browser operation barrier. Final source acceptance passed
191/192 with one host skip; packaged acceptance passed 9/9. Approximate time:
implementation 50 minutes, review 10 minutes, source checks 15 minutes,
packaging and installed checks 2 minutes. Owner and daemon restart together,
corrupt receipt recovery and DOM automation remain unverified.

Browser owner read checkpoint, 2026-09-27: the installed CLI reads the exact
active Electron owner and tab, and refuses inactive or closed targets. A
review-identified A→B→A tab-open race is fenced by the lease object. No full
feature ID closes: F095 needs public mutation and automation, F101–F103 need
the remaining command and SDK acceptance. The initial packaged run exposed a
client error-mapping fault; mapping explicit daemon `unavailable` outcomes and
rebuilding made all 9 packaged E2Es pass. Full source acceptance passed twice
at 189/190 with one host skip, with the second run after the client change.
Approximate checkpoint time: implementation 25 minutes, review 5 minutes,
source checks 13 minutes, packaging and installed checks 3 minutes. The next
slice stays on public browser mutations; no unrelated v1 work is active.

CLI terminal lifecycle checkpoint, 2026-09-27: terminal create/stop/retire and
durable same-ID creation receipt acceptance are verified through the running
daemon and installed CLI. No full feature ID closes: F083 still needs
input/viewport ownership and incarnation coverage; F101–F103 still need the
remaining shared-control and SDK acceptance. A review caught the initial
duplicate-create risk, which the receipt and lost-reply E2E resolved; final
read-only review found no P1/P2. The final `pnpm check` passed type checking,
Fallow and 186 source E2Es with one host skip; strict Clippy and rustfmt passed;
the rebuilt installed suite passed 9/9. Estimated time: implementation 12
minutes, review 4 minutes, focused and full checks 22 minutes, packaging and
installed checks 3 minutes.

Installed real-provider continuity checkpoint, 2026-09-27: no feature ID is
fully closed by this ambient-account evidence. On macOS arm64, the initial
opt-in installed live E2E failed because Finder-style PATH could not find the
host's Codex and Claude executables; a later strict Claude run failed auth
until the test explicitly used its pre-existing `CLAUDE_CONFIG_DIR`. These
were distinct tool discovery and test-auth conditions. At `23ee13e`,
`ADE_RUN_LIVE_PROVIDERS=1 pnpm exec playwright test --config
playwright.live.config.ts e2e/live/packaged-provider-continuity.spec.ts`
passed 2/2 with the turn confirmed running after window close, the same
daemon/runtime/native thread, one prompt and a completed answer after reopen.
The final `pnpm check` passed type checking, Fallow and 185 source E2Es with
one host skip; strict Rust Clippy and rustfmt passed; the rebuilt installed
suite passed 9/9. An independent review found no remaining P1/P2 after
the live test was tightened to exclude inherited provider overrides and to
retain data when cleanup ownership is uncertain. No test-owned live process
remained. Estimated time: implementation 10 minutes, review 5 minutes,
checks and diagnostic runs 17 minutes, packaging 0.5 minutes. Managed-account
real execution and real Oh My Pi remain pending.

Daily-use CLI worktree checkpoint, 2026-09-27: no feature ID is fully closed
by this retry slice. `pnpm check` passed type checking, Fallow and 185 source
E2Es with one existing host skip; the new focused E2E passed 1/1. After
`pnpm package:mac`, installed checks passed 9/9. The CLI requires a retained
request ID for create/remove and exposes `worktree operation` so a lost reply
can be inspected before retry. Implementation took about 4 minutes, review
about 2 minutes, source checks 6.1 minutes and packaging plus installed checks
about 1 minute. Broader CLI parity, real-provider retry and managed-account
evidence remain open.

Daily-use real desktop continuity checkpoint, 2026-09-27: no feature ID is
fully closed by this source-only evidence. `ADE_RUN_LIVE_PROVIDERS=1 pnpm
test:e2e:live:desktop` passed 2/2 on macOS arm64 against ambient authenticated
Codex and Claude. Each real turn continued after the last Electron window
closed and the same conversation completed after reopen, with one user prompt,
the same provider thread and unchanged daemon boot/runtime instance. This does
not establish ADE-managed account continuity or installed-app behavior. The
new opt-in live suite is excluded from the normal deterministic source suite;
the previous integrated source suite passed 184 E2Es with one host skip.
Implementation took about 3 minutes, review about 2 minutes, the live checks
1.7 minutes, and packaging 0 minutes because no packaging input changed.

Daily-use CLI retry checkpoint, 2026-09-27: no feature ID is fully closed by
this fixture-backed boundary. On macOS arm64, `pnpm check` passed 184 E2Es with
one existing host skip, including type checking and Fallow, on `dfc82fe`. The app was
rebuilt with `pnpm package:mac`, then the installed suite passed 9/9. The
CLI lost-reply E2E is `e2e/specs/cli-send-retry.spec.ts`; an independent review
found no P1/P2 in request-ID parsing, one-dispatch proof or ownership cleanup.
No test-owned retry or packaged CLI process remains. Implementation and review
were not separately timed; the full source check took 6.1 minutes, package
rebuild about 21 seconds, and installed E2Es 37.2 seconds. Broader R001 crash
phases and real-provider retries remain open.

Daily-use CLI/unknown-item checkpoint, 2026-09-27: no feature ID is fully
closed by these slices. `pnpm check` passed 183 E2Es with one existing host
skip, including type checking and Fallow, after a failed run exposed conflicting
`NO_COLOR`/`FORCE_COLOR` warnings in child Node errors. Eight focused affected
CLI E2Es passed after the harness fix. Strict ade-runtime Clippy and Rust
formatting passed. `pnpm package:mac` and the rebuilt installed suite passed
9/9; the focused installed CLI E2E passed again after its last cleanup edit.
Independent reviews cleared privacy, test ownership and cold-start findings.
Implementation and review were not separately timed; the failed full source
run took 5.9 minutes, the passing full source run 6.0 minutes, focused CLI
checks 20.9 seconds, and installed E2Es 28.0 seconds. Two package builds took
about 53 seconds combined after the first build exposed a missing staged client
module. No test-owned process remains. One inactive test
directory remains because automatic approval review rejected recursive removal;
the test profile in it is inactive and outside the installed product.

Daily-use CLI/handoff checkpoint, 2026-09-27: no feature ID is fully closed by
these slices. Independent review found no remaining actionable issue after
large-paste framing and TTY-signal fixes. `pnpm check` passed 181 E2Es with one
existing host skip, including type checking and Fallow. Implementation and
review were not separately timed; the integrated source check took 5.9
minutes, and packaging took zero minutes because no packaging input or
installed-app behavior changed. The installed suite last passed 8/8 at the
previous checkpoint. Real two-account verification remains pending by user
choice.

Daily-use continuity checkpoint, 2026-09-27: no feature ID is fully closed by
fixture-only evidence. The new E2Es passed independent review after fixing
async account-capture races, a missing credential-isolation assertion, and
false-pass risks in tool survival. `pnpm check` passed 179 E2Es with one existing
host skip, including type checking and Fallow. The unchanged installed app
passed 8/8 packaged E2Es. Implementation and review were not separately timed;
the full source run took 6.0 minutes, and the installed run took 27.5 seconds.
No packaged rebuild was needed because product packaging inputs were unchanged.
The next slice stays on the daily-use gate.

Bounded dependency correction checkpoint, 2026-09-26: all three correction
acceptance slices pass. Direct Git worktree operations require explicit adoption
and retain dirty, locked, active and external safeguards. Workspace scripts use
the applicable monorepo root and verified installed tool versions. The installed
app ships `ade-control` instead of Python controllers and can resume an
interrupted backend restore. The full source check passed 178 E2Es with one
existing host skip; the rebuilt installed suite passed 7/7. Strict daemon
Clippy, Rust formatting, and diff checks pass. No daily-use gate ID was closed
by these corrections. Implementation and review were not separately timed;
the final full source run took 5.8 minutes, and rebuild plus installed checks
took about one minute. Broader v1 work remains paused.

Connected service checkpoint, 2026-09-26: the selected daily-use
script-to-service-to-preview scenario now passes through Electron, CLI and a
real daemon/runtime. The full source check passed (Playwright last-run status:
passed); the focused E2E passed 1/1 after correcting its success-label
expectation. The installed suite was not repeated because only E2E coverage
changed. No test-owned ADE process remains. F086/F088/F090 remain unverified
for their broader feature acceptance. Approximate time: implementation 3
minutes, local review 1 minute, focused checks and diagnosis 1 minute, full
source checks 5.5 minutes, packaging 0 minutes. The next slice stays on the
daily-use provider gate.

F061/CLI review checkpoint, 2026-09-26: F061 is verified; F074 remains
verified. F061 required cases pass for both Git projects and ordinary folders,
stable reopen and missing/replaced directory reports without unrelated
binding. A reviewer found that path probing held the daemon data lock; the
probe now occurs outside it and a running-process E2E checks concurrent
`hello`. CLI review controls share the daemon's paged diff and feedback
history, and use a durable send intent for same-ID uncertain retries. F101–F103
remain open for the rest of the daily-use CLI flow. Final focused E2Es passed
5/5; full source checks passed 173 with one existing host skip, including
typecheck and Fallow; strict daemon Clippy and rustfmt passed. Packaged macOS
checks passed 6/6. No test-owned ADE process remains. Approximate time:
implementation 10 minutes, review 3 minutes overlapping implementation,
focused/static checks 1 minute, full source 5.2 minutes, packaging and
installed checks 1.2 minutes. The next slice stays on the daily-use gate.

F074 structured-feedback checkpoint, 2026-09-26: F074 is verified; the daily-use
workspace/review row remains open for F061. Review findings in the current
slice were fixed: note-size mismatch, mixed search pagination, one-note history
omission and unanchored note loss. The final independent pass found no other
confirmed current-slice P1/P2. The review E2Es all passed in the full source
suite after a focused rerun verified the legacy recovery case. The full
source suite passed 170 with one existing host skip; Fallow, type checking,
rustfmt and strict Clippy passed. Packaged macOS checks passed 6/6. No
test-owned ADE processes remain after the passing runs. Two runtimes leaked by
failed intermediate runs were identified by E2E data paths and stopped; the
failed-run teardown improvement stays queued outside the daily-use gate.
Approximate elapsed time: implementation 17 minutes; independent review 5
minutes (overlapping implementation); focused checks and failure diagnosis 5
minutes; full source check 5.1 minutes; packaging and installed checks 1.2
minutes. The next slice should keep focused checks until review findings close.

F074 paging/admission checkpoint, 2026-09-26: the daily-use large-diff,
daemon admission and crash-retry subcriteria close. `review.diff_page` serves
bounded pages for diffs up to 16 MiB. A changed diff after local send journaling
is rejected before provider dispatch; a crashed Electron process restores the
anchor, note and original request ID. The independent reviewer found no
remaining current-slice P1/P2 under the linearization contract above. Full
F074 remains open for multi-range notes, structured anchors and history.
Implementation occupied about 20 minutes; independent review about 2 minutes
and overlapped implementation; focused checks about 2 minutes; three full
source runs took 4.6, 4.9 and 4.9 minutes; packaging plus installed checks
about 1 minute. The first two source runs failed because schema-15 backup and
legacy fixture expectations had not been propagated; the final run passed
166 with one existing host skip. The packaged suite passed 6/6. Five orphaned
test-owned runtimes from failed runs were identified by their E2E data paths
and stopped; the passing source and packaged runs left none. Their failed-run
teardown is queued as a test-harness improvement outside the daily-use gate.
For the next schema change, inspect every version gate in the daemon, launcher,
backup helper and E2E fixtures before the full source run; run focused migration
and backup E2Es first.

Native-choice checkpoint `8f70037`: F021/F038's ambient Codex and Claude
prompt, read-tool, active-turn cancel/resume and native write approval/negative
choice observations pass. Codex offered `accept`/`cancel` and interrupted its
turn on cancel; Claude's decline returned ready. Exact answer repeats
acknowledged and changed decisions conflicted; the disposable file appeared
only after acceptance. An independent reviewer found three current-slice
defects in probe safety and UI choice semantics; all were fixed and re-reviewed
with no confirmed P1/P2 remaining. F021/F038 remain open for managed accounts,
native questions, crash/lost-reply recovery, Oh My Pi and installed flow.
Implementation and triage occupied about 19 minutes from the first live
control check to final code freeze; independent review overlapped and its
elapsed time was not separately metered. Final focused E2Es took 5.5 seconds;
the full source suite took 4.7 minutes; final guarded live approval runs took
28.34 seconds for Codex and 15.39 seconds for Claude. Packaging plus installed
E2Es took about 58 seconds. Failed exploratory live runs were changed before
retry, and the integrated source suite ran once after code freeze. An earlier
source run was interrupted for review fixes and left one test-owned runtime;
it was stopped through its checked instance ID. The completed source and
packaged runs left no test-owned ADE processes. SIGINT cleanup is queued as an
unrelated test-harness improvement, not a reopened normal-teardown failure.

Live-provider checkpoint, 2026-09-26: an opt-in `--tool-probe` in
`scripts/live_provider_check.py` asks each native provider to read a unique
file from a disposable workspace. Ambient Codex and Claude returned the exact
file token and each exposed a tool message in ADE's transcript (10.65 and
4.85 seconds). Their ordinary no-tool prompts also passed (6.31 and 2.95
seconds). This closes the observed single-account prompt/tool criteria for
those two providers only; real approval, answer recovery, cancel/resume,
managed two-account execution and Oh My Pi remain. Implementation and local
review were not metered separately; the observed interval from the baseline
run to the tool run was 2 minutes 22 seconds, including coding and inspection.
Checks took about 25 seconds across both live runs plus Python compilation and
diff validation; packaging took 0 seconds because no packaging input changed.
The full source suite was not repeated for this opt-in script-only change.

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

## Headless E2E, round 2

Ten workers fixed round 1's cross-area bugs and proved further areas. The
merged suite passes 352 specs in 2.2 minutes with 6 workers; 15 are `fixme`.
`check:static` passes with 750 in-process tests.

**Newly accepted (18):** F027, F028, F029, F030, F124, F125, F127, F067, F083,
F087, F088, F090, F032, F033, F036, F037, F040 and F046. The register now
holds 41 accepted features plus R014.

Fixed and proven:
- the SDK and CLI keep daemon error codes and recovery hints, and the CLI
  documents its exit codes;
- queue resume after an interrupt dispatches;
- oversized agent messages are bounded;
- crash classification is deterministic;
- conversations can launch generic ACP and custom adapters and plugin
  providers, pending the fix round below;
- streamed hook status and authenticated terminal commands;
- the remote tests run over a fake-`ssh` fixture with a pinned host key.

**Held back:**
- F023 and F024, until plugin uninstall stops deleting provider leases before
  admission.
- F089, until secret service values are stored as references rather than plain
  text.
- R001 and R002: the evidence over-claimed again.
- F039 (rewind) was not claimed.
- F098–F100 and F131/F132/F043/F136–F138 were proven only partly; see
  `evidence/e2e-devices.md` and `evidence/e2e-ops.md`.

A fix round covers the two blockers and the delegation provider gap. Browser
automation and diagnostics (F091–F097) live in Electron main and wait for
Electron E2E in the UI phase.

## Headless E2E, round 3

**Merged:** seven of ten slices. `check:static` passes with 770 in-process tests.
The protocol suite runs 506 passing specs in 3.7 minutes with one
deterministic failure, `reliability-a/overload.spec.ts` "with the data volume
full". Since the merge, a cancellation under a full data volume is reported as
recorded, where the slice expected an explicit failure. Two merged slices
disagree about where cancellation is recorded under storage failure; this needs
a fix. It affects R004, which is not accepted.

**Newly accepted (17):** R006, R008, R009, R010, R017, F010, F075, F099, F100,
F104, F106, F107, F117, F121, F122, F126 and F129. The register now holds 58
accepted rows.

**Not merged:**
- **secret-refs:** secrets stored as Keychain or environment references. Its
  final E2E never completed, because the Mac's keychain service (securityd)
  stopped answering during its runs; it answers again now. Review also found
  that a restored profile could delete another profile's Keychain item through
  plugin credential references. Held for a fix and a full rerun, with keychain
  specs serialized.
- **reliability-c:** R007, R013, R015 and R018 pass, but the slice broke the
  `browser.list` and `browser.inspect` wire shape for the real Electron owner
  in fixed-socket mode. Held for a fix.
- **ops-3:** the worker lost network access mid-run (DNS failure). Its branch
  has five unreviewed commits (native Claude rewind, MCP catalog wired into
  launches, retention limits, SSH clone and publish). Held for completion and
  review.

