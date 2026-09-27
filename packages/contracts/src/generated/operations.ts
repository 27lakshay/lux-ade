// Generated from the Rust contracts in crates/ade-core/src/contract by scripts/generate-contracts.mjs. Do not edit.

/** Each operation's tier and domain, and the validator names for its request and response. */
export const operations = {
  "catalog.get": { tier: "query", domain: "workspaces", request: "CatalogGetRequest", response: "CatalogFrame" },
  "conversation.get": { tier: "query", domain: "conversations", request: "ConversationGetRequest", response: "ConversationSnapshot" },
  "agent.send": { tier: "effect_command", domain: "conversations", request: "AgentSendRequest", response: "Ack" },
  "agent.answer": { tier: "effect_command", domain: "conversations", request: "AgentAnswerRequest", response: "Ack" },
  "hello": { tier: "query", domain: "daemon", request: "HelloRequest", response: "DaemonHello" },
  "runtime.status": { tier: "query", domain: "daemon", request: "RuntimeStatusRequest", response: "RuntimeStatus" },
  "runtime.prepare_restart": { tier: "effect_command", domain: "daemon", request: "RuntimePrepareRestartRequest", response: "RestartPrepared" },
  "session.subscribe": { tier: "query", domain: "daemon", request: "SessionSubscribeRequest", response: "CatalogFrame" },
  "browser.owner.get": { tier: "query", domain: "daemon", request: "BrowserOwnerGetRequest", response: "BrowserOwnerReply" },
  "browser.owner.register": { tier: "idempotent_command", domain: "daemon", request: "BrowserOwnerRegisterRequest", response: "BrowserOwnerReply" },
  "browser.owner.unregister": { tier: "idempotent_command", domain: "daemon", request: "BrowserOwnerUnregisterRequest", response: "BrowserOwnerReleased" },
  "browser.list": { tier: "query", domain: "daemon", request: "BrowserListRequest", response: "BrowserTabs" },
  "browser.inspect": { tier: "query", domain: "daemon", request: "BrowserInspectRequest", response: "BrowserTabReply" },
  "browser.open": { tier: "effect_command", domain: "daemon", request: "BrowserOpenRequest", response: "BrowserMutation" },
  "browser.navigate": { tier: "effect_command", domain: "daemon", request: "BrowserNavigateRequest", response: "BrowserMutation" },
  "browser.close": { tier: "effect_command", domain: "daemon", request: "BrowserCloseRequest", response: "BrowserMutation" },
  "browser.operation": { tier: "query", domain: "daemon", request: "BrowserOperationRequest", response: "BrowserOperation" },
} as const

/** Each feed frame's `type` tag and the validator name for it. */
export const frames = {
  "catalog": { domain: "workspaces", frame: "CatalogFrame" },
  "conversation_changed": { domain: "conversations", frame: "ConversationChanged" },
  "service_changed": { domain: "daemon", frame: "ServiceChanged" },
} as const
