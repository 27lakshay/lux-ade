# Rust-owned terminal and xterm presentation

Status: in-progress
Type: implementation ticket
Requirements: F081, F082, F083, R005, R008, R009
Blocked by: 02-client-connection

Outcome: React mounts an xterm adapter while Rust continues to own the PTY.
Terminal bytes bypass React state. Negotiate recovery rather than treating the
current Ghostty binary snapshot as xterm-compatible.

E2E acceptance: create a real shell, send input, observe output, resize, detach and
reopen during an interactive program, and prove supported screen/mode restoration.
Stress slow and multiple subscribers; report overflow honestly.

Evidence (26 September 2026): the Rust runtime offers negotiated
`xterm-replay-v1` in parallel with the existing Ghostty snapshot. Two
real-process E2E cases prove output/resize replay after detach and an explicit
`replay_limit_exceeded` result after 4 MiB while the shell remains alive. xterm
mount/input, alternate-screen restoration, generated reply handling, slow-client
behavior and host/profile memory budgets remain open; F081/F082 are not complete.
