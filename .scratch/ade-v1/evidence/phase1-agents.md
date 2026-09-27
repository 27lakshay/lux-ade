# phase1-agents

Status: returned
Type: slice evidence
Branch: claude/wf_e0896549-359-2
Worker: Phase 1 parallel build, typed domain agents
Requirements: none (Phase 1 typed contracts, D02)

## Outcome

Typed the seven agents operations in `crates/ade-core/src/contract/agents.rs`.
The session handlers for `agent.cancel`, `agent.resume`, `agent.disconnect`,
`agent.send_review` and `agent.child_transcript` now decode typed requests and
reply from typed responses. The runtime supervisor decodes and replies with typed
`agent.list` and `agent.account_inspect` shapes. Desktop main now sends
`agent.cancel` and `agent.resume` through `dailyUseCommand`.

## Operation tiers

| Operation | Tier | Request | Response |
|---|---|---|---|
| `agent.cancel` | effect command | `AgentCancelRequest` | `Ack` |
| `agent.resume` | effect command | `AgentResumeRequest` | `Ack` |
| `agent.disconnect` | effect command | `AgentDisconnectRequest` | `Ack` |
| `agent.send_review` | effect command | `AgentSendReviewRequest` | `Ack` |
| `agent.child_transcript` | query | `AgentChildTranscriptRequest` | `ChildTranscriptPage` |
| `agent.list` | query | `AgentListRequest` | `AgentList` |
| `agent.account_inspect` | query | `AgentAccountInspectRequest` | `AgentAccountInspection` |

Receipts: none of these operations had a pure receipt table. `agent.send_review`
keys on `request_id` through send intents and messages, which stay unmigrated as
instructed. No receipt table became unused.

Shapes typed as `Value` or with caveats:

- `review_anchor` and `review_feedback` are `Value`. A present `null` still
  counts as present, as before.
- `ChildTranscriptPage.items` is `Value[]`, because provider bridges project the
  items. `next_offset` and `next_cursor` keep null-versus-absent as each bridge
  sends them.
- `AgentRunSpec.account` and `AgentAccountInspectRequest.account` are `Value`.
  The `AccountExecution` model in the shared `model.rs` has no `JsonSchema`
  derive.
- `agent.child_transcript` `offset` and `cursor` are now typed. The daemon used
  to read a non-integer `offset` or a non-string `cursor` as absent; now it
  rejects them. No client sends this operation today.
- `agent.list` and `agent.account_inspect` are runtime supervisor operations. The
  profile daemon sends them on the runtime socket, and the runtime adds `token`.
  They are in the client bundle because the task assigned them here.

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-core/src/contract/agents.rs` (schema round
  trips and tier assertions)

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 45 | 5 | 10 | 0 |

## References

None.

## Open

- `crates/ade-core/src/contract/tests.rs`: this slice added its seven operations
  to the exact tier list in `every_operation_declares_a_tier_and_named_types`.
  Every slice will touch that list. Consider making it per-domain.
- Decide whether runtime-socket operations (`agent.list`, `agent.account_inspect`,
  and the unassigned `agent.create`, `agent.command`, `agent.events`, `agent.ack`,
  `agent.connected`, `agent.stop`) belong in the client bundle or in a separate
  runtime protocol domain.
- Not switched to typed clients: `apps/desktop/src/main/conversations/send-pipeline.ts`
  picks `agent.send` or `agent.send_review` at runtime. A client-side contract
  rejection would skip its daemon-rejection recovery path. `apps/cli/src/commands/git.ts`
  belongs to the review area.
- `sessions/accounts.rs` still sends `agent.account_inspect` as untyped JSON and
  decodes the runtime `Inspection`. It was left alone to avoid colliding with the
  accounts slice.
