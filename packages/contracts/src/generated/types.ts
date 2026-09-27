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
  | GitOperation
  | GitOperationStatus
  | Message
  | PendingRequest
  | QueuedPrompt
  | ReviewCommitRequest
  | ReviewDiff
  | ReviewDiffPage
  | ReviewDiffPageRequest
  | ReviewDiffRequest
  | ReviewDiffRow
  | ReviewDiffRowKind
  | ReviewDiscardRequest
  | ReviewFeedbackMatch
  | ReviewFeedbackSearch
  | ReviewFeedbackSearchRequest
  | ReviewFile
  | ReviewHunkRequest
  | ReviewOperationReply
  | ReviewOperationRequest
  | ReviewStageRequest
  | ReviewStatus
  | ReviewStatusRequest
  | ReviewUnstageRequest
  | TerminalOwner
  | WorkspaceRecord
/**
 * Where a Git mutation stands.
 */
export type GitOperationStatus = ('running' | 'succeeded' | 'failed') | 'interrupted'
/**
 * What one diff line is.
 */
export type ReviewDiffRowKind = 'hunk' | 'context' | 'added' | 'removed' | 'meta'

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
 * A Git mutation's receipt.
 */
export interface GitOperation {
  /**
   * Where a discard kept the displaced file.
   */
  backup_path?: string | null
  /**
   * The failure code; present and null on a failure without one.
   */
  code?: string | null
  error?: string | null
  finished_at?: number | null
  /**
   * The caller's operation ID.
   */
  id: string
  /**
   * The operation name, such as `review.stage`.
   */
  op: string
  /**
   * The recovery hint; present and null on a failure without one.
   */
  recovery?: string | null
  /**
   * The success result: `{head, output}` for a commit, otherwise
   * `{changed, action, receipt}`.
   */
  result?: unknown
  started_at: number
  status: GitOperationStatus
  [k: string]: unknown
}
/**
 * `review.commit`: commit the reviewed staged index.
 */
export interface ReviewCommitRequest {
  /**
   * The status `index_token` the user reviewed.
   */
  index_token: string
  message: string
  op: 'review.commit'
  operation_id: string
  workspace_id: string
}
/**
 * The `review.diff` reply.
 */
export interface ReviewDiff {
  binary: boolean
  bytes: number
  conflict: boolean
  header: string
  /**
   * Whether single hunks can be staged; binary, mode, link and
   * conflicted changes move only as whole files.
   */
  hunk_actions: boolean
  hunks: string[]
  path: string
  staged: boolean
  token: string
  /**
   * The `review_diff` type tag.
   */
  type: 'review_diff'
  [k: string]: unknown
}
/**
 * The `review.diff_page` reply.
 */
export interface ReviewDiffPage {
  binary: boolean
  bytes: number
  complete: boolean
  conflict: boolean
  header: string
  /**
   * The cursor for the next page; null on the last page.
   */
  next_cursor: string | null
  path: string
  revision: string
  rows: ReviewDiffRow[]
  staged: boolean
  token: string
  /**
   * The `review_diff_page` type tag.
   */
  type: 'review_diff_page'
  [k: string]: unknown
}
/**
 * One line of a paged diff.
 */
export interface ReviewDiffRow {
  /**
   * The header of the hunk the line belongs to.
   */
  hunk: string
  kind: ReviewDiffRowKind
  new_line: number | null
  old_line: number | null
  /**
   * The line, cut to 8 KiB.
   */
  text: string
  truncated: boolean
  [k: string]: unknown
}
/**
 * `review.diff_page`: read one bounded page of a file's diff. A first page
 * omits `cursor`; a continued page sends the previous `next_cursor`.
 */
export interface ReviewDiffPageRequest {
  cursor?: string
  /**
   * The token of the first page; a changed diff fails as stale.
   */
  expected_token?: string
  op: 'review.diff_page'
  path: string
  staged: boolean
  workspace_id: string
}
/**
 * `review.diff`: read one file's whole diff, split into hunks.
 */
export interface ReviewDiffRequest {
  op: 'review.diff'
  path: string
  /**
   * The staged side; the unstaged side when false or absent.
   */
  staged?: boolean
  workspace_id: string
}
/**
 * `review.discard`: discard one previewed, tracked, unstaged file change.
 */
export interface ReviewDiscardRequest {
  /**
   * The unstaged diff token the user previewed.
   */
  diff_token: string
  op: 'review.discard'
  operation_id: string
  path: string
  revision: string
  workspace_id: string
}
/**
 * One message whose review notes match a search.
 */
export interface ReviewFeedbackMatch {
  conversation_id: string
  message_id: string
  /**
   * The matching notes as `ade-review-feedback-v1`.
   */
  review_feedback: unknown
  [k: string]: unknown
}
/**
 * The `review.feedback.search` reply.
 */
