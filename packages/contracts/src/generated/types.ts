// Generated from the Rust contracts in crates/ade-core/src/contract by scripts/generate-contracts.mjs. Do not edit.

export type ContractDefinition =
  | Ack
  | AgentAnswerRequest
  | AgentSendRequest
  | Attachment
  | CatalogFrame
  | CatalogGetRequest
  | Catalogue
  | Conversation
  | ConversationChanged
  | ConversationGetRequest
  | ConversationSnapshot
  | Descriptor
  | Message
  | PendingRequest
  | QueuedPrompt
  | TerminalCreateRequest
  | TerminalCreated
  | TerminalOperation
  | TerminalOperationRequest
  | TerminalOwner
  | TerminalRestartRequest
  | TerminalRetireRequest
  | TerminalStopRequest
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
 * `terminal.create`: add another terminal to a workspace.
 *
 * `operation_id` is the caller-owned receipt ID; `request_id` is accepted as
 * its older name. Without one, every call creates a new terminal.
 */
export interface TerminalCreateRequest {
  op: 'terminal.create'
  /**
   * Absent or a string of 1 to 256 bytes; the daemon rejects `null`.
   */
  operation_id?: string
  workspace_id: string
}
/**
 * The `terminal.create` reply.
 */
export interface TerminalCreated {
  terminal_id: string
  /**
   * The `ack` type tag.
   */
  type: 'ack'
  [k: string]: unknown
}
/**
 * The `terminal.operation` reply. `request_id` echoes the requested
 * operation ID under its older name.
 */
export interface TerminalOperation {
  request_id: string
  terminal_id: string
  /**
   * The `terminal_operation` type tag.
   */
  type: 'terminal_operation'
  workspace_id: string
  [k: string]: unknown
}
/**
 * `terminal.operation`: read the terminal a `terminal.create` receipt produced.
 * `request_id` is accepted as the older name of `operation_id`.
 */
export interface TerminalOperationRequest {
  op: 'terminal.operation'
  operation_id: string
  workspace_id: string
}
/**
 * `terminal.restart`: start a new shell in an exited terminal. Without
 * `workspace_id` the daemon uses its default workspace; without
 * `terminal_id` it uses the workspace's primary terminal.
 */
export interface TerminalRestartRequest {
  op: 'terminal.restart'
  terminal_id?: string | null
  workspace_id?: string | null
}
/**
 * `terminal.retire`: remove a stopped terminal from its workspace.
 */
export interface TerminalRetireRequest {
  op: 'terminal.retire'
  terminal_id: string
  workspace_id: string
}
/**
 * `terminal.stop`: stop a workspace terminal's shell.
 */
export interface TerminalStopRequest {
  op: 'terminal.stop'
  terminal_id: string
  workspace_id: string
}

export type Operation = "catalog.get" | "conversation.get" | "agent.send" | "agent.answer" | "terminal.create" | "terminal.operation" | "terminal.restart" | "terminal.stop" | "terminal.retire"

export interface RequestByOperation {
  "catalog.get": CatalogGetRequest
  "conversation.get": ConversationGetRequest
  "agent.send": AgentSendRequest
  "agent.answer": AgentAnswerRequest
  "terminal.create": TerminalCreateRequest
  "terminal.operation": TerminalOperationRequest
  "terminal.restart": TerminalRestartRequest
  "terminal.stop": TerminalStopRequest
  "terminal.retire": TerminalRetireRequest
}

export interface ResponseByOperation {
  "catalog.get": CatalogFrame
  "conversation.get": ConversationSnapshot
  "agent.send": Ack
  "agent.answer": Ack
  "terminal.create": TerminalCreated
  "terminal.operation": TerminalOperation
  "terminal.restart": Ack
  "terminal.stop": Ack
  "terminal.retire": Ack
}

export type FeedFrame = CatalogFrame | ConversationChanged
