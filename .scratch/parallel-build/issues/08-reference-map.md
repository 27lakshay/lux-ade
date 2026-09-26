# Which reference repo applies to each remaining slice, and may it be copied?

Status: closed
Type: wayfinder ticket (research, AFK)
Label: wayfinder:research
Map: [Parallel build](../README.md)
Assignee: claude (research subagent, 2026-09-27)
Blocked by: none

## Question

For each open v1 domain and the next daily-use slices in `.scratch/ade-v1/progress.md`, which files in `/Users/lakshyakumar/work/ade-evaluation-2026-09-24` (orca, paseo, t3code, opencode-v2, oh-my-pi, herdr, ghostex) implement the same behaviour?

Produce a table: slice, reference repo, file paths, what to borrow (pattern versus code), and caveats (TypeScript to Rust, different ownership model). Establish each repo's licence precisely, including Paseo's "portions" clause and Ghostex's missing licence text, and state which may be copied with attribution and which may only be studied.

## Comments

- 2026-09-27 (claude, research): findings in [../research/08-reference-map.md](../research/08-reference-map.md).
  All seven repos are permissive: five are MIT and Paseo and Herdr are Apache-2.0 (Herdr since 0.8.0, previously AGPL). First-party code may be copied with attribution.
  Ghostex's LICENSE does contain the full MIT grant, just untitled. Paseo's "portions" are named third-party files, mostly MIT. Vendored Ghostty shell-integration files are GPLv3 and study-only.
  The slice table maps 7 daily-use slices and 12 domains to 125 verified paths, with a pattern-versus-code call per row. The note proposes a `References:` block with a static header check for the coordinator.
