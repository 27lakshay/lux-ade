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
  | FileEntry
  | FileKind
  | FileList
  | FileListRequest
  | FilePreview
  | FilePreviewRequest
  | FileSearch
  | FileSearchRequest
  | Message
  | OutputCoverage
  | OutputCoverageReason
  | OutputCoverageStatus
  | PendingRequest
  | PreviewKind
  | QueuedPrompt
  | Script
  | ScriptInspectRequest
  | ScriptInspection
  | ScriptList
  | ScriptListRequest
  | ScriptRetireRequest
  | ScriptRetired
  | ScriptRun
  | ScriptRunState
  | ScriptRunStatus
  | ScriptRuns
  | ScriptRunsRequest
  | ScriptStartRequest
  | ScriptStopRequest
  | TerminalOwner
  | WorkspaceRecord
/**
 * A directory entry's type, read without following symbolic links.
 */
export type FileKind = 'directory' | 'file' | 'symlink' | 'other'
/**
 * How a preview presents the file.
 */
export type PreviewKind = 'text' | 'image' | 'unsupported'
/**
 * Why output coverage is pending or incomplete.
 */
export type OutputCoverageReason =
  | 'capture_error'
  | 'durable_output_unavailable'
  | 'retention_overflow'
  | 'segment_gap'
  | 'process_running'
  | 'exit_unknown'
  | 'capture_gap'
  | 'tail_limited'
/**
 * Whether the returned output covers everything the run produced.
 */
export type OutputCoverageStatus = 'complete' | 'pending' | 'incomplete'
/**
 * A configured workspace script, as `script.list` returns it.
 */
export type Script =
  | {
      command: string
      kind: 'package_json'
      name: string
      [k: string]: unknown
    }
  | {
      args: string[]
      cwd: string
      kind: 'ade_recipe'
      name: string
      program: string
      [k: string]: unknown
    }
/**
 * A run's observed process state.
 */
export type ScriptRunStatus = 'running' | 'exited' | 'unknown'

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
 * One entry in a listing or search result.
 */
export interface FileEntry {
  kind: FileKind
  /**
   * Display name; a name that is not UTF-8 is shown lossily.
   */
  name: string
  /**
   * Workspace-relative path. A non-UTF-8 component is encoded as U+E000
   * followed by its unpadded URL-safe Base64 bytes.
   */
  path: string
  /**
   * Byte size of a regular file; null for every other kind.
   */
  size: number | null
  [k: string]: unknown
}
/**
 * The `file.list` reply.
 */
export interface FileList {
  entries: FileEntry[]
  incomplete: boolean
  /**
   * Null when the directory has no more entries.
   */
  next_cursor: string | null
  path: string
  /**
   * The `file_list` type tag.
   */
  type: 'file_list'
  [k: string]: unknown
}
/**
 * `file.list`: one page of a workspace directory.
 */
export interface FileListRequest {
  /**
   * The `next_cursor` of the previous page for the same path.
   */
  cursor?: string | null
  /**
   * Page size, 1 to 100; the daemon uses 100 when it is absent.
   */
  limit?: number
  op: 'file.list'
  /**
   * Workspace-relative directory; the workspace root when absent or empty.
   */
  path?: string
  workspace_id: string
}
/**
 * The `file.preview` reply. `text` carries `mime` and `text`; `image` carries
 * `mime` and `bytes_base64`; `unsupported` carries neither.
 */
export interface FilePreview {
  bytes_base64?: string | null
  kind: PreviewKind
  mime?: string | null
  path: string
  /**
   * The file's byte size.
   */
  size: number
  text?: string | null
  /**
   * True when the file exceeds the 256 KiB preview limit.
   */
  truncated: boolean
  /**
   * The `file_preview` type tag.
   */
  type: 'file_preview'
  [k: string]: unknown
}
/**
 * `file.preview`: the bounded contents of one workspace file.
 */
export interface FilePreviewRequest {
  op: 'file.preview'
  /**
   * Workspace-relative file path.
   */
  path: string
  workspace_id: string
}
/**
 * The `file.search` reply.
 */
export interface FileSearch {
  /**
   * True when depth, path-length or directory limits cut the search short.
   */
  incomplete: boolean
  /**
   * Null when the search has finished.
   */
  next_cursor: string | null
  results: FileEntry[]
  /**
   * The `file_search` type tag.
   */
  type: 'file_search'
  [k: string]: unknown
}
/**
 * `file.search`: one page of entries whose name contains the query, ignoring case.
 */
export interface FileSearchRequest {
  /**
   * The `next_cursor` of the previous page for the same query.
   */
  cursor?: string | null
  /**
   * Page size, 1 to 100; the daemon uses 100 when it is absent.
   */
  limit?: number
  op: 'file.search'
  /**
   * 1 to 256 bytes.
   */
  query: string
  workspace_id: string
}
/**
 * How much of a run's output the durable spool holds and the reply returns.
 */
export interface OutputCoverage {
  captured_through_offset: number | null
  produced_bytes: number | null
  /**
   * Null when the status is `complete`.
   */
  reason: OutputCoverageReason | null
  returned_start_offset: number | null
  status: OutputCoverageStatus
  [k: string]: unknown
}
/**
 * `script.inspect`: one run's state and output tail.
 */
