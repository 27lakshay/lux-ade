# Local CLI over the shared command protocol

Status: claimed
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
