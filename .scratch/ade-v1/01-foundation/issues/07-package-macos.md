# Package the new Electron desktop for local macOS use

Status: packaged local-use slice accepted; full F005/F007/R020 remain open
Type: implementation ticket
Owner: package_macos, integrated by coordinator
Requirements: F005, F007, R020, 01-S16 (distribution slice)

Problem: development Electron resolves `scripts/profiles.py` and
`target/debug/ade-daemon` relative to the repository. The Rust executables,
Python launcher, provider bridges and native dependencies are not packaged as
Electron resources. A successful `pnpm build` is not an installable ADE app.

Outcome: package a macOS Electron app with explicit resource paths and one
pinned dependency graph. The app must launch with a fresh user data directory
outside the repository, create/select a profile, open a folder, run a terminal
and a deterministic provider turn, close/reopen without stopping runtime work,
and show incompatible-resource errors without replacing a running owner. Keep
the GPUI prototype build working during migration. Measure archive/install size
and identify the provider tree's largest contributors before optimization.

E2E acceptance: run the packaged `.app`, not the Vite development build,
against an isolated profile; exercise the above flow and collect crash/log
artifacts. Test resource resolution without source checkout paths. Treat actual
signed/notarized distribution and app updates as separate later tickets.

Candidate from `docs/monorepo-initialization-plan.md`: electron-builder. Verify
its current official packaging guidance and agent-facing resources before
integrating it. Do not copy the existing GPUI `scripts/package.py` assumptions
into the Electron build.

Local arm64 size measurement, 26 September 2026: the unpacked final `.app` is
2.4 GB; `ditto -c -k --sequesterRsrc --keepParent` produces a 790 MB ZIP.
The provider resources account for most of the unpacked size: Oh My Pi is
1.5 GB and Claude is 515 MB. Within Oh My Pi, `onnxruntime-node` is 287 MB,
`@oh-my-pi/pi-natives-darwin-arm64` is 161 MB, and `onnxruntime-web` is 139 MB.
The ZIP at `dist/electron/Lux-ADE-local-verified.zip` has SHA-256
`7c6b61a53b7b1af411e8a3ab17b7cf33b01e226e878e4d6147cd65f63a997041`.
It is a local measurement only; this ticket does not sign or notarize it.

Packaged acceptance on the integrated build branch after `05c3064` used
`pnpm package:mac` (exit 0) and `pnpm test:e2e:package`
(3/3 passed). The three Playwright scenarios exercise a fresh profile, folder,
PTY, deterministic provider turn and reopen; bundled Codex relay/Bun, Claude
bridge and Oh My Pi bridge through ADE's public protocol; and an incompatible
live-owner refusal. `pnpm exec playwright test --config playwright.package.config.ts
--grep 'packaged provider entry points' --repeat-each=5` passed 5/5, including
new-conversation draft retention and Send availability. Packaged Playwright
launches the app with its test-only hidden-window mode, so acceptance does not
raise a desktop window in the active macOS Space.

A fourth packaged scenario covers two profiles in the installed app. It opens a
separate workspace, terminal and deterministic Codex conversation in each,
reopens the app, switches profiles, and verifies each daemon boot identity,
shell PID, terminal state and catalog stayed independent. Startup profile
selection now settles before a user-initiated switch; the E2E holds startup
selection at a bounded test-only gate to prove the race and its fix. The
integrated check is `pnpm test:e2e:package` (4/4 passed).

Signing, notarization and app updates remain separate release work. Renderer HMR
belongs to 01-S15 and is not covered by this packaged-app check. Primary
providers still need the full live-account and daily-use acceptance before
F005/F007/R020 can be marked complete in the register.

Dependency correction: the installed Electron app now invokes bundled Rust
`ade-control` for profile startup, browser leases, compatible daemon restart and
backend-only backup/restore. The package no longer copies the Python controller
scripts. The source Python prototype tools remain for legacy development tests.
Packaged E2E must prove startup/reopen, lease ownership, backup, restore,
interrupted restore recovery and incompatible live-owner refusal without a
Python executable or Python resources in the product path. This does not close
the broader F005/F007/R020 or complete managed-backup requirements.
