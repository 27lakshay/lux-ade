# Local CLI over the shared command protocol

Status: initial local slice implemented; full CLI/API acceptance remains open
Type: implementation ticket
Owner: CLI worker
Requirements: F101, F102, F103, F083 (initial local slice)
Blocked by: 02-client-connection, 01-xterm-surface

Outcome: a headless `ade` CLI attaches to an explicit profile socket, discovers
workspaces and terminals, and controls a runtime-owned terminal through the
same daemon protocol as Electron. Keep process ownership in Rust and avoid a
second business-logic implementation in the CLI.

Owned modules: `apps/cli`, CLI-specific scripts, and additive public client
commands in `packages/client`. Do not edit Electron, Rust, root scripts or
lockfile without coordinating with the coordinator.

E2E acceptance: with an isolated real daemon and Electron, list the same
workspace, send a shell command from the CLI, observe output in Electron,
resize/inspect the same terminal through CLI, and return structured errors and
stable exit codes for an unavailable or incompatible endpoint. A live provider
case is separate.

Completion evidence: committed implementation, full checks, observed shared
terminal identity and explicit limits. F101/F102/F103 remain open until their
full v1 surfaces pass their spec acceptance.

Recorded evidence: `e2e/specs/local-cli.spec.ts` passed against a real isolated
daemon and Electron. CLI and desktop observed the same terminal ID and shell
PID; shell output submitted by CLI appeared in Electron. Missing and
incompatible endpoints returned stable structured errors. Terminal input
acknowledgement does not prove shell command completion. Profile discovery,
remote transport, attach mode, and stable public schemas remain open.

Additional partial F085/F086/F102 evidence, 26 September 2026: named
`listener list` and `service inspect WORKSPACE_ID NAME [TAIL_BYTES]` commands
use the existing daemon operations and report JSON. The real-daemon/Electron
scenario in `e2e/specs/desktop-services.spec.ts` observed the same managed
HTTP service through CLI and desktop, verified direct-process TCP listener
evidence, and read a bounded PTY output tail. It kept application readiness
`unverified`. Invalid byte limits and extra operands returned structured
`usage` errors. These commands do not complete port discovery, health checks
or the full CLI acceptance.

Account control slice, 26 September 2026 (F025/F027/F102 partial): `account`
`list/create/inspect/verify/disable` uses the same public daemon commands as
the desktop. `conversation create` accepts `--account ID`; an account ID in the
title position is rejected rather than silently creating an ambient conversation.
The help names the native Claude login command and explains that `disable`
affects future ADE launches, not native logout or already running Agents.
`pnpm --filter @ade/cli build` and all four real-process cases in
`e2e/specs/local-cli.spec.ts` passed at `56cea4d` on macOS arm64. One case checks missing
executable and explicit binding; another verifies and sends through a managed
Claude account using a deterministic external CLI/SDK fixture. This does not
prove two hosted accounts or full F025/F027/F102 acceptance.

`edc4562` tightened `account verify` to require `IDENTITY_JSON` from a prior
inspection. The daemon compares that exact identity with a fresh native probe;
CLI E2E rejects a different expected email and completes a managed fixture
turn with the matching identity. The combined 50-case source E2E suite passed
at `2c2d710` on macOS arm64.