export interface ScriptInspectRequest {
  op: 'script.inspect'
  run_id: string
  /**
   * Output tail size, 1 to 32768 bytes; the daemon uses 8192 when it is absent.
   */
  tail_bytes?: number
  workspace_id: string
}
/**
 * The `script.inspect` reply.
 */
export interface ScriptInspection {
  /**
   * The durable spool tail, passed through unchanged.
   */
  durable_output: unknown
  /**
   * The runtime's exit outcome (`kind` is `success`, `failure`, `signaled`
   * or `unknown`), present once the runtime reports one.
   */
  exit_status?: unknown
  /**
   * The runtime's terminal metrics, passed through unchanged.
   */
  metrics: unknown
  /**
   * The script name encoded in the run ID; empty if it does not parse.
   */
  name: string
  /**
   * The runtime's live `terminal.tail` reply, passed through unchanged.
   */
  output: unknown
  output_coverage: OutputCoverage
  run_id: string
  state: ScriptRunStatus
  /**
   * The `script_run` type tag.
   */
  type: 'script_run'
  workspace_id: string
  [k: string]: unknown
}
/**
 * The `script.list` reply.
 */
export interface ScriptList {
  scripts: Script[]
  /**
   * The `scripts` type tag.
   */
  type: 'scripts'
  workspace_id: string
  [k: string]: unknown
}
/**
 * `script.list`: the workspace's configured package scripts and ADE recipes.
 */
export interface ScriptListRequest {
  op: 'script.list'
  workspace_id: string
}
/**
 * `script.retire`: remove a stopped run and its retained output.
 */
export interface ScriptRetireRequest {
  op: 'script.retire'
  run_id: string
  workspace_id: string
}
/**
 * The `script.retire` reply.
 */
export interface ScriptRetired {
  run_id: string
  /**
   * The `ack` type tag.
   */
  type: 'ack'
  workspace_id: string
  [k: string]: unknown
}
/**
 * The `script.start` and `script.stop` reply.
 */
export interface ScriptRun {
  /**
   * The runtime's exit outcome (`kind` is `success`, `failure`, `signaled`
   * or `unknown`), present once the runtime reports one.
   */
  exit_status?: unknown
  /**
   * The runtime's terminal metrics, passed through unchanged.
   */
  metrics: unknown
  /**
   * The script name encoded in the run ID; empty if it does not parse.
   */
  name: string
  run_id: string
  state: ScriptRunStatus
  /**
   * The selected Node toolchain, on `script.start` of a Node-based script.
   */
  toolchain?: unknown
  /**
   * The `script_run` type tag.
   */
  type: 'script_run'
  workspace_id: string
  [k: string]: unknown
}
/**
 * One run as `script.runs` lists it.
 */
export interface ScriptRunState {
  /**
   * The runtime's exit outcome (`kind` is `success`, `failure`, `signaled`
   * or `unknown`), present once the runtime reports one.
   */
  exit_status?: unknown
  /**
   * The runtime's terminal metrics, passed through unchanged.
   */
  metrics: unknown
  /**
   * The script name encoded in the run ID; empty if it does not parse.
   */
  name: string
  run_id: string
  state: ScriptRunStatus
  [k: string]: unknown
}
/**
 * The `script.runs` reply.
 */
export interface ScriptRuns {
  runs: ScriptRunState[]
  /**
   * The `script_runs` type tag.
   */
  type: 'script_runs'
  workspace_id: string
  [k: string]: unknown
}
/**
 * `script.runs`: the workspace's registered script runs the runtime still knows.
 */
export interface ScriptRunsRequest {
  op: 'script.runs'
  workspace_id: string
}
/**
 * `script.start`: launch a configured script by name as a supervised PTY.
 */
export interface ScriptStartRequest {
  name: string
  op: 'script.start'
  workspace_id: string
}
/**
 * `script.stop`: stop a run and wait up to five seconds for it to exit.
 */
export interface ScriptStopRequest {
  op: 'script.stop'
  run_id: string
  workspace_id: string
}

export type Operation = "catalog.get" | "conversation.get" | "agent.send" | "agent.answer" | "script.list" | "script.inspect" | "script.start" | "script.stop" | "script.retire" | "script.runs" | "file.list" | "file.search" | "file.preview"

export interface RequestByOperation {
  "catalog.get": CatalogGetRequest
  "conversation.get": ConversationGetRequest
  "agent.send": AgentSendRequest
  "agent.answer": AgentAnswerRequest
  "script.list": ScriptListRequest
  "script.inspect": ScriptInspectRequest
  "script.start": ScriptStartRequest
  "script.stop": ScriptStopRequest
  "script.retire": ScriptRetireRequest
  "script.runs": ScriptRunsRequest
  "file.list": FileListRequest
  "file.search": FileSearchRequest
  "file.preview": FilePreviewRequest
}

export interface ResponseByOperation {
  "catalog.get": CatalogFrame
  "conversation.get": ConversationSnapshot
  "agent.send": Ack
  "agent.answer": Ack
  "script.list": ScriptList
  "script.inspect": ScriptInspection
  "script.start": ScriptRun
  "script.stop": ScriptRun
  "script.retire": ScriptRetired
  "script.runs": ScriptRuns
  "file.list": FileList
  "file.search": FileSearch
  "file.preview": FilePreview
}

export type FeedFrame = CatalogFrame | ConversationChanged
