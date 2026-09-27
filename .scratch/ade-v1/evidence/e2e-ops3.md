# e2e-ops3

Status: returned
Type: slice evidence
Branch: claude/wf_c51346dc-a4d-3 (completes claude/wf_317b0f50-41b-9)
Worker: ADE parallel build, round 3 follow-up, slice ops-3
Requirements: F039, F050, F062, F132 (accepted); F043, F131, F136, F137, F138 (advanced, not accepted)

## Outcome

The ops-3 worker lost network access after five commits. This slice merged
them, reviewed them and fixed two defects the review found:

- **Refused Claude rewind was reported as done.** When the Claude CLI refuses a
  single-turn rewind (`resumeDropsTurn`), it answers with a later
  `Resume rejected` result. The bridge acknowledged the rewind once the new
  query initialised, so ADE deleted its messages and moved the history epoch
  while Claude kept the turn. The bridge now waits for that refusal, resumes
  plainly with the history kept, and reports the rewind as refused. A new spec
  proves this; it fails against the merged bridge.
- **The Codex MCP override could drop the user's own servers.** The adapter
  passed the whole `mcp_servers` table as one `config` key, which can replace
  the servers in the user's `config.toml`. It now passes one
  `mcp_servers.<name>` key per server, as t3code does. Catalog names cannot
  contain a dot.

It also fixed a `u64` overflow in `retention.policy.set`: a client sending
`expected_revision` of `u64::MAX` panicked the debug daemon.

Accepted: F039, F050, F062 and F132. Every part of each register criterion now
has a passing spec.

## Acceptance criteria

### F039 Conversation and file rewind

| Criterion | Spec | Result |
|---|---|---|
| Preview the affected conversation | `ops3/rewind.spec.ts` first test: the preview names removed messages, turns, kept messages and a state token | pass |
| Preview the affected files | `context/rewind.spec.ts` file rewind tests | pass |
| Perform supported rewind: Claude natively through `resumeSessionAt`, removing ADE's messages; the CLI drives it; lost reply and daemon crash replay once | `ops3/rewind.spec.ts` first, second and R001 tests | pass |
| Invalidate stale history pages: an older page read under epoch 0 is refused after the rewind | `ops3/rewind.spec.ts` first test | pass |
| Report unsupported honestly: Codex, busy, disconnected, before the first turn, not at a prompt | `context/rewind.spec.ts`, `ops3/rewind.spec.ts` third test | pass |
| Report a refused rewind honestly: Claude refuses the fork, ADE keeps every message and the epoch, the Conversation continues and a resume reads the kept history | `ops3/rewind.spec.ts` "a rewind Claude refuses at resume…" | pass after fix |
| Report partial restoration honestly: Git fails part way (a read-only directory), so the rewind is `partial` and unverified, names the failure, keeps the safety checkpoint and replays | `ops3/rewind.spec.ts` "a file rewind that stops part way…" (new: no earlier spec drove `partial`) | pass |

### F050 History export and backup

| Criterion | Spec | Result |
|---|---|---|
| Export readable history across pages, never overwriting, no partial file, refused when history changes mid-read | `ops3/export.spec.ts` | pass |
| Managed backup and restore, blob verification, disclosed exclusions | `backup/*.spec.ts` (see `e2e-backup.md`), rerun here: 10 pass | pass |

The rewind's `conversation_history_epochs` table and the retention
`retention_settings` table live in `sessions.sqlite`, which backup copies whole.

### F062 Repository clone and publish

| Criterion | Spec | Result |
|---|---|---|
| Clone into a selected path; never overwrite an existing path; partial-operation evidence; unknown outcomes typed `outcome_unknown` | `resources/repository.spec.ts` (see `e2e-resources.md`) | pass |
| Clone into a selected host: lands, registers and replays on the remote host only | `ops3/remote.spec.ts` first test | pass |
| Publish and clone through the configured Git auth flow: the profile's `core.sshCommand`; a refused key settles as `not_pushed` with Git's reason; a URL with a password is refused before Git runs | `ops3/repository-auth.spec.ts` | pass |

### F132 Central skill catalog

