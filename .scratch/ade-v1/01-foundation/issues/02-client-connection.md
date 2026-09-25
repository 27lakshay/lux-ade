# Shared client and daemon connection

Status: ready-for-agent
Type: implementation ticket
Requirements: F005, F007, F010, F101, F103, R001, R010
Blocked by: 01-root-workspace

Outcome: a framework-neutral TypeScript client connects to an explicit local
profile daemon, validates a versioned hello, reads a real projection, and reports
connection/reconnect/incompatible states to the desktop. Keep the client independent
of React and Electron. Use the current Rust daemon as the first implementation
source; any protocol change must preserve the GPUI prototype until replacement.

E2E acceptance: start the real daemon/runtime under an isolated profile, connect
through the public client, reload Electron, and recover the same profile state
without duplicate commands. Stop/restart compatible daemon and report catch-up or
an explicit recovery error.
