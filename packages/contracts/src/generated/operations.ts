// Generated from the Rust contracts in crates/ade-core/src/contract by scripts/generate-contracts.mjs. Do not edit.

/** Each operation's tier and domain, and the validator names for its request and response. */
export const operations = {
  "catalog.get": { tier: "query", domain: "workspaces", request: "CatalogGetRequest", response: "CatalogFrame" },
  "conversation.get": { tier: "query", domain: "conversations", request: "ConversationGetRequest", response: "ConversationSnapshot" },
  "agent.send": { tier: "effect_command", domain: "conversations", request: "AgentSendRequest", response: "Ack" },
  "agent.answer": { tier: "effect_command", domain: "conversations", request: "AgentAnswerRequest", response: "Ack" },
  "conversation.create": { tier: "effect_command", domain: "conversations", request: "ConversationCreateRequest", response: "ConversationCreated" },
  "draft.get": { tier: "query", domain: "conversations", request: "DraftGetRequest", response: "DraftReply" },
  "draft.save": { tier: "idempotent_command", domain: "conversations", request: "DraftSaveRequest", response: "DraftReply" },
  "draft.send.get": { tier: "query", domain: "conversations", request: "DraftSendGetRequest", response: "SendIntentState" },
  "draft.send.prepare": { tier: "idempotent_command", domain: "conversations", request: "DraftSendPrepareRequest", response: "SendIntentPrepared" },
  "draft.send.complete": { tier: "idempotent_command", domain: "conversations", request: "DraftSendCompleteRequest", response: "DraftReply" },
  "draft.send.abort": { tier: "idempotent_command", domain: "conversations", request: "DraftSendAbortRequest", response: "DraftReply" },
  "queue.enqueue": { tier: "effect_command", domain: "conversations", request: "QueueEnqueueRequest", response: "Ack" },
  "queue.cancel": { tier: "idempotent_command", domain: "conversations", request: "QueueCancelRequest", response: "Ack" },
  "queue.pause": { tier: "idempotent_command", domain: "conversations", request: "QueuePauseRequest", response: "Ack" },
  "window.save": { tier: "idempotent_command", domain: "conversations", request: "WindowSaveRequest", response: "Ack" },
  "window.close": { tier: "idempotent_command", domain: "conversations", request: "WindowCloseRequest", response: "Ack" },
  "attachment.put": { tier: "idempotent_command", domain: "conversations", request: "AttachmentPutRequest", response: "AttachmentReply" },
  "attachment.import": { tier: "idempotent_command", domain: "conversations", request: "AttachmentImportRequest", response: "AttachmentReply" },
  "attachment.inspect": { tier: "query", domain: "conversations", request: "AttachmentInspectRequest", response: "AttachmentInspection" },
  "attachment.reclaim.preview": { tier: "query", domain: "conversations", request: "AttachmentReclaimPreviewRequest", response: "AttachmentReclaimPreviewReply" },
  "attachment.reclaim.apply": { tier: "idempotent_command", domain: "conversations", request: "AttachmentReclaimApplyRequest", response: "AttachmentReclaim" },
} as const

/** Each feed frame's `type` tag and the validator name for it. */
export const frames = {
  "catalog": { domain: "workspaces", frame: "CatalogFrame" },
  "conversation_changed": { domain: "conversations", frame: "ConversationChanged" },
} as const
