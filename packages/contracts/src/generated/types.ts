// Generated from the Rust contracts in crates/ade-core/src/contract by scripts/generate-contracts.mjs. Do not edit.

export type ContractDefinition =
  | Account
  | AccountAck
  | AccountCreateRequest
  | AccountDisableRequest
  | AccountDisabled
  | AccountInspectRequest
  | AccountInspection
  | AccountListRequest
  | AccountVerifyRequest
  | AccountsReply
  | Ack
  | AgentAnswerRequest
  | AgentSendRequest
  | Attachment
  | CatalogFrame
  | CatalogGetRequest
  | Catalogue
  | ClaudeIdentity
  | CodexIdentity
  | Conversation
  | ConversationChanged
  | ConversationGetRequest
  | ConversationSnapshot
  | Descriptor
  | Inspection
  | Message
  | OmpIdentity
  | PendingRequest
  | ProviderListRequest
  | ProvidersReply
  | QueuedPrompt
  | TerminalOwner
  | WorkspaceRecord

/**
 * Profile-owned account metadata. Credentials remain with the native provider.
 */
export interface Account {
  claude_identity?: ClaudeIdentity | null
  codex_identity?: CodexIdentity | null
  generation: number
  id: string
  name: string
  native_home: string
  omp_identity?: OmpIdentity | null
  provider: string
  state: string
  [k: string]: unknown
}
export interface ClaudeIdentity {
  api_provider: string
  auth_method: string
  email: string
  org_id: string
  [k: string]: unknown
}
export interface CodexIdentity {
  chatgpt_account_id: string
  email: string
  [k: string]: unknown
}
export interface OmpIdentity {
  account_id: string | null
  credential_id: number
  credential_type: string
  email: string | null
  identity_key: string
  org_id: string | null
  provider: string
  [k: string]: unknown
}
/**
 * The `account.create` and `account.verify` reply.
 */
export interface AccountAck {
  account: Account
  /**
   * The `ack` type tag.
   */
  type: 'ack'
  [k: string]: unknown
}
/**
 * `account.create`: register a new native account home for a provider.
 */
export interface AccountCreateRequest {
  /**
   * Trimmed by the daemon; 1 to 80 characters without line breaks.
   */
  name: string
  op: 'account.create'
  provider: string
}
/**
 * `account.disable`: stop new ADE launches with this account.
 */
export interface AccountDisableRequest {
  account_id: string
  op: 'account.disable'
}
/**
 * The `account.disable` reply. ADE never logs the native CLI out.
 */
export interface AccountDisabled {
  account: Account
  native_logout: boolean
  /**
   * The `ack` type tag.
   */
  type: 'ack'
  [k: string]: unknown
}
/**
 * `account.inspect`: probe a managed account's native readiness.
 */
export interface AccountInspectRequest {
  account_id: string
  op: 'account.inspect'
}
/**
 * The `account.inspect` reply.
 */
export interface AccountInspection {
  account_id: string
  generation: number
  inspection: Inspection
  /**
   * The `account_inspection` type tag.
   */
  type: 'account_inspection'
  [k: string]: unknown
}
/**
 * A provider's native readiness report for one account.
 */
export interface Inspection {
  /**
   * The provider-specific identity to pin; its shape depends on the provider.
   */
  identity: unknown
  reason: string
  /**
   * `ready` when the account can be verified.
   */
  state: string
  version: string | null
  [k: string]: unknown
}
/**
 * `account.list`: every account in the profile.
 */
export interface AccountListRequest {
  op: 'account.list'
}
/**
 * `account.verify`: pin the identity an earlier `account.inspect` returned.
 */
export interface AccountVerifyRequest {
  account_id: string
  /**
   * The `generation` from `account.inspect`. Required on the wire; the
   * daemon reports its absence after it has found the account.
   */
  expected_generation: number
  /**
   * The `inspection.identity` object from `account.inspect`, as returned.
   */
  expected_identity: unknown
  op: 'account.verify'
}
/**
 * The `account.list` reply.
 */
export interface AccountsReply {
  accounts: Account[]
  /**
   * The `accounts` type tag.
   */
  type: 'accounts'
  [k: string]: unknown
}
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
 * `provider.list`: the providers this daemon can launch.
 */
export interface ProviderListRequest {
  op: 'provider.list'
}
/**
 * The `provider.list` reply.
 */
export interface ProvidersReply {
  providers: Descriptor[]
  /**
   * The `providers` type tag.
   */
  type: 'providers'
  [k: string]: unknown
}

export type Operation = "catalog.get" | "conversation.get" | "agent.send" | "agent.answer" | "provider.list" | "account.list" | "account.create" | "account.inspect" | "account.verify" | "account.disable"

export interface RequestByOperation {
  "catalog.get": CatalogGetRequest
  "conversation.get": ConversationGetRequest
  "agent.send": AgentSendRequest
  "agent.answer": AgentAnswerRequest
  "provider.list": ProviderListRequest
  "account.list": AccountListRequest
  "account.create": AccountCreateRequest
  "account.inspect": AccountInspectRequest
  "account.verify": AccountVerifyRequest
  "account.disable": AccountDisableRequest
}

export interface ResponseByOperation {
  "catalog.get": CatalogFrame
  "conversation.get": ConversationSnapshot
  "agent.send": Ack
  "agent.answer": Ack
  "provider.list": ProvidersReply
  "account.list": AccountsReply
  "account.create": AccountAck
  "account.inspect": AccountInspection
  "account.verify": AccountAck
  "account.disable": AccountDisabled
}

export type FeedFrame = CatalogFrame | ConversationChanged
