// Generated from the Rust contracts in crates/ade-core/src/contract by scripts/generate-contracts.mjs. Do not edit.

/** Each operation's tier and domain, and the validator names for its request and response. */
export const operations = {
  "catalog.get": { tier: "query", domain: "workspaces", request: "CatalogGetRequest", response: "CatalogFrame" },
  "conversation.get": { tier: "query", domain: "conversations", request: "ConversationGetRequest", response: "ConversationSnapshot" },
  "agent.send": { tier: "effect_command", domain: "conversations", request: "AgentSendRequest", response: "Ack" },
  "agent.answer": { tier: "effect_command", domain: "conversations", request: "AgentAnswerRequest", response: "Ack" },
  "service.configure": { tier: "idempotent_command", domain: "services", request: "ServiceConfigureRequest", response: "ServiceReply" },
  "service.list": { tier: "query", domain: "services", request: "ServiceListRequest", response: "ServiceList" },
  "service.inspect": { tier: "query", domain: "services", request: "ServiceInspectRequest", response: "ServiceInspection" },
  "service.start": { tier: "effect_command", domain: "services", request: "ServiceStartRequest", response: "ServiceReply" },
  "service.stop": { tier: "effect_command", domain: "services", request: "ServiceStopRequest", response: "ServiceReply" },
  "service.remove": { tier: "effect_command", domain: "services", request: "ServiceRemoveRequest", response: "Ack" },
  "service.health.sample": { tier: "query", domain: "services", request: "ServiceHealthSampleRequest", response: "ServiceHealthSample" },
  "service.proxy.ensure": { tier: "idempotent_command", domain: "services", request: "ServiceProxyEnsureRequest", response: "ServiceProxy" },
  "service.proxy.inspect": { tier: "query", domain: "services", request: "ServiceProxyInspectRequest", response: "ServiceProxy" },
  "service.proxy.target": { tier: "query", domain: "services", request: "ServiceProxyTargetRequest", response: "ServiceProxyTarget" },
  "service.proxy.remap": { tier: "effect_command", domain: "services", request: "ServiceProxyRemapRequest", response: "ServiceProxy" },
  "service.proxy.retire": { tier: "effect_command", domain: "services", request: "ServiceProxyRetireRequest", response: "ServiceProxyRetired" },
  "service.proxy.recovery.inspect": { tier: "query", domain: "services", request: "ServiceProxyRecoveryInspectRequest", response: "ServiceProxyRecovery" },
  "service.proxy.recovery.retry": { tier: "effect_command", domain: "services", request: "ServiceProxyRecoveryRetryRequest", response: "ServiceProxy" },
  "service.proxy.recovery.reset": { tier: "effect_command", domain: "services", request: "ServiceProxyRecoveryResetRequest", response: "ServiceProxyRecoveryReset" },
  "listener.list": { tier: "query", domain: "services", request: "ListenerListRequest", response: "ListenerInventory" },
} as const

/** Each feed frame's `type` tag and the validator name for it. */
export const frames = {
  "catalog": { domain: "workspaces", frame: "CatalogFrame" },
  "conversation_changed": { domain: "conversations", frame: "ConversationChanged" },
  "service_changed": { domain: "services", frame: "ServiceChanged" },
} as const
