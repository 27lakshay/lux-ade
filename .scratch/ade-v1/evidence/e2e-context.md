# E2E round 2: context controls

Status: returned
Type: slice evidence
Branch: claude/wf_40412ab1-96e-9
Worker: ADE parallel build, E2E round 2, context-controls worker
Requirements: F032, F033, F036, F037, F039, F040, F046, R001, R002

## Outcome

Headless protocol E2E now covers context and conversation controls in
`e2e/protocol/context/`: 24 tests pass and 1 is `test.fixme`. Every test
drives a real `ade-daemon` and `ade-runtime` through the SDK, the CLI or raw
protocol lines, with the Codex and Claude fixture providers. The specs found
four product bugs and two gaps in this area; all six are fixed. The register
E2E acceptance for F032, F033, F036, F037 and F046 passes with fixture
providers. F040 passes if "retained context" means the retained history (see
below). F039 does not fully pass: no adapter rewinds a provider's history.

Fixture providers alone do not establish product completion (spec 03,
"Feature acceptance"). Real-provider evidence and UI coverage are still
required separately.

## Acceptance criteria

| Requirement | Criterion | Spec | Result |
|---|---|---|---|
| F032 | Supported image and text reach Codex (UserInput image data URL, text item) and Claude (base64 image block, text block) in native form | `attachments.spec.ts` "an image and a text file reach Codex and Claude in their native forms" | pass |
| F032 | Attachment references restored after a daemon crash (messages, `attachment.inspect`) | same test | pass |
| F032 | Unsupported type (PDF, binary, empty) and size (over 8 MiB, text over 1 MiB) refused at attach time | `attachments.spec.ts` "unsupported types and sizes are refused before anything is recorded or dispatched" | pass |
| F032 | 7.6 MB image refused for Claude before dispatch by `context.plan`, `agent.send` and `queue.enqueue`; nothing recorded or sent; the same image is admitted for Codex; more than 8 attachments refused | same test | pass |
| F032 | Missing file, directory, unknown attachment ID and reclaimed attachment are reported; draft reference survives a crash and protects the attachment | `attachments.spec.ts` "missing files and reclaimed attachments are reported and never sent" | pass |
| F033 | File range and diff hunk captured by the daemon with source identity; stale diff token refused; preview equals what Codex receives, byte for byte | `capture.spec.ts` "file and diff captures keep their source identity and preview exactly what Codex receives" | pass |
| F033 | Terminal selection (escapes stripped), service log tail (bounded, truncation stated) and browser element (document and screenshot) with origin and provenance; unknown terminal, service and capture refused; plan forms and prefixes match the native input | `capture.spec.ts` "terminal, service log and browser captures record who supplied the text" | pass |
| F033, R002 | Repeat of a request ID returns the recorded node without re-reading; a different source conflicts; node survives a daemon crash; CLI `context get` and `context file` | `capture.spec.ts` "a repeated capture returns the recorded node" | pass |
| F033 | Line and size bounds, 1 MiB client text limit, cross-workspace refusal, reclaimed attachment reported unavailable and refused at send | `capture.spec.ts` "captures are bounded, stay in their workspace" | pass |
| F036 | Live draft keeps captured context through a window crash and a daemon crash; older write never overwrites; conflict resolution only over the seen revision | `drafts.spec.ts` "a live draft restores its captured context" and `conversations/drafts.spec.ts` "a live draft restores its context nodes" (fixme removed) | pass |
| F036 | Discarded and sent drafts recalled with their context; a send clears the context; recall refused over a newer revision | `drafts.spec.ts` "a cleared or sent draft is recalled with its context" | pass |
| F036 | Stash transfers text, attachments and context between windows without overwriting a newer draft; stash protects the attachment; context bound refused | `drafts.spec.ts` "a stash moves a draft and its context to another window" | pass |
| F037 | Claude project command and skill listed with provenance, description and argument hint; invoked with arguments in native form; the provider receives `/review src/app.ts`; retry converges after a crash; other arguments conflict; CLI list and invoke | `commands.spec.ts` "Claude lists project commands and skills with provenance" | pass |
| F037 | Setting source not loaded, ambiguous command and skill, missing file, control-character arguments: refused with the reason, nothing queued, no receipt | `commands.spec.ts` "an entry the provider does not load, an ambiguous name and a missing file are refused" | pass |
| F037 | Codex prompts and skills listed as unavailable with the missing native mechanism; nothing queued or sent | `commands.spec.ts` "Codex lists its prompts and skills as unavailable" | pass |
| F037, R001 | Lost reply plus daemon crash: queued once, delivered once; a cancelled invocation replays as `cancelled` | `commands.spec.ts` "an invocation whose reply was lost is queued once" | pass |
| F039 | File rewind through a checkpoint for Codex and Claude: preview lists changes and asks for confirmation, restore verified, history untouched, replay after crash, conflict on a different payload | `rewind.spec.ts` "codex/claude rewinds files through a checkpoint after a preview" | pass |
| F039 | Conversation rewind reported unavailable with the adapter's reason for both providers, no receipt, history unchanged | same tests | pass |
| F039 | Stale preview, unconfirmed overwrite and running turn refused; files kept; no receipt | `rewind.spec.ts` "file rewind refuses a stale preview, unconfirmed overwrites and a running turn" | pass |
| F039, R001 | Lost rewind reply plus daemon crash: outcome read back, no second restore over a later edit, one safety checkpoint | `rewind.spec.ts` "a file rewind whose reply was lost is read back" | pass |
| F039 | Perform a supported conversation rewind and invalidate stale history pages | `rewind.spec.ts` "a Codex conversation rewind drops later messages" | fixme (gap below) |
| F040 | Native compaction with provenance (`thread/compact/start` on the provider thread, `contextCompaction` item ID and turn); earlier history retained in order; record survives a crash; the same thread continues; CLI compact | `compaction.spec.ts` "a Codex compaction keeps its native provenance and the earlier history" | pass |
| F040, R001 | Lost compaction reply plus daemon crash: acknowledged on retry, one native call, one record | `compaction.spec.ts` "a compaction whose reply was lost is read back" | pass |
| F040 | Unsupported provider and busy Conversation report why; no compaction record claimed | `compaction.spec.ts` "an unsupported provider or a busy Conversation reports why" (provider refusal is in `conversations/controls.spec.ts`) | pass |
| F046 | Snooze falls due while ADE is down; one `snooze_ended` activity on restart; the running turn keeps running; nothing queued or sent; no second wake on another restart | `snooze.spec.ts` "a snooze that falls due while ADE is down wakes once on restart" | pass |
| F046 | Wake while running; a new time replaces the old; unsnooze records no wake; no agent work scheduled; CLI snooze | `snooze.spec.ts` "a snooze wakes while ADE runs" | pass |
| F046 | Past, over-366-day and unparseable wake times refused | `snooze.spec.ts` "a wake time in the past or more than 366 days ahead is refused" | pass |

