// Generated from the Rust contracts in crates/ade-core/src/contract by scripts/generate-contracts.mjs. Do not edit.

/** Each operation's tier and domain, and the validator names for its request and response. */
export const operations = {
  "catalog.get": { tier: "query", domain: "workspaces", request: "CatalogGetRequest", response: "CatalogFrame" },
  "workspace.open": { tier: "idempotent_command", domain: "workspaces", request: "WorkspaceOpenRequest", response: "WorkspaceAck" },
  "workspace.rebind.list": { tier: "query", domain: "workspaces", request: "WorkspaceRebindListRequest", response: "WorkspaceRebindCatalog" },
  "workspace.rebind": { tier: "idempotent_command", domain: "workspaces", request: "WorkspaceRebindRequest", response: "WorkspaceAck" },
  "repository.rebind.list": { tier: "query", domain: "workspaces", request: "RepositoryRebindListRequest", response: "RepositoryRebindCatalog" },
  "repository.rebind": { tier: "idempotent_command", domain: "workspaces", request: "RepositoryRebindRequest", response: "RepositoryAck" },
  "conversation.get": { tier: "query", domain: "conversations", request: "ConversationGetRequest", response: "ConversationSnapshot" },
  "agent.send": { tier: "effect_command", domain: "conversations", request: "AgentSendRequest", response: "Ack" },
  "agent.answer": { tier: "effect_command", domain: "conversations", request: "AgentAnswerRequest", response: "Ack" },
} as const

/** Each feed frame's `type` tag and the validator name for it. */
export const frames = {
  "catalog": { domain: "workspaces", frame: "CatalogFrame" },
  "conversation_changed": { domain: "conversations", frame: "ConversationChanged" },
} as const
