# lane-e-sdk

Status: returned
Type: lane evidence
Branch: claude/agent-a9c9a17f11af4c66e (worktree `~/work/worktrees/lux-ade/claude-agent-a9c9a17f11af4c66e`)
Ticket: [daemon authority 06](../../daemon-authority/issues/06-lane-sdk-reliability.md)
Requirements: R001, R002

## Outcome

The send journal and its pipeline, the Git journal and the Git refusal proof now
live in `@ade/client/journals`. They import no UI framework and no Electron.
Electron main keeps only wiring. The CLI uses the same journals for
`conversation send` and for Git stage, unstage, commit and discard. A new
protocol E2E proves that a prompt the CLI sent while the daemon was stopped is
delivered once, and only once, after the daemon restarts.

## What is uncertain or skipped

- **The desktop's send and Git recovery paths have no E2E.** No Electron spec
  drives the send journal or the Git journal; `e2e/specs` holds none. The moved
  code is a line-for-line move with Electron couplings turned into hooks, and it
  typechecks against the bridge types. The desktop was not launched.
- **The refusal proof changed.** `decideRefusedGitRecord` now also releases a
  record when the daemon refuses a retry of an ID whose receipt is already final
  (succeeded or failed). Without it, a CLI retry that reuses a finished request
  ID with a new payload (`e2e/specs/git-cli-ordinary.spec.ts`) left a record that
  blocked every later mutation in the workspace. The desktop gets the same rule.
  Its old tests pass unchanged, and a new test covers the new rule.
- **The CLI skips the desktop's "one operation per workspace" check.** The
  desktop asks `review.operation.list` before every Git mutation and refuses
  while another one needs the person. The CLI sends the mutation as its first
  request (`oneAtATime: false`), as it did before. Asking first broke
  `git-cli-ordinary`'s lost-admission-reply spec, whose proxy drops the second
  reply on each connection. The journal still refuses a second unadmitted
  mutation in the same workspace.
- **`outbox-file.ts` is no longer a storage implementation.** The file storage
  moved into the SDK (`fileOutboxStorage`) so the desktop and the CLI share one.
  `outbox-file.ts` in main now only places the journals in the user data folder.
  The ticket said the file would stay as the Electron implementation. Two copies
  of the same storage seemed worse.
- **The CLI's `--request-id` for `conversation send` is narrower.** The journal
  accepts 1 to 128 letters, digits, `-` and `_`. The CLI took any 1 to 256
  characters before, and now refuses the rest with a usage error. Git request
  IDs keep the old CLI rule; the Git journal was widened to 256 printable
  characters.
- **Concurrent CLI commands serialise on a lock.** A journal keeps its records
  in memory between saves, so each CLI command that uses the journals holds
  `journals.lock` in the client directory. A lock whose owner has exited is
  taken over. A second command waits up to 60 s, then fails with `in_progress`.
- **Suppressions.** Fallow cannot see class members called from another
  package through an accessor. Nine members of `SendPipeline` and `SendJournal`
  carry a `fallow-ignore-next-line unused-class-member` with the reason.
- **Stale doc (not edited, outside this lane's files).** `apps/desktop/AGENTS.md`
  still says main owns "the send journal".
- **Legacy specs failing before this lane.** Eight tests in `e2e/specs` fail with
  `Missing operation_id` from their own raw daemon calls, and
  `omp-account-readiness` fails on an account message. None of them reaches the
  journals.
- **Flaky tests seen.** The renderer test `command-service.test.ts` ("Frame was
  detached") failed once and then passed. The protocol test
  `conversations2/draft-history.spec.ts:22` failed once under a full two-worker
  run, then passed 8 of 8 alone. It touches no journal code.

## What moved

| From (Electron main) | To (`packages/client/src`) |
|---|---|
| `send-journal.ts` | `send-journal.ts`: `SendJournal.open(storage)` |
| `conversations/send-pipeline.ts` (logic) | `send-pipeline.ts`: `SendPipeline` |
| `git-journal.ts` | `git-journal.ts`: `GitJournal.open(storage)` |
| `git-refusal.ts`, `git-refusal.test.mjs` | `git-refusal.ts`, `git-refusal.test.mjs` |
| `review.ts` Git admission, refusal release, read, acknowledge | `git-recovery.ts` |
| `outbox-file.ts` (file storage) | `journal-file.ts` |
| `review.ts` `sameReviewAnchor`, `sameReviewFeedback` | `review.ts` (exported from the root) |

Main keeps `conversations/send-pipeline.ts` as wiring: the draft-entry cache,
the window owner ID, the hooks (the profile and review-selection check, draft
error events, the E2E pause) and `pendingSend`. `review.ts` keeps IPC input
checks and the prompt-text builders. `outbox-file.ts` opens the journals in the
user data folder, under the same file names as before.

## SDK API (`@ade/client/journals`)

- `SendJournal`: prompts not yet admitted, plus restore-held records and the transfer bundle.
- `GitJournal`, `GitIntent`: Git mutations not yet admitted, one per profile and workspace.
- `fileOutboxStorage(file, name)`: atomic file storage for any journal.
- `openClientJournals(directory)`: both journals in one directory.
- `lockJournalDirectory(directory, timeoutMs?)`: a cross-process lock on that directory.
- `SendPipeline`: open, save, begin, dispatch and reconcile one window's drafts and prompts.
- `sendJournaled`, `deliverHeldSends`, `heldDirectSends`, `SendHeld`: journaled direct `agent.send` for a client without drafts.
- `socketProfileId(endpoint)`: the journal profile ID for a bare socket.
- `sendGitMutation`, `readGitJournal`, `acknowledgeGitJournal`, `GitOperationBlocked`: Git mutations through the journal.

## CLI

- `conversation send` journals the prompt first. When the daemon doesn't answer,
  the prompt stays held and the command fails with the failure's code (for
  example `unavailable`, exit 3), naming the request ID.
- `conversation pending` lists held prompts. `conversation deliver` sends each
  one once, under its original request ID.
- `git stage|unstage|commit|discard` go through the Git journal.
  `git recovery WORKSPACE_ID` shows the mutation that still needs the person.
- The journals live in `<profile>/client` with `--profile`. With `--socket`, they
  live in `ADE_CLIENT_DIR`, or in `~/.ade/client/<socket profile ID>`.

## Tests

| Run | Result |
|---|---|
| `pnpm check:static` after rebase onto `b048501` | passed, every step |
| SDK pure tests: `journals.test.mjs` (7), `git-refusal.test.mjs` (7) | 14 passed |
| New protocol E2E `conversations/cli-journal.spec.ts` | 2 passed |
| Protocol E2E: conversations, conversations2, files-git, backup, orchestration/parity, profiles/continuity, reliability-a and reliability-core receipts, context/drafts, conversation-delete (`ADE_E2E_WORKERS=2`) | before rebase 241/241; after rebase 240/241, and the one failure (draft-history) passed 8/8 on repeat |
| Legacy CLI specs: git-cli-ordinary, git-discard, review-mutations, review-cwd-binding, worktree-cwd-pin, local-cli | 22 passed before rebase; 16 of these rerun after rebase, all passed |

After every run, no `ade-daemon` or `ade-runtime` process from this worktree was
left running.
