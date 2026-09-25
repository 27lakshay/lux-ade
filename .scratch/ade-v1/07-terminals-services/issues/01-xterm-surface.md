# Rust-owned terminal and xterm presentation

Status: ready-for-agent
Type: implementation ticket
Requirements: F081, F082, F083, R005, R008, R009
Blocked by: 02-client-connection

Outcome: React mounts an xterm adapter while Rust continues to own the PTY.
Terminal bytes bypass React state. Negotiate recovery rather than treating the
current Ghostty binary snapshot as xterm-compatible.

E2E acceptance: create a real shell, send input, observe output, resize, detach and
reopen during an interactive program, and prove supported screen/mode restoration.
Stress slow and multiple subscribers; report overflow honestly.
