# repo-clone-publish

Status: returned
Type: slice evidence
Branch: claude/wf_a7262165-955-2
Worker: Phase 2 round D, repo-clone-publish worker
Requirements: F062 (advanced, not accepted); D08 (named transport coverage, no forge APIs)

## Outcome

The profile daemon can now clone a remote into a new local folder and register
it as a project, and publish a local folder by initialising Git, optionally
recording an initial commit, adding the remote and pushing without force. Both
run the system `git` with the user's own credentials, and both are effect
commands with receipts. Partial failure is a typed outcome that says what
completed: `cloned_not_registered`, or `not_pushed` with `initialized`,
`initial_commit`, `remote_added` and `failed_step`. Publish counts as done
only when `git ls-remote` shows the remote branch at the pushed commit.

Safety rules:

- Clone never writes into an existing path. It never deletes what a failed
  or stopped clone left behind; it reports it.
- Publish never changes an existing remote's URL and never force-pushes.
- Remote helpers (`ext::` and others), `http://`, `git://`, bare local paths,
  a leading `-` and passwords in the URL are refused.
- Git never prompts: `GIT_TERMINAL_PROMPT=0`, stdin is null, and SSH runs in
  batch mode unless the user configured an SSH command.
- Timeouts: clone 30 minutes, push 10 minutes, `ls-remote` 2 minutes.

## Operation tiers

- `repository.coverage`: query. Returns the D08 matrix: supported and refused
  transports, `forge_apis: false`, and the excluded work.
- `repository.clone`: effect command. The receipt goes `dispatched`
  (phase `cloning`), then `acknowledged` (phase `registering`, with the verified
  HEAD), then `settled`.
- `repository.publish.preview`: query. Returns the verdict (`ready`,
  `needs_initial_commit` or `blocked`), the planned steps, the branch and any
  uncommitted changes that the push would leave out.
- `repository.publish`: effect command. The receipt goes `dispatched`
  (phase `local`), then `acknowledged` (phase `pushing`), then `settled`.

Reconciliation of a receipt left open by an earlier daemon process:

| Receipt phase | What the disk shows | Result |
|---|---|---|
| clone `cloning` | Nothing at the destination | Settled error: nothing written |
| clone `cloning` | Something at the destination | `unknown`. ADE never deletes it and never clones again under that ID |
| clone `registering` | Same repository at the same HEAD | Registration completes; it is idempotent |
| clone `registering` | Folder gone or changed | Settled error; nothing registered |
| publish `local` | Anything | Settled error that describes the folder's state; nothing was pushed |
| publish `pushing` | Anything | `unknown`; ADE never pushes again under that ID |

Refusals are checked before the receipt is recorded, so a refused request
leaves no receipt.

## Checks

- `pnpm check:static`: pass. Run on the final commit.
- In-process tests added:
  - `crates/ade-daemon/src/repository/decide.rs`: URL classification and
    refusals, remote, branch and message names, the destination rule, the
    publish plan and its blocked states, remote read-back matching, clone and
    publish reconciliation, and the coverage declaration.
  - `crates/ade-core/src/contract/repository.rs`: request defaults and the
    reply's wire shape.
- Manual smoke, not a gate. It ran against a throwaway daemon with `file://`
  remotes, using the CLI:
  - Clone registered the project.
  - Replaying the same ID returned the stored result.
  - Cloning into an existing path, a URL with a password and a URL with
    spaces were all refused.
  - A clone from a missing remote left nothing behind.
  - Without `--initial-commit`, publish refused an uncommitted folder.
  - Publish initialised, committed, added the remote, pushed and was confirmed.
  - Publishing again with a new ID was confirmed with no new steps.
  - A different remote URL was refused.
  - A push to a missing remote returned `not_pushed` with the completed local
    steps.
  - Reusing an ID with other parameters was refused.
  - Not tested: interrupting the daemon mid-operation, and real HTTPS or SSH
    remotes.

## Verified only statically

- The reconciliation paths after a daemon crash. They are covered by the pure
  decider tests only.
- The SSH batch-mode override, the timeouts, and HTTPS or SSH credential
  helpers. No real forge was contacted.

## Needs E2E or UI later

- F062 acceptance, run end to end:
  - Clone into a selected host and path.
  - Publish through a configured credential flow.
  - Keep the evidence of a partial operation after a daemon restart during
    clone and during push.
- A renderer flow: choose a URL and destination, preview publish, confirm the
  initial commit, and show a partial outcome with its next step.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 55 | 5 | 10 | 0 |

## References

- Ghostex @ ade-evaluation-2026-09-24, `server/src/repository_clone.rs`,
  studied. Pattern used: the never-overwrite destination check, the 30-minute
  clone timeout, and stopping the Git process group on timeout. No code was
  copied.
- ADE `crates/ade-daemon/src/sessions/checkpoints.rs`, pattern. The receipt
  helpers (peek, dispatch, settle, finish, replay) and the in-process `Claim`
  follow it.

## Open

- Clone only onto this host. Cloning onto a remote host waits for the
  remote-host slices.
- Publishing a folder that is already a registered workspace without a
  repository does not attach the new repository to that workspace record.
  `workspace_open` returns the existing record unchanged, so the store needs
  a rebind path. This is left for the workspaces owner.
- Clone and publish run for the whole request and emit no progress frames. The
  CLI waits up to 31 minutes. A long clone should become a background job with
  progress frames and a status query.
- A crash during push is always settled as `unknown`. It could read the remote
  back to settle it exactly.
- There is no shallow clone, single-branch clone or submodule checkout.
- Coordinator: no shared-file changes needed. No third-party code was copied,
  so no `THIRD-PARTY-NOTICES.md` entry is needed.
