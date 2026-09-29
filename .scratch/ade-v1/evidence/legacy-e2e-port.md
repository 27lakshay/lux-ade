# legacy-e2e-port

Status: returned
Type: cleanup evidence
Branch: claude/agent-adc8acb0b8a4fd3ad (worktree `~/work/worktrees/lux-ade/claude-agent-adc8acb0b8a4fd3ad`)
Rule: AGENTS.md, Tests: "Port one into `e2e/protocol`, then delete it."

## Outcome

`e2e/specs` is empty and gone. All 26 legacy specs were ported onto the shared
protocol fixtures and deleted; none was fully covered by an existing protocol
spec. The legacy `playwright.config.ts` and the `test:e2e` script are removed.
No product bug was confirmed.

## What is uncertain or skipped

- **One legacy test is not ported.** `local-profiles` "a current profile store
  can be adopted by a new runtime home" drives `scripts/runtime.py adopt`, the
  GPUI prototype's Python tool. `ade-control runtime` has no `adopt`; its `bind`
  accepts only a fenced restore. AGENTS.md says not to write code for the
  prototype's Python scripts. Its "future" store version (18) is also older than
  the current schema (19). Restore it from the commit that deleted `e2e/specs/local-profiles.spec.ts` if adoption should stay.
- **One ported test is a `fixme`.** `backup/rebind.spec.ts` "schema-12 restore
  cannot rebind…": `ade-control backup restore` refuses schema 12
  (`Unsupported sessions.sqlite schema version 12`). It accepts the current
  schema and one behind; widening that is open decision D15.
- **Some assertions changed with the product, not the behaviour.** Each still
  asserts the same outcome:
  - effect commands carry an operation ID (the SDK adds one; raw lines name one);
  - a script's `exit_status` now also carries a `descendants` verdict, so it is
    matched by kind and code rather than equal;
  - backup `format_version` is 7, not 2;
  - a turn on a disabled account is refused as "disabled", not "not verified";
  - ade-control's refusal wording replaces profiles.py's ("Directory is
    redirected", "must be outside the profile it copies");
  - the migrated-schema checks compare with the schema a fresh profile has,
    not a fixed 16;
  - the registered backup's exclusions are read from the backend manifest
    inside the bundle, where ade-control records them.
- **Two environment adaptations.** A protocol profile has a scratch HOME, so the
  daemon cannot find mise-installed tools. The toolchain tests pass the host's
  real tool directories through `ADE_PROJECT_TOOL_PATHS`, and Corepack runs
  offline from a scratch copy of its cache. The Finder `PATH` stays
  `/no-system-tools`.
- **Not run:** the whole protocol suite. I ran every new spec, and the full
  `profiles/`, `backup/` and `load/fault-classes` areas after changing their
  shared fixtures.
- **AGENTS.md line 43 is stale** (it still describes `e2e/specs`). It is a
  coordinator-owned file, so I left it.

## Starting state

Before any change, `playwright test` on the legacy config (2 workers):
87 tests, 49 failed, 37 passed, 1 skipped. Lane E had reported 9 failures.
Causes: `Missing operation_id` from raw effect commands (most), Python
`managed_backup.py` and `profiles.py` refusing schema 19, a stale
`format_version` 2, and the disabled-account message.

## Legacy spec → outcome

| Legacy spec | Tests | Outcome |
|---|---|---|
| account-launch | 1 | Ported to `accounts/registry.spec.ts` |
| account-registry | 2 | Ported to `accounts/registry.spec.ts`, on ade-control managed profiles |
| attachment-retention | 4 | Ported to `context/reclaim.spec.ts`, backups through ade-control |
| conversation-answer-cli | 1 | Ported to `conversations/answer-cli.spec.ts` (`requests.spec.ts` covers `agent.answer`, not the CLI) |
| git-cli-ordinary | 2 | Ported to `files-git/cli-git.spec.ts` |
| git-discard | 9 | Ported to `files-git/discard.spec.ts` |
| local-cli | 4 | Ported: endpoint and TTY cases to `cli/local.spec.ts`, account cases to `accounts/cli.spec.ts` |
| local-profiles | 4 | 3 ported (`profiles/registry.spec.ts`, `profiles/backend-restore.spec.ts`); 1 not ported (`runtime.py adopt`, above) |
| native-control | 2 | Ported to `profiles/registry.spec.ts` |
| omp-account-readiness | 1 | Ported to `accounts/cli.spec.ts` |
| profile-backend-restore | 3 | Ported to `profiles/backend-restore.spec.ts`, through `ade-control profiles` |
| restored-workspace-fence | 2 | Ported to `backup/workspace-fence.spec.ts` |
| restored-workspace-rebind | 10 | Ported to `backup/rebind.spec.ts`; schema-12 case is a `fixme` (D15) |
| review-cli-parity | 1 | Ported to `files-git/review-feedback.spec.ts` |
| review-cwd-binding | 3 | Ported to `files-git/checkout-binding.spec.ts` |
| review-diff-page | 1 | Ported to `files-git/review-feedback.spec.ts` |
| review-feedback-batch | 1 | Ported to `files-git/review-feedback.spec.ts` |
| review-mutations | 1 | Covered by `files-git/local-git.spec.ts` (stage, unstage, stale revision and index, commit receipt); the uncovered pre-commit hook failure and commit replay/conflict ported to `files-git/cli-git.spec.ts` |
| service-durable-logs | 4 | Ported to `services/durable-logs.spec.ts` |
| service-inspection | 5 | Ported to `services/inspection.spec.ts` |
| service-peer-wiring | 2 | Ported to `services/peer-wiring.spec.ts` |
| service-proxy | 2 | Ported to `services/proxy-lifecycle.spec.ts` (`proxy.spec.ts` covers the single steps) |
| workspace-files-large | 9 | 2 covered by `files-git/browse.spec.ts` (10,000-entry listing, no-match search budget); 7 ported to `files-git/browse-cursors.spec.ts` |
| workspace-registration | 2 | Ported to `workspaces/registration.spec.ts` |
| workspace-scripts | 8 | Ported to `services/script-runs.spec.ts` |
| worktree-cwd-pin | 3 | Ported to `worktrees/checkout-pin.spec.ts` |

Counts by spec: 26 ported (2 of them partly covered already), 0 deleted as fully
covered, 0 kept. By test: 83 ported (1 of them `fixme`), 3 covered by existing
protocol specs, 1 not ported.

## Product findings (not bugs)

- `ade-control profiles backup-backend` on a profile that never started refuses
  with a raw lock error, `Cannot open lock …/runtime/launch.lock: No such file or
  directory`. profiles.py said the profile has no durable runtime binding. The
  refusal is correct; the message does not tell the user why.
- The renderer test `features/workspace/cards/motion.test.tsx` "collapsing a
  sidebar grows the centre frame by frame…" failed twice in `pnpm check:static`
  while E2E ran on the same machine (`expected 4 to be greater than 4`, then
  `expected 3 …`). It passed on each rerun alone. It counts frames, so it is
  load-sensitive.

## Follow-ups this unblocks

- Ticket 07 (backup implementation) step 6: no E2E calls `scripts/profiles.py`
  or `scripts/managed_backup.py` any more.
- `e2e/fixtures/` stays: `fixtures/daemon.ts` supplies `rpc` to the protocol
  fixtures, and the packaged and live specs use it and the two provider fixtures.

## Checks

- `pnpm check:static`: pass on each commit (the motion test above needed a rerun twice).
- Every new protocol spec run green with `ADE_E2E_WORKERS=2`.
