// Generated from the Rust contracts in crates/ade-core/src/contract by scripts/generate-contracts.mjs. Do not edit.

export type ContractDefinition =
  | Ack
  | AgentAccountInspectRequest
  | AgentAccountInspection
  | AgentAnswerRequest
  | AgentCancelRequest
  | AgentChildTranscriptRequest
  | AgentDisconnectRequest
  | AgentList
  | AgentListRequest
  | AgentResumeRequest
  | AgentRun
  | AgentRunSpec
  | AgentSendRequest
  | AgentSendReviewRequest
  | Attachment
  | AttachmentImportRequest
  | AttachmentInspectRequest
  | AttachmentInspection
  | AttachmentPutRequest
  | AttachmentReclaim
  | AttachmentReclaimApplyRequest
  | AttachmentReclaimPreview
  | AttachmentReclaimPreviewReply
  | AttachmentReclaimPreviewRequest
  | AttachmentReply
  | CatalogFrame
  | CatalogGetRequest
  | Catalogue
  | ChildTranscriptPage
  | Conversation
  | ConversationChanged
  | ConversationCreateRequest
  | ConversationCreated
  | ConversationGetRequest
  | ConversationSnapshot
  | Descriptor
  | Draft
  | DraftGetRequest
  | DraftReply
  | DraftSaveRequest
  | DraftSendAbortRequest
  | DraftSendCompleteRequest
  | DraftSendGetRequest
  | DraftSendPrepareRequest
  | Message
  | PendingRequest
  | QueueCancelRequest
  | QueueEnqueueRequest
  | QueuePauseRequest
  | QueuedPrompt
  | SendIntent
  | SendIntentPrepared
  | SendIntentState
  | TerminalOwner
  | WindowCloseRequest
  | WindowSaveRequest
  | WorkspaceRecord

/**
 * A bare acceptance reply.
 */
export interface Ack {
  /**
   * The `ack` type tag.
   */
  type: 'ack'
  [k: string]: unknown
}
/**
 * `agent.account_inspect`: probe a provider account's native status. The
 * profile daemon sends it on the runtime socket; `token` is its owner token.
 */
export interface AgentAccountInspectRequest {
  /**
   * The account execution context (`ade_core::model::AccountExecution`).
   */
  account: unknown
  op: 'agent.account_inspect'
  token: string
}
/**
 * The `agent.account_inspect` reply: an untagged account inspection.
 */
export interface AgentAccountInspection {
  /**
   * The provider-specific identity, when the account is ready.
   */
  identity: unknown
  reason: string
  state: string
  version: string | null
  [k: string]: unknown
}
/**
 * `agent.answer`: answer a pending provider request by its ID.
 */
export interface AgentAnswerRequest {
  /**
   * Structured answers; required by the `answer` decision.
   */
  answers?: unknown
  conversation_id: string
  decision: string
  op: 'agent.answer'
  request_id: string
}
/**
 * `agent.cancel`: cancel the Conversation's active turn.
 */
export interface AgentCancelRequest {
  conversation_id: string
  op: 'agent.cancel'
}
/**
 * `agent.child_transcript`: one page of a provider child agent's transcript.
 */
export interface AgentChildTranscriptRequest {
  child_id: string
  conversation_id: string
  /**
   * Provider page cursor, at most 4096 bytes.
   */
  cursor?: string
  /**
   * The parent message that records the child agents.
   */
  message_id: string
  /**
   * Item offset; the daemon uses 0 when it is absent and allows at most 100000.
   */
  offset?: number
  op: 'agent.child_transcript'
}
/**
 * `agent.disconnect`: stop the Conversation's idle Agent.
 */
export interface AgentDisconnectRequest {
  conversation_id: string
  op: 'agent.disconnect'
}
/**
 * The `agent.list` reply.
 */
export interface AgentList {
  agents: AgentRun[]
  /**
   * The `agents` type tag.
   */
  type: 'agents'
  [k: string]: unknown
}
/**
 * One live Agent run in the runtime supervisor.
 */
export interface AgentRun {
  /**
   * Command keys the run holds receipts for.
   */
  commands: string[]
  /**
   * The provider process ID, when the adapter has one.
   */
  pid: number | null
  spec: AgentRunSpec
  [k: string]: unknown
}
/**
 * The identity an Agent run was created with.
 */
