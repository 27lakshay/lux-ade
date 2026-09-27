# e2e-errors

Status: returned
Type: slice evidence
Branch: claude/wf_40412ab1-96e-1
Worker: E2E round 2, sdk-errors worker
Requirements: F102 (error and exit-code part), F103 (error part). Both were
already accepted by `e2e-orchestration.md`; this slice closes the error gap
that acceptance did not reach.

## Outcome

The SDK and the CLI now keep every daemon error code and recovery hint. Before
this slice, `packages/client/src/request.ts` turned every code it did not list
into `daemon` and dropped `recovery`. That hid `host_resource_conflict`,
`host_resources_unavailable`, `needs_rebind` and the `lifecycle_*` codes, and
the CLI printed `code: daemon` and exited 7 for all of them.

Five headless specs in `e2e/protocol/errors/propagation.spec.ts` prove the fix
against real daemons and runtimes. All five pass. None is `test.fixme`.

## What is uncertain or not covered

- `lifecycle_outcome_unknown` (exit 9), `lifecycle_unavailable`,
  `lifecycle_invalid_output` and `restored_send_held` have no E2E. No request
  returns them synchronously in a way a spec can trigger without a sleep or a
  broken Git. Their mapping is in the CLI table and the SDK list.
- An in-flight request lost to a daemon crash (`unavailable`, delivery
  `unknown`) is not covered here. The spec covers a daemon that is already
  dead (`unavailable`, delivery `not_sent`, exit 3).
- Behaviour change for desktop: two desktop decisions read `code === 'daemon'`.
  They now use the SDK's `isDaemonRefusal`, which is true exactly when the old
  SDK would have said `daemon`. So `lifecycle_outcome_unknown` still counts as
  a definite refusal there, as it did before. The follow-up lookup
  (`review.operation`) still guards the Git outbox release. A reviewer may want
  outcome-unknown codes excluded.

## Product fixes

- `packages/client/src/request.ts`: `DaemonErrorCode` is now the known codes
  plus any string (`KnownDaemonErrorCode | (string & {})`). An error frame's
  `code` is kept as sent; only a frame with no code becomes `daemon`.
  `DaemonRequestError` gains `recovery`. New exports: `categoryErrorCodes`,
  `daemonRefusalCodes`, `KnownDaemonErrorCode` and `isDaemonRefusal`.
- `apps/cli/src/index.ts`: the error body adds `recovery` when the daemon sent
  one. The exit codes are documented in `ade --help`:

  | Exit | Codes |
  |---|---|
  | 2 | `usage`, `invalid_request` |
  | 3 | `unavailable` |
  | 4 | `incompatible` |
  | 5 | `timeout` |
  | 6 | `protocol`, or a local failure with no other code |
  | 7 | `daemon`: a daemon refusal with no code, or a code not listed here |
  | 8 | `conflict` |
  | 9 | `outcome_unknown`, `lifecycle_outcome_unknown` |
  | 10 | `in_progress` |
  | 11 | `overloaded` |
  | 12 | `not_applied` |
  | 13 | `needs_rebind` |
  | 14 | `host_resource_conflict` |
  | 15 | `host_resources_unavailable` |
  | 16 | `lifecycle_command_failed`, `lifecycle_unavailable`, `lifecycle_invalid_output` |
  | 17 | `restored_send_held` |

- `apps/desktop/src/main/conversations/send-pipeline.ts` and
  `apps/desktop/src/main/review.ts` with `git-refusal.ts`: they keep their
  earlier decisions through `isDaemonRefusal` instead of `code === 'daemon'`.
- Pure-core tests: `packages/client/src/request.test.mjs` (the refusal
  decision and `recovery`), and one case added to
  `apps/desktop/src/main/git-refusal.test.mjs`.
- `e2e/protocol/fixtures/raw-reply.ts`: comment only; it no longer says the
  SDK drops codes. No new fixture. `e2e/protocol/errors/steps.ts` holds this
  area's setup steps.

## Acceptance criteria and specs

All in `e2e/protocol/errors/propagation.spec.ts`.

| Criterion | Spec | Result |
|---|---|---|
| F102/F103: `host_resource_conflict` keeps code, recovery and message through the SDK (`replied`, delivery) and the CLI (JSON body, exit 14) | a host_resource_conflict keeps its code and recovery ... across a retry and a restart | pass |
| Fault: a duplicate request with the same operation ID gets the same typed refusal; a crashed and restarted daemon still reports it; the shell survives; following the hint (inspect, stop the claim) admits the same request | same spec | pass |
| F102/F103: `needs_rebind` through the SDK and `ade file list` (exit 13) | a needs_rebind keeps its code and recovery ... until the workspace is rebound | pass |
| Fault: the refusal survives a daemon restart; following the hint (`workspace.rebind`) clears it | same spec | pass |
| F102/F103: a lifecycle refusal (`lifecycle_command_failed`, `inspect_repository`) through the SDK and `ade request` (exit 16); no Git output in the message | a lifecycle refusal keeps its lifecycle code and recovery ... | pass |
| F102/F103: `host_resources_unavailable` through the SDK and the CLI (exit 15) | a host_resources_unavailable keeps its code and recovery ... | pass |
| F102: a code-less daemon error stays `daemon` (exit 7, no `recovery`); a contract failure is `invalid_request`/`not_sent` (exit 2); a dead daemon is `unavailable`/`not_sent` (exit 3) | a daemon error with no code stays daemon, and local failures keep their own codes | pass |
| `lifecycle_outcome_unknown`, `lifecycle_unavailable`, `lifecycle_invalid_output`, `restored_send_held` through SDK and CLI | none | not covered |
| An in-flight request lost to a daemon crash | none | not covered |

## Requirements whose full register acceptance passes

F102 and F103 were already accepted by `e2e-orchestration.md`. This slice adds
their stable-error evidence for daemon refusal codes. It closes no new ID.

## Verification

- `pnpm build:backend && pnpm build`: pass.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/errors`: 5 passed.
- Regression run of the specs that read error codes:
  `orchestration/parity.spec.ts`, `resources/`, `backup/fences.spec.ts` and
  `boot.spec.ts`: 26 passed, 1 skipped (an existing fixme).
- `pnpm check:static`: pass.
- No `ade-daemon` or `ade-runtime` from this worktree was left running (`pgrep`).

## Bugs outside this area (not fixed)

None found.
