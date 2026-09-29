# 08 — Add focused test selection with an explanation mode

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** complete (verified 2026-09-29)

**What to build:** Developers can run a conservative subset for their changes and see why each suite was selected without mistaking that run for full acceptance.

**Blocked by:** [03 — Detect tests that belong to no gate](03-discovery-validation.md); [06 — Provide one complete local acceptance command](06-local-acceptance.md)

## Acceptance criteria

- [x] Provide `pnpm test:affected --base <ref> --list` and an execution mode using the same rules. Include committed differences and staged, unstaged, untracked, renamed and deleted files.
- [x] Shared contracts select contract/parity checks, affected Rust tests and all protocol/desktop acceptance; shared daemon/runtime ownership, receipts or admission changes select full protocol and relevant desktop coverage.
- [x] Map SDK, provider, renderer and Electron changes to their consumers and lifecycle/recovery acceptance. Shared fixtures, runner configuration and lockfiles expand selection across affected suites.
- [x] A missing base, unknown path or unsupported relationship falls back to broad coverage rather than empty success; explain the selecting rule for every suite.
- [x] Test shared Rust changes, contracts, renames, deletions, untracked/unstaged changes, missing bases and unknown paths.
- [x] Preserve full required acceptance; focused output explicitly describes its limited scope and forwards runner failures and cancellation.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.

## Comments


### 2026-09-29 — Selection execution evidence

Selection and CLI regression tests passed, including real temporary Git changes,
missing-base fallback, runner exit 7 and cancellation exit 130 with child cleanup.
Current-worktree list mode selected static, protocol and desktop; missing-base list
mode also selected broad coverage without running tests.

`pnpm test:affected --base HEAD --workers 5` produced
`affected-f67e1356-5a05-4a2c-bd19-1243dc8490fb`: static passed, protocol passed
978 cases with five skips in 526.5 seconds, desktop failed one case and the parent
returned exit 1. This demonstrates actual downstream failure propagation. The desktop
case's synchronization error is recorded in ticket 05; after fixing it the complete
seven-case desktop suite passed with five workers. The current static gate is pending
before this ticket is marked complete. These timings are diagnostic, not a benchmark.

Final static verification: `pnpm check:static` passed all 25 stages in `static-dcfb59df-5143-46b0-af0b-836e3853e26d`. Ticket 08 is complete; remaining benchmark and CI proof belong to tickets 05 and 07.