export interface AgentRunSpec {
  /**
   * The pinned account execution context, or null for ambient credentials.
   */
  account: unknown
  conversation: string
  provider: string
  root: string
  run: string
  [k: string]: unknown
}
/**
 * `agent.list`: the runtime supervisor's live Agent runs. The profile daemon
 * sends it on the runtime socket; `token` is the daemon's owner token.
 */
export interface AgentListRequest {
  op: 'agent.list'
  token: string
}
/**
 * `agent.resume`: reconnect the Conversation's Agent.
 */
export interface AgentResumeRequest {
  conversation_id: string
  op: 'agent.resume'
}
/**
 * `agent.send`: submit a prompt. `request_id` is the caller-owned operation ID.
 */
export interface AgentSendRequest {
  attachments?: Attachment[]
  conversation_id: string
  op: 'agent.send'
  request_id: string
  text: string
}
export interface Attachment {
  id: string
  media_type: string
  name: string
  size: number
  [k: string]: unknown
}
/**
 * `agent.send_review`: submit a prompt that carries review feedback.
 * `request_id` is the caller-owned send identity shared with the draft send
 * intent. Exactly one of `review_anchor` and `review_feedback` is present.
 */
export interface AgentSendReviewRequest {
  /**
   * Review prompts reject attachments; an empty list is accepted.
   */
  attachments?: Attachment[]
  conversation_id: string
  op: 'agent.send_review'
  request_id: string
  /**
   * One review anchor.
   */
  review_anchor?: unknown
  /**
   * A review feedback batch.
   */
  review_feedback?: unknown
  text: string
}
/**
 * `attachment.import`: attach a regular file that the daemon reads from disk.
 * `request_id` becomes the attachment ID.
 */
export interface AttachmentImportRequest {
  conversation_id: string
  op: 'attachment.import'
  path: string
  request_id: string
}
/**
 * `attachment.inspect`: read a live attachment's metadata and digest.
 */
export interface AttachmentInspectRequest {
  attachment_id: string
  conversation_id: string
  op: 'attachment.inspect'
}
/**
 * The `attachment.inspect` reply.
 */
export interface AttachmentInspection {
  attachment: Attachment
  /**
   * Lowercase hex SHA-256 of the payload.
   */
  sha256: string
  /**
   * The `attachment_inspection` type tag.
   */
  type: 'attachment_inspection'
  [k: string]: unknown
}
/**
 * `attachment.put`: upload attachment bytes. `request_id` becomes the attachment ID.
 */
export interface AttachmentPutRequest {
  conversation_id: string
  /**
   * Standard base64 of the file bytes.
   */
  data: string
  name: string
  op: 'attachment.put'
  request_id: string
}
/**
 * The `attachment.reclaim.apply` reply; `attachment` is the state after reclaim.
 */
export interface AttachmentReclaim {
  attachment: AttachmentReclaimPreview
  filesystem_reclaimed_bytes: number
  reclaimed_payload_bytes: number
  /**
   * The `explicit_single_attachment` type tag.
   */
  scope: 'explicit_single_attachment'
  /**
   * The `attachment_reclaim` type tag.
   */
  type: 'attachment_reclaim'
  [k: string]: unknown
}
/**
 * One attachment's retention state and what protects it from reclaim.
 */
export interface AttachmentReclaimPreview {
  attachment_id: string
  conversation_id: string
  created_at: number
  estimated_reusable_payload_bytes: number
  generation: string
  payload_bytes: number
  /**
   * `message`, `draft`, `queued_prompt`, `send_intent` or `already_discarded`.
   */
  protected_by: string[]
  reclaimable: boolean
  /**
   * `live` or `discarded`.
   */
  state: string
  [k: string]: unknown
}
/**
 * `attachment.reclaim.apply`: discard one unreferenced attachment's payload.
 */
export interface AttachmentReclaimApplyRequest {
  attachment_id: string
  conversation_id: string
  /**
   * The preview's `generation`; a changed attachment is refused.
   */
  expected_generation: string
  op: 'attachment.reclaim.apply'
}
/**
 * The `attachment.reclaim.preview` reply.
 */
export interface AttachmentReclaimPreviewReply {
  /**
   * Always false: only an explicit reclaim frees an attachment.
   */
  automatic_gc_eligible: boolean
  /**
   * The `not_enumerated` type tag.
   */
  client_held_uploads: 'not_enumerated'
  filesystem_reclaimed_bytes: number
  preview: AttachmentReclaimPreview
  /**
   * The `explicit_single_attachment` type tag.
   */
  scope: 'explicit_single_attachment'
  /**
   * The `attachment_reclaim_preview` type tag.
   */
  type: 'attachment_reclaim_preview'
  [k: string]: unknown
}
/**
 * `attachment.reclaim.preview`: report what reclaiming one attachment would free.
 */
