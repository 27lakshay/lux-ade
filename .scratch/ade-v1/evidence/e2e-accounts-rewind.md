# e2e-accounts-rewind

Status: returned
Type: slice evidence
Branch: claude/wf_59b7ac6e-d6c-3
Worker: ADE parallel build, round 4, slice accounts-rewind
Requirements: F026, F039 (accepted, pending coordinator review); D04

## Outcome

Claude conversation rewind no longer depends on behaviour the Agent SDK does
not document. The earlier proof relied on the fake SDK truncating its session
file when a query started with `resumeSessionAt`. The bridge now rewinds with
`forkSession()`, which the SDK documents as writing a new session file up to a
chosen message, and resumes that fork. Claude now also declares native
account continuation: ADE copies the session transcript into the new
account's `CLAUDE_CONFIG_DIR`, which is how the SDK documents resuming a
session on another host. With that, both register criteria have passing
specs, so this slice claims F026 and F039.

What is uncertain:

- Nothing here ran against the real Claude CLI or a real account. The fake SDK
  now does only what `sdk.d.ts` 0.3.281 and the Agent SDK docs say. Where the
  docs are silent, it does the least helpful thing: it never truncates a
  transcript, and it writes an idle fork's file only at the first message.
- The single-turn check (`resumeDropsTurn`) runs as a separate forking resume
  that ADE closes without sending anything. The docs say the CLI checks "at
  fork time". Whether the real CLI refuses before it answers `initialize`
  was not verified against the real CLI.
- The fork gives kept entries new UUIDs, so ADE stores a record under
  `<data>/claude-forks/<session>.json` that maps them back to the IDs ADE
  knows. If that record is lost, a resume of the fork would show the kept
  messages twice. Backup copies the data directory; nothing else checks the
  record.
- Codex conversation rewind stays unavailable. See "Provider support" below.

## What the providers document

| Provider | Documented | ADE uses |
|---|---|---|
| Claude Agent SDK 0.3.281 (`sdk.d.ts`, sessions and file-checkpointing guides) | `forkSession(id, {upToMessageId})` copies the transcript up to and including a message into a new session with new UUIDs, keeping the chain, and the fork resumes with `resume`. The `forkSession: true` option forks on resume, and the original stays unchanged. `resumeSessionAt` loads only up to a message. It does not say what happens to the file. `resumeDropsTurn` refuses at fork time with `Resume rejected by --resume-drops-turn:`, and the refusal must not be retried. `rewindFiles()` restores files only and "does not rewind the conversation". A session file moved under another `projects/` directory can be resumed. | `forkSession()` then `resume`. The single-turn check is a forking resume with `resumeDropsTurn`. Files go through ADE checkpoints. Account continuation copies the transcript. |
| Codex app-server (README and `v2/thread.rs` at `main`, 2026-09-27) | `thread/rollback` is removed. `thread/revert` replaces the durable history of a *paginated* thread with the prefix before a turn, and leaves files unchanged. `thread/fork` takes `lastTurnId` (stable) or `beforeTurnId` (experimental) to fork at an earlier turn. | Nothing. Conversation rewind reports `unavailable` and names these methods. The installed 0.157.0 schema was not regenerated, because running `codex` could reach its keyring; so `lastTurnId` support in 0.157.0 is unverified. |

## Acceptance criteria

Specs are in `e2e/protocol/accounts-rewind/`. `rewind.spec.ts` replaces
`ops3/rewind.spec.ts`, moved with `git mv`, and is rewritten for the fork.

### F039 Conversation and file rewind

