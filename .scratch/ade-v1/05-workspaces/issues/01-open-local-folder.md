# Open a local folder from Electron

Status: initial local slice implemented; full project/workspace acceptance open
Type: implementation ticket
Owner: coordinator
Requirements: F061 (initial local slice)
Blocked by: 06-desktop-profiles

Outcome: register an existing local folder through the selected profile daemon,
select its stable workspace ID, and attach its runtime-owned terminal. The UI
accepts an absolute path or uses the native macOS directory picker. Opening
an unavailable path reports an error without changing workspace selection.

Recorded evidence: `e2e/specs/desktop-workspace.spec.ts` passed against real
Electron/daemon/runtime. It rejects a missing folder, opens an existing
folder, restores the same selected workspace after renderer reload, attaches
its terminal, and reopens the folder without duplicate workspace identity.
The full `pnpm check` passed 13/13 running-process E2E cases.

Remaining: repository/folder classification in UI, missing/replaced directory
warnings, worktree lifecycle, remote hosts, and native picker automation.
This slice does not complete F061.
