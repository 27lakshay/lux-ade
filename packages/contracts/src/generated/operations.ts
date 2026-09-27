// Generated from the Rust contracts in crates/ade-core/src/contract by scripts/generate-contracts.mjs. Do not edit.

/** Each operation's tier and domain, and the validator names for its request and response. */
export const operations = {
  "catalog.get": { tier: "query", domain: "workspaces", request: "CatalogGetRequest", response: "CatalogFrame" },
  "conversation.get": { tier: "query", domain: "conversations", request: "ConversationGetRequest", response: "ConversationSnapshot" },
  "agent.send": { tier: "effect_command", domain: "conversations", request: "AgentSendRequest", response: "Ack" },
  "agent.answer": { tier: "effect_command", domain: "conversations", request: "AgentAnswerRequest", response: "Ack" },
  "script.list": { tier: "query", domain: "scripts", request: "ScriptListRequest", response: "ScriptList" },
  "script.inspect": { tier: "query", domain: "scripts", request: "ScriptInspectRequest", response: "ScriptInspection" },
  "script.start": { tier: "effect_command", domain: "scripts", request: "ScriptStartRequest", response: "ScriptRun" },
  "script.stop": { tier: "effect_command", domain: "scripts", request: "ScriptStopRequest", response: "ScriptRun" },
  "script.retire": { tier: "effect_command", domain: "scripts", request: "ScriptRetireRequest", response: "ScriptRetired" },
  "script.runs": { tier: "query", domain: "scripts", request: "ScriptRunsRequest", response: "ScriptRuns" },
  "file.list": { tier: "query", domain: "files", request: "FileListRequest", response: "FileList" },
  "file.search": { tier: "query", domain: "files", request: "FileSearchRequest", response: "FileSearch" },
  "file.preview": { tier: "query", domain: "files", request: "FilePreviewRequest", response: "FilePreview" },
} as const

/** Each feed frame's `type` tag and the validator name for it. */
export const frames = {
  "catalog": { domain: "workspaces", frame: "CatalogFrame" },
  "conversation_changed": { domain: "conversations", frame: "ConversationChanged" },
} as const