| Criterion | Spec | Result |
|---|---|---|
| Preview the affected conversation: removed messages and turns, kept messages, a state token; a stale token is refused before Claude is asked | `rewind.spec.ts` "a Claude rewind forks the session…" | pass |
| Preview the affected files | `context/rewind.spec.ts` file rewind tests | pass |
| Perform supported rewind: `forkSession` at the entry before the turn; the Conversation moves to the fork in the same transaction; the earlier native session is unchanged on disk; later turns land in the fork; a resume reads the fork back without duplicates | same, plus "a fork is rewound again at a prompt it copied…" (a second rewind across an Agent restart, at a prompt whose UUID the fork changed) | pass |
| The CLI drives it; dropping only the last turn runs Claude's fork-time check first | "removing only the last turn…" | pass |
| Invalidate stale history pages: a page read under epoch 0 is refused after the rewind | "a Claude rewind forks the session…" | pass |
| Faults: a lost reply and a daemon crash replay once. A daemon crash while Claude is still forking leaves the Conversation on the earlier session: the reattached Agent reports the fork and the session it left, and the retry commits the move once. That spec fails when the reattach check is removed. | "R001: a rewind whose reply was lost…", "R001: a daemon crash while Claude forks…" | pass |
| Report unsupported honestly: Codex (with the documented reason), busy, disconnected, before the first turn, not at a prompt | `context/rewind.spec.ts`, "a rewind is refused while a turn runs…" | pass |
| Report a refused rewind honestly: the fork-time check refuses; no fork is made; ADE keeps its messages, session and epoch; the live query is untouched; the refusal replays | "a rewind Claude refuses at its fork-time check…" | pass |
| Report partial restoration honestly: a file rewind that fails part way is `partial`, unverified, names the failure and keeps the safety checkpoint | "a file rewind that stops part way…" | pass |

### F026 Explicit in-conversation account switching

| Criterion | Spec | Result |
|---|---|---|
| Switch using an adapter-declared operation: Claude declares `account_switch: supported`. The preview offers `native_continuation`. The transcript is copied byte for byte into the new account's home. After a resume, the next turn runs in the same native session under the new account's `CLAUDE_CONFIG_DIR`, and only that account's mock sees it. | `accounts-rewind/account-switch.spec.ts` "a Claude conversation continues its native session…" | pass |
| Switch when the adapter declares nothing: Codex moves to a new native session under the new `CODEX_HOME` with an excerpt | `providers/account-switch.spec.ts` (round 2) | pass |
| Retain provenance: accounts, generations, `previous_native_session`, operation ID, `agent_stopped`; list and CLI | both files | pass |
| Disclose continuity limits: the native-continuation disclosure says the earlier account keeps its copy and file checkpoints do not carry over; the new-session disclosure says what stays behind | both files | pass |
| Reject unsupported switching without silently creating a different session: `native_continuation` is refused for Codex and for a Claude conversation with no native session; `new_native_session` is refused where native continuation applies. A different transcript already in the target home is never overwritten, and nothing switches. | both files, "a different transcript already in the new account…" | pass |
| Faults: a lost reply and a daemon crash converge on the receipt; the copy is idempotent | "a native-continuation switch whose reply was lost…", `providers/account-switch.spec.ts` | pass |

The `test.fixme` for native continuation in `providers/account-switch.spec.ts`
is now a comment that points to the new spec.

## Product changes

- `providers/claude/bridge.mjs`: rewind through `forkSession()`, a fork-time
  check for a single-turn drop, a check that the fork kept every earlier entry
  in order with the same type and body (as t3code does), and the UUID record.
  The old `resumeSessionAt` restart and its refusal handling in `consume()`
  are gone.
- `crates/ade-runtime`: `Provider::rewind` returns the forked session. The
  Agent remembers the fork and the session it left, so a reattaching daemon
  reads both (`Connected.rewound_from`). A managed Claude launch keeps
  `ADE_DATA_DIR`, which holds no credentials. The Claude capability record
  declares rewind and account switching `supported`, with the documented
  mechanism.
- `crates/ade-daemon`: the rewind moves `provider_thread_id` to the fork in
  the same transaction as the message removal and the receipt. Reattach
  accepts an unsettled fork. Native continuation copies the Claude transcript
  and its `<session>/` directory before the switch commits, and never
  overwrites a different file. The mechanism is now `claude.fork_session`,
  and the Codex reason names the documented methods.
- Contract: `ConversationRewindHistory` gains optional `native_session` and
  `previous_native_session` (regenerated).
- Fixtures: `fake-sdk.mjs` implements `forkSession()`, `deleteSession()`, the
  `forkSession` option and an init message. It keeps transcripts as JSON Lines,
  under `<CLAUDE_CONFIG_DIR>/projects/<cwd>/` for a managed account.
  `claude_mock.mjs` keeps its call log in the account home when a managed
  launch clears `ADE_MOCK_CLAUDE_DIR`, so managed Claude turns now run in E2E
  (the gap `e2e-providers.md` recorded).

