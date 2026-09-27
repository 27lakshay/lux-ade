// Generated from the Rust contracts in crates/ade-core/src/contract by scripts/generate-contracts.mjs. Do not edit.

/** Each operation's tier and domain, and the validator names for its request and response. */
export const operations = {
  "catalog.get": { tier: "query", domain: "workspaces", request: "CatalogGetRequest", response: "CatalogFrame" },
  "conversation.get": { tier: "query", domain: "conversations", request: "ConversationGetRequest", response: "ConversationSnapshot" },
  "agent.send": { tier: "effect_command", domain: "conversations", request: "AgentSendRequest", response: "Ack" },
  "agent.answer": { tier: "effect_command", domain: "conversations", request: "AgentAnswerRequest", response: "Ack" },
  "provider.list": { tier: "query", domain: "accounts", request: "ProviderListRequest", response: "ProvidersReply" },
  "account.list": { tier: "query", domain: "accounts", request: "AccountListRequest", response: "AccountsReply" },
  "account.create": { tier: "effect_command", domain: "accounts", request: "AccountCreateRequest", response: "AccountAck" },
  "account.inspect": { tier: "query", domain: "accounts", request: "AccountInspectRequest", response: "AccountInspection" },
  "account.verify": { tier: "idempotent_command", domain: "accounts", request: "AccountVerifyRequest", response: "AccountAck" },
  "account.disable": { tier: "idempotent_command", domain: "accounts", request: "AccountDisableRequest", response: "AccountDisabled" },
} as const

/** Each feed frame's `type` tag and the validator name for it. */
export const frames = {
  "catalog": { domain: "workspaces", frame: "CatalogFrame" },
  "conversation_changed": { domain: "conversations", frame: "ConversationChanged" },
} as const
