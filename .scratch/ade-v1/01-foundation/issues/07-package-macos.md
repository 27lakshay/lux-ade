# Package the new Electron desktop for local macOS use

Status: ready after desktop drafts and profile selection
Type: implementation ticket
Owner: unassigned
Requirements: F005, F007, 01-S15/16 (distribution slice)

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
