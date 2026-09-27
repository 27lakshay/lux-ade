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
  | BranchPolicy
  | BrowserCloseRequest
  | BrowserInspectRequest
  | BrowserListRequest
  | BrowserMutation
  | BrowserNavigateRequest
  | BrowserOpenRequest
  | BrowserOperation
  | BrowserOperationRequest
  | BrowserOperationState
  | BrowserOwnerGetRequest
  | BrowserOwnerRegisterRequest
  | BrowserOwnerReleased
  | BrowserOwnerReply
  | BrowserOwnerUnregisterRequest
  | BrowserTabRecord
  | BrowserTabReply
  | BrowserTabs
  | CatalogFrame
  | CatalogGetRequest
  | Catalogue
  | ChildTranscriptPage
  | ClaudeIdentity
  | CodexIdentity
  | Config
  | Conversation
  | ConversationChanged
  | ConversationCreateRequest
  | ConversationCreated
  | ConversationGetRequest
  | ConversationSnapshot
  | DaemonHello
  | Descriptor
  | Draft
  | DraftGetRequest
  | DraftReply
  | DraftSaveRequest
  | DraftSendAbortRequest
  | DraftSendAcknowledgeRequest
  | DraftSendCompleteRequest
  | DraftSendGetRequest
  | DraftSendListRequest
  | DraftSendPrepareRequest
  | ExecutionState
  | FileEntry
  | FileKind
  | FileList
  | FileListRequest
  | FilePreview
  | FilePreviewRequest
  | FileSearch
  | FileSearchRequest
  | GitOperation
  | GitOperationStatus
  | HealthCheckRequest
  | HealthPolicy
  | HelloRequest
  | Inspection
  | ListenerFamily
  | ListenerInventory
  | ListenerListRequest
  | ListenerOwnership
  | ListenerRow
  | Message
  | OmpIdentity
  | OutputCoverage
  | OutputCoverageReason
  | OutputCoverageStatus
  | PeerEndpoint
  | PendingRequest
  | PendingSend
  | PendingSendList
  | PluginActivation
  | PluginCommandContribution
  | PluginContributions
  | PluginDataRecord
  | PluginDetail
  | PluginDisableRequest
  | PluginEnableRequest
  | PluginEntryPoints1
  | PluginInspectRequest
  | PluginInstallRequest
  | PluginList
  | PluginListRequest
  | PluginManifest
  | PluginPanelContribution
  | PluginRecordDeleteRequest
  | PluginRecordDeleted
  | PluginRecordGetRequest
  | PluginRecordList
  | PluginRecordListRequest
  | PluginRecordPutRequest
  | PluginRecordReply
  | PluginRegistration
  | PluginRegistrationKind
  | PluginReply
  | PluginSettingContribution
  | PluginSettingKind
  | PluginSettingListRequest
  | PluginSettingSetRequest
  | PluginSettingValue
  | PluginSettings
  | PluginSource
  | PluginSourceKind
  | PluginSourcePin
  | PluginStatus
  | PluginSummary
  | PluginUninstallRequest
  | PluginUninstalled
  | PortAssignment
  | PortObservation
  | PreviewKind
  | ProviderListRequest
  | ProvidersReply
  | ProxyAvailability
  | QueueCancelRequest
  | QueueEnqueueRequest
  | QueuePauseRequest
  | QueuedPrompt
  | Readiness
  | ReadinessBasis
  | ReadinessState
  | RecoveryStatus
  | RepositoryAck
  | RepositoryRebindCatalog
  | RepositoryRebindEntry
  | RepositoryRebindListRequest
  | RepositoryRebindRequest
  | RepositoryRecord
  | RestartPrepared
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
  | ReviewOperationAcknowledgeRequest
  | ReviewOperationAcknowledged
  | ReviewOperationEntry
  | ReviewOperationList
  | ReviewOperationListRequest
  | ReviewOperationReply
  | ReviewOperationRequest
  | ReviewStageRequest
  | ReviewStatus
  | ReviewStatusRequest
  | ReviewUnstageRequest
  | RuntimePrepareRestartRequest
  | RuntimeStatus
  | RuntimeStatusRequest
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
  | SendAcknowledged
  | SendIntent
  | SendIntentPrepared
  | SendIntentState
  | SendOutcome
  | SendResolution
  | Service
  | ServiceChanged
  | ServiceConfigureRequest
  | ServiceExecution
  | ServiceHealthSample
  | ServiceHealthSampleRequest
  | ServiceInspectRequest
  | ServiceInspection
  | ServiceList
  | ServiceListRequest
  | ServiceProxy
  | ServiceProxyEnsureRequest
  | ServiceProxyInspectRequest
  | ServiceProxyRecovery
  | ServiceProxyRecoveryInspectRequest
  | ServiceProxyRecoveryReset
  | ServiceProxyRecoveryResetRequest
  | ServiceProxyRecoveryRetryRequest
  | ServiceProxyRemapRequest
  | ServiceProxyRetireRequest
  | ServiceProxyRetired
  | ServiceProxyRoute
  | ServiceProxyTarget
  | ServiceProxyTargetRequest
  | ServiceRemoveRequest
  | ServiceReply
  | ServiceStartRequest
  | ServiceStopRequest
  | SessionSubscribeRequest
  | SetupState
  | TerminalCreateRequest
  | TerminalCreated
  | TerminalOperation
  | TerminalOperationRequest
  | TerminalOwner
  | TerminalRestartRequest
  | TerminalRetireRequest
  | TerminalStopRequest
  | WindowCloseRequest
  | WindowSaveRequest
  | WorkspaceAck
  | WorkspaceOpenRequest
  | WorkspaceRebindCatalog
  | WorkspaceRebindEntry
  | WorkspaceRebindListRequest
  | WorkspaceRebindRequest
  | WorkspaceRecord
  | WorktreeAdoptRequest
  | WorktreeConfigInput
  | WorktreeConfigureRequest
  | WorktreeGetRequest
  | WorktreeItem
  | WorktreeOperation
  | WorktreeOperationReply
  | WorktreeOperationRequest
  | WorktreeOperationStatus
  | WorktreeRebindCandidate
  | WorktreeRebindCatalog
  | WorktreeRebindListRequest
  | WorktreeRebindRequest
  | WorktreeRefreshRequest
  | WorktreeRemoveRequest
  | WorktreeRepository
  | WorktreeRepositoryRequest
  | WorktreeState
  | WorktreeSwitchRequest
/**
 * What `worktree.remove` does with the removed tree's branch.
 */
export type BranchPolicy = 'keep' | 'merged'
/**
 * Where a browser mutation stands.
 */
export type BrowserOperationState = 'accepted' | 'unknown' | 'completed'
/**
 * Whether a service's recorded run is live in the current runtime.
 */
export type ExecutionState = 'running' | 'exited' | 'stopped' | 'unavailable'
/**
 * A directory entry's type, read without following symbolic links.
 */
export type FileKind = 'directory' | 'file' | 'symlink' | 'other'
/**
 * How a preview presents the file.
 */
export type PreviewKind = 'text' | 'image' | 'unsupported'
/**
 * Where a Git mutation stands.
 */
export type GitOperationStatus = ('running' | 'succeeded' | 'failed') | 'interrupted'
export type ListenerFamily = 'ipv4' | 'ipv6'
export type PortObservation = 'verified_managed' | 'contested' | 'observed_other' | 'unobserved'
export type ListenerOwnership = 'managed_service' | 'unknown'
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
 * What the daemon knows about an unresolved send.
 */
export type SendOutcome = 'prepared' | 'accepted' | 'rejected' | 'held' | 'conflict'
/**
 * A registration kind in the activation registry.
 */
export type PluginRegistrationKind = 'command' | 'panel'
/**
 * A setting's value type. `credential_ref` holds a reference to a credential
 * kept elsewhere (an account ID or keychain item), never the secret itself.
 */
export type PluginSettingKind = 'string' | 'boolean' | 'number' | 'credential_ref'
/**
 * The kind of source a plugin was installed from.
 */
export type PluginSourceKind = 'local' | 'package' | 'git'
/**
 * Whether the plugin should be active.
 */