## Product fixes

1. **`context.*` refused every protocol request.** `ContextCaptureRequest`,
   `ContextGetRequest` and `ContextPlanRequest` deny unknown fields, and the
   daemon decoded them with the `op` field still present, so all three failed
   with "unknown field `op`". `sessions/context.rs` now drops `op` before
   decoding.
2. **Client-supplied context over 128 KiB could not be sent.** Both the daemon
   (`bin/daemon/server.rs`) and the SDK (`packages/client/src/request.ts`)
   refused any request over 128 KiB except `attachment.put`, so terminal and
   log captures up to the documented 1 MiB failed. `context.capture` is now
   exempt too; the 12 MiB line limit still applies.
3. **F033 gap: no preview of what is sent.** No operation returned a node's
   stored document. `ContextNodeReply` now carries `previews`: each live
   attachment's ID, media type and, for text, the exact document the provider
   receives after the plan's `text_prefix`.
4. **F036 gap: a live draft lost its context nodes.** `draft.save` takes
   `context_nodes`, and `Draft` returns them. They live in a new
   `draft_context` table in the profile state database, created idempotently
   beside `draft_history`, keyed by window and tied to the revision that saved
   them. A later write without them (a send clearing the draft) leaves them
   behind without a delete. History entries now keep the draft's context;
   restores write it back. A draft holding only context counts as non-empty.
   No migration version changed.
