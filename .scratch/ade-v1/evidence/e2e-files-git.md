# e2e-files-git

Status: returned
Type: slice evidence
Branch: claude/wf_317b0f50-41b-6
Worker: E2E round 3, files-git worker
Requirements: F071, F073, F075, F078 (06-S06 partial evidence)

## Outcome

Headless E2E specs in `e2e/protocol/files-git/` drive file browse, search and
preview, and ordinary Git, through the SDK and the CLI against real daemons,
runtimes, Git and bare remotes. F075 lacked branch, stash, merge, fetch, pull
and push; this slice adds them as six effect commands on the existing review
receipts. The specs found three product bugs, all fixed: one unreadable folder
failed a whole search, `--include-untracked` stash left the saved files behind,
and fetch reported `origin/HEAD` as an updated ref. F075 now passes its full
register acceptance. F071, F073 and F078 pass their protocol-level parts, but
parts of each remain outside what this suite can prove (see the table).

## Acceptance criteria

| Requirement | Criterion part | Spec | Result |
|---|---|---|---|
| F071 | Browse nested folders in bounded pages with cursors | `browse.spec.ts` › browses nested folders in bounded pages… | pass |
| F071 | Search names at any depth, paged, case-insensitive; CLI parity | same | pass |
| F071 | Cursors single-use and bound to folder, operation and workspace | same | pass |
| F071 | Symlinks listed, never followed (file, folder, inside and outside); `..`, absolute and encoded traversal refused | `browse.spec.ts` › never leaves the workspace… | pass |
| F071 | Large trees: listing past 10,000 names, search past 1,000 non-matches | `browse.spec.ts` › a large tree lists and searches past the scan budgets… | pass |
| F071 | Permission failures: unreadable folder refused on list, skipped by search with `incomplete` | same | pass (after fix 1) |
| F071 | Changed paths: changed folder, renamed folder, vanished file, daemon restart, replaced root (`needs_rebind`) | `browse.spec.ts` › changed paths invalidate cursors… | pass |
| F071 | On the execution host when that is a remote host | none | not covered: `file.*` runs on the local daemon host only |
| F071 | Without freezing the UI | bounded pages only | not covered: UI out of scope |
| F073 | Text previews, including Unicode and empty files | `preview.spec.ts` › previews text and the supported image formats… | pass |
| F073 | Image previews: PNG, JPEG, GIF, WebP, with MIME and exact bytes; CLI parity | same | pass |
| F073 | Limits: text cut at 256 KiB on a character boundary and flagged; oversized image refused whole | `preview.spec.ts` › large, binary, mislabelled and unsupported files… | pass |
| F073 | Unsupported formats: binary, non-UTF-8, archives, mislabelled images, folders, missing files | same | pass |
| F073 | Untrusted content gets no authority: HTML, HTM, XHTML, SVG, XML returned as `unsupported` with no content; HTML in a `.txt` is `text/plain` | `preview.spec.ts` › active content is never returned in a renderable form | pass (daemon side) |
| F073 | Renderer isolation of previews; audio and video | none | not covered: UI out of scope; the daemon previews no audio or video |
| F075 | Stage, unstage (including untracked), discard, commit with receipts; CLI commit and receipt read | `local-git.spec.ts` › stage, unstage, discard and commit each return a receipt… | pass |
| F075 | Duplicate request replays the receipt and never commits twice; changed payload under the same ID refused | same; `remote-git.spec.ts` › fetch, pull and push… (push replay and conflict) | pass |
| F075 | Changed working-state preconditions: stale revision, stale diff token (new bytes kept), stale index token, stale stash revision | `local-git.spec.ts` (first two tests); `remote-git.spec.ts` › fetch, pull and push… (stale push and pull) | pass |
| F075 | Branch create, switch, create-and-switch; invalid, existing and missing names; Git's refusal to overwrite local changes | `local-git.spec.ts` › branches, stashes and merges… | pass |
| F075 | Stash push (with untracked files and a message) and pop; nothing to stash or pop | same; › a stash pop that conflicts… | pass (after fix 2) |
| F075 | Merge: conflicts listed in the failed receipt and in status; commit, stash and a second merge blocked; abort restores; resolve, stage and commit a two-parent merge; clean merge; unknown and option-like targets refused | `local-git.spec.ts` › branches, stashes and merges… | pass |
| F075 | Stash pop conflict keeps the stash and lists the conflict | `local-git.spec.ts` › a stash pop that conflicts… | pass |
| F075 | Fetch changes only tracking refs; pull fast-forwards; push is read back at the pushed commit | `remote-git.spec.ts` › fetch, pull and push… | pass (after fix 3) |
| F075 | Push rejected rather than forced; diverged pull refused; explicit merge of the upstream then push | same | pass |
| F075 | Missing upstream, named remote sets it once, second remote leaves it; only configured remote names (URLs and options refused); unreachable remote; detached HEAD | `remote-git.spec.ts` › a new branch needs a named remote once… | pass |
| F075 | Daemon crash mid-mutation: interrupted receipt, never rerun, listed and acknowledged; receipts survive restart | `local-git.spec.ts` › a daemon killed during a Git mutation… | pass |
| F075 | Uncertain outcome: daemon killed with a push in flight; receipt interrupted, never rerun; fetch shows the remote's truth | `remote-git.spec.ts` › a daemon killed while a push is in flight… | pass |
| F078 | Declared coverage: supported and refused transports, no forge API, excluded PR and issue work | `forges.spec.ts` › the coverage declaration… | pass |
| F078 | Clone, commit, push, fetch and pull for an SSH URL on a nested-group host, over the SSH command | `forges.spec.ts` › …an SSH URL on a nested-group forge… | pass |
| F078 | Same for an scp-like URL on a self-hosted host, over the SSH command | `forges.spec.ts` › …an scp-like URL on a self-hosted server… | pass |
| F078 | Same for a `file://` URL | `forges.spec.ts` › …a file URL on this machine… | pass |
| F078 | Same for an HTTPS forge URL; ADE keeps the URL and Git resolves it | `forges.spec.ts` › …an HTTPS forge… | pass, through Git's `url.insteadOf` onto a local bare repository |
| F078 | Refused transports (http, git daemon, remote helper, bare path, password in URL) never reach Git; a remote helper configured in a repository stays disabled on fetch; a refused SSH key fails with Git's message | `forges.spec.ts` › refused transports never reach Git… | pass |
| F078 | HTTPS transport and credential-helper authentication against a real HTTPS server | none | not covered: no local HTTPS Git server fixture |
| 06-S06 | Change a file after a discard preview; stale execution rejected, new bytes kept | `local-git.spec.ts` (first test) | pass; restore previews are not covered |

