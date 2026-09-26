# Open a local folder from Electron

Status: complete for F061
Type: implementation ticket
Owner: coordinator
Requirements: F061
Blocked by: 06-desktop-profiles

Outcome: register an existing local folder through the selected profile daemon,
select its stable workspace ID, and attach its runtime-owned terminal. The UI
accepts an absolute path or uses the native macOS directory picker. Opening
an unavailable path reports an error without changing workspace selection.

Recorded evidence: `e2e/specs/desktop-workspace.spec.ts` and
`e2e/specs/workspace-registration.spec.ts` run against real
Electron/daemon/runtime. They register Git projects and ordinary folders,
restore stable identity on reopen, report missing/replaced paths, and refuse
to bind unrelated Git content silently. The running-process catalog case
holds a slow path probe while `hello` remains responsive. The full `pnpm
check` passed 173 source E2Es with one existing host skip, and the installed
macOS suite passed 6/6.

Worktree lifecycle and remote hosts belong to F063 and F121 onward, not F061.
