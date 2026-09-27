# e2e-rewind-flake

Status: returned
Type: slice evidence
Branch: claude/wf_29c70e79-8bf-1
Worker: rewind-flake
Requirements: R001 (file rewind, F039)

## Outcome

The R001 file-rewind test in `e2e/protocol/context/rewind.spec.ts` failed 2 of 6
repeats. It killed the daemon as soon as the file content changed, which could
land before the checkpoint receipt settled. The retry then correctly reported
"outcome unknown", but the test expected "restored". Both outcomes are valid
product behaviour; the kill point was the only non-determinism.

The test is now three tests. Each holds the daemon at a fixed debug-only pause
point (`receipts::e2e_pause`, gated on `ADE_E2E_RECEIPT_PAUSE_DIR`) and SIGKILLs
it there:

| Pause point | Where | What the retry must do |
|---|---|---|
| `conversation.rewind.files.settled` | `controls.rs`, after the restore receipt settled, before the rewind receipt settled | Return `restored` once; a later edit is kept; a second retry after another crash returns the same reply; one safety checkpoint |
| `checkpoint.restore.writing` | `checkpoints.rs`, after the receipt moved to phase `writing`, before any file write | Reject as unknown, naming the safety checkpoint; files stay in the agent's state; never re-run, also after another crash |
| `checkpoint.restore.written` | `checkpoints.rs`, after the file writes, before the receipt settled | Reject as unknown; files stay restored; a later edit is not overwritten; never re-run, also after another crash |

R001 stays proven for file rewind. No product behaviour changed; the pause
points compile to nothing in release builds.

## Operation tiers

No operation added or changed. `conversation.rewind` and `checkpoint.restore`
remain effect commands.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only context/rewind.spec.ts --grep R001 --repeat-each 6`: 18 of 18 passed
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only context`: 31 passed
- `pnpm check:static`: pass
- In-process tests added: none

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 15 | 5 | 10 | 0 |

## References

None.

## Open

None.