export interface AttachmentReclaimPreviewRequest {
  attachment_id: string
  conversation_id: string
  op: 'attachment.reclaim.preview'
}
/**
 * The `attachment.put` and `attachment.import` reply.
 */
export interface AttachmentReply {
  attachment: Attachment
  /**
   * The `attachment` type tag.
   */
  type: 'attachment'
  [k: string]: unknown
}
/**
 * The `catalog.get` reply and the `catalog` feed frame.
 */
export interface CatalogFrame {
  boot_id: string
  catalog: Catalogue
  providers: Descriptor[]
  revision: number
  /**
   * The `catalog` type tag.
   */
  type: 'catalog'
  [k: string]: unknown
}
export interface Catalogue {
  conversations: Conversation[]
  windows: unknown[]
  workspaces: WorkspaceRecord[]
  [k: string]: unknown
}
export interface Conversation {
  account_context: string
  account_id: string | null
  active_turn_id: string | null
  error: string | null
  id: string
  provider: string
  provider_config: unknown
  provider_thread_id: string | null
  queue_paused: boolean
  runtime_cursor: number
  runtime_run: string | null
  runtime_submission: string | null
  status: string
  terminal_owner: TerminalOwner | null
  title: string
  updated_at: number
  view_terminal: TerminalOwner | null
  workspace_id: string
  [k: string]: unknown
}
export interface TerminalOwner {
  runtime_instance: string
  terminal_id: string
  transfer_id: string
  [k: string]: unknown
}
export interface WorkspaceRecord {
  extra_terminals: string[]
  id: string
  name: string
  needs_rebind: boolean
  repository_id: string | null
  root: string
  terminal_id: string
  worktree_lifecycle_needs_rebind: boolean
  [k: string]: unknown
}
/**
 * The daemon advertises the same contract it uses to validate configuration.
 * Clients consume descriptors; they do not infer support from a provider name.
 */
export interface Descriptor {
  capabilities: string[]
  id: string
  name: string
  permission_modes: string[]
  setting_sources: string[]
  [k: string]: unknown
}
/**
 * `catalog.get`: read the profile's workspaces, conversations and windows.
 */
export interface CatalogGetRequest {
  op: 'catalog.get'
}
/**
 * The `agent.child_transcript` reply, passed through from the provider bridge.
 * Offset-paged providers send `next_offset` (null on the last page); cursor-paged
 * providers send `next_cursor` instead.
 */
export interface ChildTranscriptPage {
  child_id: string
  /**
   * Provider-projected transcript items.
   */
  items: unknown[]
  next_cursor?: string | null
  next_offset?: number | null
  /**
   * The `child_transcript` type tag.
   */
  type: 'child_transcript'
  [k: string]: unknown
}
/**
 * The `conversation_changed` feed frame.
 */
export interface ConversationChanged {
  boot_id: string
  conversation: Conversation
  messages: Message[]
  queued: QueuedPrompt[]
  requests: PendingRequest[]
  revision: number
  /**
   * The `conversation_changed` type tag.
   */
  type: 'conversation_changed'
  [k: string]: unknown
}
export interface Message {
  attachments?: Attachment[]
  content?: unknown
  conversation_id: string
  id: string
  kind: string
  provider_item_id: string | null
  review_feedback?: unknown
  role: string
  sequence: number
  status: string
  text: string
  turn_id: string | null
  [k: string]: unknown
}
export interface QueuedPrompt {
  attachments?: Attachment[]
  conversation_id: string
  id: string
  status: string
  text: string
  [k: string]: unknown
}
export interface PendingRequest {
  answer_attempt: number
  answer_dispatched: boolean
  answer_fingerprint?: string | null
  conversation_id: string
  id: string
  method: string
  params: unknown
  rpc_id: unknown
  run_id: string
  status: string
  [k: string]: unknown
}
/**
 * `conversation.create`: make a Conversation in a workspace.
 */
export interface ConversationCreateRequest {
  /**
   * A managed account of the same provider.
   */
  account_id?: string
  op: 'conversation.create'
  /**
   * Provider ID; defaults to `codex`.
   */
  provider?: string
  /**
   * Provider settings; the daemon validates them for the provider.
   */
  provider_config?: unknown
  /**
   * Defaults to `New Conversation`; at most 256 bytes.
   */
  title?: string
  workspace_id: string
}
/**
 * The `conversation.create` reply: an `ack` carrying the new Conversation.
 */