Requirement IDs whose full register acceptance now passes as E2E: **F075**.

Partial: F071 (remote execution host, UI), F073 (renderer isolation, audio and
video), F078 (real HTTPS and credential-helper authentication), 06-S06
(restore previews).

No spec is marked `test.fixme`.

## Product changes

1. **One unreadable folder failed a whole search.** One unreadable folder
   failed the whole `file.search`, so a workspace containing one could never
   be searched. Search now skips a folder the host refuses and reports
   `incomplete: true`; any other error still fails. Pure-core test:
   `files.rs` › `only_a_refused_folder_is_skipped`.
2. **New Git operations (F075 gap).** `review.branch`, `review.stash`,
   `review.merge`, `review.fetch`, `review.pull` and `review.push` in
   `crates/ade-daemon/src/review/sync.rs`, with contracts in
   `crates/ade-core/src/contract/review.rs` and CLI commands `git branch`,
   `git stash`, `git merge`, `git merge-abort`, `git fetch`, `git pull` and
   `git push`. A merge or stash pop that stops on conflicts fails with
   `result.conflicts`. Remote steps disable remote helpers and put SSH in batch
   mode unless the user configured an SSH command, as `repository.*` does.
   Nothing forces, rebases or resets.
3. **Stash left untracked files behind.** Review Git runs with
   `GIT_LITERAL_PATHSPECS=1`, which turns stash's internal `:/` clean into a
   no-op. `review.stash push` now clears it for that one command; it passes no
   user path.
4. **Fetch reported symbolic refs.** `origin/HEAD` appeared as an updated ref
   whenever `origin/main` moved. Symbolic refs are now left out.

## Operation tiers

| Operation | Tier |
|---|---|
| `review.branch` | effect command |
| `review.stash` | effect command |
| `review.merge` | effect command |
| `review.fetch` | effect command |
| `review.pull` | effect command |
| `review.push` | effect command |

All six use the existing review receipts: operation ID, daemon-computed
payload fingerprint, replay, conflict on a changed payload, and `interrupted`
after a daemon crash.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/files-git`:
  20 passed, after `pnpm build:backend && pnpm build`.
- `pnpm check:static`: pass.
- In-process tests added: `crates/ade-daemon/src/review/sync.rs` (Git failure
  messages, upstream names), `crates/ade-daemon/src/files.rs` (permission
  decision), `crates/ade-core/src/contract/review.rs` (new request round trips
  and tiers).
- No `ade-daemon` or `ade-runtime` from this worktree was left running.

## New shared fixture

- `e2e/protocol/fixtures/git-remotes.ts`: `bareRemote`, `remoteHead`,
  `forgeSsh` (an SSH command serving bare repositories under
  `<root>/<host>/`, with a call log) and `profileGitConfig` (appends to the
  scratch profile's global Git config). It is not re-exported from
  `fixtures/index.ts`; specs import it directly.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 95 | 10 | 20 | 0 |

## References

- ADE `crates/ade-daemon/src/repository.rs`, pattern: network Git settings
  (`protocol.ext.allow=never`, SSH batch mode unless configured).
- ADE `e2e/specs/workspace-files.spec.ts`, `review-mutations.spec.ts` and
  `git-discard.spec.ts`, studied: legacy scenarios re-proved at protocol level.

## Open

- Coordinator: `packages/contracts` generated files changed through
  `pnpm contract:generate`; regenerate on conflict. No other shared file was
  edited.
- A push interrupted by a daemon crash is always `interrupted`; the daemon
  could read the remote back on restart to settle it exactly, as
  `repository.publish` could.
- The desktop Changes view does not expose the six new operations yet.
- F078 needs a local HTTPS Git server fixture (for example `git http-backend`
  behind TLS) to prove HTTPS credential-helper authentication.