export type PluginStatus = 'enabled' | 'disabled'
/**
 * Where to install from. Every source ends pinned: a local directory by its
 * content digest, a package by its archive digest, Git by its commit.
 */
export type PluginSource =
  | {
      kind: 'local'
      path: string
    }
  | {
      kind: 'package'
      path: string
      /**
       * The expected lowercase hex SHA-256 of the archive.
       */
      sha256?: string | null
    }
  | {
      /**
       * A full 40-character commit ID.
       */
      commit?: string | null
      kind: 'git'
      ref?: string | null
      url: string
    }
export type ProxyAvailability = 'bound' | 'port_occupied'
export type ReadinessBasis =
  ('execution_state' | 'identity_changed') | 'direct_process_tcp_listener' | 'process_tree_tcp_listener'
/**
 * What the daemon could observe about a running service's ports.
 */
export type ReadinessState =
  | (
      | 'stopped'
      | 'exited'
      | 'unknown'
      | 'unknown_no_port_check'
      | 'port_conflict'
      | 'tcp_listening'
      | 'not_observed'
      | 'observation_unavailable'
    )
  | 'bound_unassigned_port'
export type RecoveryStatus = 'healthy' | 'degraded' | 'corrupt'
/**
 * What one diff line is.
 */
export type ReviewDiffRowKind = 'hunk' | 'context' | 'added' | 'removed' | 'meta'
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
 * How an acknowledged send settled.
 */
export type SendResolution = 'completed' | 'aborted'
/**
 * Whether a tree is ready for an Agent, from its latest `worktree.switch`.
 */
export type SetupState = 'ready' | 'preparing' | 'interrupted' | 'failed'
/**
 * A lifecycle operation's status in its ledger.
 */
export type WorktreeOperationStatus = ('running' | 'succeeded' | 'failed') | 'partial' | 'interrupted'

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
 * `browser.close`: close an exact tab.
 */
export interface BrowserCloseRequest {
  op: 'browser.close'
  operation_id: string
  owner_id: string
  profile_id: string
  tab_id: string
}
/**
 * `browser.inspect`: inspect one exact tab.
 */
export interface BrowserInspectRequest {
  op: 'browser.inspect'
  owner_id: string
  profile_id: string
  tab_id: string
}
/**
 * `browser.list`: list the tabs under one exact owner.
 */
export interface BrowserListRequest {
  op: 'browser.list'
  owner_id: string
  profile_id: string
}
/**
 * The `browser.open`, `browser.navigate` and `browser.close` reply, relayed
 * from the owner. `payload_fingerprint` is the daemon's fingerprint of the
 * operation, its profile, owner, tab and URL.
 */
export interface BrowserMutation {
  op: string
  owner_id: string
  payload_fingerprint: string
  profile_id: string
  request_id: string
  tab_id: string
  /**
   * The `browser_mutation` type tag.
   */
  type: 'browser_mutation'
  [k: string]: unknown
}
/**
 * `browser.navigate`: load a URL in an exact tab.
 */
export interface BrowserNavigateRequest {
  op: 'browser.navigate'
  operation_id: string
  owner_id: string
  profile_id: string
  tab_id: string
  url: string
}
/**
 * `browser.open`: open a tab. `operation_id` is the caller-owned operation
 * ID; the daemon still accepts it as `request_id`.
 */
export interface BrowserOpenRequest {
  op: 'browser.open'
  operation_id: string
  owner_id: string
  profile_id: string
  /**
   * An `http://` or `https://` URL of at most 8192 bytes.
   */
  url: string
}
/**
 * The `browser.operation` reply: the daemon's receipt, or the owner's.
 */
export interface BrowserOperation {
  /**
   * The mutation's operation; only the owner's receipt carries it.
   */
  op?: string | null
  owner_id: string
  payload_fingerprint: string
  profile_id: string
  request_id: string
  /**
   * The completed mutation's reply. The daemon's receipt sends `null`
   * before completion; the owner's omits it without a tab.
   */
  result?: unknown
  state: BrowserOperationState
  /**
   * The `browser_operation` type tag.
   */
  type: 'browser_operation'
  [k: string]: unknown
}
/**
 * `browser.operation`: read a browser mutation's receipt by its operation ID.
 */
export interface BrowserOperationRequest {
  op: 'browser.operation'
  operation_id: string
  /**
   * Defaults to this daemon's browser profile.
   */
  profile_id?: string | null
}
/**
 * `browser.owner.get`: read the live browser owner of a profile.
 */
export interface BrowserOwnerGetRequest {
  op: 'browser.owner.get'
  /**
   * Defaults to this daemon's browser profile.
   */
  profile_id?: string | null
}
/**
 * `browser.owner.register`: name the Unix socket that owns the profile's browser.
 */
export interface BrowserOwnerRegisterRequest {
  op: 'browser.owner.register'
  owner_id: string
  profile_id: string
  /**
   * An absolute path to a private, owned Unix socket.
   */
  socket_path: string
}
/**
 * The `browser.owner.unregister` reply.
 */
export interface BrowserOwnerReleased {
  owner_id: string
  profile_id: string
  /**
   * The `ack` type tag.
   */
  type: 'ack'
  [k: string]: unknown
}
/**
 * The `browser.owner.get` and `browser.owner.register` reply.
 */
export interface BrowserOwnerReply {
  owner_id: string
  profile_id: string
  /**
   * The `browser_owner` type tag.
   */
  type: 'browser_owner'
  [k: string]: unknown
}
/**
 * `browser.owner.unregister`: release the owner registration.
 */
export interface BrowserOwnerUnregisterRequest {
  op: 'browser.owner.unregister'
  owner_id: string
  profile_id: string
}
/**
 * One browser tab as the owner reports it. The owner uses camelCase names.
 */
export interface BrowserTabRecord {
  error: string
  id: string
  loading: boolean
  observedUrl: string
  /**
   * The owner's browser storage profile.
   */
  profileId: string
  requestedUrl: string
  title: string
  [k: string]: unknown
}
/**
 * The `browser.inspect` reply, relayed from the owner.
 */
export interface BrowserTabReply {
  owner_id: string
  profile_id: string
  tab: BrowserTabRecord
  tab_id: string
  /**
   * The `browser_tab` type tag.
   */
  type: 'browser_tab'
  [k: string]: unknown
}
/**
 * The `browser.list` reply, relayed from the owner.
 */