5. **A replayed `command.invoke` said `queued` for a cancelled prompt.** A
   settled receipt returned its stored reply even after the user cancelled the
   queued prompt, so a retry after a lost reply reported an invocation that will
   never run as queued. The replay now reads the queue entry and reports
   `cancelled` (`sessions/commands.rs`, `Store::queue_entry`).

## Fixture changes

- New generic fixture `e2e/protocol/fixtures/browser-owner.ts`: a scripted
  browser owner on a private Unix socket inside the test process, registered
  with `browser.owner.register`, answering relayed commands such as
  `browser.context.capture`. It starts no process. It is not re-exported from
  `fixtures/index.ts`; specs import it directly.
- `e2e/protocol/context/helpers.ts`: area-local helpers (mock inputs, sized PNG).

## Requirements whose register E2E acceptance now passes

- F032, F033, F036, F037, F046: full register acceptance passes with fixture
  providers.
- F040: passes if "retained context" means ADE keeps the history before the
  compaction and the provider thread continues. Codex does not expose the
  retained summary, and ADE claims none.
- R001 and R002: pass for `context.capture`, `command.invoke`,
  `conversation.rewind`, `conversation.compact`, `conversation.snooze` and the
  draft operations with context.
- Not fully passing: F039 (conversation rewind and history-page invalidation).

## Operation tiers

No tier changed. `draft.save` (idempotent command) gained an optional
`context_nodes` field; `context.capture` and `context.get` (idempotent command,
query) gained the `previews` reply field. Both are additive.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/context`: 24
  passed, 1 fixme. Under `--repeat-each 2`: 48 passed, 2 skipped, no flakes.
- `e2e/protocol/conversations` and `boot.spec.ts` rerun after the fixes: 42
  passed, including the former F036 fixme.
- `pnpm check:static`: pass (734 legacy Rust tests, 5 skipped).
- In-process tests added: `crates/ade-daemon/src/store/drafts.rs`
  (`a_draft_keeps_context_only_at_the_revision_that_saved_it`),
  `crates/ade-daemon/src/sessions/commands.rs`
  (`a_settled_reply_reports_a_later_cancellation_and_nothing_else`).
- `pgrep` found no `ade-daemon` or `ade-runtime` from this worktree after the runs.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 75 | 5 | 15 | 0 |

## References

- None. No reference repository was used.

## Open

- F039 gap: conversation rewind needs the adapter call (Codex
  `thread/revert`, Oh My Pi `branch`, OpenCode revert, Claude
  `resumeSessionAt`), removal of ADE's stored messages after the rewind point,
  and invalidation of history pages a client already read. The `test.fixme`
  in `rewind.spec.ts` names it.
- F033: terminal and service text stays client-supplied; the daemon checks only
  that the terminal or service exists. The browser capture ran against the
  scripted owner, not Electron.
- A context node does not protect its attachment from explicit reclaim; only
  draft, stash, queue, send-intent and message references do. The spec shows a
  reclaimed node reported as unavailable and refused at send.
- Shared files for the coordinator: `crates/ade-daemon/src/bin/daemon/server.rs`
  and `packages/client/src/request.ts` (one-line size-limit exemption each),
  `crates/ade-core/src/model.rs` (`Draft.context_nodes`),
  `crates/ade-daemon/src/store/tests.rs` (field added to test literals),
  regenerated `packages/contracts`, and `e2e/protocol/conversations/drafts.spec.ts`
  (fixme lifted). The new `draft_context` table lives in the profile state
  database; backup copies that database whole.
- Other domains: `conversation.controls` and the conversation core were not
  changed. `agent.cancel` leaves a Claude Conversation `interrupted` with a
  provider error after a daemon restart, and an unpaused queue then does not
  dispatch until the next send (seen while writing the command spec; not
  investigated, spec reworked to pause the queue instead).