export interface ConversationCreated {
  conversation: Conversation
  /**
   * The `ack` type tag.
   */
  type: 'ack'
  [k: string]: unknown
}
/**
 * `conversation.get`: one page of a conversation's messages, newest first.
 */
export interface ConversationGetRequest {
  /**
   * Return messages with a sequence below this one.
   */
  before?: number
  conversation_id: string
  /**
   * Page size; the daemon uses 50 when it is absent.
   */
  limit?: number
  op: 'conversation.get'
}
/**
 * The `conversation.get` reply.
 */
export interface ConversationSnapshot {
  boot_id: string
  conversation: Conversation
  messages: Message[]
  queued: QueuedPrompt[]
  requests: PendingRequest[]
  revision: number
  /**
   * The `conversation_snapshot` type tag.
   */
  type: 'conversation_snapshot'
  [k: string]: unknown
}
/**
 * The schema of [`Draft`], which the model defines without one.
 */
export interface Draft {
  attachments?: Attachment[]
  revision: number
  text: string
  [k: string]: unknown
}
/**
 * `draft.get`: read one window's draft of a Conversation.
 */
export interface DraftGetRequest {
  conversation_id: string
  op: 'draft.get'
  window_id: string
}
/**
 * The reply to `draft.get`, `draft.save`, `draft.send.complete` and `draft.send.abort`.
 */
export interface DraftReply {
  draft: Draft
  /**
   * The `draft` type tag.
   */
  type: 'draft'
  [k: string]: unknown
}
/**
 * `draft.save`: store a newer draft revision for one window.
 */
export interface DraftSaveRequest {
  attachments?: Attachment[]
  conversation_id: string
  /**
   * Resolve a conflict: save only if the stored revision is still this one.
   */
  expected_revision?: number
  op: 'draft.save'
  revision: number
  text: string
  window_id: string
}
/**
 * `draft.send.abort`: release a send the daemon rejected before admission.
 */
export interface DraftSendAbortRequest {
  conversation_id: string
  op: 'draft.send.abort'
  request_id: string
  window_id: string
}
/**
 * `draft.send.complete`: clear the draft once the prompt was accepted.
 */
export interface DraftSendCompleteRequest {
  conversation_id: string
  op: 'draft.send.complete'
  request_id: string
  window_id: string
}
/**
 * `draft.send.get`: read the window's unresolved send intent.
 */
export interface DraftSendGetRequest {
  conversation_id: string
  op: 'draft.send.get'
  window_id: string
}
/**
 * `draft.send.prepare`: record the exact prompt and draft before dispatch.
 * `request_id` is the send's ID and becomes the accepted message's ID.
 */
export interface DraftSendPrepareRequest {
  attachments?: Attachment[]
  conversation_id: string
  draft_text: string
  op: 'draft.send.prepare'
  request_id: string
  /**
   * One review anchor; excludes `review_feedback`.
   */
  review_anchor?: unknown
  /**
   * A review feedback batch; excludes `review_anchor`.
   */
  review_feedback?: unknown
  revision: number
  text: string
  window_id: string
}
/**
 * `queue.cancel`: cancel a queued prompt that has not been submitted.
 */
export interface QueueCancelRequest {
  conversation_id: string
  op: 'queue.cancel'
  request_id: string
}
/**
 * `queue.enqueue`: queue a prompt. `request_id` becomes the queued prompt's ID.
 */
export interface QueueEnqueueRequest {
  attachments?: Attachment[]
  conversation_id: string
  op: 'queue.enqueue'
  request_id: string
  text: string
}
/**
 * `queue.pause`: pause or resume a Conversation's prompt queue.
 */
export interface QueuePauseRequest {
  conversation_id: string
  op: 'queue.pause'
  paused: boolean
}
/**
 * A prompt recorded before dispatch, with the draft it came from.
 */
export interface SendIntent {
  attachments: Attachment[]
  conversation_id: string
  draft_revision: number
  draft_text: string
  request_id: string
  /**
   * Null unless the send carries one review anchor.
   */
  review_anchor: unknown
  /**
   * Null unless the send carries a review feedback batch.
   */
  review_feedback: unknown
  /**
   * `pending`, `rejected`, `completed` or `aborted`.
   */
  state: string
  text: string
  window_id: string
  [k: string]: unknown
}
/**
 * The `draft.send.prepare` reply: the new or already recorded intent.
 */