export interface BrowserTabs {
  owner_id: string
  /**
   * The owner's browser storage profile.
   */
  profileId: string
  profile_id: string
  selectedId: string | null
  tabs: BrowserTabRecord[]
  /**
   * The `browser_tabs` type tag.
   */
  type: 'browser_tabs'
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
 * A repository's stored lifecycle configuration.
 */
export interface Config {
  /**
   * Parent directory for new trees; the repository's parent when absent.
   */
  directory: string | null
  /**
   * Git command timeout in seconds.
   */
  timeout_seconds: number
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
 * The `hello` reply: build identity and every protocol version.
 */
export interface DaemonHello {
  application_protocol: string
  boot_id: string
  /**
   * `ADE_BUILD_ID`, or `null` when the daemon was built without one.
   */
  build_id: string | null
  pid: number
  response_owner: string
  review_protocol: string
  runtime_instance: string
  runtime_pid: number
  runtime_protocol: string
  runtime_socket: string
  session_protocol: string
  terminal_snapshot_format: string
  terminal_snapshot_formats: string[]
  /**
   * The `hello` type tag.
   */
  type: 'hello'
  worktree_protocol: string
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
 * `draft.send.acknowledge`: settle one listed send once the caller has shown
 * its outcome. An accepted prompt completes; a rejected one aborts. A prompt
 * the daemon has not accepted is refused, because only delivery can settle it.
 */
export interface DraftSendAcknowledgeRequest {
  conversation_id: string
  op: 'draft.send.acknowledge'
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
 * `draft.send.list`: list one window's unresolved sends across Conversations,
 * ordered by Conversation ID. A later page sends the previous `next_cursor`.
 */
export interface DraftSendListRequest {
  after?: string
  /**
   * Page size from 1 to 200; the daemon uses 50 when it is absent.
   */
  limit?: number
  op: 'draft.send.list'
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
 * The HTTP probe `service.inspect` accepts.
 */
export interface HealthCheckRequest {
  path: string
  port_variable: string
  timeout_ms: number
}
export interface HealthPolicy {
  interval_ms: number
  path: string
  port_variable: string
  timeout_ms: number
}
/**
 * `hello`: the handshake every connection sends first.
 */
export interface HelloRequest {
  op: 'hello'
}
/**
 * The `listener.list` reply.
 */
export interface ListenerInventory {
  assignments: PortAssignment[]
  /**
   * The `partial` type tag.
   */
  coverage: 'partial'
  listeners: ListenerRow[]
  /**
   * The `local_host` type tag.
   */
  scope: 'local_host'
  /**
   * The `listeners` type tag.
   */
  type: 'listeners'
  [k: string]: unknown
}
/**
 * One service port assignment and who was seen listening on it.
 */
export interface PortAssignment {
  observation: PortObservation
  port: number
  service_name: string
  variable: string
  workspace_id: string
  [k: string]: unknown
}
/**
 * One observed TCP listener.
 */
export interface ListenerRow {
  address: string
  family: ListenerFamily
  ownership: ListenerOwnership
  pid: number
  port: number
  /**
   * The `tcp` type tag.
   */
  protocol: 'tcp'
  service_name: string | null
  /**
   * Set when the listener belongs to a verified managed service run.
   */
  workspace_id: string | null
  [k: string]: unknown
}
/**
 * `listener.list`: observe local TCP listeners and service port assignments.
 */
export interface ListenerListRequest {
  op: 'listener.list'
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
export interface PeerEndpoint {
  port_variable: string
  service: string
}
/**
 * One unresolved send and what the daemon knows about it.
 */
export interface PendingSend {
  intent: SendIntent
  outcome: SendOutcome
  [k: string]: unknown
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
 * The `draft.send.list` reply.
 */
export interface PendingSendList {
  /**
   * The cursor for the next page; null on the last page.
   */
  next_cursor: string | null
  /**
   * Whether the profile was restored from a backup, which holds its sends.
   */
  restored_from_backup: boolean
  sends: PendingSend[]
  /**
   * The `pending_sends` type tag.
   */
  type: 'pending_sends'
  [k: string]: unknown
}
/**
 * The live activation of an enabled plugin.
 */
export interface PluginActivation {
  activated_at: number
  generation: number
  registrations: PluginRegistration[]
  [k: string]: unknown
}
/**
 * One registration owned by an activation.
 */
export interface PluginRegistration {
  id: string
  kind: PluginRegistrationKind
  [k: string]: unknown
}
/**
 * A command. Its ID starts with the plugin ID and a dot.
 */
export interface PluginCommandContribution {
  id: string
  title: string
}
/**
 * Static contributions the registry records for each activation.
 */
export interface PluginContributions {
  commands: PluginCommandContribution[]
  panels: PluginPanelContribution[]
  settings: PluginSettingContribution[]
}
/**
 * A panel for the UI host. Its ID starts with the plugin ID and a dot.
 */
export interface PluginPanelContribution {
  id: string
  title: string
}
/**
 * A declared setting. Only declared keys may be set.
 */
export interface PluginSettingContribution {
  /**
   * Must match `kind`. A `credential_ref` setting has no default.
   */
  default?: unknown
  key: string
  kind: PluginSettingKind
  title: string
}
/**
 * One namespaced durable record.
 */
export interface PluginDataRecord {
  /**
   * The plugin data schema in force when the record was written.
   */
  data_schema: number
  key: string
  namespace: string
  /**
   * Starts at 1 and rises by one on every write.
   */
  revision: number
  updated_at: number
  value: unknown
  [k: string]: unknown
}
/**
 * An installed plugin with its manifest and artifact.
 */
export interface PluginDetail {
  /**
   * The live activation; null while disabled or when activation failed.
   */
  activation: PluginActivation | null
  /**
   * Why an enabled plugin has no activation after a daemon restart.
   */
  activation_error: string | null
  /**
   * The highest activation generation issued so far; 0 before the first.
   */
  activation_generation: number
  /**
   * `sha256:<hex>` over the installed artifact's files.
   */
  artifact_digest: string
  artifact_path: string
  /**
   * The data schema the installed code declares.
   */
  data_schema: number
  id: string
  installed_at: number
  manifest: PluginManifest
  name: string
  source: PluginSourcePin
  status: PluginStatus
  /**
   * The highest data schema any installed code has declared. Records may
   * carry any schema up to this one.
   */
  stored_data_schema: number
  updated_at: number
  /**
   * The artifact version from the manifest.
   */
  version: string
  [k: string]: unknown
}
/**
 * `ade-plugin.json`, format version 1. Unknown fields are rejected so a
 * newer manifest never activates with parts silently ignored.
 */
export interface PluginManifest {
  /**
   * The plugin API version the code targets.
   */
  api_version: number
  contributes: PluginContributions1
  /**
   * The version of the plugin's durable data layout, from 1. It is separate
   * from the artifact version: code rollback never rolls data back.
   */
  data_schema: number
  description?: string | null
  entry_points: PluginEntryPoints
  /**
   * `publisher.name`: lowercase letters, digits and single hyphens in each
   * dot-separated part, at least two parts, at most 64 bytes.
   */
  id: string
  /**
   * Always 1.
   */
  manifest_version: number
  /**
   * Display name, 1 to 128 characters.
   */
  name: string
  /**
   * The artifact version, in strict semantic versioning.
   */
  version: string
}
/**
 * Static contributions the registry records for each activation.
 */
export interface PluginContributions1 {
  commands: PluginCommandContribution[]
  panels: PluginPanelContribution[]
  settings: PluginSettingContribution[]
}
/**
 * At least one entry point, each a relative path inside the artifact.
 */
export interface PluginEntryPoints {
  /**
   * Loaded by a separate restartable backend host.
   */
  backend?: string | null
  /**
   * Loaded by a runtime-supervised provider worker.
   */
  provider?: string | null
  /**
   * Loaded into the trusted application renderer.
   */
  ui?: string | null
}
/**
 * The resolved, pinned source of an installed artifact.
 */
export interface PluginSourcePin {
  /**
   * The requested Git ref, if any.
   */
  git_ref: string | null
  kind: PluginSourceKind
  /**
   * The local path, package path or Git URL the artifact came from.
   */
  locator: string
  /**
   * `sha256:<hex>` for local and package sources; the commit ID for Git.
   */
  pin: string
  [k: string]: unknown
}
/**
 * `plugin.disable`: end the current activation and dispose only its registrations.
 */
export interface PluginDisableRequest {
  op: 'plugin.disable'
  plugin_id: string
}
/**
 * `plugin.enable`: start a new activation. Enabling an enabled plugin
 * returns its current state and starts nothing.
 */
export interface PluginEnableRequest {
  op: 'plugin.enable'
  plugin_id: string
}
/**
 * Where each host loads the plugin from. Paths are relative to the artifact root.
 */
export interface PluginEntryPoints1 {
  /**
   * Loaded by a separate restartable backend host.
   */
  backend?: string | null
  /**
   * Loaded by a runtime-supervised provider worker.
   */
  provider?: string | null
  /**
   * Loaded into the trusted application renderer.
   */
  ui?: string | null
}
/**
 * `plugin.inspect`: one plugin with its manifest and live registrations.
 */
export interface PluginInspectRequest {
  op: 'plugin.inspect'
  plugin_id: string
}
/**
 * `plugin.install`: copy a pinned artifact into the profile and record it.
 * Replacing an installed plugin requires it to be disabled first.
 */
export interface PluginInstallRequest {
  /**
   * Refuse the artifact unless its manifest declares exactly this version.
   */
  expected_version?: string | null
  op: 'plugin.install'
  operation_id: string
  source: PluginSource
}
/**
 * The `plugin.list` reply.
 */
export interface PluginList {
  plugins: PluginSummary[]
  /**
   * The `plugins` type tag.
   */
  type: 'plugins'
  [k: string]: unknown
}
/**
 * An installed plugin as `plugin.list` shows it.
 */
export interface PluginSummary {
  /**
   * The live activation; null while disabled or when activation failed.
   */
  activation: PluginActivation | null
  /**
   * Why an enabled plugin has no activation after a daemon restart.
   */
  activation_error: string | null
  /**
   * The highest activation generation issued so far; 0 before the first.
   */
  activation_generation: number
  /**
   * The data schema the installed code declares.
   */
  data_schema: number
  id: string
  installed_at: number
  name: string
  source: PluginSourcePin
  status: PluginStatus
  /**
   * The highest data schema any installed code has declared. Records may
   * carry any schema up to this one.
   */
  stored_data_schema: number
  updated_at: number
  /**
   * The artifact version from the manifest.
   */
  version: string
  [k: string]: unknown
}
/**
 * `plugin.list`: every installed plugin.
 */
export interface PluginListRequest {
  op: 'plugin.list'
}
/**
 * `plugin.record.delete`: delete a record; deleting a missing record succeeds.
 */
export interface PluginRecordDeleteRequest {
  /**
   * Delete only if the record is at this revision.
   */
  expected_revision?: number | null
  key: string
  namespace: string
  op: 'plugin.record.delete'
  plugin_id: string
}
/**
 * The `plugin.record.delete` reply.
 */
export interface PluginRecordDeleted {
  /**
   * False when there was no record to delete.
   */
  deleted: boolean
  key: string
  namespace: string
  plugin_id: string
  /**
   * The `plugin_record_deleted` type tag.
   */
  type: 'plugin_record_deleted'
  [k: string]: unknown
}
/**
 * `plugin.record.get`: one namespaced record, or null.
 */
export interface PluginRecordGetRequest {
  key: string
  namespace: string
  op: 'plugin.record.get'
  plugin_id: string
}
/**
 * The `plugin.record.list` reply.
 */
export interface PluginRecordList {
  namespace: string
  plugin_id: string
  records: PluginDataRecord[]
  /**
   * The `plugin_records` type tag.
   */
  type: 'plugin_records'
  [k: string]: unknown
}
/**
 * `plugin.record.list`: the records in one namespace, by key.
 */
export interface PluginRecordListRequest {
  namespace: string
  op: 'plugin.record.list'
  plugin_id: string
}
/**
 * `plugin.record.put`: write a record of at most 64 KiB of JSON.
 */
export interface PluginRecordPutRequest {
  /**
   * Write only if the record is at this revision; 0 means it must not exist.
   */
  expected_revision?: number | null
  key: string
  namespace: string
  op: 'plugin.record.put'
  plugin_id: string
  value: unknown
}
/**
 * The `plugin.record.get` and `plugin.record.put` reply.
 */
export interface PluginRecordReply {
  plugin_id: string
  record: PluginDataRecord | null
  /**
   * The `plugin_record` type tag.
   */
  type: 'plugin_record'
  [k: string]: unknown
}
/**
 * The `plugin.inspect`, `plugin.install`, `plugin.enable` and `plugin.disable` reply.
 */
export interface PluginReply {
  plugin: PluginDetail
  /**
   * The `plugin` type tag.
   */
  type: 'plugin'
  [k: string]: unknown
}
/**
 * `plugin.setting.list`: every declared setting with its effective value.
 */
export interface PluginSettingListRequest {
  op: 'plugin.setting.list'
  plugin_id: string
}
/**
 * `plugin.setting.set`: set a declared setting; null restores its default.
 */
export interface PluginSettingSetRequest {
  key: string
  op: 'plugin.setting.set'
  plugin_id: string
  value: unknown
}
/**
 * One declared setting and its effective value.
 */
export interface PluginSettingValue {
  /**
   * Whether `value` is the declared default.
   */
  is_default: boolean
  key: string
  kind: PluginSettingKind
  /**
   * The stored value, or the default when none is stored; null if neither.
   */
  value: unknown
  [k: string]: unknown
}
/**
 * The `plugin.setting.list` and `plugin.setting.set` reply.
 */
export interface PluginSettings {
  plugin_id: string
  settings: PluginSettingValue[]
  /**
   * The `plugin_settings` type tag.
   */
  type: 'plugin_settings'
  [k: string]: unknown
}
/**
 * `plugin.uninstall`: remove a disabled plugin and its artifacts.
 */
export interface PluginUninstallRequest {
  op: 'plugin.uninstall'
  operation_id: string
  plugin_id: string
  /**
   * Also delete the plugin's records and settings. Without it they stay
   * and a reinstall of the same ID finds them.
   */
  purge_data?: boolean
}
/**
 * The `plugin.uninstall` reply.
 */
export interface PluginUninstalled {
  data_purged: boolean
  plugin_id: string
  /**
   * The `plugin_uninstalled` type tag.
   */
  type: 'plugin_uninstalled'
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
 * Port readiness; application readiness is never inferred.
 */
export interface Readiness {
  /**
   * The `unverified` type tag.
   */
  application_ready: 'unverified'
  basis: ReadinessBasis
  observation_error: string | null
  state: ReadinessState
  [k: string]: unknown
}
/**
 * The `repository.rebind` reply.
 */
export interface RepositoryAck {
  repository: RepositoryRecord
  /**
   * The `ack` type tag.
   */
  type: 'ack'
  [k: string]: unknown
}
/**
 * A saved repository as the daemon stores it.
 */
export interface RepositoryRecord {
  id: string
  needs_rebind: boolean
  /**
   * The Git common directory.
   */
  root: string
  worktree_lifecycle_needs_rebind: boolean
  [k: string]: unknown
}
/**
 * The `repository.rebind.list` reply.
 */
export interface RepositoryRebindCatalog {
  repositories: RepositoryRebindEntry[]
  /**
   * The `repository_rebind_catalog` type tag.
   */
  type: 'repository_rebind_catalog'
  [k: string]: unknown
}
/**
 * One restored repository. `rebindable` says a saved physical identity exists.
 */
export interface RepositoryRebindEntry {
  id: string
  needs_rebind: boolean
  rebindable: boolean
  root: string
  [k: string]: unknown
}
/**
 * `repository.rebind.list`: restored repositories and whether each needs a path.
 */
export interface RepositoryRebindListRequest {
  op: 'repository.rebind.list'
}
/**
 * `repository.rebind`: bind a restored Git repository to a verified checkout.
 */
export interface RepositoryRebindRequest {
  op: 'repository.rebind'
  path: string
  repository_id: string
}
/**
 * The `runtime.prepare_restart` reply.
 */
export interface RestartPrepared {
  boot_id: string
  runtime_instance: string
  /**
   * The `ack` type tag.
   */
  type: 'ack'
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
 * `review.operation.acknowledge`: record that the person saw an interrupted
 * Git mutation. The operation never runs again either way.
 */
export interface ReviewOperationAcknowledgeRequest {
  op: 'review.operation.acknowledge'
  operation_id: string
  workspace_id: string
}
/**
 * The `review.operation.acknowledge` reply. A repeat returns the first time.
 */
export interface ReviewOperationAcknowledged {
  acknowledged_at: number
  operation: GitOperation
  /**
   * The `review_operation_acknowledged` type tag.
   */
  type: 'review_operation_acknowledged'
  [k: string]: unknown
}
/**
 * One listed Git mutation.
 */
export interface ReviewOperationEntry {
  /**
   * When the person acknowledged it; null while unacknowledged.
   */
  acknowledged_at: number | null
  operation: GitOperation
  [k: string]: unknown
}
/**
 * The `review.operation.list` reply.
 */
export interface ReviewOperationList {
  operations: ReviewOperationEntry[]
  /**
   * More matching operations exist than the reply carries.
   */
  truncated: boolean
  /**
   * The `review_operations` type tag.
   */
  type: 'review_operations'
  [k: string]: unknown
}
/**
 * `review.operation.list`: the workspace's Git mutations that still need the
 * person: running ones and interrupted ones not yet acknowledged, newest
 * first. `include_acknowledged` adds acknowledged interrupted ones.
 */
export interface ReviewOperationListRequest {
  include_acknowledged?: boolean
  op: 'review.operation.list'
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
/**
 * `runtime.prepare_restart`: drain the daemon so a new build can take over.
 */
export interface RuntimePrepareRestartRequest {
  /**
   * The `boot_id` from `runtime.status`; a different daemon refuses.
   */
  boot_id: string
  op: 'runtime.prepare_restart'
}
/**
 * The `runtime.status` reply.
 */
export interface RuntimeStatus {
  active_git_operations: number
  /**
   * The runtime supervisor's agent runs without their command logs.
   */
  agents: unknown
  application_protocol: string
  boot_id: string
  connected_agents: number
  pid: number
  runtime_instance: string
  runtime_pid: number
  runtime_protocol: string
  runtime_socket: string
  stopping: boolean
  /**
   * The runtime supervisor's terminal list, relayed as it sends it.
   */
  terminals: unknown
  /**
   * The `runtime_status` type tag.
   */
  type: 'runtime_status'
  [k: string]: unknown
}
/**
 * `runtime.status`: read the daemon and runtime supervisor state.
 */
export interface RuntimeStatusRequest {
  op: 'runtime.status'
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
/**
 * The `draft.send.acknowledge` reply, with the window's current draft.
 */
export interface SendAcknowledged {
  conversation_id: string
  draft: Draft
  request_id: string
  resolution: SendResolution
  /**
   * The `send_acknowledged` type tag.
   */
  type: 'send_acknowledged'
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
export interface Service {
  /**
   * Inlined in schemas: a request's defaults make its required fields differ
   * from a reply's, so the two cannot share one named definition.
   */
  config: {
    args: string[]
    cwd: string
    env: {
      [k: string]: string
    }
    health?: HealthPolicy | null
    /**
     * Environment variables populated from another managed service in this workspace.
     */
    peers?: {
      [k: string]: PeerEndpoint
    }
    /**
     * Environment variables that receive stable, host-local TCP ports.
     */
    ports: string[]
    program: string
  }
  hostname: string
  /**
   * Durable incarnation; a removed service with the same name gets a new ID.
   */
  identity: string
  last_run_transfer_id?: string | null
  /**
   * URLs placed in the environment of the currently reserved service run.
   */
  launch_peers?: {
    [k: string]: string
  }
  name: string
  ports: {
    [k: string]: number
  }
  revision: number
  terminal_id: string | null
  terminal_owner: TerminalOwner | null
  workspace_id: string
  [k: string]: unknown
}
/**
 * The `service_changed` feed frame, sent when a run starts or stops.
 */
export interface ServiceChanged {
  boot_id: string
  /**
   * The launched terminal's metrics; present when a run starts.
   */
  metrics?: unknown
  revision: number
  service: Service
  /**
   * The `service_changed` type tag.
   */
  type: 'service_changed'
  [k: string]: unknown
}
/**
 * `service.configure`: create or edit a service recipe.
 */
export interface ServiceConfigureRequest {
  /**
   * Decoded as a [`Config`] by the handler, so malformed recipes keep the
   * daemon's own validation messages.
   */
  config: {
    args?: string[]
    cwd?: string
    env?: {
      [k: string]: string
    }
    health?: HealthPolicy | null
    /**
     * Environment variables populated from another managed service in this workspace.
     */
    peers?: {
      [k: string]: PeerEndpoint
    }
    /**
     * Environment variables that receive stable, host-local TCP ports.
     */
    ports?: string[]
    program: string
  }
  name: string
  op: 'service.configure'
  /**
   * The revision the caller last saw; 0 creates the service.
   */
  revision: number
  workspace_id: string
}
/**
 * One service's entry in [`ServiceList::states`].
 */
export interface ServiceExecution {
  /**
   * The runtime terminal metrics, or null when the service has no live terminal.
   */
  metrics: unknown
  state: ExecutionState
  [k: string]: unknown
}
/**
 * The `service.health.sample` reply.
 */
export interface ServiceHealthSample {
  health_monitor: unknown
  /**
   * The `service_health_sample` type tag.
   */
  type: 'service_health_sample'
  [k: string]: unknown
}
/**
 * `service.health.sample`: probe the service's configured health policy now.
 */
export interface ServiceHealthSampleRequest {
  name: string
  op: 'service.health.sample'
  workspace_id: string
}
/**
 * `service.inspect`: execution, readiness, peers and bounded output of one service.
 */
export interface ServiceInspectRequest {
  health_check?: HealthCheckRequest1
  name: string
  op: 'service.inspect'
  /**
   * Output tail in bytes, 1 to 32768; the daemon uses 8192 when it is absent.
   */
  tail_bytes?: number
  workspace_id: string
}
/**
 * A one-off HTTP probe. The handler validates it, so its messages stay
 * specific.
 */
export interface HealthCheckRequest1 {
  path: string
  port_variable: string
  timeout_ms: number
}
/**
 * The `service.inspect` reply.
 */
export interface ServiceInspection {
  /**
   * Absent when the service changed during inspection.
   */
  current_peer_endpoints?: {
    [k: string]: string
  } | null
  /**
   * The durable run log tail, or `{available: false, reason}`.
   */
  durable_logs: unknown
  effective_peers: {
    [k: string]: string
  }
  execution_error: string | null
  execution_state: ExecutionState
  /**
   * The requested one-off probe result; present when `health_check` was sent.
   */
  health?: unknown
  /**
   * The configured policy's latest monitored result.
   */
  health_monitor: unknown
  /**
   * The live terminal tail, or `{available: false, reason}`.
   */
  logs: unknown
  peer_error: string | null
  readiness: Readiness
  service: Service
  /**
   * The `service_inspection` type tag.
   */
  type: 'service_inspection'
  [k: string]: unknown
}
/**
 * The `service.list` reply.
 */
export interface ServiceList {
  services: Service[]
  /**
   * Keyed by service name.
   */
  states: {
    [k: string]: ServiceExecution
  }
  /**
   * The `services` type tag.
   */
  type: 'services'
  [k: string]: unknown
}
/**
 * `service.list`: a workspace's services and their execution state.
 */
export interface ServiceListRequest {
  op: 'service.list'
  workspace_id: string
}
/**
 * A stable URL. The `service.proxy.ensure`, `service.proxy.inspect`,
 * `service.proxy.remap` and `service.proxy.recovery.retry` reply.
 */
export interface ServiceProxy {
  /**
   * Present, as `port_occupied`, only from `service.proxy.inspect` on a blocked route.
   */
  availability?: ProxyAvailability | null
  /**
   * The `runtime` type tag.
   */
  owner: 'runtime'
  port: number
  route_id: string
  /**
   * The `local_private` type tag.
   */
  scope: 'local_private'
  service_identity: string
  target_port: number
  /**
   * The `service_proxy` type tag.
   */
  type: 'service_proxy'
  /**
   * Null when the route's port is occupied.
   */
  url: string | null
  [k: string]: unknown
}
/**
 * `service.proxy.ensure`: create or reuse the stable URL for one service port.
 */
export interface ServiceProxyEnsureRequest {
  name: string
  op: 'service.proxy.ensure'
  port_variable: string
  workspace_id: string
}
/**
 * `service.proxy.inspect`: read one stable URL.
 */
export interface ServiceProxyInspectRequest {
  name: string
  op: 'service.proxy.inspect'
  port_variable: string
  workspace_id: string
}
/**
 * The `service.proxy.recovery.inspect` reply.
 */
export interface ServiceProxyRecovery {
  /**
   * Present when the registry is corrupt.
   */
  reason?: string | null
  /**
   * Present when the registry is corrupt; empty when no bounded digest exists.
   */
  registry_sha256?: string | null
  routes: ServiceProxyRoute[]
  status: RecoveryStatus
  /**
   * The `service_proxy_recovery` type tag.
   */
  type: 'service_proxy_recovery'
  [k: string]: unknown
}
/**
 * One route in [`ServiceProxyRecovery::routes`].
 */
export interface ServiceProxyRoute {
  availability: ProxyAvailability
  name: string
  /**
   * The `runtime` type tag.
   */
  owner: 'runtime'
  port: number
  port_variable: string
  /**
   * Why the port is unavailable; present when it is occupied.
   */
  reason?: string | null
  route_id: string
  /**
   * The `local_private` type tag.
   */
  scope: 'local_private'
  service_identity: string
  target_port: number
  /**
   * The `service_proxy` type tag.
   */
  type: 'service_proxy'
  /**
   * Null when the route's port is occupied.
   */
  url: string | null
  workspace_id: string
  [k: string]: unknown
}
/**
 * `service.proxy.recovery.inspect`: blocked routes or a corrupt registry.
 */
export interface ServiceProxyRecoveryInspectRequest {
  op: 'service.proxy.recovery.inspect'
}
/**
 * The `service.proxy.recovery.reset` reply.
 */
export interface ServiceProxyRecoveryReset {
  /**
   * Path of the archived corrupt registry.
   */
  archive: string
  previous_sha256: string
  /**
   * The `reset` type tag.
   */
  status: 'reset'
  /**
   * The `service_proxy_recovery_reset` type tag.
   */
  type: 'service_proxy_recovery_reset'
  [k: string]: unknown
}
/**
 * `service.proxy.recovery.reset`: archive and reset an inspected corrupt registry.
 */
export interface ServiceProxyRecoveryResetRequest {
  expected_registry_sha256: string
  op: 'service.proxy.recovery.reset'
}
/**
 * `service.proxy.recovery.retry`: rebind a blocked route's original port.
 */
export interface ServiceProxyRecoveryRetryRequest {
  expected_proxy_port: number
  expected_route_id: string
  expected_service_identity: string
  expected_target_port: number
  name: string
  op: 'service.proxy.recovery.retry'
  port_variable: string
  workspace_id: string
}
/**
 * `service.proxy.remap`: point a stable URL at the service's current identity
 * and port, only if both reviewed targets still match.
 */
export interface ServiceProxyRemapRequest {
  expected_route_identity: string
  expected_route_port: number
  expected_service_identity: string
  expected_target_port: number
  name: string
  op: 'service.proxy.remap'
  port_variable: string
  workspace_id: string
}
/**
 * `service.proxy.retire`: retire exactly one reviewed stable URL.
 */
export interface ServiceProxyRetireRequest {
  expected_proxy_port: number
  expected_route_id: string
  expected_service_identity: string
  expected_target_port: number
  name: string
  op: 'service.proxy.retire'
  port_variable: string
  workspace_id: string
}
/**
 * The `service.proxy.retire` reply: the route as it was retired.
 */
export interface ServiceProxyRetired {
  /**
   * The `runtime` type tag.
   */
  owner: 'runtime'
  port: number
  route_id: string
  /**
   * The `local_private` type tag.
   */
  scope: 'local_private'
  service_identity: string
  target_port: number
  /**
   * The `service_proxy_retired` type tag.
   */
  type: 'service_proxy_retired'
  url: string
  [k: string]: unknown
}
/**
 * The `service.proxy.target` reply: the verified service process to forward to.
 */
export interface ServiceProxyTarget {
  host: string
  pid: number
  port: number
  transfer_id: string
  /**
   * The `service_proxy_target` type tag.
   */
  type: 'service_proxy_target'
  [k: string]: unknown
}
/**
 * `service.proxy.target`: the runtime proxy asks the daemon to verify its
 * target before forwarding one connection.
 */
export interface ServiceProxyTargetRequest {
  /**
   * `127.0.0.1` or `::1`.
   */
  connected_host: string
  expected_port: number
  name: string
  op: 'service.proxy.target'
  port_variable: string
  service_identity: string
  workspace_id: string
}
/**
 * `service.remove`: delete a stopped service at the revision the caller saw.
 */
export interface ServiceRemoveRequest {
  name: string
  op: 'service.remove'
  revision: number
  workspace_id: string
}
/**
 * The `service.configure`, `service.start` and `service.stop` reply.
 */
export interface ServiceReply {
  /**
   * Peer URLs placed in the run's environment; present on `service.start`.
   */
  effective_peers?: {
    [k: string]: string
  } | null
  /**
   * The launched terminal's metrics; present on `service.start`.
   */
  metrics?: unknown
  service: Service
  /**
   * Present on `service.start`.
   */
  terminal_id?: string | null
  /**
   * The `service` type tag.
   */
  type: 'service'
  [k: string]: unknown
}
/**
 * `service.start`: launch a configured service, or return its live run.
 */
export interface ServiceStartRequest {
  name: string
  op: 'service.start'
  workspace_id: string
}
/**
 * `service.stop`: stop a service and confirm its process exited.
 */
export interface ServiceStopRequest {
  name: string
  op: 'service.stop'
  workspace_id: string
}
/**
 * `session.subscribe`: turn this connection into the feed. The reply is the
 * first `catalog` frame; later lines are feed frames.
 */
export interface SessionSubscribeRequest {
  op: 'session.subscribe'
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
/**
 * The `workspace.open` and `workspace.rebind` reply.
 */
export interface WorkspaceAck {
  /**
   * The `ack` type tag.
   */
  type: 'ack'
  workspace: WorkspaceRecord
  [k: string]: unknown
}
/**
 * `workspace.open`: register a folder, or return the workspace already at it.
 */
export interface WorkspaceOpenRequest {
  op: 'workspace.open'
  /**
   * The folder to open; the daemon canonicalizes it.
   */
  path: string
}
/**
 * The `workspace.rebind.list` reply.
 */
export interface WorkspaceRebindCatalog {
  /**
   * The `workspace_rebind_catalog` type tag.
   */
  type: 'workspace_rebind_catalog'
  workspaces: WorkspaceRebindEntry[]
  [k: string]: unknown
}
/**
 * One restored workspace. `rebindable` says a saved physical identity exists.
 */
export interface WorkspaceRebindEntry {
  id: string
  name: string
  needs_rebind: boolean
  rebindable: boolean
  root: string
  [k: string]: unknown
}
/**
 * `workspace.rebind.list`: restored workspaces and whether each needs a path.
 */
export interface WorkspaceRebindListRequest {
  op: 'workspace.rebind.list'
}
/**
 * `workspace.rebind`: bind a restored workspace to a verified directory.
 */
export interface WorkspaceRebindRequest {
  op: 'workspace.rebind'
  path: string
  workspace_id: string
}
/**
 * `worktree.adopt`: take ADE removal authority over an existing linked tree.
 */
export interface WorktreeAdoptRequest {
  /**
   * Must equal the canonical form of `path`. Optional in Rust only so a
   * missing value keeps the daemon's own error message.
   */
  confirm_path: string
  op: 'worktree.adopt'
  path: string
  repository_id: string
}
/**
 * The configuration a caller sends. Absent fields take their defaults; the
 * stored form is [`Config`].
 */
export interface WorktreeConfigInput {
  /**
   * Parent directory for new trees; the repository's parent when absent.
   */
  directory?: string | null
  /**
   * Git command timeout; the daemon accepts 5 to 300.
   */
  timeout_seconds?: number
}
/**
 * `worktree.configure`: replace a repository's lifecycle configuration.
 */
export interface WorktreeConfigureRequest {
  config: WorktreeConfigInput
  op: 'worktree.configure'
  repository_id: string
}
/**
 * `worktree.get`: read a registered repository's lifecycle state.
 */
export interface WorktreeGetRequest {
  op: 'worktree.get'
  repository_id: string
}
/**
 * One entry of `git worktree list`, with ADE's ownership and setup state.
 */
export interface WorktreeItem {
  /**
   * Whether ADE holds removal authority over this tree.
   */
  ade_owned: boolean
  bare?: boolean | null
  branch?: string | null
  detached?: boolean | null
  lock_reason?: string | null
  locked?: boolean | null
  path: string
  prunable?: boolean | null
  setup_state: SetupState
  [k: string]: unknown
}
/**
 * One lifecycle operation from the ledger. The daemon stores this shape.
 */
export interface WorktreeOperation {
  binding_generation: number
  code?: string | null
  error: string | null
  finished_at: number | null
  /**
   * The caller's operation ID.
   */
  id: string
  recovery?: string | null
  repository_id: string
  /**
   * The request as the caller sent it, including `op`.
   */
  request: unknown
  /**
   * Command output and its `value`; `null` until the command runs.
   * `worktree_state` omits `stdout` and `stderr`.
   */
  result: unknown
  started_at: number
  status: WorktreeOperationStatus
  worktree_path: string | null
  [k: string]: unknown
}
/**
 * The `worktree.operation` reply.
 */
export interface WorktreeOperationReply {
  operation: WorktreeOperation
  /**
   * The `worktree_operation` type tag.
   */
  type: 'worktree_operation'
  [k: string]: unknown
}
/**
 * `worktree.operation`: read one lifecycle operation receipt in full.
 */
export interface WorktreeOperationRequest {
  op: 'worktree.operation'
  /**
   * The operation's ID; `request_id` is accepted as an alias.
   */
  operation_id: string
  repository_id: string
}
/**
 * One lifecycle repository in the rebind catalog.
 */
export interface WorktreeRebindCandidate {
  binding_generation: number
  common_dir: string
  id: string
  needs_rebind: boolean
  /**
   * Whether the saved source identity survives, so a rebind can be verified.
   */
  rebindable: boolean
  root: string
  [k: string]: unknown
}
/**
 * The `worktree.rebind.list` reply.
 */
export interface WorktreeRebindCatalog {
  repositories: WorktreeRebindCandidate[]
  /**
   * The `worktree_rebind_catalog` type tag.
   */
  type: 'worktree_rebind_catalog'
  [k: string]: unknown
}
/**
 * `worktree.rebind.list`: list lifecycle repositories and whether each needs a rebind.
 */
export interface WorktreeRebindListRequest {
  op: 'worktree.rebind.list'
}
/**
 * `worktree.rebind`: bind a restored lifecycle repository to a verified checkout.
 */
export interface WorktreeRebindRequest {
  op: 'worktree.rebind'
  path: string
  repository_id: string
}
/**
 * `worktree.refresh`: re-read the Git worktree listing under the repository lock.
 */
export interface WorktreeRefreshRequest {
  op: 'worktree.refresh'
  /**
   * Caller-owned operation ID; `request_id` is accepted as an alias.
   */
  operation_id: string
  repository_id: string
}
/**
 * `worktree.remove`: remove a clean ADE-owned linked tree.
 */
export interface WorktreeRemoveRequest {
  confirm_path?: string | null
  /**
   * Branch policy; the daemon uses `keep` when it is absent. The daemon
   * reads the raw string so an unknown policy keeps its own error message.
   */
  delete_branch?: BranchPolicy | null
  /**
   * Forced removal is unavailable; `true` is rejected.
   */
  force?: boolean | null
  op: 'worktree.remove'
  /**
   * Caller-owned operation ID; `request_id` is accepted as an alias.
   */
  operation_id: string
  path: string
  repository_id: string
}
/**
 * A registered lifecycle repository. Device and inode identities are decimal strings.
 */
export interface WorktreeRepository {
  binding_generation: number
  common_device: string | null
  common_dir: string
  common_inode: string | null
  config: Config
  id: string
  needs_rebind: boolean
  refreshed_at: number | null
  /**
   * The primary checkout, where lifecycle commands run.
   */
  root: string
  root_device: string | null
  root_inode: string | null
  source_common_device: string | null
  /**
   * The common directory before the first rebind.
   */
  source_common_dir: string | null
  source_common_inode: string | null
  source_root_device: string | null
  source_root_inode: string | null
  [k: string]: unknown
}
/**
 * `worktree.repository`: register the Git repository containing `path`, or
 * return the one already registered for its common directory.
 */
export interface WorktreeRepositoryRequest {
  op: 'worktree.repository'
  path: string
}
/**
 * A repository's lifecycle state: the reply to every command except
 * `worktree.operation` and `worktree.rebind.list`.
 */
export interface WorktreeState {
  /**
   * Whether a lifecycle or review operation holds the repository.
   */
  busy: boolean
  /**
   * The newest 100 operations, newest first, without command output.
   */
  operations: WorktreeOperation[]
  repository: WorktreeRepository
  /**
   * The `worktree_state` type tag.
   */
  type: 'worktree_state'
  /**
   * The cached Git listing, primary checkout first.
   */
  worktrees: WorktreeItem[]
  [k: string]: unknown
}
/**
 * `worktree.switch`: check out `target` in a linked tree, creating the branch
 * when `create` is true.
 */
export interface WorktreeSwitchRequest {
  /**
   * Start point for a new branch; the daemon uses `HEAD` when it is absent.
   */
  base?: string | null
  create?: boolean | null
  op: 'worktree.switch'
  /**
   * Caller-owned operation ID; `request_id` is accepted as an alias.
   */
  operation_id: string
  /**
   * Absolute path for a new tree, directly inside the configured directory.
   */
  path?: string | null
  repository_id: string
  /**
   * A branch name, or the path of an existing linked tree.
   */
  target: string
}

export type Operation = "catalog.get" | "workspace.open" | "workspace.rebind.list" | "workspace.rebind" | "repository.rebind.list" | "repository.rebind" | "conversation.get" | "agent.send" | "agent.answer" | "conversation.create" | "draft.get" | "draft.save" | "draft.send.get" | "draft.send.prepare" | "draft.send.complete" | "draft.send.abort" | "draft.send.list" | "draft.send.acknowledge" | "queue.enqueue" | "queue.cancel" | "queue.pause" | "window.save" | "window.close" | "attachment.put" | "attachment.import" | "attachment.inspect" | "attachment.reclaim.preview" | "attachment.reclaim.apply" | "agent.cancel" | "agent.resume" | "agent.disconnect" | "agent.send_review" | "agent.child_transcript" | "agent.list" | "agent.account_inspect" | "provider.list" | "account.list" | "account.create" | "account.inspect" | "account.verify" | "account.disable" | "terminal.create" | "terminal.operation" | "terminal.restart" | "terminal.stop" | "terminal.retire" | "service.configure" | "service.list" | "service.inspect" | "service.start" | "service.stop" | "service.remove" | "service.health.sample" | "service.proxy.ensure" | "service.proxy.inspect" | "service.proxy.target" | "service.proxy.remap" | "service.proxy.retire" | "service.proxy.recovery.inspect" | "service.proxy.recovery.retry" | "service.proxy.recovery.reset" | "listener.list" | "review.status" | "review.diff" | "review.diff_page" | "review.hunk" | "review.stage" | "review.unstage" | "review.discard" | "review.commit" | "review.operation" | "review.operation.list" | "review.operation.acknowledge" | "review.feedback.search" | "worktree.repository" | "worktree.get" | "worktree.switch" | "worktree.adopt" | "worktree.remove" | "worktree.refresh" | "worktree.configure" | "worktree.operation" | "worktree.rebind" | "worktree.rebind.list" | "script.list" | "script.inspect" | "script.start" | "script.stop" | "script.retire" | "script.runs" | "file.list" | "file.search" | "file.preview" | "hello" | "runtime.status" | "runtime.prepare_restart" | "session.subscribe" | "browser.owner.get" | "browser.owner.register" | "browser.owner.unregister" | "browser.list" | "browser.inspect" | "browser.open" | "browser.navigate" | "browser.close" | "browser.operation" | "plugin.list" | "plugin.inspect" | "plugin.install" | "plugin.uninstall" | "plugin.enable" | "plugin.disable" | "plugin.record.get" | "plugin.record.list" | "plugin.record.put" | "plugin.record.delete" | "plugin.setting.list" | "plugin.setting.set"

export interface RequestByOperation {
  "catalog.get": CatalogGetRequest
  "workspace.open": WorkspaceOpenRequest
  "workspace.rebind.list": WorkspaceRebindListRequest
  "workspace.rebind": WorkspaceRebindRequest
  "repository.rebind.list": RepositoryRebindListRequest
  "repository.rebind": RepositoryRebindRequest
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
  "draft.send.list": DraftSendListRequest
  "draft.send.acknowledge": DraftSendAcknowledgeRequest
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
  "provider.list": ProviderListRequest
  "account.list": AccountListRequest
  "account.create": AccountCreateRequest
  "account.inspect": AccountInspectRequest
  "account.verify": AccountVerifyRequest
  "account.disable": AccountDisableRequest
  "terminal.create": TerminalCreateRequest
  "terminal.operation": TerminalOperationRequest
  "terminal.restart": TerminalRestartRequest
  "terminal.stop": TerminalStopRequest
  "terminal.retire": TerminalRetireRequest
  "service.configure": ServiceConfigureRequest
  "service.list": ServiceListRequest
  "service.inspect": ServiceInspectRequest
  "service.start": ServiceStartRequest
  "service.stop": ServiceStopRequest
  "service.remove": ServiceRemoveRequest
  "service.health.sample": ServiceHealthSampleRequest
  "service.proxy.ensure": ServiceProxyEnsureRequest
  "service.proxy.inspect": ServiceProxyInspectRequest
  "service.proxy.target": ServiceProxyTargetRequest
  "service.proxy.remap": ServiceProxyRemapRequest
  "service.proxy.retire": ServiceProxyRetireRequest
  "service.proxy.recovery.inspect": ServiceProxyRecoveryInspectRequest
  "service.proxy.recovery.retry": ServiceProxyRecoveryRetryRequest
  "service.proxy.recovery.reset": ServiceProxyRecoveryResetRequest
  "listener.list": ListenerListRequest
  "review.status": ReviewStatusRequest
  "review.diff": ReviewDiffRequest
  "review.diff_page": ReviewDiffPageRequest
  "review.hunk": ReviewHunkRequest
  "review.stage": ReviewStageRequest
  "review.unstage": ReviewUnstageRequest
  "review.discard": ReviewDiscardRequest
  "review.commit": ReviewCommitRequest
  "review.operation": ReviewOperationRequest
  "review.operation.list": ReviewOperationListRequest
  "review.operation.acknowledge": ReviewOperationAcknowledgeRequest
  "review.feedback.search": ReviewFeedbackSearchRequest
  "worktree.repository": WorktreeRepositoryRequest
  "worktree.get": WorktreeGetRequest
  "worktree.switch": WorktreeSwitchRequest
  "worktree.adopt": WorktreeAdoptRequest
  "worktree.remove": WorktreeRemoveRequest
  "worktree.refresh": WorktreeRefreshRequest
  "worktree.configure": WorktreeConfigureRequest
  "worktree.operation": WorktreeOperationRequest
  "worktree.rebind": WorktreeRebindRequest
  "worktree.rebind.list": WorktreeRebindListRequest
  "script.list": ScriptListRequest
  "script.inspect": ScriptInspectRequest
  "script.start": ScriptStartRequest
  "script.stop": ScriptStopRequest
  "script.retire": ScriptRetireRequest
  "script.runs": ScriptRunsRequest
  "file.list": FileListRequest
  "file.search": FileSearchRequest
  "file.preview": FilePreviewRequest
  "hello": HelloRequest
  "runtime.status": RuntimeStatusRequest
  "runtime.prepare_restart": RuntimePrepareRestartRequest
  "session.subscribe": SessionSubscribeRequest
  "browser.owner.get": BrowserOwnerGetRequest
  "browser.owner.register": BrowserOwnerRegisterRequest
  "browser.owner.unregister": BrowserOwnerUnregisterRequest
  "browser.list": BrowserListRequest
  "browser.inspect": BrowserInspectRequest
  "browser.open": BrowserOpenRequest
  "browser.navigate": BrowserNavigateRequest
  "browser.close": BrowserCloseRequest
  "browser.operation": BrowserOperationRequest
  "plugin.list": PluginListRequest
  "plugin.inspect": PluginInspectRequest
  "plugin.install": PluginInstallRequest
  "plugin.uninstall": PluginUninstallRequest
  "plugin.enable": PluginEnableRequest
  "plugin.disable": PluginDisableRequest
  "plugin.record.get": PluginRecordGetRequest
  "plugin.record.list": PluginRecordListRequest
  "plugin.record.put": PluginRecordPutRequest
  "plugin.record.delete": PluginRecordDeleteRequest
  "plugin.setting.list": PluginSettingListRequest
  "plugin.setting.set": PluginSettingSetRequest
}

export interface ResponseByOperation {
  "catalog.get": CatalogFrame
  "workspace.open": WorkspaceAck
  "workspace.rebind.list": WorkspaceRebindCatalog
  "workspace.rebind": WorkspaceAck
  "repository.rebind.list": RepositoryRebindCatalog
  "repository.rebind": RepositoryAck
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
  "draft.send.list": PendingSendList
  "draft.send.acknowledge": SendAcknowledged
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
  "provider.list": ProvidersReply
  "account.list": AccountsReply
  "account.create": AccountAck
  "account.inspect": AccountInspection
  "account.verify": AccountAck
  "account.disable": AccountDisabled
  "terminal.create": TerminalCreated
  "terminal.operation": TerminalOperation
  "terminal.restart": Ack
  "terminal.stop": Ack
  "terminal.retire": Ack
  "service.configure": ServiceReply
  "service.list": ServiceList
  "service.inspect": ServiceInspection
  "service.start": ServiceReply
  "service.stop": ServiceReply
  "service.remove": Ack
  "service.health.sample": ServiceHealthSample
  "service.proxy.ensure": ServiceProxy
  "service.proxy.inspect": ServiceProxy
  "service.proxy.target": ServiceProxyTarget
  "service.proxy.remap": ServiceProxy
  "service.proxy.retire": ServiceProxyRetired
  "service.proxy.recovery.inspect": ServiceProxyRecovery
  "service.proxy.recovery.retry": ServiceProxy
  "service.proxy.recovery.reset": ServiceProxyRecoveryReset
  "listener.list": ListenerInventory
  "review.status": ReviewStatus
  "review.diff": ReviewDiff
  "review.diff_page": ReviewDiffPage
  "review.hunk": ReviewOperationReply
  "review.stage": ReviewOperationReply
  "review.unstage": ReviewOperationReply
  "review.discard": ReviewOperationReply
  "review.commit": ReviewOperationReply
  "review.operation": ReviewOperationReply
  "review.operation.list": ReviewOperationList
  "review.operation.acknowledge": ReviewOperationAcknowledged
  "review.feedback.search": ReviewFeedbackSearch
  "worktree.repository": WorktreeState
  "worktree.get": WorktreeState
  "worktree.switch": WorktreeState
  "worktree.adopt": WorktreeState
  "worktree.remove": WorktreeState
  "worktree.refresh": WorktreeState
  "worktree.configure": WorktreeState
  "worktree.operation": WorktreeOperationReply
  "worktree.rebind": WorktreeState
  "worktree.rebind.list": WorktreeRebindCatalog
  "script.list": ScriptList
  "script.inspect": ScriptInspection
  "script.start": ScriptRun
  "script.stop": ScriptRun
  "script.retire": ScriptRetired
  "script.runs": ScriptRuns
  "file.list": FileList
  "file.search": FileSearch
  "file.preview": FilePreview
  "hello": DaemonHello
  "runtime.status": RuntimeStatus
  "runtime.prepare_restart": RestartPrepared
  "session.subscribe": CatalogFrame
  "browser.owner.get": BrowserOwnerReply
  "browser.owner.register": BrowserOwnerReply
  "browser.owner.unregister": BrowserOwnerReleased
  "browser.list": BrowserTabs
  "browser.inspect": BrowserTabReply
  "browser.open": BrowserMutation
  "browser.navigate": BrowserMutation
  "browser.close": BrowserMutation
  "browser.operation": BrowserOperation
  "plugin.list": PluginList
  "plugin.inspect": PluginReply
  "plugin.install": PluginReply
  "plugin.uninstall": PluginUninstalled
  "plugin.enable": PluginReply
  "plugin.disable": PluginReply
  "plugin.record.get": PluginRecordReply
  "plugin.record.list": PluginRecordList
  "plugin.record.put": PluginRecordReply
  "plugin.record.delete": PluginRecordDeleted
  "plugin.setting.list": PluginSettings
  "plugin.setting.set": PluginSettings
}

export type FeedFrame = CatalogFrame | ConversationChanged | ServiceChanged
