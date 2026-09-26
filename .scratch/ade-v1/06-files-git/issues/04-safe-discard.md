# Discard one reviewed working-tree change

Status: implemented slice; broader requirements remain open
Type: implementation ticket
Requirements: F075 (partial), 06-S06, R002, R007, R011
Owner: coordinator; public-protocol E2E: `/root/git_discard_e2e`
Implementation: `9901747`
Depends on: F074 review status/diff and `03-ordinary-git-local.md` operation receipts

Outcome: The user can inspect the unstaged diff for one tracked file, explicitly
confirm discarding that file's working-tree changes, and see the recorded Git
result. ADE keeps staged content and other files. An edit after preview makes
the confirmation stale and requires a fresh preview.

## Observable E2E acceptance

1. Read `review.status` and `review.diff`, then submit `review.discard` with
   workspace, literal path, status revision, unstaged diff token and request ID.
   The working tree returns to the index for that path; staged content, other
   files and HEAD stay intact. The CLI and hidden Electron show the same result.
2. Change the file after preview. The original revision/token rejects discard
   and preserves the new bytes. Reject untracked, conflicted and submodule paths
   and traversal without touching their content.
3. Lose an admitted reply, query `review.operation`, and retry the original ID
   with the same payload. Return one recorded result. Changed payload under the
   same ID conflicts. A crash/relaunch keeps Electron's original operation ID.

This first slice discards tracked unstaged working-tree changes only. Staged
changes use the existing explicit Unstage command. Deletion of untracked files
or a whole repository is not implicit in Discard. F075 remains open for branch,
stash, merge, push, pull and broader Git acceptance; F078 remains separate.

## Implementation and remaining limits

The first reverse-`git apply` draft was rejected: a concurrent edit can move a
patch match, and rollback can overwrite newer bytes. The implementation stages
the index version in a private Git directory, records its location in the
durable operation receipt, and uses `renameatx_np` to exchange file names on a
verified local APFS volume. It keeps the displaced original file and reports
its path in the UI/CLI receipt. It refuses other volumes, symlinked path
components, changed workspace roots and changed reviewed content. File and
directory syncs protect the staged file, displaced original and exchange
metadata around a daemon crash. A deleted tracked file is installed with
exclusive rename, so a concurrently created file cannot be replaced.

The exchange is the operation's linearization point. A process already holding
the original inode open can write to it after exchange; those later bytes land
in the retained file, not at the worktree path. The receipt exposes that path,
and an E2E demonstrates the behavior. No finite path check can prevent a
separate process from writing through its existing descriptor afterward.
Backup retention and an explicit cleanup/undo control belong to R015/F075
follow-on work; this slice must not claim those requirements complete. The
slice passes 9 public-protocol/CLI and 2 hidden Electron E2Es, including
changed-byte, rename, daemon-crash and linked-worktree cases. The final source
suite passes 152 tests with one host-filesystem skip. The macOS package builds
and its installed-app E2Es pass 6/6. Independent safety review found no
confirmed remaining byte-loss path after the APFS exchange and recovery-file
changes. F075, 06-S06 and R015 still require their broader acceptance.