export interface SendIntentPrepared {
  intent: SendIntent
  /**
   * The `send_intent` type tag.
   */
  type: 'send_intent'
  [k: string]: unknown
}
/**
 * The `draft.send.get` reply. `intent` is null when no send is unresolved.
 */
export interface SendIntentState {
  intent: SendIntent | null
  /**
   * Whether the profile was restored from a backup, which holds its sends.
   */
  restored_from_backup: boolean
  /**
   * The `send_intent` type tag.
   */
  type: 'send_intent'
  [k: string]: unknown
}
/**
 * `window.close`: forget a window's record, unless it is the last one.
 */
export interface WindowCloseRequest {
  op: 'window.close'
  window_id: string
}
/**
 * `window.save`: store one window's layout record.
 */
export interface WindowSaveRequest {
  op: 'window.save'
  /**
   * The window record, in the shape `catalog.get` lists it.
   */
  window: unknown
}

export type Operation = "catalog.get" | "conversation.get" | "agent.send" | "agent.answer" | "conversation.create" | "draft.get" | "draft.save" | "draft.send.get" | "draft.send.prepare" | "draft.send.complete" | "draft.send.abort" | "queue.enqueue" | "queue.cancel" | "queue.pause" | "window.save" | "window.close" | "attachment.put" | "attachment.import" | "attachment.inspect" | "attachment.reclaim.preview" | "attachment.reclaim.apply" | "agent.cancel" | "agent.resume" | "agent.disconnect" | "agent.send_review" | "agent.child_transcript" | "agent.list" | "agent.account_inspect"

export interface RequestByOperation {
  "catalog.get": CatalogGetRequest
  "conversation.get": ConversationGetRequest
  "agent.send": AgentSendRequest
  "agent.answer": AgentAnswerRequest
  "conversation.create": ConversationCreateRequest
  "draft.get": DraftGetRequest
  "draft.save": DraftSaveRequest
  "draft.send.get": DraftSendGetRequest
  "draft.send.prepare": DraftSendPrepareRequest
  "draft.send.complete": DraftSendCompleteRequest
  "draft.send.abort": DraftSendAbortRequest
  "queue.enqueue": QueueEnqueueRequest
  "queue.cancel": QueueCancelRequest
  "queue.pause": QueuePauseRequest
  "window.save": WindowSaveRequest
  "window.close": WindowCloseRequest
  "attachment.put": AttachmentPutRequest
  "attachment.import": AttachmentImportRequest
  "attachment.inspect": AttachmentInspectRequest
  "attachment.reclaim.preview": AttachmentReclaimPreviewRequest
  "attachment.reclaim.apply": AttachmentReclaimApplyRequest
  "agent.cancel": AgentCancelRequest
  "agent.resume": AgentResumeRequest
  "agent.disconnect": AgentDisconnectRequest
  "agent.send_review": AgentSendReviewRequest
  "agent.child_transcript": AgentChildTranscriptRequest
  "agent.list": AgentListRequest
  "agent.account_inspect": AgentAccountInspectRequest
}

export interface ResponseByOperation {
  "catalog.get": CatalogFrame
  "conversation.get": ConversationSnapshot
  "agent.send": Ack
  "agent.answer": Ack
  "conversation.create": ConversationCreated
  "draft.get": DraftReply
  "draft.save": DraftReply
  "draft.send.get": SendIntentState
  "draft.send.prepare": SendIntentPrepared
  "draft.send.complete": DraftReply
  "draft.send.abort": DraftReply
  "queue.enqueue": Ack
  "queue.cancel": Ack
  "queue.pause": Ack
  "window.save": Ack
  "window.close": Ack
  "attachment.put": AttachmentReply
  "attachment.import": AttachmentReply
  "attachment.inspect": AttachmentInspection
  "attachment.reclaim.preview": AttachmentReclaimPreviewReply
  "attachment.reclaim.apply": AttachmentReclaim
  "agent.cancel": Ack
  "agent.resume": Ack
  "agent.disconnect": Ack
  "agent.send_review": Ack
  "agent.child_transcript": ChildTranscriptPage
  "agent.list": AgentList
  "agent.account_inspect": AgentAccountInspection
}

export type FeedFrame = CatalogFrame | ConversationChanged
