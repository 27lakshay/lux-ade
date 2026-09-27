// Generated from the Rust contracts in crates/ade-core/src/contract by scripts/generate-contracts.mjs. Do not edit.

/** Each operation's tier and domain, and the validator names for its request and response. */
export const operations = {
  "catalog.get": { tier: "query", domain: "workspaces", request: "CatalogGetRequest", response: "CatalogFrame" },
  "conversation.get": { tier: "query", domain: "conversations", request: "ConversationGetRequest", response: "ConversationSnapshot" },
  "agent.send": { tier: "effect_command", domain: "conversations", request: "AgentSendRequest", response: "Ack" },
  "agent.answer": { tier: "effect_command", domain: "conversations", request: "AgentAnswerRequest", response: "Ack" },
  "terminal.create": { tier: "effect_command", domain: "terminals", request: "TerminalCreateRequest", response: "TerminalCreated" },
  "terminal.operation": { tier: "query", domain: "terminals", request: "TerminalOperationRequest", response: "TerminalOperation" },
  "terminal.restart": { tier: "effect_command", domain: "terminals", request: "TerminalRestartRequest", response: "Ack" },
  "terminal.stop": { tier: "effect_command", domain: "terminals", request: "TerminalStopRequest", response: "Ack" },
  "terminal.retire": { tier: "effect_command", domain: "terminals", request: "TerminalRetireRequest", response: "Ack" },
} as const

/** Each feed frame's `type` tag and the validator name for it. */
export const frames = {
  "catalog": { domain: "workspaces", frame: "CatalogFrame" },
  "conversation_changed": { domain: "conversations", frame: "ConversationChanged" },
} as const
