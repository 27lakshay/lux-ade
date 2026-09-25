# Local profile registry and lazy launcher

Status: initial local slice implemented; full profile acceptance remains open
Type: implementation ticket
Owner: profile worker, integrated by coordinator
Requirements: F005, F007 (initial local slice)
Blocked by: 02-client-connection

Outcome: create and select stable local profile identities without changing the
running profiles; lazily attach to or start a compatible per-profile daemon and
runtime. Each profile has its own runtime home, data store and initial workspace.

Owned modules: `scripts/profiles.py`, narrow compatibility fix in
`scripts/runtime.py`, and public-interface E2E in
`e2e/specs/local-profiles.spec.ts`.

Recorded evidence: two profiles ran simultaneously with distinct sockets,
workspace IDs and conversation catalogs. After restarting one daemon, its
profile ID and conversation remained stable. An incompatible endpoint was
refused without removing the existing listener. These scenarios passed in
`pnpm check` (11/11 E2E). Python compilation passed.

Remaining: Electron profile creation/switching, profile-specific account/plugin/
browser isolation, profile retirement and shared-resource conflict handling.
This slice does not complete F005 or F007.
