# E2E round 1: backup

Status: returned
Type: slice evidence
Branch: claude/wf_8e5e7c6f-164-2
Worker: ADE parallel build, E2E round 1, backup worker
Requirements: F050, R014, F059 (backup part), D15

## Outcome

Nine headless E2E specs in `e2e/protocol/backup/` drive `ade-control backup
create|inspect|restore` against real daemon and runtime processes, and read
every restored store back through the SDK. All nine pass. They found one
product bug in restore, now fixed: restored accounts made `account.list` fail.

R014's register acceptance now passes for the backend bundle (see "Open" for
what that excludes). F050 still lacks E2E for readable history export. F059
has only its backup part proven here.

## Acceptance criteria

| Criterion (source) | Spec | Result |
|---|---|---|
| Back up during writes (R014) | `restore.spec.ts` "backs up a live profile during writes…": the test pause holds the online copy; an attachment, a draft revision and a plugin record are written meanwhile; the daemon keeps serving | pass |
| Restore database, blobs and manifests, validated through public reads (R014, F050) | same test: conversation messages, `attachment.inspect` SHA-256, the draft and its attachments, plugin registry, record, setting and activation, skill catalog and blobs, accounts | pass |
| Verify blobs (F050) | same test and `corrupt.spec.ts`: attachment SHA-256 equal after restore; incomplete attachment payload, damaged skill blob and changed plugin artifact file refused | pass |
| Disclose excluded credentials, native and private-plugin data (R014, F050, F059) | `restore.spec.ts`: manifest `excluded` and `coverage`; the account's credential file is absent after restore and the account is `unverified`; plugin-private files and staging disclosed | pass |
| Plugin records, settings and artifacts take part in backup (F059, plugins spec decision 7) | `restore.spec.ts`: record, setting, enabled status, re-activation, artifact path inside the restored profile, executable bit kept | pass |
| Reject unsupported schemas without mutation (R014, D15) | `restore.spec.ts` "one schema behind…" (two behind refused, no target, no stage); `corrupt.spec.ts` (future schema 99, pre-fence schema 11) | pass |
| Restore the current schema and one behind (D15) | `restore.spec.ts` "one schema behind…": a real schema-16 bundle inspects, restores, migrates to 17 (an effect command writes a receipt) and backs up again at 17 | pass |
| Format 2 still restores (D15) | `restore.spec.ts` "format-2 bundle…" | pass |
| History index is rebuilt, not backed up (D15) | `history.spec.ts`: disclosed as `rebuilt`; restored epoch is higher; the same message IDs are found; a source cursor is refused; a daemon kill does not rebuild again | pass |
| Restored profile does not auto-send queued prompts (audit fix 2) | `fences.spec.ts`: a queued prompt behind a held turn stays `queued` with the queue paused, across a daemon kill and a graceful restart; the restored provider receives only the barrier turn | pass |
| Restored profile holds pending sends | `fences.spec.ts`: `draft.send.get` is pending and `restored_from_backup`; `agent.send` and `draft.send.complete` refuse with "Restored prompt is held" before and after restarts | pass |
| Restored profile does not inherit runtime incarnations (audit fix 1) | `fences.spec.ts`: a new runtime instance, `runtime.recovery` has no reports, the source runtime still runs. Removing the fix makes this spec fail (checked by hand) | pass |
| Execution stays fenced until rebind | `fences.spec.ts`, `faults.spec.ts`: `agent.send` refuses with `needs_rebind` until `workspace.rebind` | pass |
| Refuse corrupt bundles before target mutation (R014, ticket) | `corrupt.spec.ts`: 13 damages, each refused by `inspect` and `restore`, no target, no stage; an existing target is never replaced | pass |
| Kill backup at a staged write boundary; a later attempt proceeds (ticket) | `faults.spec.ts` "a backup killed part-way…": SIGKILL during the paused copy; nothing is published; the stage is not restorable; a retry to the same destination publishes and restores | pass |
| Duplicate requests | `faults.spec.ts` "duplicate and misplaced requests…": a second create to a published destination and a second restore to a restored target are refused and change nothing; a nested destination is refused; two restores of one bundle are independent | pass |
| Crash of the source daemon | `faults.spec.ts` "the data directory of a crashed daemon…": after SIGKILL the data directory backs up with every committed write, and the source recovers | pass |
| Uncertain outcome at backup time | `fences.spec.ts`: a turn in flight at backup time is interrupted, not resumed, in the restored profile, and the source's turn continues in its own runtime | pass |
| Back up during browser tab and cookie writes; restore tab and cookie (ticket) | none: Electron owns that state, and Electron E2E is paused | not covered |
| Registered-profile path: `profiles backup-backend`, `restore-backend`, `pending-restores`, `resume-restore`, registry last | none: see "Open" | not covered |
| A backup taken while a plugin installs or uninstalls (backup-coverage evidence) | none: there is no hook to hold an install between registry and artifact | not covered |
| Retention during backup (R015) | none: another slice's area | not covered |
| A crash part-way through `backup restore` | none: plain restore has no test hook at its publish boundary | not covered |

## Product fix

- **Restored accounts broke `account.list`.** `fence()` in
  `crates/ade-daemon/src/bin/control/backup.rs` created each account home with
  `private_dir`, which uses `create_dir_all`. The shared `provider-accounts`
  root was left at mode 0755. The daemon refuses any account whose root is
  readable by others, so every `account.list` in a restored profile failed with
  "Account native home is unavailable or redirected". The fix makes the root
  private before creating the homes. `restore.spec.ts` covers it. No pure-core
  test was added because no decision changed.

## Fixture added

`e2e/protocol/fixtures/control.ts` is a new generic fixture:

- `control(ade, args)` runs `target/debug/ade-control` with the scratch
  environment and returns a `CliResult`.
- `spawnControl(ade, args)` starts it without waiting and records it in the
  harness ledger, for pause and kill tests.
- `nextProfileDataDirectory(ade)` returns the data directory the next
  `ade.profile()` will use. A restore writes there, so the next profile opens
  the restored data. It relies on the harness naming profiles `p1`, `p2` and so
  on. A `dataDirectory` option on `ade.profile()` would be cleaner.

## Operation tiers

No operations were added or changed. `ade-control backup` is a local CLI, not a
wire operation.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/backup`: 9 passed
- `pnpm check:static`: pass
- In-process tests added: none
- No `ade-daemon` or `ade-runtime` from this worktree was left running (`pgrep`).

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 70 | 10 | 15 | 0 |

## References

- None. The specs follow ADE's own legacy `e2e/specs/managed-backup-core.spec.ts`
  and `e2e/specs/restored-send-hold.spec.ts`, which were read and not changed.

## Open

- **R014 scope.** The passing acceptance covers the backend bundle. Browser
  tabs and cookies, the pending-send journal and the registered-profile
  commands are not proven here. The coordinator decides whether R014 is
  accepted at that scope.
- **Registered-profile restore needs a fixture.** `profiles restore-backend`
  writes data under the profiles home. A scratch profile can only open
  `<root>/data`. An `ade.profile({ dataDirectory })` option, or a helper that
  owns a daemon started by `profiles start`, would let a spec read it back.
- **A killed backup leaves its stage.** `.ade-stage-*` stays in the destination
  folder after a SIGKILL. It is not restorable, and a retry succeeds, but
  nothing removes it.
- **A resumed queue does not send on an interrupted conversation.** In both the
  source and the restored profile, `queue.pause` with `paused=false` on an
  `interrupted` conversation left the prompt queued. This belongs to the
  conversations area. No spec asserts it.
- **F050** still needs E2E for `conversation export`.