| Criterion | Spec | Result |
|---|---|---|
| Install and discover complete bundles with provenance; external files kept intact | `catalogs/skills.spec.ts` (round 1) | pass |
| Invoke through adapter rules: `skill.place` writes the bundle to Claude's workspace root; it becomes `/greet` and reaches Claude; Codex reports it has no skill input | `ops3/skill-place.spec.ts` | pass |
| Never write over an external skill; identical external content stays external; an edited placement is refused | `ops3/skill-place.spec.ts` second and first tests | pass |
| Remote installation is explicit: installed and placed only on the named remote host | `ops3/remote.spec.ts` second test | pass |

### Advanced, not accepted

- **F043.** Messages removed by a rewind leave search (`ops3/rewind.spec.ts`).
  No operation deletes a whole Conversation, so
  `catalogs/history.spec.ts` "a deleted conversation disappears" stays
  `fixme`. Whether rewind is enough to accept F043 is a coordinator decision.
- **F131.** Claude (`mcpServers`) and Codex (`mcp_servers.<name>`) launches
  receive the resolved catalog, a resume reads the current catalog, and the
  resolution reports `delivery: direct` (`ops3/mcp-launch.spec.ts`). There is
  no gateway, so "both-leg capability/auth handling" has nothing to observe.
  Oh My Pi stays unwired.
- **F138.** Retention limits can now be configured under a revision guard,
  and a preview made under the old policy cannot apply
  (`ops3/retention-policy.spec.ts`). The display and the unreferenced skill
  files remain open, as `e2e-ops.md` records.
- **F136, F137.** This slice made no change; their display parts remain.

## Operation tiers

- `conversation.rewind` (scope `conversation`): effect command; now performed for Claude.
- `conversation.rewind.preview`: query; gains `history`.
- `conversation.get`: query; gains `history_epoch` in request and reply.
- `skill.place`: effect command (new).
- `retention.policy.get`: query (new).
- `retention.policy.set`: idempotent command (new), guarded by revision.
- `repository.clone`, `repository.publish`: unchanged tier; an unknown outcome is typed `outcome_unknown`.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/ops3 e2e/protocol/ops e2e/protocol/catalogs e2e/protocol/context e2e/protocol/resources/repository.spec.ts e2e/protocol/remote`: 111 passed, 3 skipped (`fixme`).
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/backup`: 10 passed.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/ops3/rewind.spec.ts` after the partial-restore spec was added: 6 passed.
- `pnpm check:static`: pass (774 Rust tests).
- `node --test` in `providers/claude`: 20 passed.
- In-process tests added: `crates/ade-runtime/src/codex.rs` (per-server MCP overrides), `crates/ade-daemon/src/retention.rs` (a revision no daemon issued is refused), `crates/ade-runtime/src/agent_runtime.rs` (a failed rewind does not end the run).
- Machine safety: no spec or code in this slice calls the Security framework, the `security` tool or `hdiutil`. Profile processes run with `GIT_CONFIG_NOSYSTEM=1`, so the system `osxkeychain` credential helper never loads, and the one HTTPS URL is refused before Git runs.
- `pgrep`: no `ade-daemon`, `ade-runtime` or `security` process from this worktree was left running.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 30 | 35 | 30 | 10 |

## References

- `@anthropic-ai/claude-agent-sdk` 0.3.281 `sdk.d.ts`, `resumeSessionAt` and `resumeDropsTurn`: studied.
- t3code @ 2026-09-24 `apps/server/src/provider/Layers/CodexAdapter.ts`: pattern (per-server `mcp_servers.<name>` overrides).

## Open

- Coordinator: `conversation_history_epochs` is created on first use, not by a
  numbered migration, because migration numbers are the coordinator's. It may
  belong in `store/migrations.rs`.
- `context/rewind.spec.ts` "R001: a file rewind whose reply was lost…" is
  timing-sensitive. It failed 4 times in a row under load from other workers,
  then passed 6 of 6. It passes on the pre-merge base too, and this slice did
  not change the file rewind path. The spec kills the daemon as soon as the
  file is restored, which can land before the checkpoint receipt settles; the
  retry then reports the outcome as unknown.
- A refused rewind whose `Resume rejected` result arrives after the CLI answers
  initialize is still only reported as an error event. The SDK documents the
  refusal as a boot-time check, so the bridge waits one event-loop turn after
  initialization for it. This was verified against the fake SDK, not the real
  CLI.
- `skill.place` has two narrow races: a directory created at the path after
  the final check and before the rename, and an edit to ADE's own placement
  after observation and before a replace.
- Codex conversation rewind stays unavailable: `thread/revert` rewrites only
  paginated threads.