## Operation tiers

- `conversation.rewind`: effect command. Unchanged tier; the reply's `history` can carry `native_session` and `previous_native_session`.
- `conversation.rewind.preview`, `conversation.controls`: queries; the mechanism is renamed.
- `account.switch`: effect command. Native continuation now copies the transcript before the commit.
- `account.switch.preview`, `account.switch.list`: queries; unchanged.

## Checks

- `pnpm build:backend && pnpm build`: pass.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/accounts-rewind e2e/protocol/providers e2e/protocol/context e2e/protocol/conversations e2e/protocol/conversations2 e2e/protocol/ops3 e2e/protocol/catalogs e2e/protocol/boot.spec.ts`: 152 passed, 4 skipped (`fixme`).
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/adapters e2e/protocol/orchestration e2e/protocol/plugins e2e/protocol/reliability-b e2e/protocol/backup`: 106 passed. These are the other areas that start the Claude mock, whose transcript storage changed.
- After `cargo fmt`, `accounts-rewind`, `providers/account-switch.spec.ts` and `context/rewind.spec.ts`: 20 passed, 1 skipped (the Codex conversation-rewind `fixme`).
- The unsettled-fork reattach path was checked by disabling it: "R001: a daemon crash while Claude forks…" then fails.
- `pnpm check:static`: pass (784 Rust tests).
- `node --test` in `providers/claude`: 20 passed.
- In-process tests added: none. The behaviour is proved by E2E.
- Machine safety: no spec, fixture or product change calls the Security framework, the `security` tool or `hdiutil`. `codex` was not run. `pgrep` found no `ade-daemon`, `ade-runtime` or `security` process from this worktree after the runs.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 150 | 15 | 30 | 0 |

## References

- `@anthropic-ai/claude-agent-sdk` 0.3.281 `sdk.d.ts`: `forkSession`, `ForkSessionOptions.upToMessageId`, `deleteSession`, `getSessionMessages`, `Options.forkSession`, `resumeSessionAt`, `resumeDropsTurn`, `rewindFiles`, studied.
- https://code.claude.com/docs/en/agent-sdk/sessions (fork, resume, moving a session file across hosts) and https://code.claude.com/docs/en/agent-sdk/file-checkpointing (file rewind does not rewind the conversation), studied 2026-09-27.
- Codex app-server README and `codex-rs/app-server-protocol/src/protocol/v2/thread.rs` at `main`, 2026-09-27 (`thread/revert`, `thread/fork` `lastTurnId`/`beforeTurnId`, `thread/rollback` removed), studied.
- t3code @ ade-evaluation-2026-09-24, `apps/server/src/provider/Layers/ClaudeAdapter.ts` `rollbackThread` and `remapClaudeForkTurnBoundaries`: pattern (fork with `upToMessageId`, check the fork by type and body, resume the fork). No code copied.
- paseo @ ade-evaluation-2026-09-24, `packages/server/src/server/agent/providers/codex/rewind.ts`: studied (Codex fork or rollback by history mode).
- agentclientprotocol/claude-agent-acp PR #872: studied (`resumeSessionAt` with `forkSession: true` for rewind-on-fork).

## Open

- Coordinator: `conversation_history_epochs` is still created on first use (from ops-3).
- Codex conversation rewind: wire `thread/fork` with `lastTurnId` once the pinned Codex schema is checked by hand. Do not run `codex` from a worker.
- A refusal reaches clients as the safe category "Provider rejected the operation…", not Claude's text. That is the existing error policy; the refusal's cause is visible only in logs.
- `account.switch` with native continuation leaves the Conversation `disconnected`, so the user must resume it before the next prompt. `agent.send` refuses until then, as it does for any disconnected Conversation that has a native session.
- Legacy (provider login) Claude conversations carry from `$CLAUDE_CONFIG_DIR` or `~/.claude`. The fake keeps unmanaged sessions in its mock directory, so no spec covers moving from the provider login to a managed account by native continuation.
- Claude's own file checkpoints (`file-history`) and task results in `claude-task-results` stay keyed to the earlier session or account. The disclosure names the checkpoints.
- Outside this area: none found.
