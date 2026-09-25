# Electron local profile selection

Status: initial local slice implemented; packaged profile flow remains open
Type: implementation ticket
Owner: desktop profile worker, integrated by coordinator
Requirements: F007, F010, 01-S15 (initial local slice)
Blocked by: 05-local-profile-launcher

Outcome: create/select local profiles in Electron. Switching replaces the client
projection and UI terminal attachment, while existing profile daemons and
runtime work remain alive. An explicit ADE_SOCKET continues to select a fixed
connection for isolated tests and external launchers. `pnpm dev` creates a
managed Development profile by default.

Recorded evidence: `e2e/specs/desktop-profiles.spec.ts` passed against two real
profile daemons. Conversation catalogs were isolated; switching back restored
the first catalog and neither daemon boot ID changed. The full `pnpm check`
passed 12/12 running-process E2E cases. Impeccable UI detector reported no
findings for the changed renderer files.

Remaining: native/package resource paths for `scripts/profiles.py`, Python and
Rust binaries, profile-specific accounts/plugins/browser data, profile
retirement, and shared physical-resource conflicts. This slice does not
complete F007 or F010.
