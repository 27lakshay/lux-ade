// Generated from the Rust contracts in crates/ade-core/src/contract by scripts/generate-contracts.mjs. Do not edit.

/** Each operation's tier and domain, and the validator names for its request and response. */
export const operations = {
  "catalog.get": { tier: "query", domain: "workspaces", request: "CatalogGetRequest", response: "CatalogFrame" },
  "conversation.get": { tier: "query", domain: "conversations", request: "ConversationGetRequest", response: "ConversationSnapshot" },
  "agent.send": { tier: "effect_command", domain: "conversations", request: "AgentSendRequest", response: "Ack" },
  "agent.answer": { tier: "effect_command", domain: "conversations", request: "AgentAnswerRequest", response: "Ack" },
  "agent.cancel": { tier: "effect_command", domain: "agents", request: "AgentCancelRequest", response: "Ack" },
  "agent.resume": { tier: "effect_command", domain: "agents", request: "AgentResumeRequest", response: "Ack" },
  "agent.disconnect": { tier: "effect_command", domain: "agents", request: "AgentDisconnectRequest", response: "Ack" },
  "agent.send_review": { tier: "effect_command", domain: "agents", request: "AgentSendReviewRequest", response: "Ack" },
  "agent.child_transcript": { tier: "query", domain: "agents", request: "AgentChildTranscriptRequest", response: "ChildTranscriptPage" },
  "agent.list": { tier: "query", domain: "agents", request: "AgentListRequest", response: "AgentList" },
  "agent.account_inspect": { tier: "query", domain: "agents", request: "AgentAccountInspectRequest", response: "AgentAccountInspection" },
} as const

/** Each feed frame's `type` tag and the validator name for it. */
export const frames = {
  "catalog": { domain: "workspaces", frame: "CatalogFrame" },
  "conversation_changed": { domain: "conversations", frame: "ConversationChanged" },
} as const