export interface ReviewFeedbackSearch {
  /**
   * The cursor for the next page; null on the last page.
   */
  next_cursor: number | null
  results: ReviewFeedbackMatch[]
  /**
   * The `review_feedback_search` type tag.
   */
  type: 'review_feedback_search'
  [k: string]: unknown
}
/**
 * `review.feedback.search`: find saved review notes by file, note text or both.
 */
export interface ReviewFeedbackSearchRequest {
  /**
   * The `next_cursor` of the previous page.
   */
  before?: number
  /**
   * Page size from 1 to 50; the daemon uses 20 when it is absent.
   */
  limit?: number
  op: 'review.feedback.search'
  path?: string
  query?: string
  workspace_id: string
}
/**
 * One changed file in `review.status`.
 */
export interface ReviewFile {
  /**
   * The two-letter porcelain v2 status code.
   */
  code: string
  conflict: boolean
  /**
   * The literal repository-relative path.
   */
  path: string
  staged: boolean
  submodule: boolean
  unstaged: boolean
  untracked: boolean
  [k: string]: unknown
}
/**
 * `review.hunk`: stage, or with `staged` unstage, one hunk of a reviewed diff.
 */
export interface ReviewHunkRequest {
  /**
   * The hunk's index in that diff.
   */
  hunk: number
  op: 'review.hunk'
  operation_id: string
  path: string
  staged?: boolean
  /**
   * The `review.diff` token the hunk was chosen from.
   */
  token: string
  workspace_id: string
}
/**
 * The reply to every Git mutation and to `review.operation`.
 */
export interface ReviewOperationReply {
  operation: GitOperation
  /**
   * The `review_operation` type tag.
   */
  type: 'review_operation'
  [k: string]: unknown
}
/**
 * `review.operation`: read a Git mutation's receipt by its operation ID.
 */
export interface ReviewOperationRequest {
  op: 'review.operation'
  operation_id: string
  workspace_id: string
}
/**
 * `review.stage`: stage one reviewed file at a status revision.
 */
export interface ReviewStageRequest {
  op: 'review.stage'
  operation_id: string
  path: string
  revision: string
  workspace_id: string
}
/**
 * The `review.status` reply.
 */
export interface ReviewStatus {
  /**
   * The branch name, or `(detached)`.
   */
  branch: string
  /**
   * How many files are in conflict.
   */
  conflicts: number
  files: ReviewFile[]
  /**
   * The HEAD commit, or `(initial)` before the first commit.
   */
  head: string
  /**
   * Identifies HEAD and the index; `review.commit` must send it back.
   */
  index_token: string
  /**
   * Identifies the whole status; file mutations must send it back.
   */
  revision: string
  /**
   * The canonical Git worktree root.
   */
  root: string
  /**
   * The `review_status` type tag.
   */
  type: 'review_status'
  [k: string]: unknown
}
/**
 * `review.status`: read Git status for a workspace. Replies within 750 ms of
 * the last read come from a shared cache unless `force` is true.
 */
export interface ReviewStatusRequest {
  force?: boolean
  op: 'review.status'
  workspace_id: string
}
/**
 * `review.unstage`: unstage one reviewed file at a status revision.
 */
export interface ReviewUnstageRequest {
  op: 'review.unstage'
  operation_id: string
  path: string
  revision: string
  workspace_id: string
}

export type Operation = "catalog.get" | "conversation.get" | "agent.send" | "agent.answer" | "review.status" | "review.diff" | "review.diff_page" | "review.hunk" | "review.stage" | "review.unstage" | "review.discard" | "review.commit" | "review.operation" | "review.feedback.search"

export interface RequestByOperation {
  "catalog.get": CatalogGetRequest
  "conversation.get": ConversationGetRequest
  "agent.send": AgentSendRequest
  "agent.answer": AgentAnswerRequest
  "review.status": ReviewStatusRequest
  "review.diff": ReviewDiffRequest
  "review.diff_page": ReviewDiffPageRequest
  "review.hunk": ReviewHunkRequest
  "review.stage": ReviewStageRequest
  "review.unstage": ReviewUnstageRequest
  "review.discard": ReviewDiscardRequest
  "review.commit": ReviewCommitRequest
  "review.operation": ReviewOperationRequest
  "review.feedback.search": ReviewFeedbackSearchRequest
}

export interface ResponseByOperation {
  "catalog.get": CatalogFrame
  "conversation.get": ConversationSnapshot
  "agent.send": Ack
  "agent.answer": Ack
  "review.status": ReviewStatus
  "review.diff": ReviewDiff
  "review.diff_page": ReviewDiffPage
  "review.hunk": ReviewOperationReply
  "review.stage": ReviewOperationReply
  "review.unstage": ReviewOperationReply
  "review.discard": ReviewOperationReply
  "review.commit": ReviewOperationReply
  "review.operation": ReviewOperationReply
  "review.feedback.search": ReviewFeedbackSearch
}

export type FeedFrame = CatalogFrame | ConversationChanged
