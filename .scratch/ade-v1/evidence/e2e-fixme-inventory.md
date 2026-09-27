# fixme-cleanup

Status: returned
Type: slice evidence
Branch: claude/wf_ead686db-a2b-5
Worker: workflow wf_ead686db, worker 5 (fixme-cleanup)
Requirements: R002 (the 21 envelope commands' contracts), R010 (spec made deterministic), F030 (Claude exhaustion half), R019 (evidence pointers only)

## Outcome

Round 4 made 23 `test.fixme` markers obsolete. They now run and pass:

- `reliability-a/operation-ids.spec.ts`: 21 tests. Each checks that the
  command's request contract requires `operation_id`. Replay, conflict and
  crash behaviour for these commands is proven in `reliability-core/`.
- `conversations2/rewind-create.spec.ts`: a `conversation.create` whose reply
  was lost is retried under the same operation ID until it settles. After a
  daemon SIGKILL it returns the same Conversation. Another payload is a
  conflict, and the workspace holds exactly one Conversation.
- `services/faults.spec.ts`: the old fixme expected a `receipt` field on the
  reply, which the chosen design does not add. The design keeps the receipt
  in the daemon's envelope journal. The test now checks the guarantee a
  caller sees instead: a replay under the same ID returns the recorded reply,
  another payload is a conflict, and the first run keeps serving.

Beyond the listed files:

- `catalogs/usage.spec.ts`: the F030 Claude exhaustion fixme is closed. Its
  reason was out of date, because the daemon already treats a `rejected`
  window as exhausted. The Claude mock (`providers/claude/fake-sdk.mjs`) now
  answers the `usage-exhausted` prompt with a `rejected` five-hour limit. The
  test shows the limit as rejected, `provider.quota` as exhausted, and the
  next turn on the same account, provider and configuration with no
  switches.
- `fault-suite.ts`: the fault-class-4 entry "late pages after a rewind" was
  mapped only to a fixme test (the Codex rewind). A fixme still appears in
  `--list`, so the class looked covered while nothing ran. It now maps to the
  two passing Claude tests in `restarts/stale-rewind.spec.ts`.
  `load/fault-classes.spec.ts` now fails when a fault maps only to a fixme
  test, so this cannot happen again.
- `reliability-b/consistent-view.spec.ts`, "a kept activity cursor catches
  up exactly after a restart…", is now deterministic. It had two timing
  assumptions:
  1. It polled `history.search` with `limit: 1` until one result appeared,
     then required a `next_cursor`. The index runs behind the turns, so a
     second match was not always indexed yet. It now polls until all 3
     matches are searchable.
  2. It compared the catch-up page with a later full listing. Activity
     recorded after the turn went idle made the later listing larger. The
     comparison is now bounded to the range the catch-up page covered. The
     cursor is the feed's `latest_sequence`, and the page is asserted
     complete (`next_cursor` null).
- `e2e-reliability-c.md`: the R019 rows now point at `load/load.spec.ts`,
  which replaced `reliability-c/load.spec.ts` and added the browser tabs and
  the large history.

## Remaining `test.fixme` in e2e/protocol

Nine markers remain, and none of them is a stale fixme. Seven are real
product gaps, one needs Electron and one needs system services. None needs
real accounts.

### Electron-only

| Spec | Test | Reason |
|---|---|---|
| `load/fault-classes.spec.ts` (generated from `fault-suite.ts`) | fault class 6, freeze a plugin and recover it | A frozen UI plugin recovered from Electron main needs Electron E2E, which is paused until the UI phase. The backend plugin host part passes (`devplug/plugin-recovery.spec.ts`). |

### Needs real accounts

None. Two gaps also depend on a real provider:
- The Codex rewind needs checking against a real Codex `thread/fork` schema.
- F140's real-provider matrix needs credentials. It is not a fixme; see
  `e2e-load-conformance.md`.

### Needs system services

| Spec | Test | Reason |
|---|---|---|
| `load/fault-classes.spec.ts` (generated) | fault class 3, saturate storage | The full-volume test (`reliability-a/overload.spec.ts`, "with the data volume full") mounts a scratch volume with `hdiutil`. It runs only with `ADE_E2E_SYSTEM=1` and alone; otherwise it skips (a `testInfo.skip`, not a fixme). |

### Real product gaps

| Spec | Test | Gap | Why not fixed here |
|---|---|---|---|
| `context/rewind.spec.ts` | F039: a Codex conversation rewind drops later messages and invalidates stale history pages | The Codex adapter starts legacy threads. `thread/revert` rewrites only paginated threads, and `thread/rollback` was removed, so Codex conversation rewind reports itself unavailable. `thread/fork` with `lastTurnId` could fork before a turn, as Claude's adapter does. | Runtime adapter work, and it must first be checked against the pinned Codex schema. F039 is accepted through Claude (`accounts-rewind/rewind.spec.ts`). |
| `restarts/stale-rewind.spec.ts` | R011: a result delayed across a conversation delete cannot resurrect it | No operation deletes a Conversation. | Needs a new effect command, a contract and the store cascade. This is a feature, not a small fix. |
| `catalogs/history.spec.ts` | a deleted conversation disappears from search results (F043) | Same: no Conversation delete. | Same. |
| `load/fault-classes.spec.ts` (generated) | fault class 4, late pages after a deletion | Same: no Conversation delete. | Same. |
| `recovery/descendants.spec.ts` | an escaped descendant that survives a runtime kill keeps its script attempt quarantined (R006) | Restart reconciliation knows only the recorded process and its group. A descendant that left the group before the runtime crashed is not recorded, so the attempt settles and the workspace is released while it runs. | The runtime must report the descendants it tracks per attempt, and the daemon must record them. This crosses the runtime and the daemon. |
| `reliability-a/overload.spec.ts` | a cancel sent during a connection flood past the socket backlog is admitted on its first attempt | Cancellation shares the profile socket and its listen backlog (128 on macOS) with ordinary commands. A cancel sent during a flood past the backlog can be refused with ECONNREFUSED. It was never sent, so a retry is safe, but no control lane is reserved (architecture section 4). | Needs a reserved control socket or lane in the daemon, and the SDK must use it. This crosses the daemon and the client. |
| `devices/control.spec.ts` | F098: input to an explicit display or application target never follows focus | There is no input to a display or application target (`app:<bundle>` or a window). Displays report `input` unavailable. | The feature is not built. |

Conditional skips that are not fixmes, for completeness:
- `recovery/runtime-crash.spec.ts` skips when the daemon recorded the
  provider before the kill.
- `devices/inventory.spec.ts` and `devplug/device-input.spec.ts` skip when
  the host already has the real tool installed.

## Operation tiers

No operation was added or changed.

## Checks

- `pnpm build:backend && pnpm build`: pass
- `pnpm check:static`: see the worker result
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only` on the edited specs: pass.
  The consistent-view cursor test, the create retry and the service replay
  also passed `--repeat-each=8`.
- In-process tests added: none

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 45 | 10 | 20 | 0 |

## References

None.

## Open

- A Conversation delete operation would close three of the remaining
  fixmes (R011 delete, F043 deleted search, fault class 4).
- None else from this slice.
