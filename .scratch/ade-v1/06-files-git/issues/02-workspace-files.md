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

Listings scan at most 10,000 names and search scans at most 1,000 entries to
bound one request. An `incomplete` response stops pagination even when the
scanned portion has more than one result page; the UI states that limit. Full
large-tree continuation and a stable snapshot across concurrent mutations
remain open. Non-UTF-8 file names currently fail the whole request.

F071 still needs a broad execution-host and UI stress case across large trees,
permission failures and concurrent path changes. F073 still needs a declared
supported-media matrix and adversarial preview isolation evidence. R011/R016
remain cross-surface requirements. Record implementation commits, tested
revision and exact command evidence before changing this ticket's status.
