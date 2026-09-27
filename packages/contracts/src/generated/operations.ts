// Generated from the Rust contracts in crates/ade-core/src/contract by scripts/generate-contracts.mjs. Do not edit.

/** Each operation's tier and domain, and the validator names for its request and response. */
export const operations = {
  "catalog.get": { tier: "query", domain: "workspaces", request: "CatalogGetRequest", response: "CatalogFrame" },
  "conversation.get": { tier: "query", domain: "conversations", request: "ConversationGetRequest", response: "ConversationSnapshot" },
  "agent.send": { tier: "effect_command", domain: "conversations", request: "AgentSendRequest", response: "Ack" },
  "agent.answer": { tier: "effect_command", domain: "conversations", request: "AgentAnswerRequest", response: "Ack" },
  "review.status": { tier: "query", domain: "review", request: "ReviewStatusRequest", response: "ReviewStatus" },
  "review.diff": { tier: "query", domain: "review", request: "ReviewDiffRequest", response: "ReviewDiff" },
  "review.diff_page": { tier: "query", domain: "review", request: "ReviewDiffPageRequest", response: "ReviewDiffPage" },
  "review.hunk": { tier: "effect_command", domain: "review", request: "ReviewHunkRequest", response: "ReviewOperationReply" },
  "review.stage": { tier: "effect_command", domain: "review", request: "ReviewStageRequest", response: "ReviewOperationReply" },
  "review.unstage": { tier: "effect_command", domain: "review", request: "ReviewUnstageRequest", response: "ReviewOperationReply" },
  "review.discard": { tier: "effect_command", domain: "review", request: "ReviewDiscardRequest", response: "ReviewOperationReply" },
  "review.commit": { tier: "effect_command", domain: "review", request: "ReviewCommitRequest", response: "ReviewOperationReply" },
  "review.operation": { tier: "query", domain: "review", request: "ReviewOperationRequest", response: "ReviewOperationReply" },
  "review.feedback.search": { tier: "query", domain: "review", request: "ReviewFeedbackSearchRequest", response: "ReviewFeedbackSearch" },
} as const

/** Each feed frame's `type` tag and the validator name for it. */
export const frames = {
  "catalog": { domain: "workspaces", frame: "CatalogFrame" },
  "conversation_changed": { domain: "conversations", frame: "ConversationChanged" },
} as const
