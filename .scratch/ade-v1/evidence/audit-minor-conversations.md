# Audit minor fixes: conversations

Both defects were traced in the current code and confirmed before fixing.
`pnpm check:static` passes.

## 1. A replayed `command.invoke` reported `queued` for a cancelled prompt

- Confirmed: `Store::enqueue_content` found the existing `queued_prompts` row,
  compared owner, text and attachments only, and returned `Ok(())` whatever its
  status. The invoke replay then settled the receipt as `Queued`.
- Fix: `enqueue_content` now returns a `QueueEntry` (`Queued`, `Delivered`,
  `Cancelled`) read from the row's status. The pure decider
  `settled_outcome` in `crates/ade-daemon/src/sessions/commands.rs` maps
  `Cancelled` to a new `CommandInvokeOutcome::Cancelled` with a reason; the
  receipt settles with that reply, so later retries return it too.
- Contract: `CommandInvokeOutcome` gains `cancelled` (additive).
  `pnpm contract:generate` was run.
- Test: `sessions::commands::tests::a_replay_that_finds_its_prompt_cancelled_does_not_report_queued`.

## 2. `conversation_changed` dropped `responding` requests that `conversation.get` returned

- Confirmed: `Sessions::changed` filtered `store.pending()` to `status == "pending"`,
  while the snapshot included `responding`. `agent.answer` leaves a request
  `responding` after an uncertain runtime error, and the client replaces its
  request list with each frame's, so the retry form vanished.
- Fix: the frame's list now comes from the pure `frame_requests` in
  `crates/ade-daemon/src/sessions.rs`, which keeps `pending` and `responding`,
  the same set `conversation.get` returns.
- Test: `sessions::frame_tests::an_uncertain_answer_keeps_its_form_in_the_delta`.
