# Browse, search and preview workspace files

Status: in progress; F071/F073 acceptance remains open
Type: implementation ticket
Requirements: F071, F073, R011, R016 (partial)
Owner: coordinator
Depends on: stable workspace identity, selected-profile IPC, read-only daemon commands

Outcome: A selected local workspace can browse directories, search names and
preview supported text and raster images without giving file content application
authority. Fenced workspaces stay readable in the catalogue but cannot inspect
their old filesystem path. Each command has bounded output and handles stale
selection, symlinks and changed paths safely.

## This slice

1. Add public read-only `file.list`, `file.search` and `file.preview` commands to
   the real profile daemon. Use workspace identity for admission; never follow a
   workspace-relative symlink into another path. Bound directory pages, search
   work and preview bytes. Preserve an explicit continuation or incomplete
   result instead of silently dropping more entries.
2. Expose only these commands through a validated Electron bridge. Tie each
   response to the selected profile and workspace. Render text as text and
   raster images as images, with no executable HTML or application bridge in
   the preview. Show unsupported types and size or permission limits plainly.
3. Exercise a real daemon/runtime and Electron: browse nested directories,
   paginate and search, show text and raster previews, reject `..` and a
   symlink outside the workspace, surface oversized and unsupported content,
   and discard a delayed response after workspace/profile selection changes.

## Acceptance remaining after this slice

Listings scan at most 10,000 names and search scans at most 1,000 entries in
one request. Opaque single-use cursors now continue an unchanged tree beyond
those budgets. Eight active scans and their directory streams expire after
60 seconds of inactivity. Search caps depth at 32 and retained visited folders
at 1,024; it reports `incomplete` when those or the path-length limit stop
traversal. Arbitrary concurrent mutation is not an immutable snapshot, and
validating many visited paths may make one search page slow. Non-UTF-8 names
have a reversible encoded path, but this Mac rejects the E2E fixture name.

F071 still needs a broad execution-host and UI stress case across large trees,
permission failures and concurrent path changes. F073 still needs a declared
supported-media matrix and adversarial preview isolation evidence. R011/R016
remain cross-surface requirements. Record implementation commits, tested
revision and exact command evidence before changing this ticket's status.

## Comments

- 2026-09-26: `a3a9f77` adds the read-only daemon commands, selected-workspace
  Electron bridge and file surface. A real-process protocol E2E covers three
  listing pages, two search pages, text/image/HTML/oversized previews, permission
  refusal, traversal, outside symlinks and root replacement. Electron E2Es cover
  browse/preview and reject a delayed response after workspace selection changes.
  On the same tree, `pnpm check` passed 126/126 source E2Es, `pnpm package:mac`
  and `pnpm test:e2e:package` passed 6/6, Rust formatting and workspace
  all-target strict Clippy passed. After the final one-line empty-state change,
  desktop typecheck/build and both focused Electron E2Es passed again. No test-
  owned daemon/runtime remains. The first slice left large-tree continuation
  and non-UTF-8 names open.
- 2026-09-26: `6f40428` continues listing beyond 10,000 entries and search
  beyond 1,000 matches, including an empty search page after 1,000 nonmatches.
  It uses workspace-bound, single-use cursors; detects changed active and
  previously visited paths; evicts old scans at the count limit; and releases
  idle directory descriptors on expiry. Encoded names reject crafted parent
  traversal. The committed revision on arm64 macOS 26.6.1 passes `pnpm check`
  (135 source E2Es passed, one host-filesystem skip), `pnpm package:mac`,
  `pnpm test:e2e:package` (6/6), `node scripts/cargo.mjs fmt --check` and
  workspace all-target Clippy with `-D warnings`. Focused file coverage passes
  12/12 with the same one skip. An earlier full-suite attempt failed only
  because test titles changed during discovery; the clean committed rerun
  passed. Post-run process audit found no test-owned ADE process. F071/F073
  remain open for adversarial preview/isolation and broad UI/performance stress.
