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
