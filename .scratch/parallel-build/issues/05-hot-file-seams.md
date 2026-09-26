# Where do the hot files split?

Status: closed
Type: wayfinder ticket (research, AFK)
Label: wayfinder:research
Map: [Parallel build](../README.md)
Assignee: claude (research subagent, 2026-09-27)
Blocked by: none

## Question

Where are the seams in `crates/ade-daemon/src/sessions.rs`, `crates/ade-daemon/src/store.rs`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/renderer/src/main.tsx` and `apps/cli/src/index.ts`, so parallel features stop editing the same files?

For each file, propose modules aligned with the v1 domains (`.scratch/ade-v1/NN-*`). Name the shared state that crosses each proposed seam, the order in which to split the files, and which splits are pure moves versus which need interface changes. Use `git log` since `e42e5e7` to show which feature areas co-edit which regions. Recommend a split; do not perform it.

## Comments

- 2026-09-27 (claude, research): findings in [../research/05-hot-file-seams.md](../research/05-hot-file-seams.md).
  Split desktop main IPC, then renderer panes, then CLI commands (with per-module usage text), then `sessions.rs` as child `impl Sessions` modules; `store.rs` last.
  Measured on history since e42e5e7: steps 1–4 separate ~66% of cross-feature co-edits (1,950 → 666 commit pairs); per-domain host-bridge namespaces, a quit-guard registry and the store split take it to ~78%.
  The rest is real coupling (review feedback through the send path, migrations, `Data`/`command()` admission) and needs interface work, not a file move.
