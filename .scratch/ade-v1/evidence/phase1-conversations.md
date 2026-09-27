# phase1-conversations

Status: returned
Type: slice evidence
Branch: claude/wf_e0896549-359-1
Worker: ADE parallel build, Phase 1 typed domains, conversations
Requirements: none (D02 contract typing)

## Outcome

The 17 conversation-domain operations that exist in the daemon now have typed request and response contracts in `crates/ade-core/src/contract/conversations.rs`, each with a declared tier. Their handlers in `crates/ade-daemon/src/sessions/conversations.rs` decode the typed requests and build replies from typed responses. The store's `SendIntent` and `AttachmentReclaimPreview` are now the contract types. The CLI (`conversation create`, the `git feedback-send` draft steps) and Electron main (`send-pipeline.ts`, `ipc.ts`) check these replies with `decodeDailyUseResponse`. `prompt.send` does not exist in the daemon, so it has no contract.

## Operation tiers

| Operation | Tier | Request | Response |
|---|---|---|---|
| `conversation.create` | effect command | `ConversationCreateRequest` | `ConversationCreated` |
| `draft.get` | query | `DraftGetRequest` | `DraftReply` |
| `draft.save` | idempotent command | `DraftSaveRequest` | `DraftReply` |
| `draft.send.get` | query | `DraftSendGetRequest` | `SendIntentState` |
| `draft.send.prepare` | idempotent command | `DraftSendPrepareRequest` | `SendIntentPrepared` |
| `draft.send.complete` | idempotent command | `DraftSendCompleteRequest` | `DraftReply` |
| `draft.send.abort` | idempotent command | `DraftSendAbortRequest` | `DraftReply` |
| `queue.enqueue` | effect command | `QueueEnqueueRequest` | `Ack` |
| `queue.cancel` | idempotent command | `QueueCancelRequest` | `Ack` |
| `queue.pause` | idempotent command | `QueuePauseRequest` | `Ack` |
| `window.save` | idempotent command | `WindowSaveRequest` | `Ack` |
| `window.close` | idempotent command | `WindowCloseRequest` | `Ack` |
| `attachment.put` | idempotent command | `AttachmentPutRequest` | `AttachmentReply` |
| `attachment.import` | idempotent command | `AttachmentImportRequest` | `AttachmentReply` |
| `attachment.inspect` | query | `AttachmentInspectRequest` | `AttachmentInspection` |
| `attachment.reclaim.preview` | query | `AttachmentReclaimPreviewRequest` | `AttachmentReclaimPreviewReply` |
| `attachment.reclaim.apply` | idempotent command | `AttachmentReclaimApplyRequest` | `AttachmentReclaim` |

Tier reasons:

- `conversation.create` makes a new Conversation ID on every call, so a retry makes a duplicate. That makes it an effect command, but it has no operation ID or receipt yet.
- `queue.enqueue` is an effect command because the queue later delivers the prompt to the provider. Its `request_id` is the queued prompt's ID and later the message ID. The `queued_prompts` row already gives replay and conflict behaviour.
- The `draft.send.*` commands converge on the same state per `request_id` and stay on `send_intents`, as instructed.
- `attachment.reclaim.apply` removes a payload, but a repeat with the same generation returns 0 reclaimed bytes. It stays in ADE state, so it is an idempotent command.

No feed frames were added. `conversation_reload` is emitted by `sessions/agents.rs`, which belongs to the agents slice.

## Receipts

No operation moved onto `receipts.rs`. No conversation-domain command has a pure receipt table:

- `queued_prompts` and `attachments` are domain state keyed by the caller's ID, not receipt tables.
- `send_intents` is excluded from this phase.

So `operation_id` was not introduced; every effect command keeps `request_id`, as `agent.send` does. No receipt-shaped table became unused.

## Checks

- `pnpm check:static`: pass (rustfmt, contract check, architecture, SDK build, typecheck, Fallow, JS build, Clippy, legacy Rust tests)
- In-process tests added: `#[cfg(test)] mod tests` in `crates/ade-core/src/contract/conversations.rs`. Each test decodes today's wire request, validates it against the generated schema and re-serializes it to the same line. Each reply is compared with the JSON the untyped handler sent, then validated and round-tripped.
- E2E: not run, as the test policy requires.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 55 | 5 | 10 | 0 |

## References

None. No reference repo was used. The contract, `receipts.rs` and the `conversation.get` and `agent.send` handlers in this repo were the pattern.

## Open

Shapes not fully confirmed, and behaviour changes on malformed input only:

- `window.save.window` and `conversation.create.provider_config` stay unconstrained (`Value`). `WindowRecord` and `provider::Config` have no schema in `model.rs`, which is outside this slice.
- The `review_anchor` and `review_feedback` values stay unconstrained, as before.
- An explicit `null` for `draft.send.prepare` `review_anchor` or `review_feedback`, or for `conversation.create` `provider_config`, behaves as before: the handler sees it as present. The schema does not allow it.
- `conversation.create` with a non-string `title` or `provider` used to fall back to the defaults. It now fails with `Invalid request: …`. The same applies to a non-integer `draft.save` `expected_revision`, which used to be ignored.
- Kept error messages: `Missing draft text`, `Missing draft revision`, `Missing prompt text`, `Missing paused flag`, `Invalid account ID`, `Choose one review payload` and every `Missing <field>`. When a request has several faults, the first one reported can differ from before.
- A missing `window.save` `window` now reads `Missing window`. Before, it was a serde message about `null`.

For the coordinator:

- `crates/ade-core/src/contract/tests.rs`: `every_operation_declares_a_tier_and_named_types` compared the full operation list, so any new operation failed it. It now checks only that the four original entries are present. Every Phase 1 worker will hit this line; keep one version at merge.
- `apps/cli/src/commands/conversations.ts` now exports `decodeReply` and `Fields`, and `git.ts` imports them. A CLI-wide home, such as `apps/cli/src/shared.ts`, would suit other domains too.
- `conversation.create` and `queue.enqueue` are effect commands without an operation ID or receipt. Adding one needs a wire change, which is later work.
