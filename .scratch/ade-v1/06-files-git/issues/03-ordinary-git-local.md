# Stage, unstage and commit in the selected workspace

Status: ready-for-agent
Type: implementation ticket
Requirements: F075 (partial), R002, R007, R011
Owner: coordinator
Depends on: F074 review status and diffs, stable workspace/Git common-directory identity

Outcome: A user can stage and unstage a reviewed file and commit the staged
index from the Electron Changes view or a named CLI command. The daemon remains
the sole Git executor. A late response cannot apply to another profile or
workspace, and changed Git state requires a fresh review.

## Observable E2E acceptance

1. In an isolated repository, use Electron and named CLI commands to stage,
   unstage and commit. Show the changed file, staged index and new HEAD through
   the public review status and ordinary Git inspection.
2. Send a stale file revision or commit index token after an external Git change;
   reject the mutation and preserve the newer working state. Show conflicts and
   a failed hook/signing outcome without claiming success.
3. Race a delayed mutation receipt with workspace/profile selection changes.
   Keep its operation ID and result bound to the original target; never show or
   retry it as an action in the new selection.
4. Retry one request ID with the same and then changed payload. Return the
   recorded receipt or a conflict; do not repeat a completed commit.

This ticket exposes the existing `review.stage`, `review.unstage` and
`review.commit` daemon operations. It does not close F075. Separate tickets
must implement branch, stash, merge, discard, push and pull, then verify
changed-state preconditions and remote/forge coverage for F075/F078/06-S06.
