// Generated from the Rust contracts in crates/ade-core/src/contract by scripts/generate-contracts.mjs. Do not edit.

/** Each operation's tier and domain, and the validator names for its request and response. */
export const operations = {
  "catalog.get": { tier: "query", domain: "workspaces", request: "CatalogGetRequest", response: "CatalogFrame" },
  "conversation.get": { tier: "query", domain: "conversations", request: "ConversationGetRequest", response: "ConversationSnapshot" },
  "agent.send": { tier: "effect_command", domain: "conversations", request: "AgentSendRequest", response: "Ack" },
  "agent.answer": { tier: "effect_command", domain: "conversations", request: "AgentAnswerRequest", response: "Ack" },
  "worktree.repository": { tier: "idempotent_command", domain: "worktrees", request: "WorktreeRepositoryRequest", response: "WorktreeState" },
  "worktree.get": { tier: "query", domain: "worktrees", request: "WorktreeGetRequest", response: "WorktreeState" },
  "worktree.switch": { tier: "effect_command", domain: "worktrees", request: "WorktreeSwitchRequest", response: "WorktreeState" },
  "worktree.adopt": { tier: "effect_command", domain: "worktrees", request: "WorktreeAdoptRequest", response: "WorktreeState" },
  "worktree.remove": { tier: "effect_command", domain: "worktrees", request: "WorktreeRemoveRequest", response: "WorktreeState" },
  "worktree.refresh": { tier: "effect_command", domain: "worktrees", request: "WorktreeRefreshRequest", response: "WorktreeState" },
  "worktree.configure": { tier: "idempotent_command", domain: "worktrees", request: "WorktreeConfigureRequest", response: "WorktreeState" },
  "worktree.operation": { tier: "query", domain: "worktrees", request: "WorktreeOperationRequest", response: "WorktreeOperationReply" },
  "worktree.rebind": { tier: "idempotent_command", domain: "worktrees", request: "WorktreeRebindRequest", response: "WorktreeState" },
  "worktree.rebind.list": { tier: "query", domain: "worktrees", request: "WorktreeRebindListRequest", response: "WorktreeRebindCatalog" },
} as const

/** Each feed frame's `type` tag and the validator name for it. */
export const frames = {
  "catalog": { domain: "workspaces", frame: "CatalogFrame" },
  "conversation_changed": { domain: "conversations", frame: "ConversationChanged" },
} as const
