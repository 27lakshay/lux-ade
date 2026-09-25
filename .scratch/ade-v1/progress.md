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
| Providers and conversations: F021, F025, F027, F031, F038, R001, R002 | Select each real primary agent and account; prompt, inspect tools, answer/decline, cancel and resume with truthful retry outcome | Codex/Claude single-account live prompts passed; Oh My Pi lacks configured account; account and full control flows remain |
| Workspaces and review: F061, F074 | Open a folder, inspect changed files and give agent feedback on a diff | Folder opens; diff review and feedback are next |
| Terminal, service and browser: F081, F083, F085, F086, F091 | Keep one shell alive through UI reload; discover/start/stop a dev service and open its preview in the embedded browser | Shell and managed-service controls pass; listener discovery, readiness and embedded browser remain |
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

At integrated revision `814975c` on macOS arm64, `pnpm check` passed TypeScript
type checking, Fallow, backend and desktop/CLI builds, and 25/25 real-process
E2Es in `e2e/specs/`. `pnpm test:e2e:package` passed 3/3 running-packaged-app
E2Es in `e2e/packaged/macos.spec.ts`; the provider/new-draft scenario passed
5/5 repeated runs. `node scripts/cargo.mjs fmt --all -- --check` and strict
Clippy passed. `pnpm --filter ade-claude-adapter test` passed 9/9 legacy bridge
cases; `pnpm --filter ade-omp-bridge test` passed 37 with 3 live-only skips.
`PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH" bash scripts/run.sh
--build-only` built and packaged the GPUI prototype; its GUI startup was not
verified. Build output is local and unsigned.

| Requirement slice | Implementation commit | Reproducible acceptance at `814975c` | Result and evidence |
|---|---|---|---|
| R001/R002/F036, partial | `8ffdf3f` | `pnpm check` on macOS arm64 | Pass: `e2e/specs/daemon-send-intent.spec.ts`, `desktop-send-recovery.spec.ts`; Electron SIGKILL/relaunch, lost replies and one provider turn. Daemon SIGKILL boundaries remain. |
| F031/F036, partial | `4e7d91c` | `pnpm check` on macOS arm64 | Pass: `e2e/specs/desktop-conversation-switch.spec.ts`; new-conversation typing survives catalog catch-up. |
| F085/F086, partial | `4e7d91c` | `pnpm check` on macOS arm64 | Pass: `e2e/specs/desktop-services.spec.ts`; real HTTP process survives UI closure and stops. Listener discovery/readiness remain. |
| F005/F007/R020/01-S16, partial | `814975c` | `pnpm package:mac`, `pnpm test:e2e:package` on macOS arm64 | Pass: `e2e/packaged/macos.spec.ts`, local `.app` and ZIP; provider fixtures are not live accounts. |

The packaged `.app` is 2.4 GB unpacked and the local ZIP is 790 MB at
`dist/electron/Lux-ADE-local-verified.zip`, SHA-256
`24e407ad8dabd5abfae96f52d9b77f7ccb44d4f507dc29f6f29e52796591724d`.
Oh My Pi uses about 1.5 GB unpacked and Claude about 515 MB. The package is
unsigned; signing and notarization remain release work.

Separate opt-in live check on this Mac: Codex CLI 0.153.4 reached `ready` and
returned the expected answer in 5.9 seconds; Claude Code 2.1.282 did so in
2.86 seconds. Oh My Pi reached `error` after 2.85 seconds. This Mac has no
`~/.pi/agent/auth.json` and no common provider API key in the environment;
the failure may have another cause and needs a configured-account rerun.
The repeatable command is `pnpm test:e2e:live codex claude omp`.

The 25 main E2E cases and 3 packaged cases are narrow slices. No entire v1
domain or 140-item requirement
register is marked complete by this record.

Manual development smoke: `pnpm dev` created a managed Development profile,
Electron attached to its daemon and shell, and the first run registered this
checkout as a workspace. The test daemon/runtime were stopped through their
recorded identities. The local command guard refused recursive deletion of the
disposable `/tmp/ade-dev-smoke.DwLZ6c` directory, which remains.

## Active and next work

- No worker is active. `durable_send_intent`, `package_macos` and
  `service_daily_flow` delivered their slices. `send_reconciliation` and
  `client_connection` independently reviewed the send/service, package and
  conversation-selection changes and prepared the F074 ticket. All shared
  this checkout; no worker worktree was created. Root integrated and committed
  on `codex/architecture-proposal`.
- Send-intent review closed altered/rejected/aborted request-ID dispatch,
  delayed prepare and accepted-message ID reuse holes. Concurrent completion
  across separate draft reads and daemon-crash boundary acceptance remain.
  No R001/R002/R010 criterion is closed.
- Managed-service CLI/Electron control passes a real HTTP process E2E through
  full app closure and restart, with an invalid recipe error. F085 arbitrary
  listener discovery and F086 readiness/log acceptance remain open.
- Electron profile creation/switching works in local development; the packaged
  app bundles the profile launcher. Installed multi-profile continuity remains.
- Workspace opening works for local folders; repository and worktree lifecycle
  acceptance remains.
- Drafts survive renderer reload, send-reply loss and an Electron process crash,
  and clear after acknowledged send. Recall/stash, transfer, conflicting clients
  and daemon-crash acceptance remain.
- Conversation pagination, native attachments/context, queues,
  broader approval forms, and live Oh My Pi verification remain.
- Account management, extensible providers/plugins, worktrees, dev services,
  browsers, notifications, remote hosts, unified catalogs/history, customization,
  operations and reliability acceptance remain in the v1 register.
- Next daily-use work: implement `06-files-git/issues/01-diff-review-feedback.md`,
  then embedded browser preview, listener discovery/readiness, and real-agent
  account/control acceptance. Continue through the full V1 register afterward.
- Deterministic provider fixtures are evidence for protocol behavior. They do
  not establish live-account compatibility or quality.

See each domain `issues/` ticket for slice-specific acceptance and limits.
