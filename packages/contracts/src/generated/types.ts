// Generated from the Rust contracts in crates/ade-core/src/contract by scripts/generate-contracts.mjs. Do not edit.

export type ContractDefinition =
  | Account
  | AccountAck
  | AccountChoice
  | AccountCreateRequest
  | AccountDisableRequest
  | AccountDisabled
  | AccountInspectRequest
  | AccountInspection
  | AccountListRequest
  | AccountVerifyRequest
  | AccountsReply
  | Ack
  | AcpHandshake
  | Activity
  | ActivityChanged
  | ActivityKind
  | ActivityList
  | ActivityListRequest
  | ActivityMark
  | ActivityMarkRequest
  | ActivityMarked
  | ActivityState
  | ActivityTarget
  | AdapterDefinition
  | AdapterKind
  | AdapterList
  | AdapterListRequest
  | AdapterProbe
  | AdapterProbeRequest
  | AdapterProbed
  | AdapterPut
  | AdapterPutRequest
  | AdapterReadiness
  | AdapterRecord
  | AdapterRemoveRequest
  | AdapterRemoved
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
  | BackendCompatibility
  | BranchPolicy
  | BrowserAttachment
  | BrowserAttachmentState
  | BrowserCaptureKind
  | BrowserCloseRequest
  | BrowserConsoleEntry
  | BrowserDiagnostics
  | BrowserDiagnosticsAttachRequest
  | BrowserDiagnosticsDetachRequest
  | BrowserDiagnosticsDropped
  | BrowserDiagnosticsReadRequest
  | BrowserDiagnosticsState
  | BrowserInspectRequest
  | BrowserListRequest
  | BrowserMutation
  | BrowserNavigateRequest
  | BrowserNetworkEntry
  | BrowserNetworkOutcome
  | BrowserOpenRequest
  | BrowserOperation
  | BrowserOperationRequest
  | BrowserOperationState
  | BrowserOwnerGetRequest
  | BrowserOwnerRegisterRequest
  | BrowserOwnerReleased
  | BrowserOwnerReply
  | BrowserOwnerUnregisterRequest
  | BrowserRecording
  | BrowserRecordingGetRequest
  | BrowserRecordingStartRequest
  | BrowserRecordingState
  | BrowserRecordingStopRequest
  | BrowserTabRecord
  | BrowserTabReply
  | BrowserTabs
  | Caller
  | Capability
  | CapabilityChange
  | CapabilityRecord
  | CarryBlocker
  | CarryChange
  | CatalogFrame
  | CatalogGetRequest
  | Catalogue
  | CheckState
  | CheckedPreset
  | CheckpointArea
  | CheckpointChangeKind
  | CheckpointCoverage
  | CheckpointCreateRequest
  | CheckpointCreated
  | CheckpointDeleteRequest
  | CheckpointDeleted
  | CheckpointKind
  | CheckpointList
  | CheckpointListRequest
  | CheckpointPathChange
  | CheckpointProblem
  | CheckpointRestoreOutcome
  | CheckpointRestorePreview
  | CheckpointRestorePreviewRequest
  | CheckpointRestoreRequest
  | CheckpointRestoreVerdict
  | CheckpointRestored
  | CheckpointSummary
  | ChildDelegated
  | ChildGetRequest
  | ChildList
  | ChildMessageQueued
  | ChildRecord
  | ChildReply
  | ChildSendRequest
  | ChildTranscriptPage
  | ChildWait
  | ChildWaitRequest
  | ChildrenRequest
  | ClaimMode
  | ClaimPhase
  | ClaimPurpose
  | ClaimState
  | ClaudeIdentity
  | CleanupBlocker
  | CodexIdentity
  | CommittedChanges
  | CommittedFile
  | Config
  | Conversation
  | ConversationCapabilities
  | ConversationChanged
  | ConversationCreateRequest
  | ConversationCreated
  | ConversationGetRequest
  | ConversationSnapshot
  | CostBasis
  | DaemonHello
  | DelegateRequest
  | DeliveryChannel
  | DeliveryOutcome
  | DeliveryStatus
  | Descriptor
  | DiagnosticClaims
  | DiagnosticCounter
  | DiagnosticCounterKind
  | DiagnosticIdentity
  | DiagnosticLive
  | DiagnosticLogs
  | DiagnosticProvenance
  | DiagnosticQueue
  | DiagnosticReceipts
  | DiagnosticRedaction
  | DiagnosticRetention
  | DiagnosticRun
  | DiagnosticService
  | DiagnosticTerminal
  | DiagnosticUnit
  | DiagnosticUnknown
  | DiagnosticUnknownSource
  | DiagnosticUnresolvedClaim
  | DiagnosticWindow
  | DiagnosticsExport
  | DiagnosticsExportRequest
  | DiagnosticsStatus
  | DiagnosticsStatusRequest
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
  | Excluded
  | Exclusion
  | ExecutableIdentity
  | ExecutableSettings
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
  | GrantCapabilities
  | GroupCompareRequest
  | GroupComparison
  | GroupGetRequest
  | GroupList
  | GroupRecord
  | GroupReply
  | GroupStartRequest
  | GroupStarted
  | GroupState
  | GroupSummary
  | GroupsRequest
  | HealthCheckRequest
  | HealthPolicy
  | HelloRequest
  | HistoryConversation
  | HistoryImportCandidate
  | HistoryImportOutcome
  | HistoryImportProvider
  | HistoryImportRequest
  | HistoryImportScan
  | HistoryImportScanRequest
  | HistoryImportSource
  | HistoryImportStore
  | HistoryImported
  | HistoryIndexRebuildRequest
  | HistoryIndexReply
  | HistoryIndexStatus
  | HistoryIndexStatusRequest
  | HistoryList
  | HistoryListRequest
  | HistoryMatch
  | HistoryProvenance
  | HistorySearch
  | HistorySearchRequest
  | Hook
  | HookDelivery
  | HookDeliveryAbandonRequest
  | HookDeliveryInspectRequest
  | HookDeliveryList
  | HookDeliveryListRequest
  | HookDeliveryReply
  | HookDeliveryRetryRequest
  | HookDeliveryStatus
  | HookEvent
  | HookHostStatus
  | HookSubscription
  | HookSubscriptionList
  | HookSubscriptionListRequest
  | HostResourcesState
  | Inspection
  | Installation
  | ListenerFamily
  | ListenerInventory
  | ListenerListRequest
  | ListenerOwnership
  | ListenerRow
  | McpResolution
  | McpResolveRequest
  | McpServerAddRequest
  | McpServerInspectRequest
  | McpServerInspection
  | McpServerListRequest
  | McpServerRemoveRequest
  | McpServerRemoved
  | McpServerReply
  | McpServerUpdateRequest
  | McpServers
  | Message
  | ModelCapabilities
  | ModelFormat
  | NotificationDeliveries
  | NotificationDelivery
  | NotificationDeliveryClaim
  | NotificationDeliveryClaimRequest
  | NotificationDeliveryListRequest
  | NotificationDeliveryReply
  | NotificationDeliveryReportRequest
  | OmpIdentity
  | Outcome
  | OutputCoverage
  | OutputCoverageReason
  | OutputCoverageStatus
  | PackageRegistry
  | PairingState
  | PathOverlap
  | PeerEndpoint
  | PendingPhase
  | PendingRequest
  | PendingSend
  | PendingSendList
  | PermissionModeCapability
  | PluginActivation
  | PluginCommandContribution
  | PluginCommandInvokeRequest
  | PluginCommandOutcome
  | PluginCommandResult
  | PluginContributions
  | PluginDataRecord
  | PluginDetail
  | PluginDisableRequest
  | PluginEnableRequest
  | PluginEntryPoints1
  | PluginHostReply
  | PluginHostRestartRequest
  | PluginHostState
  | PluginHostStatus
  | PluginHostStatusRequest
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
  | Preset
  | PresetConflict
  | PresetDeleteRequest
  | PresetDeleted
  | PresetField
  | PresetGetRequest
  | PresetList
  | PresetListRequest
  | PresetSaveRequest
  | PresetSaved
  | PresetSettings
  | PresetView
  | PreviewKind
  | ProbeOutcome
  | Projected
  | PromptInput
  | ProviderCapabilities
  | ProviderCapabilitiesRequest
  | ProviderListRequest
  | ProviderQuota
  | ProviderQuotaRequest
  | ProviderReadiness
  | ProviderReadinessRequest
  | ProviderSelection
  | ProviderSupport
  | ProvidersReply
  | ProxyAvailability
  | QueueCancelRequest
  | QueueEnqueueRequest
  | QueuePauseRequest
  | QueuedPrompt
  | QuotaEntry
  | QuotaState
  | Readiness
  | ReadinessBasis
  | ReadinessCheck
  | ReadinessState
  | ReadinessState2
  | ReasoningCapabilities
  | RecoveryStatus
  | RegistryScope
  | RegistryState
  | RegistryStatus
  | RemoteDaemon
  | RemoteHost
  | RemoteHostAddRequest
  | RemoteHostListRequest
  | RemoteHostProbe
  | RemoteHostProbeRequest
  | RemoteHostRemoveRequest
  | RemoteHostRemoved
  | RemoteHostReply
  | RemoteHostStart
  | RemoteHostStartRequest
  | RemoteHosts
  | RemotePairRequest
  | RemotePairing
  | RemotePairingReply
  | RemotePlatform
  | RemoteRevokeRequest
  | RepositoryAck
  | RepositoryCloneOutcome
  | RepositoryCloneRequest
  | RepositoryCloned
  | RepositoryCoverage
  | RepositoryCoverageRequest
  | RepositoryPublishOutcome
  | RepositoryPublishPreview
  | RepositoryPublishPreviewRequest
  | RepositoryPublishRequest
  | RepositoryPublishStep
  | RepositoryPublishVerdict
  | RepositoryPublished
  | RepositoryRebindCatalog
  | RepositoryRebindEntry
  | RepositoryRebindListRequest
  | RepositoryRebindRequest
  | RepositoryRecord
  | RepositoryTransport
  | ResourceClaim
  | ResourceMode
  | ResourceRule
  | ResourcesClaimResolveRequest
  | ResourcesInspectRequest
  | ResourcesRegistryAcceptRequest
  | RestartPrepared
  | RetentionApply
  | RetentionApplyRequest
  | RetentionCandidate
  | RetentionItemResult
  | RetentionKind
  | RetentionObservedLog
  | RetentionOutcome
  | RetentionPolicy
  | RetentionPreview
  | RetentionPreviewRequest
  | RetentionReceiptStore
  | RetentionWithheld
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
  | RunChanges
  | RunComparison
  | RunRecord
  | RunSpec
  | RuntimePrepareRestartRequest
  | RuntimeStatus
  | RuntimeStatusRequest
  | Scope
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
  | Server
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
  | SettingValue
  | SetupState
  | SkillAdoptRequest
  | SkillDiscoverRequest
  | SkillDiscovery
  | SkillFile
  | SkillInspectRequest
  | SkillInspection
  | SkillInstallRequest
  | SkillInstalled
  | SkillList
  | SkillListRequest
  | SkillManifest
  | SkillObservedPlacement
  | SkillPlacementDecision
  | SkillProjection
  | SkillProvenance
  | SkillReference
  | SkillReferenceStatus
  | SkillRemoveRequest
  | SkillRemoved
  | SkillRoot
  | SkillRootStatus
  | SkillScope
  | SkillSourceKind
  | SkillSummary
  | StartOutcome
  | Support
  | TerminalCreateRequest
  | TerminalCreated
  | TerminalOperation
  | TerminalOperationRequest
  | TerminalOwner
  | TerminalRestartRequest
  | TerminalRetireRequest
  | TerminalStopRequest
  | TokenReference
  | TransportCoverage
  | UsageCostMeasure
  | UsageGroup
  | UsageGroupBy
  | UsageLimitWindow
  | UsageLimits
  | UsageLimitsRequest
  | UsageMeasure
  | UsageRecording
  | UsageScope
  | UsageSummary
  | UsageSummaryRequest
  | UsageTokens
  | UsageTurn
  | UsageTurns
  | UsageTurnsRequest
  | WaitState
  | WindowCloseRequest
  | WindowSaveRequest
  | WorkspaceAck
  | WorkspaceChoice
  | WorkspaceMode
  | WorkspaceOpenRequest
  | WorkspaceRebindCatalog
  | WorkspaceRebindEntry
  | WorkspaceRebindListRequest
  | WorkspaceRebindRequest
  | WorkspaceRecord
  | WorktreeAdoptRequest
  | WorktreeArchive
  | WorktreeArchiveEntry
  | WorktreeArchivedRequest
  | WorktreeCarryEntry
  | WorktreeCarryPreview
  | WorktreeCarryPreviewRequest
  | WorktreeCarryRequest
  | WorktreeCleanupCandidate
  | WorktreeCleanupPlan
  | WorktreeCleanupPlanRequest
  | WorktreeCleanupRequest
  | WorktreeConfigInput
  | WorktreeConfigureRequest
  | WorktreeCreateRequest
  | WorktreeFetchSource
  | WorktreeGetRequest
  | WorktreeItem
  | WorktreeOperation
  | WorktreeOperationReply
  | WorktreeOperationRequest
  | WorktreeOperationStatus
  | WorktreePhase
  | WorktreeRebindCandidate
  | WorktreeRebindCatalog
  | WorktreeRebindListRequest
  | WorktreeRebindRequest
  | WorktreeRefreshRequest
  | WorktreeRemoveRequest
  | WorktreeRepository
  | WorktreeRepositoryRequest
  | WorktreeResourcesApplyRequest
  | WorktreeSetupRequest
  | WorktreeState
  | WorktreeSwitchRequest
/**
 * The child's provider account, stated explicitly.
 */
export type AccountChoice =
  | {
      mode: 'inherit'
      [k: string]: unknown
    }
  | {
      account_id: string
      mode: 'managed'
      [k: string]: unknown
    }
  | {
      mode: 'ambient'
      [k: string]: unknown
    }
/**
 * What an activity records.
 */
export type ActivityKind =
  | 'turn_completed'
  | 'turn_failed'
  | 'turn_interrupted'
  | 'approval_requested'
  | 'question_requested'
  | 'operation_unknown'
/**
 * The read state of an activity. It only moves forward.
 */
export type ActivityState = 'unread' | 'read' | 'dismissed'
/**
 * The mark an `activity.mark` request applies.
 */
export type ActivityMark = 'read' | 'dismissed'
/**
 * How a custom executable receives the prompt.
 */
export type PromptInput = 'stdin' | 'argument'
/**
 * The protocol an adapter speaks on its standard streams.
 */
export type AdapterKind = 'acp' | 'executable'
/**
 * The result of one probe.
 */
export type ProbeOutcome =
  | {
      /**
       * Present for ACP adapters.
       */
      acp?: AcpHandshake | null
      /**
       * ADE capability names, in the vocabulary of provider descriptors.
       */
      capabilities: string[]
      status: 'ready'
      [k: string]: unknown
    }
  | {
      /**
       * A bounded, secret-free reason. Agent output is never included.
       */
      error: string
      status: 'failed'
      [k: string]: unknown
    }
/**
 * Whether an adapter may be trusted to have the probed capabilities now.
 */
export type AdapterReadiness = 'unprobed' | 'ready' | 'failed' | 'stale'
/**
 * What `worktree.remove` does with the removed tree's branch.
 */
export type BranchPolicy = 'keep' | 'merged'
/**
 * Whether the owner's debugger capture holds the tab.
 */
export type BrowserAttachmentState = 'attached' | 'detached'
/**
 * What a recording captures.
 */
export type BrowserCaptureKind = 'screenshots' | 'page_events' | 'console' | 'network'
/**
 * How a network request ended.
 */
export type BrowserNetworkOutcome = ('completed' | 'failed' | 'canceled' | 'blocked') | 'incomplete'
/**
 * Where a browser mutation stands.
 */
export type BrowserOperationState = 'accepted' | 'unknown' | 'completed'
/**
 * Where a recording stands.
 */
export type BrowserRecordingState = ('recording' | 'stopped') | 'interrupted'
/**
 * Who asks. An Agent caller names its own Conversation; the daemon records
 * the attribution and refuses an Agent that acts as another Conversation.
 */
export type Caller =
  | {
      kind: 'user'
      [k: string]: unknown
    }
  | {
      conversation_id: string
      kind: 'agent'
      [k: string]: unknown
    }
/**
 * How far ADE supports one provider capability.
 */
export type Support = 'supported' | 'native_only' | 'unsupported' | 'unknown'
/**
 * How the provider's capability record changed since a preset was saved.
 */
export type CapabilityChange = 'unchanged' | 'revised' | 'drifted' | 'downgraded'
/**
 * The shape a provider expects a model ID in.
 */
export type ModelFormat = 'native_id' | 'provider_qualified'
/**
 * Why a carry cannot run as asked.
 */
export type CarryBlocker =
  | 'unmerged'
  | 'submodule'
  | 'not_changed'
  | 'invalid_path'
  | 'no_changes'
  | 'too_many_changes'
  | 'unborn_head'
  | 'head_changed'
/**
 * How a path differs from `HEAD` in the source tree.
 */
export type CarryChange = ('added' | 'modified' | 'deleted' | 'type_changed' | 'untracked') | 'unmerged'
export type CheckState = 'passed' | 'failed' | 'skipped'
/**
 * The preset field a conflict concerns.
 */
export type PresetField = 'name' | 'provider' | 'model' | 'reasoning' | 'permission_mode'
/**
 * Which snapshot a change belongs to.
 */
export type CheckpointArea = 'worktree' | 'index'
/**
 * How restoring one path changes it.
 */
export type CheckpointChangeKind = ('added' | 'modified' | 'deleted') | 'type_changed'
/**
 * Why a checkpoint exists.
 */
export type CheckpointKind = 'manual' | 'safety'
/**
 * How a restore ended.
 */
export type CheckpointRestoreOutcome = 'unchanged' | 'restored' | 'partial'
/**
 * Whether a restore may run now.
 */
export type CheckpointRestoreVerdict = 'unchanged' | 'ready' | 'needs_confirmation' | 'blocked'
/**
 * How the child's workspace was chosen.
 */
export type WorkspaceMode = 'same' | 'new_worktree'
/**
 * The `orchestration.child.wait` reply.
 */
export type ChildWait = {
  child_conversation_id: string
  deadline_ms: number
  /**
   * Whether the wait has an answer; false only for `pending`.
   */
  done: boolean
  message_id: string
  /**
   * The `child_wait` type tag.
   */
  type: 'child_wait'
  [k: string]: unknown
} & ChildWait1
export type ChildWait1 =
  | {
      error: string | null
      outcome: Outcome
      state: 'settled'
      [k: string]: unknown
    }
  | {
      phase: PendingPhase
      state: 'pending'
      [k: string]: unknown
    }
  | {
      request_ids: string[]
      state: 'needs_input'
      [k: string]: unknown
    }
  | {
      reason: string
      state: 'blocked'
      [k: string]: unknown
    }
  | {
      phase: PendingPhase
      state: 'timed_out'
      [k: string]: unknown
    }
  | {
      reason: string
      state: 'unavailable'
      [k: string]: unknown
    }
/**
 * How a settled turn ended.
 */
export type Outcome = ('completed' | 'failed' | 'interrupted') | 'unknown'
/**
 * How far an unsettled turn has progressed.
 */
export type PendingPhase = ('starting' | 'running' | 'cancelling') | 'queued'
/**
 * Shared use admits other shared use; an exclusive lifecycle claim admits nothing.
 */
export type ClaimMode = 'shared' | 'exclusive'
/**
 * Operation phases, persisted before each step.
 */
export type ClaimPhase = 'reserved' | 'dispatched' | 'bound' | 'active'
export type ClaimPurpose = 'use' | 'create' | 'remove'
export type ClaimState = 'active' | 'quarantined'
/**
 * Why a tree cannot be cleaned up now.
 */
export type CleanupBlocker =
  | 'locked'
  | 'primary_checkout'
  | 'external'
  | 'authority_changed'
  | 'unavailable'
  | 'dirty'
  | 'status_unknown'
  | 'active_work'
  | 'claim_held'
  | 'claim_uncertain'
  | 'registry_unavailable'
  | 'lifecycle_running'
  | 'setup_incomplete'
  | 'teardown_incomplete'
  | 'not_listed'
/**
 * What a run committed between the group's start and its current HEAD.
 */
export type CommittedChanges =
  | {
      base_commit: string
      /**
       * Commits reachable from HEAD and not from the base.
       */
      commits: number
      files: CommittedFile[]
      state: 'known'
      /**
       * More files changed than the reply carries (2 000).
       */
      truncated: boolean
      [k: string]: unknown
    }
  | {
      reason: string
      state: 'unknown'
      [k: string]: unknown
    }
/**
 * How an ignored resource of the primary checkout reaches a tree.
 */
export type ResourceMode = 'copy' | 'link' | 'skip'
/**
 * Where a cost figure came from.
 */
export type CostBasis = 'agent_estimate'
/**
 * Where the child works, stated explicitly. Parallel children in the same
 * workspace share its files; ADE never merges their edits.
 */
export type WorkspaceChoice =
  | {
      mode: 'same'
      [k: string]: unknown
    }
  | {
      mode: 'new_worktree'
      repository_id: string
      workspace_id: string
      worktree_operation_id: string
      [k: string]: unknown
    }
/**
 * Where a notification is presented. Push is a later channel.
 */
export type DeliveryChannel = 'desktop'
/**
 * The outcome a claim holder reports.
 */
export type DeliveryOutcome = 'shown' | 'failed' | 'suppressed'
/**
 * Where one activity's delivery on one channel stands.
 */
export type DeliveryStatus = 'claimed' | 'shown' | 'failed' | 'suppressed'
/**
 * What a diagnostic counter counts.
 */
export type DiagnosticCounterKind = 'dropped' | 'coalesced'
/**
 * How far a reported number can be trusted.
 */
export type DiagnosticProvenance = 'exact' | 'approximate' | 'unavailable'
/**
 * The window a counter covers.
 */
export type DiagnosticWindow = 'daemon_boot' | 'live_incarnations'
/**
 * The unit a queue gauge counts.
 */
export type DiagnosticUnit = 'items' | 'bytes'
/**
 * Where an unknown execution was found.
 */
export type DiagnosticUnknownSource = 'receipt' | 'claim' | 'terminal' | 'conversation' | 'runtime'
/**
 * Why an entry does not reach a provider.
 */
export type Exclusion = ('disabled' | 'outside_scope' | 'provider_not_selected') | 'unsupported'
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
/**
 * A run's Git changes, or why they could not be read.
 */
export type RunChanges =
  | {
      /**
       * The branch name, or `(detached)`.
       */
      branch: string
      committed: CommittedChanges
      conflicts: number
      /**
       * The HEAD commit, or `(initial)` before the first commit.
       */
      head: string
      /**
       * The workspace's `review.status` revision at the time of the read.
       */
      revision: string
      state: 'available'
      /**
       * Staged, unstaged and untracked changes, as `review.status` reports them.
       */
      uncommitted: ReviewFile[]
      [k: string]: unknown
    }
  | {
      reason: string
      state: 'unavailable'
      [k: string]: unknown
    }
/**
 * What a wait observed. Only `pending` means the caller should ask again.
 */
export type WaitState =
  | {
      error: string | null
      outcome: Outcome
      state: 'settled'
      [k: string]: unknown
    }
  | {
      phase: PendingPhase
      state: 'pending'
      [k: string]: unknown
    }
  | {
      request_ids: string[]
      state: 'needs_input'
      [k: string]: unknown
    }
  | {
      reason: string
      state: 'blocked'
      [k: string]: unknown
    }
  | {
      phase: PendingPhase
      state: 'timed_out'
      [k: string]: unknown
    }
  | {
      reason: string
      state: 'unavailable'
      [k: string]: unknown
    }
/**
 * Where a group stands as a whole.
 */
export type GroupState = 'needs_attention' | 'running' | 'completed' | 'ended'
export type HistoryImportOutcome = 'imported' | 'appended' | 'unchanged'
/**
 * A provider whose native on-disk sessions ADE can import.
 */
export type HistoryImportProvider = 'claude' | 'codex'
/**
 * A lifecycle event a plugin can subscribe to. Every event fires after the
 * state change it describes has committed.
 */
export type HookEvent =
  'turn.settled' | 'workspace.created' | 'worktree.created' | 'worktree.removed' | 'service.state_changed'
/**
 * Where a delivery is in its lifecycle.
 */
export type HookDeliveryStatus =
  'awaiting_host' | 'queued' | 'dispatching' | 'delivered' | 'failed' | 'unknown' | 'abandoned'
export type RegistryState = 'ready' | 'blocked'
/**
 * How the server's code reached this host. ADE records it; it installs nothing.
 */
export type Installation =
  | {
      source: 'manual'
    }
  | {
      identifier: string
      registry: PackageRegistry
      source: 'package'
      version: string
    }
  | {
      source: 'remote'
    }
export type PackageRegistry = 'npm' | 'pypi' | 'oci'
export type ListenerFamily = 'ipv4' | 'ipv6'
export type PortObservation = 'verified_managed' | 'contested' | 'observed_other' | 'unobserved'
export type ListenerOwnership = 'managed_service' | 'unknown'
/**
 * Which providers an entry applies to.
 */
export type ProviderSelection =
  | {
      kind: 'all'
    }
  | {
      kind: 'only'
      provider_ids: string[]
    }
/**
 * Which workspaces an entry applies to.
 */
export type Scope =
  | {
      kind: 'profile'
    }
  | {
      kind: 'workspaces'
      workspace_ids: string[]
    }
  | {
      kind: 'repositories'
      repository_ids: string[]
    }
/**
 * A value set in a server's environment or HTTP headers. Secrets are never
 * stored: they are read at launch from the named environment variable.
 */
export type SettingValue =
  | {
      literal: string
    }
  | {
      env: string
    }
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
export type PairingState = 'active' | 'revoked'
/**
 * What the daemon knows about an unresolved send.
 */
export type SendOutcome = 'prepared' | 'accepted' | 'rejected' | 'held' | 'conflict'
/**
 * A registration kind in the activation registry.
 */
export type PluginRegistrationKind = 'command' | 'panel'
/**
 * What a command handler did.
 */
export type PluginCommandOutcome =
  | {
      status: 'completed'
      value: unknown
      [k: string]: unknown
    }
  | {
      message: string
      status: 'failed'
      [k: string]: unknown
    }
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
 * The backend host's state.
 */
export type PluginHostState = 'running' | 'no_backend' | 'inactive' | 'idle' | 'backoff' | 'errored' | 'stopped'
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
export type QuotaState = 'reported' | 'not_reported' | 'unavailable'
/**
 * The overall readiness verdict.
 */
export type ReadinessState2 =
  | ('missing_executable' | 'needs_authentication' | 'account_disabled')
  | 'ready'
  | 'installed_unchecked'
  | 'incompatible'
  | 'needs_verification'
  | 'identity_changed'
  | 'unavailable'
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
export type RegistryScope = 'host' | 'profile'
/**
 * Where the pairing token lives. The daemon stores the reference only.
 */
export type TokenReference =
  | {
      env: string
    }
  | {
      keychain: {
        account: string
        service: string
      }
    }
export type StartOutcome = 'running' | 'failed' | 'unknown'
/**
 * How a clone ended.
 */
export type RepositoryCloneOutcome = 'registered' | 'cloned_not_registered'
/**
 * A way of naming a Git remote.
 */
export type RepositoryTransport =
  ('https' | 'ssh' | 'file') | 'scp_like' | 'http' | 'git_daemon' | 'remote_helper' | 'local_path'
/**
 * How a publish ended.
 */
export type RepositoryPublishOutcome = 'published' | 'not_pushed'
/**
 * One step `repository.publish` takes, in order.
 */
export type RepositoryPublishStep = 'initialize' | 'commit' | 'add_remote' | 'push' | 'verify'
/**
 * Whether publish may run.
 */
export type RepositoryPublishVerdict = ('ready' | 'blocked') | 'needs_initial_commit'
/**
 * What a retention candidate is.
 */
export type RetentionKind = 'attachment' | 'skill_blob' | 'service_log' | 'diagnostic_log'
/**
 * What happened to one previewed item.
 */
export type RetentionOutcome = 'removed' | 'failed'
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
 * Whether a provider root belongs to the user or to one workspace.
 */
export type SkillScope = 'global' | 'workspace'
/**
 * What discovery found at one entry of a provider skill root.
 */
export type SkillReferenceStatus = 'valid' | 'invalid' | 'unreadable'
/**
 * What a provider skill root looked like during discovery.
 */
export type SkillRootStatus = 'present' | 'missing' | 'not_directory' | 'unreadable'
/**
 * What a placement of the bundle at that path would need.
 */
export type SkillPlacementDecision = 'create' | 'up_to_date' | 'replace' | 'requires_adoption' | 'refuse'
/**
 * The state observed at the path a provider would read a bundle from.
 */
export type SkillObservedPlacement =
  | ('absent' | 'external_different' | 'unreadable')
  | 'external_identical'
  | 'external_other'
  | 'adopted_unchanged'
  | 'adopted_drifted'
/**
 * How a bundle entered the catalog.
 */
export type SkillSourceKind = 'local_directory' | 'adopted'
/**
 * Which agents a turn's figures cover.
 */
export type UsageScope = 'main_agent' | 'all_agents'
/**
 * The dimension `usage.summary` groups turns by.
 */
export type UsageGroupBy = ('conversation' | 'workspace' | 'provider') | 'account' | 'day'
/**
 * Where a tree stands in ADE's setup and teardown lifecycle. Only `ready`
 * admits an Agent.
 */
export type WorktreePhase =
  | 'ready'
  | 'creating'
  | 'setting_up'
  | 'setup_failed'
  | 'setup_interrupted'
  | 'tearing_down'
  | 'teardown_failed'
  | 'teardown_interrupted'
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
 * What an ACP agent declared in its `initialize` response.
 */
export interface AcpHandshake {
  agent_name?: string | null
  agent_version?: string | null
  /**
   * IDs of the authentication methods the agent offers. ADE runs none of
   * them; sign in with the agent's own CLI.
   */
  auth_methods: string[]
  list_sessions: boolean
  load_session: boolean
  mcp_http: boolean
  mcp_sse: boolean
  prompt_audio: boolean
  prompt_embedded_context: boolean
  prompt_image: boolean
  protocol_version: number
  resume_session: boolean
  [k: string]: unknown
}
/**
 * One durable activity record.
 */
export interface Activity {
  created_at: number
  /**
   * A bounded detail such as the recorded error or request method.
   */
  detail: string | null
  dismissed_at: number | null
  /**
   * Stable identity; notification deliveries are keyed by it.
   */
  id: string
  kind: ActivityKind
  read_at: number | null
  /**
   * Monotonic position in the profile's feed; the list cursor.
   */
  sequence: number
  state: ActivityState
  target: ActivityTarget
  /**
   * The Conversation title when the activity was recorded.
   */
  title: string
  [k: string]: unknown
}
/**
 * The resource an activity points at. Its fields stay readable after the
 * resource is removed; navigation must check that it still exists.
 */
export interface ActivityTarget {
  conversation_id: string
  /**
   * The pending request, for approval and question activity.
   */
  request_id: string | null
  /**
   * The turn, when the daemon knew it.
   */
  turn_id: string | null
  workspace_id: string
  [k: string]: unknown
}
/**
 * A `session.subscribe` frame: an activity was recorded or changed state.
 */
export interface ActivityChanged {
  activity: Activity
  boot_id: string
  revision: number
  /**
   * The `activity_changed` type tag.
   */
  type: 'activity_changed'
  [k: string]: unknown
}
/**
 * The `activity.list` reply.
 */
export interface ActivityList {
  activities: Activity[]
  /**
   * The largest sequence the profile has recorded; 0 when none.
   */
  latest_sequence: number
  /**
   * Pass as `after` or `before` (matching the request) for the next page;
   * null when this page is the last.
   */
  next_cursor: number | null
  /**
   * The `activity_list` type tag.
   */
  type: 'activity_list'
  [k: string]: unknown
}
/**
 * `activity.list`: newest first, or oldest first after a cursor.
 */
export interface ActivityListRequest {
  /**
   * Return activity with a larger sequence, oldest first, to catch up.
   */
  after?: number | null
  /**
   * Return activity with a smaller sequence, newest first, to page back.
   */
  before?: number | null
  /**
   * Include dismissed activity; excluded by default.
   */
  include_dismissed?: boolean | null
  /**
   * 1 to 200; defaults to 50.
   */
  limit?: number | null
  op: 'activity.list'
  /**
   * Only unread activity.
   */
  unread_only?: boolean | null
}
/**
 * `activity.mark`: mark 1 to 100 activities read or dismissed.
 */
export interface ActivityMarkRequest {
  activity_ids: string[]
  mark: ActivityMark
  op: 'activity.mark'
}
/**
 * The `activity.mark` reply: every named activity in its current state.
 */
export interface ActivityMarked {
  activities: Activity[]
  /**
   * The `activity_marked` type tag.
   */
  type: 'activity_marked'
  [k: string]: unknown
}
/**
 * One adapter as the profile stores it.
 */
export interface AdapterDefinition {
  args?: string[]
  /**
   * Absolute path of the executable. ADE does not search `PATH`.
   */
  command: string
  /**
   * Extra environment on top of the daemon's. Names that look like
   * credentials are refused: sign in with the agent's own login instead.
   */
  env?: {
    [k: string]: string
  }
  /**
   * Required for `executable`, refused for `acp`.
   */
  executable?: ExecutableSettings | null
  /**
   * Lowercase letters, digits and `-`, starting with a letter; at most 40
   * characters. Conversations name it as `adapter:<id>`.
   */
  id: string
  kind: AdapterKind
  /**
   * Display name, 1 to 80 characters.
   */
  name: string
}
/**
 * Settings only a custom executable has.
 */
export interface ExecutableSettings {
  prompt_input: PromptInput
  /**
   * A turn still running after this many seconds is stopped and reported
   * failed. From 1 to 3600.
   */
  timeout_seconds: number
}
export interface AdapterList {
  adapters: AdapterRecord[]
  /**
   * The `adapters` type tag.
   */
  type: 'adapters'
  [k: string]: unknown
}
/**
 * One adapter with its revision and probe.
 */
export interface AdapterRecord {
  created_at: number
  definition: AdapterDefinition
  probe?: AdapterProbe | null
  /**
   * `adapter:<id>`, the provider ID conversations use.
   */
  provider_id: string
  readiness: AdapterReadiness
  /**
   * Starts at 1 and grows each time the stored definition changes.
   */
  revision: number
  updated_at: number
  [k: string]: unknown
}
/**
 * The stored probe of one adapter.
 */
export interface AdapterProbe {
  /**
   * Absent when the executable could not be inspected.
   */
  executable?: ExecutableIdentity | null
  outcome: ProbeOutcome
  probed_at: number
  /**
   * The definition revision that was probed.
   */
  revision: number
  [k: string]: unknown
}
/**
 * File identity of the executable a probe checked. Device and inode are
 * decimal strings because they can exceed a JSON-safe integer.
 */
export interface ExecutableIdentity {
  device: string
  inode: string
  /**
   * Modification time in milliseconds since the Unix epoch.
   */
  modified_ms: number
  size: number
  [k: string]: unknown
}
/**
 * `adapter.list`: every adapter this profile defines, by ID.
 */
export interface AdapterListRequest {
  op: 'adapter.list'
}
/**
 * `adapter.probe`: check the executable and record its capabilities.
 */
export interface AdapterProbeRequest {
  /**
   * When present, the probe is refused unless the stored revision equals it.
   */
  expected_revision?: number | null
  id: string
  op: 'adapter.probe'
}
/**
 * A probe that ran. A failed probe is still a completed operation; its
 * outcome says why the adapter is not ready.
 */
export interface AdapterProbed {
  adapter: AdapterRecord
  /**
   * The `adapter_probed` type tag.
   */
  type: 'adapter_probed'
  [k: string]: unknown
}
export interface AdapterPut {
  adapter: AdapterRecord
  /**
   * False when the stored definition was already identical.
   */
  changed: boolean
  /**
   * The `adapter_put` type tag.
   */
  type: 'adapter_put'
  [k: string]: unknown
}
/**
 * `adapter.put`: create or replace one adapter definition.
 */
export interface AdapterPutRequest {
  definition: AdapterDefinition
  /**
   * When present, the put is refused unless the stored revision equals it;
   * 0 means the adapter must not exist yet.
   */
  expected_revision?: number | null
  op: 'adapter.put'
}
/**
 * `adapter.remove`: delete one adapter definition and its probe.
 */
export interface AdapterRemoveRequest {
  id: string
  op: 'adapter.remove'
}
export interface AdapterRemoved {
  id: string
  /**
   * False when no adapter had this ID.
   */
  removed: boolean
  /**
   * The `adapter_removed` type tag.
   */
  type: 'adapter_removed'
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
 * Whether the remote ADE backend can serve this daemon.
 */
export interface BackendCompatibility {
  application_protocol: string | null
  compatible: boolean
  /**
   * The `ade-control` the probe found; null when none was found.
   */
  control_path: string | null
  /**
   * Each version or platform mismatch, stated exactly.
   */
  incompatible: string[]
  /**
   * Each artifact or capability the host lacks, stated exactly.
   */
  missing: string[]
  runtime_protocol: string | null
  [k: string]: unknown
}
/**
 * The debugger capture of one tab.
 */
export interface BrowserAttachment {
  /**
   * Wall-clock milliseconds when capture last attached.
   */
  attached_at_ms: number | null
  /**
   * Who holds capture: `caller` and one entry per active recording ID.
   */
  holders: string[]
  /**
   * Why capture is detached: `not_attached`, `requested`, `target_closed`,
   * `target_replaced`, or the debugger's own detach reason.
   */
  reason: string | null
  state: BrowserAttachmentState
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
 * One console message, exception or browser log entry, redacted and cut to
 * 1024 characters.
 */
export interface BrowserConsoleEntry {
  at_ms: number
  /**
   * The console method or log level, such as `log`, `warning` or `error`.
   */
  level: string
  line: number | null
  /**
   * Shared with network entries; increases for the owner's lifetime.
   */
  seq: number
  /**
   * `console`, `exception` or `browser`.
   */
  source: string
  text: string
  /**
   * The redacted script or page URL, when the page reported one.
   */
  url: string | null
  [k: string]: unknown
}
/**
 * The `browser.diagnostics.read` reply.
 */
export interface BrowserDiagnostics {
  attachment: BrowserAttachment
  console: BrowserConsoleEntry[]
  dropped: BrowserDiagnosticsDropped
  /**
   * What capture never includes.
   */
  excluded: string[]
  /**
   * Requests seen but not yet finished; they appear once they end.
   */
  in_flight: number
  /**
   * True when more entries follow this page.
   */
  more: boolean
  network: BrowserNetworkEntry[]
  /**
   * Pass as `after` to read the next page.
   */
  next: number
  owner_id: string
  profile_id: string
  /**
   * The redaction policy, such as `ade-browser-redaction-v1`.
   */
  redaction: string
  tab_id: string
  /**
   * The `browser_diagnostics` type tag.
   */
  type: 'browser_diagnostics'
  [k: string]: unknown
}
/**
 * Entries the owner discarded to stay within its bounds.
 */
export interface BrowserDiagnosticsDropped {
  console: number
  network: number
  [k: string]: unknown
}
/**
 * One network request summary. It never carries headers, cookies or bodies.
 */
export interface BrowserNetworkEntry {
  at_ms: number
  duration_ms: number | null
  encoded_bytes: number | null
  error: string | null
  method: string
  mime_type: string | null
  outcome: BrowserNetworkOutcome
  resource_type: string | null
  seq: number
  status: number | null
  /**
   * Without user information or fragment, credential-like query values
   * replaced, cut to 1024 characters.
   */
  url: string
  [k: string]: unknown
}
/**
 * `browser.diagnostics.attach`: start capturing console and network
 * summaries for one exact tab. Attaching an attached tab changes nothing.
 * A tab without a live page, or whose debugger another client holds, fails.
 */
export interface BrowserDiagnosticsAttachRequest {
  op: 'browser.diagnostics.attach'
  owner_id: string
  profile_id: string
  tab_id: string
}
/**
 * `browser.diagnostics.detach`: stop the caller's capture on one exact tab.
 * The captured entries stay readable until the tab closes. Detaching a
 * detached tab changes nothing; an active recording keeps its own capture.
 */
export interface BrowserDiagnosticsDetachRequest {
  op: 'browser.diagnostics.detach'
  owner_id: string
  profile_id: string
  tab_id: string
}
/**
 * `browser.diagnostics.read`: one page of captured entries for one exact tab.
 */
export interface BrowserDiagnosticsReadRequest {
  /**
   * Return entries whose `seq` is greater than this; the previous page's
   * `next`. From the oldest retained entry when absent.
   */
  after?: number
  /**
   * 1 to 200 entries across both kinds; 100 when absent.
   */
  limit?: number
  op: 'browser.diagnostics.read'
  owner_id: string
  profile_id: string
  tab_id: string
}
/**
 * The `browser.diagnostics.attach` and `browser.diagnostics.detach` reply.
 */
export interface BrowserDiagnosticsState {
  attachment: BrowserAttachment
  owner_id: string
  profile_id: string
  tab_id: string
  /**
   * The `browser_diagnostics_state` type tag.
   */
  type: 'browser_diagnostics_state'
  [k: string]: unknown
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
 * The `browser.recording.*` reply: the recording's manifest.
 */
export interface BrowserRecording {
  /**
   * The local artifact directory. Nothing is published.
   */
  artifact_dir: string
  bytes: number
  capture: BrowserCaptureKind[]
  console_entries: number
  /**
   * What this recording does not cover, in plain words.
   */
  coverage_gaps: string[]
  /**
   * `ade-browser-recording-v1`.
   */
  format: string
  frames: number
  /**
   * Screenshot ticks that produced no image, such as a hidden page.
   */
  frames_unavailable: number
  interval_ms: number
  max_duration_ms: number
  network_entries: number
  owner_id: string
  page_events: number
  profile_id: string
  recording_id: string
  started_at_ms: number
  state: BrowserRecordingState
  /**
   * `requested`, `duration_reached`, `frame_limit`, `size_limit`,
   * `target_closed`, `write_failed` or `owner_stopped`.
   */
  stop_reason: string | null
  stopped_at_ms: number | null
  tab_id: string
  /**
   * The `browser_recording` type tag.
   */
  type: 'browser_recording'
  [k: string]: unknown
}
/**
 * `browser.recording.get`: read a recording's manifest.
 */
export interface BrowserRecordingGetRequest {
  op: 'browser.recording.get'
  owner_id: string
  profile_id: string
  recording_id: string
}
/**
 * `browser.recording.start`: record one exact tab into a local artifact.
 * `recording_id` is caller-owned. Repeating a start with the same ID and
 * the same target and scope returns that recording in its current state and
 * never starts it again; the same ID with another target or scope conflicts.
 */
export interface BrowserRecordingStartRequest {
  /**
   * One or more distinct kinds.
   */
  capture: BrowserCaptureKind[]
  /**
   * Milliseconds between screenshots, 250 to 60000; 2000 when absent.
   */
  interval_ms?: number
  /**
   * The recording window, 1000 to 1800000 milliseconds; 300000 when absent.
   * The recording stops by itself when it ends.
   */
  max_duration_ms?: number
  op: 'browser.recording.start'
  owner_id: string
  profile_id: string
  /**
   * 1 to 128 ASCII letters, digits, `-` or `_`.
   */
  recording_id: string
  tab_id: string
}
/**
 * `browser.recording.stop`: end a recording and seal its manifest. Stopping a
 * stopped or interrupted recording returns it unchanged.
 */
export interface BrowserRecordingStopRequest {
  op: 'browser.recording.stop'
  owner_id: string
  profile_id: string
  recording_id: string
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
 * One capability and why it has that support.
 */
export interface Capability {
  /**
   * The native mechanism, or what is missing.
   */
  note: string
  support: Support
  [k: string]: unknown
}
/**
 * What an adapter declares about its provider.
 */
export interface CapabilityRecord {
  /**
   * The provider version or document the record was checked against.
   */
  checked_against: string
  conversation: ConversationCapabilities
  /**
   * SHA-256 of this record with an empty fingerprint. A change without a
   * new revision means the declaration drifted.
   */
  fingerprint: string
  grants: GrantCapabilities
  managed_accounts: Capability11
  models: ModelCapabilities
  name: string
  permission_modes: PermissionModeCapability[]
  provider: string
  quota: Capability14
  reasoning: ReasoningCapabilities
  /**
   * Raised by the adapter whenever the declared capabilities change.
   */
  revision: number
  [k: string]: unknown
}
export interface ConversationCapabilities {
  account_switch: Capability1
  compaction: Capability2
  fork: Capability3
  import: Capability4
  resume: Capability5
  rewind: Capability6
  steering: Capability7
  [k: string]: unknown
}
/**
 * Changing account inside one conversation.
 */
export interface Capability1 {
  /**
   * The native mechanism, or what is missing.
   */
  note: string
  support: Support
  [k: string]: unknown
}
/**
 * Summarizing earlier context on request.
 */
export interface Capability2 {
  /**
   * The native mechanism, or what is missing.
   */
  note: string
  support: Support
  [k: string]: unknown
}
/**
 * Branching a native session into a new one.
 */
export interface Capability3 {
  /**
   * The native mechanism, or what is missing.
   */
  note: string
  support: Support
  [k: string]: unknown
}
/**
 * Importing native history that ADE did not create.
 */
export interface Capability4 {
  /**
   * The native mechanism, or what is missing.
   */
  note: string
  support: Support
  [k: string]: unknown
}
/**
 * Reopening a native session after a restart.
 */
export interface Capability5 {
  /**
   * The native mechanism, or what is missing.
   */
  note: string
  support: Support
  [k: string]: unknown
}
/**
 * Returning the conversation, and possibly files, to an earlier point.
 */
export interface Capability6 {
  /**
   * The native mechanism, or what is missing.
   */
  note: string
  support: Support
  [k: string]: unknown
}
/**
 * Adding input to a running turn.
 */
export interface Capability7 {
  /**
   * The native mechanism, or what is missing.
   */
  note: string
  support: Support
  [k: string]: unknown
}
/**
 * How long an approval can last. ADE never widens a grant while mapping it.
 */
export interface GrantCapabilities {
  once: Capability8
  persistent: Capability9
  session: Capability10
  [k: string]: unknown
}
/**
 * Approving one request only.
 */
export interface Capability8 {
  /**
   * The native mechanism, or what is missing.
   */
  note: string
  support: Support
  [k: string]: unknown
}
/**
 * Approving similar requests in saved native settings.
 */
export interface Capability9 {
  /**
   * The native mechanism, or what is missing.
   */
  note: string
  support: Support
  [k: string]: unknown
}
/**
 * Approving similar requests for the rest of the session.
 */
export interface Capability10 {
  /**
   * The native mechanism, or what is missing.
   */
  note: string
  support: Support
  [k: string]: unknown
}
/**
 * Whether ADE can manage several accounts for this provider.
 */
export interface Capability11 {
  /**
   * The native mechanism, or what is missing.
   */
  note: string
  support: Support
  [k: string]: unknown
}
export interface ModelCapabilities {
  /**
   * Aliases the provider documents. The provider resolves them; ADE does
   * not know which model an alias means today.
   */
  aliases: string[]
  discovery: Capability12
  format: ModelFormat
  selection: Capability13
  [k: string]: unknown
}
/**
 * Listing the models an account can use.
 */
export interface Capability12 {
  /**
   * The native mechanism, or what is missing.
   */
  note: string
  support: Support
  [k: string]: unknown
}
/**
 * Choosing a model when a conversation starts.
 */
export interface Capability13 {
  /**
   * The native mechanism, or what is missing.
   */
  note: string
  support: Support
  [k: string]: unknown
}
/**
 * One permission mode and its meaning.
 */
export interface PermissionModeCapability {
  description: string
  /**
   * The value a conversation's `permission_mode` takes.
   */
  id: string
  support: Support
  [k: string]: unknown
}
/**
 * Whether the provider reports quota or rate-limit windows.
 */
export interface Capability14 {
  /**
   * The native mechanism, or what is missing.
   */
  note: string
  support: Support
  [k: string]: unknown
}
export interface ReasoningCapabilities {
  /**
   * The provider's own level names, weakest first.
   */
  levels: string[]
  selection: Capability15
  /**
   * True when the provider offers a different subset per model.
   */
  varies_by_model: boolean
  [k: string]: unknown
}
/**
 * Choosing a reasoning level when a conversation starts.
 */
export interface Capability15 {
  /**
   * The native mechanism, or what is missing.
   */
  note: string
  support: Support
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
 * A preset checked against the current capability record.
 */
export interface CheckedPreset {
  capability_change: CapabilityChange
  /**
   * Empty when the preset can be applied as saved.
   */
  conflicts: PresetConflict[]
  preset: Preset
  [k: string]: unknown
}
/**
 * A setting the provider's current capabilities do not allow.
 */
export interface PresetConflict {
  field: PresetField
  message: string
  [k: string]: unknown
}
/**
 * A stored preset.
 */
export interface Preset {
  capability_fingerprint: string
  /**
   * The capability record the settings were validated against when saved.
   */
  capability_revision: number
  name: string
  /**
   * Starts at 1 and rises with each change.
   */
  revision: number
  settings: PresetSettings
  updated_at: number
  [k: string]: unknown
}
/**
 * A preset's launch settings.
 */
export interface PresetSettings {
  model: string | null
  permission_mode: string
  provider: string
  reasoning: string | null
  [k: string]: unknown
}
/**
 * What a checkpoint holds and what it leaves out.
 */
export interface CheckpointCoverage {
  /**
   * Files in the working-tree snapshot, including symbolic links. Binary
   * files are stored byte for byte.
   */
  files: number
  /**
   * Ignored entries left out. An ignored directory counts once.
   */
  ignored_entries: number
  /**
   * The categories this checkpoint never covers.
   */
  not_covered: string[]
  /**
   * Submodules and nested repositories, recorded by commit only; their
   * contents are not captured.
   */
  submodules: number
  symlinks: number
  /**
   * Untracked, non-ignored files included in the snapshot.
   */
  untracked_files: number
  [k: string]: unknown
}
/**
 * `checkpoint.create`: record the workspace's working tree and index.
 */
export interface CheckpointCreateRequest {
  /**
   * A short note shown in lists; at most 200 characters on one line.
   */
  label?: string | null
  op: 'checkpoint.create'
  operation_id: string
  workspace_id: string
}
export interface CheckpointCreated {
  checkpoint: CheckpointSummary
  /**
   * The `checkpoint_created` type tag.
   */
  type: 'checkpoint_created'
  [k: string]: unknown
}
/**
 * One checkpoint as Git records it.
 */
export interface CheckpointSummary {
  /**
   * The branch HEAD named; absent when detached or unborn.
   */
  branch: string | null
  checkpoint_id: string
  /**
   * The checkpoint commit.
   */
  commit: string
  coverage: CheckpointCoverage
  created_at: number
  /**
   * HEAD when the checkpoint was made; absent on an unborn branch.
   */
  head: string | null
  /**
   * The tree of the index snapshot.
   */
  index_tree: string
  kind: CheckpointKind
  label?: string | null
  /**
   * The private ref that keeps the checkpoint.
   */
  ref_name: string
  workspace_id: string
  /**
   * The tree of the working-tree snapshot.
   */
  worktree_tree: string
  [k: string]: unknown
}
/**
 * `checkpoint.delete`: remove a checkpoint's ref. Its objects become
 * unreachable and Git's own garbage collection reclaims them later.
 */
export interface CheckpointDeleteRequest {
  checkpoint_id: string
  /**
   * The checkpoint's `commit`; delete refuses when the ref points elsewhere.
   */
  expected_commit: string
  op: 'checkpoint.delete'
  operation_id: string
  workspace_id: string
}
export interface CheckpointDeleted {
  checkpoint_id: string
  ref_name: string
  /**
   * The `checkpoint_deleted` type tag.
   */
  type: 'checkpoint_deleted'
  [k: string]: unknown
}
export interface CheckpointList {
  /**
   * Newest first.
   */
  checkpoints: CheckpointSummary[]
  /**
   * Refs under the workspace's namespace that do not parse as checkpoints.
   */
  problems: CheckpointProblem[]
  /**
   * The `checkpoints` type tag.
   */
  type: 'checkpoints'
  workspace_id: string
  [k: string]: unknown
}
/**
 * A checkpoint ref that ADE cannot read as a checkpoint.
 */
export interface CheckpointProblem {
  problem: string
  ref_name: string
  [k: string]: unknown
}
/**
 * `checkpoint.list`: the workspace's checkpoints, newest first.
 */
export interface CheckpointListRequest {
  op: 'checkpoint.list'
  workspace_id: string
}
/**
 * One path a restore changes, relative to the workspace root.
 */
export interface CheckpointPathChange {
  area: CheckpointArea
  kind: CheckpointChangeKind
  path: string
  [k: string]: unknown
}
export interface CheckpointRestorePreview {
  blocked_reasons: string[]
  changes: CheckpointPathChange[]
  checkpoint: CheckpointSummary
  /**
   * HEAD moved since the checkpoint. Restore keeps the current HEAD.
   */
  head_changed: boolean
  /**
   * Paths the checkpoint would write over ignored or excluded files on disk.
   * Restore refuses while any exist, because no checkpoint covers them.
   */
  ignored_overwritten: string[]
  /**
   * Pass as `expected_state` to `checkpoint.restore`.
   */
  state_token: string
  /**
   * The `checkpoint_restore_preview` type tag.
   */
  type: 'checkpoint_restore_preview'
  /**
   * Changed paths whose current content differs from HEAD. The safety
   * checkpoint keeps them.
   */
  uncommitted_overwritten: string[]
  verdict: CheckpointRestoreVerdict
  [k: string]: unknown
}
/**
 * `checkpoint.restore.preview`: what a restore would change, and whether it may run.
 */
export interface CheckpointRestorePreviewRequest {
  checkpoint_id: string
  op: 'checkpoint.restore.preview'
  workspace_id: string
}
/**
 * `checkpoint.restore`: make the working tree and index match a checkpoint.
 */
export interface CheckpointRestoreRequest {
  checkpoint_id: string
  /**
   * Required when the preview listed `uncommitted_overwritten` paths.
   */
  confirm_overwrite?: boolean
  /**
   * The `state_token` from `checkpoint.restore.preview`. Restore refuses when
   * the workspace or the checkpoint changed since that preview.
   */
  expected_state: string
  op: 'checkpoint.restore'
  operation_id: string
  workspace_id: string
}
export interface CheckpointRestored {
  changes: CheckpointPathChange[]
  checkpoint_id: string
  outcome: CheckpointRestoreOutcome
  problems: string[]
  /**
   * The state saved before any write; absent when nothing changed.
   */
  safety_checkpoint: CheckpointSummary | null
  /**
   * The `checkpoint_restored` type tag.
   */
  type: 'checkpoint_restored'
  /**
   * Whether a fresh snapshot after the restore matched the checkpoint.
   */
  verified: boolean
  [k: string]: unknown
}
/**
 * The `orchestration.delegate` reply: the child is admitted and its task is
 * queued. It says nothing about completion; wait for that.
 */
export interface ChildDelegated {
  child: ChildRecord
  /**
   * The `child_delegated` type tag.
   */
  type: 'child_delegated'
  [k: string]: unknown
}
/**
 * A durable parent and child link with the child's current Conversation state.
 */
export interface ChildRecord {
  account_id: string | null
  /**
   * `user`, or `agent:` followed by the delegating Conversation ID.
   */
  attribution: string
  child_conversation_id: string
  created_at: number
  /**
   * 1 for a child of a top-level Conversation.
   */
  depth: number
  error: string | null
  /**
   * The `orchestration.delegate` operation that created the child.
   */
  operation_id: string
  parent_conversation_id: string
  provider: string
  /**
   * The child Conversation's status, or `unavailable` when it is gone.
   */
  status: string
  /**
   * The queued prompt that carries the task.
   */
  task_message_id: string
  workspace_id: string
  workspace_mode: WorkspaceMode
  worktree_operation_id: string | null
  [k: string]: unknown
}
/**
 * `orchestration.child.get`: one child and its parent link.
 */
export interface ChildGetRequest {
  child_conversation_id: string
  op: 'orchestration.child.get'
}
/**
 * The `orchestration.children` reply.
 */
export interface ChildList {
  children: ChildRecord[]
  parent_conversation_id: string
  /**
   * The `child_list` type tag.
   */
  type: 'child_list'
  [k: string]: unknown
}
/**
 * The `orchestration.child.send` reply: the message is durably queued.
 */
export interface ChildMessageQueued {
  attribution: string
  child_conversation_id: string
  message_id: string
  /**
   * The `child_message_queued` type tag.
   */
  type: 'child_message_queued'
  [k: string]: unknown
}
/**
 * The `orchestration.child.get` reply.
 */
export interface ChildReply {
  child: ChildRecord
  /**
   * The `child` type tag.
   */
  type: 'child'
  [k: string]: unknown
}
/**
 * `orchestration.child.send`: queue a message for a delegated child.
 */
export interface ChildSendRequest {
  caller: Caller
  child_conversation_id: string
  op: 'orchestration.child.send'
  /**
   * Caller-owned operation ID; a retry with the same payload returns the same message.
   */
  operation_id: string
  /**
   * At most 64 KiB.
   */
  text: string
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
 * `orchestration.child.wait`: read whether a child's turn has settled.
 *
 * The daemon never holds the request open. Send `timeout_ms` on the first
 * call and the returned `deadline_ms` on each repeat.
 */
export interface ChildWaitRequest {
  child_conversation_id: string
  /**
   * An absolute deadline in Unix milliseconds from an earlier reply.
   */
  deadline_ms?: number
  /**
   * The delegated task or child message to wait for; the newest one when absent.
   */
  message_id?: string
  op: 'orchestration.child.wait'
  /**
   * From 0 to 86 400 000; 0 when absent. Ignored when `deadline_ms` is present.
   */
  timeout_ms?: number
}
/**
 * `orchestration.children`: the children a Conversation delegated, oldest first.
 */
export interface ChildrenRequest {
  op: 'orchestration.children'
  parent_conversation_id: string
}
/**
 * A file a run committed since the group started.
 */
export interface CommittedFile {
  /**
   * The `git diff --name-status` letter, such as A, M, D or T.
   */
  code: string
  /**
   * The literal repository-relative path.
   */
  path: string
  [k: string]: unknown
}
/**
 * A repository's stored lifecycle configuration. Fields added after the
 * first release are omitted from the wire while they hold their defaults.
 */
export interface Config {
  /**
   * Prefix for branches that `worktree.create` names, such as `ade/`.
   */
  branch_prefix?: string | null
  /**
   * Start point for `worktree.create` when the request names none; `HEAD`
   * when absent.
   */
  default_base?: string | null
  /**
   * Parent directory for new trees; the repository's parent when absent.
   */
  directory: string | null
  /**
   * Ignored local resources, such as `.env` files or `node_modules`, and
   * how each reaches a tree ADE creates. Nothing ignored is copied or
   * linked unless a rule names it.
   */
  resources?: ResourceRule[]
  /**
   * Hooks run in order inside a new tree after Git creates it. The tree is
   * ready for an Agent only after every hook exits 0.
   */
  setup?: Hook[]
  /**
   * Hooks run in order inside a tree before ADE removes it. A failed hook
   * keeps the tree.
   */
  teardown?: Hook[]
  /**
   * Git command timeout in seconds.
   */
  timeout_seconds: number
}
/**
 * One ignored-resource rule. `path` is a literal path relative to the
 * repository root: no globs, no `..`, not inside `.git`.
 */
export interface ResourceRule {
  mode: ResourceMode
  path: string
}
/**
 * One setup or teardown hook. `command` is an argument vector run without a
 * shell; write `["sh", "-c", "…"]` to use one.
 */
export interface Hook {
  command: string[]
  /**
   * A short label shown in operation results.
   */
  name: string
  /**
   * The hook's time limit; the daemon accepts 1 to 3600 and uses 300 when absent.
   */
  timeout_seconds?: number
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
 * `orchestration.delegate`: start a child Conversation for a task.
 */
export interface DelegateRequest {
  account: AccountChoice
  caller: Caller
  op: 'orchestration.delegate'
  /**
   * Caller-owned operation ID; a retry with the same payload returns the same child.
   */
  operation_id: string
  parent_conversation_id: string
  /**
   * The child's provider ID, stated explicitly.
   */
  provider: string
  /**
   * Provider settings; the daemon validates them for the provider.
   */
  provider_config?: unknown
  /**
   * The first prompt; at most 64 KiB.
   */
  task: string
  /**
   * Defaults to the task's first line, cut to 45 characters; at most 256 bytes.
   */
  title?: string
  workspace: WorkspaceChoice
}
/**
 * Lease and claim state.
 */
export interface DiagnosticClaims {
  active_git_operations: number
  /**
   * Worktree leases the session layer holds for service and script terminals.
   */
  session_worktree_leases: number
  /**
   * Workspaces whose worktree lease a live terminal holds.
   */
  terminal_worktree_leases: string[]
  unresolved: DiagnosticUnresolvedClaim[]
  [k: string]: unknown
}
/**
 * A lease the daemon holds as unresolved.
 */
export interface DiagnosticUnresolvedClaim {
  /**
   * Whether the unresolved lease still holds the worktree lease.
   */
  holds_worktree: boolean
  /**
   * The run or terminal incarnation the lease expects, when recorded.
   */
  incarnation: string | null
  /**
   * `agent`, `service` or `script`.
   */
  kind: string
  reason: string
  /**
   * The Conversation ID, service name or script run ID.
   */
  subject: string
  workspace_id: string
  [k: string]: unknown
}
/**
 * A dropped or coalesced count.
 */
export interface DiagnosticCounter {
  kind: DiagnosticCounterKind
  name: string
  note: string
  provenance: DiagnosticProvenance
  /**
   * `null` when the source was unavailable.
   */
  value: number | null
  window: DiagnosticWindow
  [k: string]: unknown
}
/**
 * The identities a report correlates.
 */
export interface DiagnosticIdentity {
  application_protocol: string
  arch: string
  boot_id: string
  /**
   * `ADE_BUILD_ID`, or `null` when the daemon was built without one.
   */
  build_id: string | null
  daemon_pid: number
  /**
   * A stable, non-reversible key for this host: 16 hex digits of the
   * SHA-256 of its host name, or `unknown`.
   */
  host_key: string
  os: string
  profile_id: string
  /**
   * The runtime incarnation.
   */
  runtime_instance: string
  runtime_pid: number
  runtime_protocol: string
  [k: string]: unknown
}
/**
 * Live execution as the runtime reports it.
 */
export interface DiagnosticLive {
  /**
   * False when the runtime could not be asked; runs and terminals are then
   * empty and every service's `running` is `null`.
   */
  observed: boolean
  runs: DiagnosticRun[]
  runtime_instance: string
  services: DiagnosticService[]
  terminals: DiagnosticTerminal[]
  [k: string]: unknown
}
/**
 * One live Agent run in the runtime.
 */
export interface DiagnosticRun {
  /**
   * Whether the run holds a pinned account context. The context itself is
   * never reported.
   */
  account_pinned: boolean
  conversation_id: string
  pid: number | null
  provider: string
  /**
   * The execution attempt.
   */
  run_id: string
  [k: string]: unknown
}
/**
 * One configured service and whether its terminal is live.
 */
export interface DiagnosticService {
  /**
   * The service identity.
   */
  identity: string
  /**
   * The incarnation of the service's last run.
   */
  last_run_transfer_id: string | null
  name: string
  revision: number
  /**
   * `null` when the runtime was not observed.
   */
  running: boolean | null
  terminal_id: string | null
  workspace_id: string
  [k: string]: unknown
}
/**
 * One runtime terminal.
 */
export interface DiagnosticTerminal {
  clients: number | null
  durable_log_failed: boolean
  /**
   * The recorded exit kind, when the shell exited.
   */
  exit_kind: string | null
  reply_dropped_bytes: number | null
  run_id: string | null
  scrollback_bytes: number | null
  shell_pid: number | null
  shell_running: boolean
  terminal_id: string
  /**
   * The terminal incarnation.
   */
  transfer_id: string | null
  workspace_id: string
  [k: string]: unknown
}
/**
 * The local diagnostic log folder against its budget.
 */
export interface DiagnosticLogs {
  available: boolean
  bytes: number
  /**
   * Bytes one process may write to its current daily file.
   */
  daily_byte_budget: number
  files: number
  /**
   * Rotated files kept per process.
   */
  max_files_per_process: number
  [k: string]: unknown
}
/**
 * The depth of one queue or spool.
 */
export interface DiagnosticQueue {
  /**
   * The bound, when the queue has one.
   */
  capacity: number | null
  /**
   * `null` when the source was unavailable.
   */
  depth: number | null
  name: string
  note: string
  provenance: DiagnosticProvenance
  unit: DiagnosticUnit
  [k: string]: unknown
}
/**
 * Effect receipts in one database, counted by status.
 */
export interface DiagnosticReceipts {
  accepted: number
  acknowledged: number
  /**
   * False when the database could not be read; every count is then zero.
   */
  available: boolean
  dispatched: number
  expired: number
  /**
   * Creation time of the oldest unexpired receipt, in Unix milliseconds.
   */
  oldest_created_at: number | null
  /**
   * Rows with a status this build does not know.
   */
  other: number
  /**
   * Unexpired receipts older than the retention window, awaiting pruning.
   */
  past_retention: number
  settled: number
  /**
   * `sessions`, `lifecycle`, `review` or `browser`.
   */
  store: string
  unknown: number
  [k: string]: unknown
}
/**
 * What redaction removed from a bundle.
 */
export interface DiagnosticRedaction {
  /**
   * Values dropped because their key names a credential.
   */
  credential_fields: number
  /**
   * Home-directory prefixes replaced with `~`.
   */
  home_paths: number
  /**
   * The rule set's version.
   */
  policy: string
  /**
   * Credential-shaped substrings replaced inside strings.
   */
  secret_patterns: number
  /**
   * Values dropped because their key names transcript or output content.
   */
  transcript_fields: number
  /**
   * Strings, arrays, objects or nesting cut to their bounds.
   */
  truncations: number
  [k: string]: unknown
}
/**
 * Retention state.
 */
export interface DiagnosticRetention {
  /**
   * Bytes of stored attachment data, or `null` when unreadable.
   */
  attachment_bytes: number | null
  logs: DiagnosticLogs
  receipt_retention_ms: number
  /**
   * Receipts past retention across every readable store, awaiting pruning.
   */
  receipts_past_retention: number
  [k: string]: unknown
}
/**
 * One execution whose outcome ADE cannot prove, and why.
 */
export interface DiagnosticUnknown {
  /**
   * The operation name, for a receipt.
   */
  operation: string | null
  reason: string
  /**
   * The store or workspace that holds it.
   */
  scope: string | null
  /**
   * When it was last updated, in Unix milliseconds.
   */
  since: number | null
  source: DiagnosticUnknownSource
  /**
   * The operation, Conversation, terminal or claim subject.
   */
  subject: string
  [k: string]: unknown
}
/**
 * The `diagnostics.export` reply: a bounded, redacted, inspectable bundle.
 */
export interface DiagnosticsExport {
  /**
   * Allow-listed operational log records, oldest first. Each carries only
   * known fields: event, timestamp, process, pid, diagnostic and run IDs,
   * operation family, elapsed time and fixed error codes.
   */
  events: unknown[]
  /**
   * Whether older records were left out to meet a bound.
   */
  events_truncated: boolean
  /**
   * What the bundle never contains.
   */
  excluded: string[]
  /**
   * The bundle format, `ade-diagnostics-v1`.
   */
  format: string
  generated_at: number
  /**
   * The bound the serialized bundle stays under.
   */
  max_bytes: number
  redaction: DiagnosticRedaction
  status: DiagnosticsStatus
  /**
   * The `diagnostics_export` type tag.
   */
  type: 'diagnostics_export'
  [k: string]: unknown
}
/**
 * The `diagnostics.status` reply.
 */
export interface DiagnosticsStatus {
  claims: DiagnosticClaims
  counters: DiagnosticCounter[]
  /**
   * Fixed descriptions of sources that could not be read.
   */
  degraded: string[]
  /**
   * Unix milliseconds.
   */
  generated_at: number
  identity: DiagnosticIdentity
  live: DiagnosticLive
  queues: DiagnosticQueue[]
  receipts: DiagnosticReceipts[]
  retention: DiagnosticRetention
  /**
   * The `diagnostics_status` type tag.
   */
  type: 'diagnostics_status'
  /**
   * At most 100 entries.
   */
  unknown: DiagnosticUnknown[]
  /**
   * Whether `unknown` was cut to its bound.
   */
  unknown_truncated: boolean
  [k: string]: unknown
}
/**
 * `diagnostics.export`: build a bounded, redacted diagnostics bundle. The
 * daemon returns it; the caller decides where to save it.
 */
export interface DiagnosticsExportRequest {
  /**
   * The most recent operational log records to include, from 0 to 1000.
   * Defaults to 200.
   */
  max_events?: number | null
  op: 'diagnostics.export'
}
/**
 * `diagnostics.status`: read queue, counter, receipt, execution, claim and
 * retention state, with the reasons behind every unknown execution.
 */
export interface DiagnosticsStatusRequest {
  op: 'diagnostics.status'
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
export interface Excluded {
  detail: string
  name: string
  reason: Exclusion
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
 * `orchestration.group.compare`: each run's outcome and Git changes.
 */
export interface GroupCompareRequest {
  group_id: string
  op: 'orchestration.group.compare'
}
/**
 * The `orchestration.group.compare` reply. It reads Git and changes nothing.
 */
export interface GroupComparison {
  compared_at: number
  group_id: string
  /**
   * Paths changed in more than one workspace, sorted by path.
   */
  overlaps: PathOverlap[]
  runs: RunComparison[]
  summary: GroupSummary
  /**
   * The `group_comparison` type tag.
   */
  type: 'group_comparison'
  [k: string]: unknown
}
/**
 * A path that runs in different workspaces both changed. ADE merges nothing;
 * the person chooses.
 */
export interface PathOverlap {
  path: string
  /**
   * Every run whose workspace changed the path.
   */
  runs: number[]
  [k: string]: unknown
}
/**
 * One run's outcome and changes.
 */
export interface RunComparison {
  account_id: string | null
  changes: RunChanges
  child_conversation_id: string
  index: number
  progress: WaitState
  provider: string
  /**
   * The workspace is the parent's or another run's, so its changes are
   * not this run's alone.
   */
  shared_workspace: boolean
  workspace_id: string
  workspace_mode: WorkspaceMode
  [k: string]: unknown
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
 * Counts of the group's runs by their newest message's state. A timed-out
 * observation counts as pending.
 */
export interface GroupSummary {
  blocked: number
  completed: number
  failed: number
  interrupted: number
  needs_input: number
  pending: number
  runs: number
  state: GroupState
  /**
   * The run's Conversation no longer exists.
   */
  unavailable: number
  /**
   * Ended without evidence of how.
   */
  unknown: number
  [k: string]: unknown
}
/**
 * `orchestration.group.get`: one group and its runs' status.
 */
export interface GroupGetRequest {
  group_id: string
  op: 'orchestration.group.get'
}
/**
 * The `orchestration.groups` reply.
 */
export interface GroupList {
  groups: GroupRecord[]
  parent_conversation_id: string
  /**
   * The `group_list` type tag.
   */
  type: 'group_list'
  [k: string]: unknown
}
/**
 * A group and its runs.
 */
export interface GroupRecord {
  /**
   * `user`, or `agent:` followed by the starting Conversation ID.
   */
  attribution: string
  created_at: number
  group_id: string
  /**
   * The `orchestration.group.start` operation that created the group.
   */
  operation_id: string
  parent_conversation_id: string
  runs: RunRecord[]
  summary: GroupSummary
  title: string
  [k: string]: unknown
}
/**
 * One run of a group and where its newest message stands.
 */
export interface RunRecord {
  /**
   * The workspace HEAD when the group started; null when it had none.
   */
  base_commit: string | null
  child: ChildRecord1
  /**
   * The run's position in the start request, from 0.
   */
  index: number
  /**
   * The child's newest task or message.
   */
  message_id: string
  progress: WaitState
  [k: string]: unknown
}
/**
 * A durable parent and child link with the child's current Conversation state.
 */
export interface ChildRecord1 {
  account_id: string | null
  /**
   * `user`, or `agent:` followed by the delegating Conversation ID.
   */
  attribution: string
  child_conversation_id: string
  created_at: number
  /**
   * 1 for a child of a top-level Conversation.
   */
  depth: number
  error: string | null
  /**
   * The `orchestration.delegate` operation that created the child.
   */
  operation_id: string
  parent_conversation_id: string
  provider: string
  /**
   * The child Conversation's status, or `unavailable` when it is gone.
   */
  status: string
  /**
   * The queued prompt that carries the task.
   */
  task_message_id: string
  workspace_id: string
  workspace_mode: WorkspaceMode
  worktree_operation_id: string | null
  [k: string]: unknown
}
/**
 * The `orchestration.group.get` reply.
 */
export interface GroupReply {
  group: GroupRecord
  /**
   * The `group` type tag.
   */
  type: 'group'
  [k: string]: unknown
}
/**
 * `orchestration.group.start`: start one task as sibling children of a parent.
 */
export interface GroupStartRequest {
  caller: Caller
  op: 'orchestration.group.start'
  /**
   * Caller-owned operation ID; a retry with the same payload returns the same group.
   */
  operation_id: string
  parent_conversation_id: string
  /**
   * From 2 to 8 runs, in the order the group reports them.
   */
  runs: RunSpec[]
  /**
   * The first prompt of every run; at most 64 KiB.
   */
  task: string
  /**
   * Every run's title. Defaults to the task's first line, cut to 45 characters.
   */
  title?: string
}
/**
 * One run of a parallel group: a provider, its account and its workspace,
 * each stated explicitly.
 */
export interface RunSpec {
  account: AccountChoice
  provider: string
  /**
   * Provider settings; the daemon validates them for the provider.
   */
  provider_config?: unknown
  /**
   * Where the child works, stated explicitly. Parallel children in the same
   * workspace share its files; ADE never merges their edits.
   */
  workspace:
    | {
        mode: 'same'
        [k: string]: unknown
      }
    | {
        mode: 'new_worktree'
        repository_id: string
        workspace_id: string
        worktree_operation_id: string
        [k: string]: unknown
      }
  [k: string]: unknown
}
/**
 * The `orchestration.group.start` reply: every run is admitted and its task
 * is queued. It says nothing about completion.
 */
export interface GroupStarted {
  group: GroupRecord
  /**
   * The `group_started` type tag.
   */
  type: 'group_started'
  [k: string]: unknown
}
/**
 * `orchestration.groups`: the parallel groups a Conversation started, oldest first.
 */
export interface GroupsRequest {
  op: 'orchestration.groups'
  parent_conversation_id: string
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
 * One conversation in the combined history.
 */
export interface HistoryConversation {
  message_count: number
  provenance: HistoryProvenance
  status: string
  [k: string]: unknown
}
/**
 * Where a history item came from. ADE never implies that one provider's
 * session continues another's.
 */
export interface HistoryProvenance {
  account_id: string | null
  conversation_id: string
  conversation_title: string
  /**
   * Milliseconds since the Unix epoch.
   */
  conversation_updated_at: number
  /**
   * Present when the conversation is a read-only import of a native
   * session rather than one ADE ran.
   */
  import?: HistoryImportSource | null
  /**
   * The provider's own session or thread ID, when the provider assigned one.
   */
  native_session_id: string | null
  provider: string
  workspace_id: string
  [k: string]: unknown
}
/**
 * Where an imported conversation came from, and what ADE can do with it.
 */
export interface HistoryImportSource {
  /**
   * The ADE account whose native home held the session.
   */
  account_id: string | null
  /**
   * The last import, in milliseconds since the Unix epoch.
   */
  imported_at: number
  /**
   * The working directory the native session recorded.
   */
  native_cwd: string | null
  /**
   * False while ADE cannot continue this native session. Sending to an
   * imported conversation is refused, never silently started fresh.
   */
  resumable: boolean
  resume_unavailable_reason: string | null
  /**
   * The native file the history was read from.
   */
  source_path: string
  [k: string]: unknown
}
/**
 * One native session found by a scan. Metadata comes from the start of the
 * file; importing reads all of it.
 */
export interface HistoryImportCandidate {
  /**
   * The working directory the native session recorded, when it did.
   */
  cwd: string | null
  /**
   * The conversation an earlier import created, when there is one.
   */
  imported_conversation_id: string | null
  /**
   * When the file last changed, in milliseconds since the Unix epoch.
   */
  modified_at: number
  native_session_id: string
  size_bytes: number
  source_path: string
  /**
   * A native title or the first user prompt, when one was found.
   */
  title: string | null
  [k: string]: unknown
}
/**
 * `history.import.session`: import one native session as a read-only
 * conversation. Keyed by provider and native session ID: repeating it
 * returns the same conversation, adds only records appended since, and
 * refuses when the native history no longer extends what was imported.
 */
export interface HistoryImportRequest {
  /**
   * Read from this ADE account's native home instead of the default store.
   */
  account_id?: string | null
  /**
   * The provider's own session UUID, as `history.import.scan` reports it.
   */
  native_session_id: string
  op: 'history.import.session'
  provider: HistoryImportProvider
  /**
   * The workspace the imported conversation belongs to. A repeat must name
   * the same workspace.
   */
  workspace_id: string
}
/**
 * The `history.import.scan` reply.
 */
export interface HistoryImportScan {
  /**
   * True when more matching sessions exist than `limit` allowed.
   */
  more: boolean
  sessions: HistoryImportCandidate[]
  store: HistoryImportStore
  /**
   * The `history_import_scan` type tag.
   */
  type: 'history_import_scan'
  /**
   * Session files whose metadata could not be read; they are not listed.
   */
  unreadable: number
  [k: string]: unknown
}
/**
 * The native store a scan read.
 */
export interface HistoryImportStore {
  account_id: string | null
  /**
   * False when the store could not be read; `unavailable_reason` says why.
   */
  available: boolean
  provider: HistoryImportProvider
  /**
   * The directory scanned.
   */
  root: string
  unavailable_reason: string | null
  [k: string]: unknown
}
/**
 * `history.import.scan`: the native sessions one provider store holds, newest
 * first. It reads the store and changes nothing.
 */
export interface HistoryImportScanRequest {
  /**
   * Scan this ADE account's native home. Absent scans the daemon user's
   * default store (`CLAUDE_CONFIG_DIR` or `~/.claude`; `CODEX_HOME` or
   * `~/.codex`).
   */
  account_id?: string | null
  /**
   * 1 to 200; the daemon uses 50 when it is absent.
   */
  limit?: number
  op: 'history.import.scan'
  provider: HistoryImportProvider
  /**
   * Keep only sessions whose recorded working directory is this
   * workspace's root or lies inside it.
   */
  workspace_id?: string | null
}
/**
 * The `history.import.session` reply.
 */
export interface HistoryImported {
  added_messages: number
  conversation: HistoryConversation
  /**
   * True when the file ended in a partly written record, which a later
   * import picks up once the provider finishes it.
   */
  incomplete_tail: boolean
  outcome: HistoryImportOutcome
  /**
   * Native records that could not be parsed and were left out. Records
   * ADE does not model, such as private reasoning, are not counted.
   */
  skipped_records: number
  /**
   * The `history_imported` type tag.
   */
  type: 'history_imported'
  /**
   * Earlier imported messages whose native record gained detail since,
   * such as a tool result written after its call.
   */
  updated_messages: number
  [k: string]: unknown
}
/**
 * `history.index.rebuild`: discard the search index and rebuild it from
 * durable history. It applies only while the index is still at
 * `expected_epoch`, so a repeated request does not restart a rebuild.
 */
export interface HistoryIndexRebuildRequest {
  /**
   * The `epoch` from the status the caller last saw.
   */
  expected_epoch: number
  op: 'history.index.rebuild'
}
/**
 * The `history.index.status` and `history.index.rebuild` reply.
 */
export interface HistoryIndexReply {
  index: HistoryIndexStatus
  /**
   * The `history_index` type tag.
   */
  type: 'history_index'
  [k: string]: unknown
}
/**
 * The state of the search index when a reply was read.
 */
export interface HistoryIndexStatus {
  /**
   * True when the index reflected every committed message change at read time.
   */
  caught_up: boolean
  /**
   * Increases on every rebuild. Search cursors from another epoch expire.
   */
  epoch: number
  /**
   * Set after the last index update failed. The indexer retries on its own.
   */
  last_error: string | null
  /**
   * Recorded message changes the index has not applied yet.
   */
  pending_changes: number
  /**
   * True while the index is being rebuilt from durable history; search
   * results cover only the messages indexed so far.
   */
  rebuilding: boolean
  [k: string]: unknown
}
/**
 * `history.index.status`: how far the search index lags durable history.
 */
export interface HistoryIndexStatusRequest {
  op: 'history.index.status'
}
/**
 * The `history.list` reply.
 */
export interface HistoryList {
  conversations: HistoryConversation[]
  /**
   * Null when the listing has finished. A conversation updated while the
   * caller pages may move ahead of the cursor; list again to see it.
   */
  next_cursor: string | null
  /**
   * The `history_list` type tag.
   */
  type: 'history_list'
  [k: string]: unknown
}
/**
 * `history.list`: one page of conversations across providers, most recently
 * updated first.
 */
export interface HistoryListRequest {
  /**
   * The `next_cursor` of the previous page for the same filters.
   */
  cursor?: string | null
  /**
   * Page size, 1 to 100; the daemon uses 50 when it is absent.
   */
  limit?: number
  op: 'history.list'
  provider?: string | null
  workspace_id?: string | null
}
/**
 * One message that matched a search.
 */
export interface HistoryMatch {
  /**
   * A short excerpt of the current message text, or of its review feedback
   * when only the feedback matched.
   */
  excerpt: string
  has_review_feedback: boolean
  kind: string
  message_id: string
  /**
   * When the daemon first recorded this message, in milliseconds since the
   * Unix epoch. Null for messages written before the index existed.
   */
  observed_at: number | null
  provenance: HistoryProvenance
  role: string
  /**
   * The message's position in its conversation.
   */
  sequence: number
  [k: string]: unknown
}
/**
 * The `history.search` reply.
 */
export interface HistorySearch {
  index: HistoryIndexStatus
  /**
   * Null when no more indexed matches remain.
   */
  next_cursor: string | null
  results: HistoryMatch[]
  /**
   * The `history_search` type tag.
   */
  type: 'history_search'
  [k: string]: unknown
}
/**
 * `history.search`: one page of indexed messages that contain every query term,
 * newest indexed first, across every conversation and provider in the profile.
 */
export interface HistorySearchRequest {
  conversation_id?: string | null
  /**
   * The `next_cursor` of the previous page for the same query and filters.
   */
  cursor?: string | null
  /**
   * Page size, 1 to 50; the daemon uses 20 when it is absent.
   */
  limit?: number
  op: 'history.search'
  /**
   * A provider ID such as `codex` or `claude`.
   */
  provider?: string | null
  /**
   * 1 to 256 bytes. Whitespace separates terms; every term must match. A
   * trailing `*` makes a term a prefix. Query operators are matched literally.
   */
  query: string
  workspace_id?: string | null
}
/**
 * One hook delivery.
 */
export interface HookDelivery {
  /**
   * The plugin's activation generation when the event committed.
   */
  activation_generation: number
  /**
   * How many times it was handed to a plugin host.
   */
  attempts: number
  created_at: number
  /**
   * Stable for the life of the delivery and across retries. The plugin
   * receives it with every send.
   */
  effect_id: string
  /**
   * The last error the host or the daemon recorded.
   */
  error: string | null
  event: HookEvent
  /**
   * The earliest time the dispatcher sends a queued delivery.
   */
  next_attempt_at: number
  /**
   * The event's facts, as the plugin receives them.
   */
  payload: unknown
  plugin_id: string
  /**
   * Commit order in the outbox.
   */
  sequence: number
  status: HookDeliveryStatus
  updated_at: number
  [k: string]: unknown
}
/**
 * `hook.delivery.abandon`: stop a delivery that is not in flight.
 */
export interface HookDeliveryAbandonRequest {
  effect_id: string
  op: 'hook.delivery.abandon'
}
/**
 * `hook.delivery.inspect`: one delivery by its effect ID.
 */
export interface HookDeliveryInspectRequest {
  effect_id: string
  op: 'hook.delivery.inspect'
}
/**
 * The `hook.delivery.list` reply.
 */
export interface HookDeliveryList {
  deliveries: HookDelivery[]
  host: HookHostStatus
  /**
   * Pass as `after` for the next page; null on the last page.
   */
  next_after: number | null
  /**
   * The `hook_deliveries` type tag.
   */
  type: 'hook_deliveries'
  [k: string]: unknown
}
/**
 * Whether a plugin host can take deliveries now.
 */
export interface HookHostStatus {
  available: boolean
  /**
   * Why deliveries are waiting, when the host is unavailable.
   */
  detail: string | null
  [k: string]: unknown
}
/**
 * `hook.delivery.list`: deliveries in commit order, oldest first.
 */
export interface HookDeliveryListRequest {
  /**
   * Return deliveries after this sequence; the previous page's `next_after`.
   */
  after?: number | null
  /**
   * 1 to 200; 50 when absent.
   */
  limit?: number | null
  op: 'hook.delivery.list'
  plugin_id?: string | null
  status?: HookDeliveryStatus | null
}
/**
 * The `hook.delivery.inspect`, `hook.delivery.retry` and `hook.delivery.abandon` reply.
 */
export interface HookDeliveryReply {
  delivery: HookDelivery
  /**
   * The `hook_delivery` type tag.
   */
  type: 'hook_delivery'
  [k: string]: unknown
}
/**
 * `hook.delivery.retry`: queue a failed or unknown delivery to be sent again
 * with the same effect ID. A delivered, abandoned or pending delivery is refused.
 */
export interface HookDeliveryRetryRequest {
  /**
   * Required to retry an `unknown` delivery: the caller accepts that the
   * plugin may see the same effect twice.
   */
  acknowledge_unknown?: boolean
  effect_id: string
  op: 'hook.delivery.retry'
  operation_id: string
}
/**
 * One plugin's subscription to one event, from its live activation.
 */
export interface HookSubscription {
  /**
   * The activation generation that declared it.
   */
  activation_generation: number
  event: HookEvent
  plugin_id: string
  [k: string]: unknown
}
/**
 * The `hook.subscription.list` reply.
 */
export interface HookSubscriptionList {
  subscriptions: HookSubscription[]
  /**
   * The `hook_subscriptions` type tag.
   */
  type: 'hook_subscriptions'
  [k: string]: unknown
}
/**
 * `hook.subscription.list`: the active subscriptions the outbox uses.
 */
export interface HookSubscriptionListRequest {
  op: 'hook.subscription.list'
}
/**
 * The reply to every `resources.*` operation.
 */
export interface HostResourcesState {
  claims: ResourceClaim[]
  /**
   * This daemon's incarnation; claims from earlier incarnations of the same
   * profile are listed with `mine: false`.
   */
  incarnation: string
  /**
   * The profile this daemon claims for.
   */
  profile: string
  registry: RegistryStatus
  /**
   * The `host_resources` type tag.
   */
  type: 'host_resources'
  [k: string]: unknown
}
/**
 * One physical resource claim.
 */
export interface ResourceClaim {
  created_at: number
  device: string
  generation: string
  host_id: string
  id: string
  inode: string
  /**
   * Whether this daemon incarnation owns the claim.
   */
  mine: boolean
  mode: ClaimMode
  operation_id: string | null
  owner_incarnation: string
  /**
   * Whether the owning incarnation still holds its liveness lock.
   */
  owner_live: boolean
  /**
   * Diagnostic only; a missing PID never clears a claim.
   */
  owner_pid: number
  owner_profile: string
  /**
   * The canonical path when the claim was taken; informational only.
   */
  path: string
  phase: ClaimPhase
  purpose: ClaimPurpose
  /**
   * Why the claim is quarantined.
   */
  reason: string | null
  state: ClaimState
  /**
   * For a reservation of a path that does not exist yet: its folded final
   * name. The identity fields then describe the parent directory.
   */
  unborn_name: string | null
  updated_at: number
  [k: string]: unknown
}
/**
 * Where the registry lives and whether it admits new claims.
 */
export interface RegistryStatus {
  /**
   * `None` until the registry has been opened successfully.
   */
  host_id: string | null
  path: string
  /**
   * Why the registry is blocked; absent when it is ready.
   */
  reason: string | null
  /**
   * `host` when every profile shares the registry; `profile` when this
   * daemon runs outside a managed profile and coordinates with nobody.
   */
  scope: 'host' | 'profile'
  state: RegistryState
  [k: string]: unknown
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
 * The `mcp.resolve` reply.
 */
export interface McpResolution {
  /**
   * `direct`: the provider connects to each server itself and negotiates
   * protocol version, capabilities and authorization on that one leg. ADE
   * runs no MCP gateway yet.
   */
  delivery: string
  /**
   * The provider's native configuration document; null when the provider has no projection.
   */
  document: unknown
  excluded: Excluded[]
  /**
   * `claude_mcp_json`, `codex_config_toml` (the TOML tables as JSON) or `omp_mcp_json`.
   */
  format: string | null
  protocol_versions: string[]
  provider: string
  servers: Projected[]
  /**
   * The `mcp_resolution` type tag.
   */
  type: 'mcp_resolution'
  /**
   * True only when the provider's adapter passes `document` at launch. When
   * false, this is what ADE would pass; the provider does not see it.
   */
  wired: boolean
  workspace_id: string
  [k: string]: unknown
}
/**
 * One entry in a provider's native shape.
 */
export interface Projected {
  name: string
  /**
   * The provider-native server object.
   */
  native: unknown
  revision: number
  [k: string]: unknown
}
/**
 * `mcp.resolve`: the servers that apply to one workspace and provider, in
 * the provider's native configuration shape.
 */
export interface McpResolveRequest {
  op: 'mcp.resolve'
  provider: string
  workspace_id: string
}
/**
 * `mcp.server.add`: record a new server once for the profile.
 */
export interface McpServerAddRequest {
  /**
   * Everything a caller sets on a catalog entry. Inlined like [`Transport`].
   */
  definition: {
    enabled: boolean
    installation: Installation
    providers: ProviderSelection
    scope: Scope
    /**
     * How a provider reaches the server. Inlined in schemas: `cwd` is optional
     * in a request and always present in a reply.
     */
    transport:
      | {
          args: string[]
          /**
           * An absolute path or a bare name looked up on the provider's PATH.
           */
          command: string
          /**
           * An absolute directory, or null for the provider's default.
           */
          cwd?: string | null
          env: {
            [k: string]: SettingValue
          }
          type: 'stdio'
        }
      | {
          headers: {
            [k: string]: SettingValue
          }
          type: 'streamable_http'
          url: string
        }
      | {
          headers: {
            [k: string]: SettingValue
          }
          type: 'sse'
          url: string
        }
  }
  name: string
  op: 'mcp.server.add'
}
/**
 * `mcp.server.inspect`: one entry and how each provider can express it.
 */
export interface McpServerInspectRequest {
  name: string
  op: 'mcp.server.inspect'
}
/**
 * The `mcp.server.inspect` reply.
 */
export interface McpServerInspection {
  /**
   * MCP protocol revisions the modelled transports follow, newest first.
   */
  protocol_versions: string[]
  providers: ProviderSupport[]
  server: Server
  /**
   * The `mcp_server_inspection` type tag.
   */
  type: 'mcp_server_inspection'
  [k: string]: unknown
}
/**
 * Whether one provider can express an entry, and whether its adapter reads it yet.
 */
export interface ProviderSupport {
  /**
   * The provider-native server object, or null when it cannot be expressed.
   */
  native: unknown
  provider: string
  /**
   * Why the provider cannot express the entry; null when it can.
   */
  unsupported_reason: string | null
  /**
   * True only when the provider's adapter passes the catalog at launch.
   */
  wired: boolean
  [k: string]: unknown
}
/**
 * One catalog entry. `name` is its identity within the profile.
 */
export interface Server {
  /**
   * Everything a caller sets on a catalog entry. Inlined like [`Transport`].
   */
  definition: {
    enabled: boolean
    installation: Installation
    providers: ProviderSelection
    scope: Scope
    /**
     * How a provider reaches the server. Inlined in schemas: `cwd` is optional
     * in a request and always present in a reply.
     */
    transport:
      | {
          args: string[]
          /**
           * An absolute path or a bare name looked up on the provider's PATH.
           */
          command: string
          /**
           * An absolute directory, or null for the provider's default.
           */
          cwd: string | null
          env: {
            [k: string]: SettingValue
          }
          type: 'stdio'
        }
      | {
          headers: {
            [k: string]: SettingValue
          }
          type: 'streamable_http'
          url: string
        }
      | {
          headers: {
            [k: string]: SettingValue
          }
          type: 'sse'
          url: string
        }
  }
  name: string
  /**
   * Starts at 1 and increases with each update.
   */
  revision: number
  [k: string]: unknown
}
/**
 * `mcp.server.list`: every catalog entry in the profile, in name order.
 */
export interface McpServerListRequest {
  op: 'mcp.server.list'
}
/**
 * `mcp.server.remove`: delete an entry at the revision the caller saw.
 */
export interface McpServerRemoveRequest {
  expected_revision: number
  name: string
  op: 'mcp.server.remove'
}
/**
 * The `mcp.server.remove` reply. `removed` is false when no entry existed.
 */
export interface McpServerRemoved {
  name: string
  removed: boolean
  /**
   * The `mcp_server_removed` type tag.
   */
  type: 'mcp_server_removed'
  [k: string]: unknown
}
/**
 * The `mcp.server.add` and `mcp.server.update` reply.
 */
export interface McpServerReply {
  server: Server
  /**
   * The `mcp_server` type tag.
   */
  type: 'mcp_server'
  [k: string]: unknown
}
/**
 * `mcp.server.update`: replace an entry's definition.
 */
export interface McpServerUpdateRequest {
  /**
   * Everything a caller sets on a catalog entry. Inlined like [`Transport`].
   */
  definition: {
    enabled: boolean
    installation: Installation
    providers: ProviderSelection
    scope: Scope
    /**
     * How a provider reaches the server. Inlined in schemas: `cwd` is optional
     * in a request and always present in a reply.
     */
    transport:
      | {
          args: string[]
          /**
           * An absolute path or a bare name looked up on the provider's PATH.
           */
          command: string
          /**
           * An absolute directory, or null for the provider's default.
           */
          cwd?: string | null
          env: {
            [k: string]: SettingValue
          }
          type: 'stdio'
        }
      | {
          headers: {
            [k: string]: SettingValue
          }
          type: 'streamable_http'
          url: string
        }
      | {
          headers: {
            [k: string]: SettingValue
          }
          type: 'sse'
          url: string
        }
  }
  /**
   * The revision the caller last saw.
   */
  expected_revision: number
  name: string
  op: 'mcp.server.update'
}
/**
 * The `mcp.server.list` reply.
 */
export interface McpServers {
  servers: Server[]
  /**
   * The `mcp_servers` type tag.
   */
  type: 'mcp_servers'
  [k: string]: unknown
}
/**
 * The `notification.delivery.list` reply.
 */
export interface NotificationDeliveries {
  deliveries: NotificationDelivery[]
  /**
   * The `notification_deliveries` type tag.
   */
  type: 'notification_deliveries'
  [k: string]: unknown
}
/**
 * Delivery bookkeeping for one activity on one channel.
 */
export interface NotificationDelivery {
  activity_id: string
  channel: DeliveryChannel
  claimed_at: number
  /**
   * The client that claimed the delivery.
   */
  client_id: string
  /**
   * Why a delivery failed or was suppressed.
   */
  reason: string | null
  status: DeliveryStatus
  updated_at: number
  [k: string]: unknown
}
/**
 * The `notification.delivery.claim` reply. `granted` is false when another
 * client or an earlier outcome already holds the delivery.
 */
export interface NotificationDeliveryClaim {
  delivery: NotificationDelivery
  granted: boolean
  /**
   * The `notification_delivery_claim` type tag.
   */
  type: 'notification_delivery_claim'
  [k: string]: unknown
}
/**
 * `notification.delivery.claim`: reserve one activity's delivery.
 */
export interface NotificationDeliveryClaimRequest {
  activity_id: string
  channel: DeliveryChannel
  /**
   * Unique per client process; 1 to 128 characters.
   */
  client_id: string
  op: 'notification.delivery.claim'
}
/**
 * `notification.delivery.list`: newest deliveries first, to inspect failures.
 */
export interface NotificationDeliveryListRequest {
  /**
   * 1 to 200; defaults to 50.
   */
  limit?: number | null
  op: 'notification.delivery.list'
  status?: DeliveryStatus | null
}
/**
 * The `notification.delivery.report` reply.
 */
export interface NotificationDeliveryReply {
  delivery: NotificationDelivery
  /**
   * The `notification_delivery` type tag.
   */
  type: 'notification_delivery'
  [k: string]: unknown
}
/**
 * `notification.delivery.report`: record what happened to a claimed delivery.
 */
export interface NotificationDeliveryReportRequest {
  activity_id: string
  channel: DeliveryChannel
  client_id: string
  op: 'notification.delivery.report'
  outcome: DeliveryOutcome
  /**
   * Required for failed and suppressed; up to 500 characters.
   */
  reason?: string | null
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
 * `plugin.command.invoke`: run a command the plugin's backend registered.
 * The host starts on first use. A command whose outcome cannot be proven,
 * because its host crashed or timed out while running it, settles as
 * `outcome_unknown` and is never run again under the same operation ID.
 */
export interface PluginCommandInvokeRequest {
  /**
   * JSON arguments passed to the handler, at most 256 KiB.
   */
  args?: unknown
  /**
   * A command the manifest declares and the current activation registered.
   */
  command_id: string
  op: 'plugin.command.invoke'
  operation_id: string
  plugin_id: string
}
/**
 * The `plugin.command.invoke` reply.
 */
export interface PluginCommandResult {
  /**
   * The host start attempt within that generation.
   */
  attempt: number
  command_id: string
  /**
   * The activation generation whose host ran the command.
   */
  generation: number
  outcome: PluginCommandOutcome
  plugin_id: string
  /**
   * The `plugin_command_result` type tag.
   */
  type: 'plugin_command_result'
  [k: string]: unknown
}
/**
 * Static contributions the registry records for each activation.
 */
export interface PluginContributions {
  commands: PluginCommandContribution[]
  /**
   * Lifecycle events delivered to the backend entry point after they commit (F058).
   */
  hooks?: HookEvent[]
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
  /**
   * Lifecycle events delivered to the backend entry point after they commit (F058).
   */
  hooks?: HookEvent[]
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
 * The `plugin.host.status` and `plugin.host.restart` reply.
 */
export interface PluginHostReply {
  host: PluginHostStatus
  /**
   * The `plugin_host` type tag.
   */
  type: 'plugin_host'
  [k: string]: unknown
}
/**
 * One plugin's backend host as the supervisor sees it.
 */
export interface PluginHostStatus {
  /**
   * The last host start attempt within the generation; 0 before the first.
   */
  attempt: number
  /**
   * Consecutive crashes counted toward the restart schedule.
   */
  crashes: number
  /**
   * The activation generation the host serves.
   */
  generation: number | null
  last_error: string | null
  /**
   * The last lines the host wrote to stderr, oldest first.
   */
  log_tail: string[]
  pid: number | null
  plugin_id: string
  /**
   * Commands the running host reports as registered.
   */
  registered: string[]
  /**
   * Whether a running host answered a health probe; null when none ran.
   */
  responsive: boolean | null
  /**
   * When the next automatic restart is due, in backoff.
   */
  retry_at: number | null
  started_at: number | null
  state: PluginHostState
  [k: string]: unknown
}
/**
 * `plugin.host.restart`: clear the crash count and start a fresh host for
 * the current activation. Invocations running in the old host settle as
 * `outcome_unknown`.
 */
export interface PluginHostRestartRequest {
  op: 'plugin.host.restart'
  plugin_id: string
}
/**
 * `plugin.host.status`: the backend host's supervision state. It never
 * starts a host.
 */
export interface PluginHostStatusRequest {
  op: 'plugin.host.status'
  plugin_id: string
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
 * `preset.delete`: remove a preset at the revision the caller saw.
 */
export interface PresetDeleteRequest {
  expected_revision: number
  name: string
  op: 'preset.delete'
}
/**
 * The `preset.delete` reply.
 */
export interface PresetDeleted {
  /**
   * False when no preset had this name.
   */
  deleted: boolean
  name: string
  /**
   * The `preset_deleted` type tag.
   */
  type: 'preset_deleted'
  [k: string]: unknown
}
/**
 * `preset.get`: one preset and its conflicts.
 */
export interface PresetGetRequest {
  name: string
  op: 'preset.get'
}
/**
 * The `preset.list` reply.
 */
export interface PresetList {
  presets: CheckedPreset[]
  /**
   * The `presets` type tag.
   */
  type: 'presets'
  [k: string]: unknown
}
/**
 * `preset.list`: every preset in the profile, by name.
 */
export interface PresetListRequest {
  op: 'preset.list'
}
/**
 * `preset.save`: create or replace a preset. The daemon refuses settings the
 * provider's current capabilities do not allow.
 */
export interface PresetSaveRequest {
  /**
   * The revision being replaced. Absent to create a new preset.
   */
  expected_revision?: number | null
  model?: string | null
  /**
   * Trimmed by the daemon; 1 to 80 characters without control characters.
   */
  name: string
  op: 'preset.save'
  /**
   * `default` when absent.
   */
  permission_mode?: string | null
  provider: string
  reasoning?: string | null
}
/**
 * The `preset.save` reply.
 */
export interface PresetSaved {
  /**
   * False when the preset already had these settings.
   */
  changed: boolean
  preset: Preset
  /**
   * The `preset_saved` type tag.
   */
  type: 'preset_saved'
  [k: string]: unknown
}
/**
 * The `preset.get` reply.
 */
export interface PresetView {
  capability_change: CapabilityChange
  /**
   * Empty when the preset can be applied as saved.
   */
  conflicts: PresetConflict[]
  preset: Preset
  /**
   * The `preset` type tag.
   */
  type: 'preset'
  [k: string]: unknown
}
/**
 * The `provider.capabilities` reply.
 */
export interface ProviderCapabilities {
  providers: CapabilityRecord[]
  /**
   * The `provider_capabilities` type tag.
   */
  type: 'provider_capabilities'
  [k: string]: unknown
}
/**
 * `provider.capabilities`: the capability records ADE ships.
 */
export interface ProviderCapabilitiesRequest {
  op: 'provider.capabilities'
  /**
   * One provider; every provider when absent.
   */
  provider?: string | null
}
/**
 * `provider.list`: the providers this daemon can launch.
 */
export interface ProviderListRequest {
  op: 'provider.list'
}
/**
 * The `provider.quota` reply.
 */
export interface ProviderQuota {
  entries: QuotaEntry[]
  recording: UsageRecording
  /**
   * The `provider_quota` type tag.
   */
  type: 'provider_quota'
  [k: string]: unknown
}
/**
 * The quota picture for one provider and account.
 */
export interface QuotaEntry {
  /**
   * Null for the provider's own login.
   */
  account_id: string | null
  /**
   * How old that report is.
   */
  age_ms: number | null
  /**
   * True when a window that has not yet reset reports exhaustion. ADE does
   * not switch account or model in response.
   */
  exhausted: boolean
  /**
   * When the newest window was received, in milliseconds since the epoch.
   */
  observed_at: number | null
  provider: string
  reason: string
  state: QuotaState
  windows: UsageLimitWindow[]
  [k: string]: unknown
}
/**
 * One rate-limit window as the provider last reported it.
 */
export interface UsageLimitWindow {
  /**
   * Null for the provider's own login.
   */
  account_id: string | null
  /**
   * The provider's name for the window, such as `five_hour` or `codex:primary`.
   */
  limit_id: string
  /**
   * When the daemon received this report. Limits are only as fresh as the
   * provider's last report; no probe runs between turns.
   */
  observed_at: number
  plan: string | null
  provider: string
  /**
   * True when `resets_at` has passed, so `used_percent` is out of date.
   */
  reset_since_observed: boolean
  /**
   * Milliseconds since the Unix epoch.
   */
  resets_at: number | null
  source: string
  /**
   * The provider's own status word, such as `allowed_warning` or `rejected`.
   */
  status: string | null
  /**
   * 0 to 100. Null when the latest report did not include it.
   */
  used_percent: number | null
  window_minutes: number | null
  [k: string]: unknown
}
/**
 * Whether the daemon could record every report it received since it started.
 */
export interface UsageRecording {
  /**
   * Event batches whose usage could not be saved since the daemon started.
   * Their turns are missing from every figure.
   */
  dropped_batches: number
  last_error: string | null
  [k: string]: unknown
}
/**
 * `provider.quota`: reported limits per provider and account.
 */
export interface ProviderQuotaRequest {
  account_id?: string | null
  op: 'provider.quota'
  provider?: string | null
}
/**
 * The `provider.readiness` reply. It is a snapshot: an external CLI update
 * changes it, so launches check again.
 */
export interface ProviderReadiness {
  account_id: string | null
  capability_revision: number
  checked_at: number
  checks: ReadinessCheck[]
  provider: string
  /**
   * What to do next, in words a person can act on.
   */
  reason: string
  state: ReadinessState2
  /**
   * The `provider_readiness` type tag.
   */
  type: 'provider_readiness'
  /**
   * The version the account probe read, when it ran.
   */
  version: string | null
  [k: string]: unknown
}
/**
 * One step of a readiness check.
 */
export interface ReadinessCheck {
  /**
   * Such as `executable:claude`, `runtime:node` or `account`.
   */
  check: string
  detail: string
  state: CheckState
  [k: string]: unknown
}
/**
 * `provider.readiness`: whether a provider, or one of its accounts, can run.
 */
export interface ProviderReadinessRequest {
  /**
   * A managed account to probe. Without it ADE checks installation only.
   */
  account_id?: string | null
  op: 'provider.readiness'
  provider: string
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
 * The remote daemon's identity as its `hello` reported it.
 */
export interface RemoteDaemon {
  application_protocol: string
  boot_id: string
  build_id: string | null
  pid: number
  profile_id: string
  runtime_protocol: string
  /**
   * The daemon's socket path on the remote host.
   */
  socket: string
  [k: string]: unknown
}
/**
 * One registered remote host.
 */
export interface RemoteHost {
  /**
   * Absolute path of `ade-control` on the remote host; null uses its `PATH`.
   */
  backend_path: string | null
  created_at_ms: number
  host_id: string
  /**
   * The pinned key's OpenSSH SHA-256 fingerprint, `SHA256:...`.
   */
  host_key_fingerprint: string
  /**
   * The pinned host key algorithm, such as `ssh-ed25519`.
   */
  host_key_type: string
  label: string
  /**
   * The active pairing, or else the most recent revoked one; null when never paired.
   */
  pairing: RemotePairing | null
  /**
   * The remote profile to start; null uses the remote host's selected profile.
   */
  remote_profile_id: string | null
  /**
   * What `ssh` is given: an alias from the user's SSH config or `user@host`.
   */
  ssh_target: string
  [k: string]: unknown
}
/**
 * One pairing between this profile and a remote host.
 */
export interface RemotePairing {
  paired_at_ms: number
  pairing_id: string
  revoked_at_ms: number | null
  state: PairingState
  token_reference: TokenReference
  [k: string]: unknown
}
/**
 * `remote.host.add`: verify and record a host.
 */
export interface RemoteHostAddRequest {
  backend_path?: string | null
  /**
   * The host key fingerprint obtained out of band, `SHA256:...`.
   */
  expected_fingerprint: string
  /**
   * Lowercase letters, digits and `-`, at most 64 characters.
   */
  host_id: string
  /**
   * The host's public key line. Required when the target is reached through
   * a proxy; otherwise the daemon reads the keys with `ssh-keyscan`.
   */
  host_public_key?: string | null
  label?: string | null
  op: 'remote.host.add'
  remote_profile_id?: string | null
  ssh_target: string
}
/**
 * `remote.host.list`: every registered host, in ID order.
 */
export interface RemoteHostListRequest {
  op: 'remote.host.list'
}
/**
 * The `remote.host.probe` reply. It is only returned after the host
 * presented the pinned key.
 */
export interface RemoteHostProbe {
  backend: BackendCompatibility
  host_id: string
  host_key_fingerprint: string
  platform: RemotePlatform
  /**
   * The `remote_host_probe` type tag.
   */
  type: 'remote_host_probe'
  [k: string]: unknown
}
/**
 * The remote operating system and machine, from `uname`.
 */
export interface RemotePlatform {
  arch: string
  os: string
  [k: string]: unknown
}
/**
 * `remote.host.probe`: check the host key and the remote backend.
 */
export interface RemoteHostProbeRequest {
  host_id: string
  op: 'remote.host.probe'
}
/**
 * `remote.host.remove`: forget a host that has no active pairing.
 */
export interface RemoteHostRemoveRequest {
  host_id: string
  op: 'remote.host.remove'
}
/**
 * The `remote.host.remove` reply. `removed` is false when no host existed.
 */
export interface RemoteHostRemoved {
  host_id: string
  removed: boolean
  /**
   * The `remote_host_removed` type tag.
   */
  type: 'remote_host_removed'
  [k: string]: unknown
}
/**
 * The `remote.host.add` reply.
 */
export interface RemoteHostReply {
  host: RemoteHost
  /**
   * The `remote_host` type tag.
   */
  type: 'remote_host'
  [k: string]: unknown
}
/**
 * The `remote.host.start` reply.
 */
export interface RemoteHostStart {
  daemon: RemoteDaemon | null
  detail: string | null
  host_id: string
  operation_id: string
  outcome: StartOutcome
  /**
   * The `remote_host_start` type tag.
   */
  type: 'remote_host_start'
  [k: string]: unknown
}
/**
 * `remote.host.start`: start or attach the remote profile daemon.
 */
export interface RemoteHostStartRequest {
  host_id: string
  op: 'remote.host.start'
  operation_id: string
}
/**
 * The `remote.host.list` reply.
 */
export interface RemoteHosts {
  hosts: RemoteHost[]
  /**
   * The `remote_hosts` type tag.
   */
  type: 'remote_hosts'
  [k: string]: unknown
}
/**
 * `remote.host.pair`: record an explicit pairing and its token reference.
 */
export interface RemotePairRequest {
  host_id: string
  op: 'remote.host.pair'
  token_reference: TokenReference
}
/**
 * The `remote.host.pair` and `remote.host.revoke` reply.
 */
export interface RemotePairingReply {
  /**
   * Where revocation takes effect. `local_profile`: this profile refuses to
   * start or attach the host; the remote backend does not yet check tokens.
   */
  enforcement: string
  host_id: string
  pairing: RemotePairing
  /**
   * The `remote_pairing` type tag.
   */
  type: 'remote_pairing'
  [k: string]: unknown
}
/**
 * `remote.host.revoke`: invalidate one pairing.
 */
export interface RemoteRevokeRequest {
  host_id: string
  op: 'remote.host.revoke'
  pairing_id: string
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
 * `repository.clone`: clone `url` into a new folder and register it as a project.
 */
export interface RepositoryCloneRequest {
  /**
   * The branch to check out; the remote's default branch when absent.
   */
  branch?: string | null
  /**
   * The absolute path of the folder to create. Its parent must exist and the
   * path itself must not; ADE never clones into an existing path.
   */
  destination: string
  op: 'repository.clone'
  operation_id: string
  /**
   * An `https://`, `ssh://`, `user@host:path` or `file://` URL without a password.
   */
  url: string
}
/**
 * The `repository.clone` reply.
 */
export interface RepositoryCloned {
  /**
   * The checked-out branch; absent when HEAD is detached.
   */
  branch: string | null
  /**
   * The canonical path of the new clone.
   */
  destination: string
  /**
   * The checked-out commit; absent when the remote repository is empty.
   */
  head: string | null
  outcome: RepositoryCloneOutcome
  registration_error: string | null
  /**
   * The `repository_cloned` type tag.
   */
  type: 'repository_cloned'
  url: string
  /**
   * The registered project; absent when `outcome` is `cloned_not_registered`.
   */
  workspace: WorkspaceRecord | null
  [k: string]: unknown
}
/**
 * The `repository.coverage` reply: ordinary Git only, with named coverage (D08).
 */
export interface RepositoryCoverage {
  /**
   * How authentication happens.
   */
  credentials: string
  /**
   * Work ADE does not do for clone or publish.
   */
  excluded: string[]
  /**
   * Always false: no forge API is called.
   */
  forge_apis: boolean
  transports: TransportCoverage[]
  /**
   * The `repository_coverage` type tag.
   */
  type: 'repository_coverage'
  [k: string]: unknown
}
/**
 * Whether ADE accepts one transport, and why.
 */
export interface TransportCoverage {
  example: string
  note: string
  supported: boolean
  transport: RepositoryTransport
  [k: string]: unknown
}
/**
 * `repository.coverage`: the transports and forge behaviour ADE supports (D08).
 */
export interface RepositoryCoverageRequest {
  op: 'repository.coverage'
}
/**
 * The `repository.publish.preview` reply.
 */
export interface RepositoryPublishPreview {
  blocked_reasons: string[]
  /**
   * The branch that would be pushed.
   */
  branch: string | null
  /**
   * The canonical folder.
   */
  path: string
  remote: string
  /**
   * The steps publish would take, in order.
   */
  steps: RepositoryPublishStep[]
  /**
   * The `repository_publish_preview` type tag.
   */
  type: 'repository_publish_preview'
  /**
   * Uncommitted changes that publish would leave out of the push.
   */
  uncommitted_changes: boolean
  verdict: RepositoryPublishVerdict
  [k: string]: unknown
}
/**
 * `repository.publish.preview`: what `repository.publish` would do, or why it refuses.
 */
export interface RepositoryPublishPreviewRequest {
  /**
   * Allows an initial commit of every non-ignored file when the repository
   * has no commits yet.
   */
  create_initial_commit?: boolean
  /**
   * The branch a new repository starts on; `main` when absent. Ignored when
   * the folder already has a current branch.
   */
  initial_branch?: string | null
  op: 'repository.publish.preview'
  /**
   * The folder to publish; it must be a Git repository's top level or not
   * belong to any repository.
   */
  path: string
  /**
   * The remote to add or reuse; `origin` when absent.
   */
  remote?: string | null
  url: string
}
/**
 * `repository.publish`: initialise if needed, add the remote and push the current branch.
 */
export interface RepositoryPublishRequest {
  /**
   * One line of at most 200 characters; `Initial commit` when absent.
   */
  commit_message?: string | null
  /**
   * Required when the repository has no commits: stage every non-ignored
   * file and commit it with `commit_message`. Git's own author identity is used.
   */
  create_initial_commit?: boolean
  initial_branch?: string | null
  op: 'repository.publish'
  operation_id: string
  path: string
  remote?: string | null
  /**
   * An `https://`, `ssh://`, `user@host:path` or `file://` URL without a
   * password. The remote repository must already exist; ADE does not create it.
   */
  url: string
}
/**
 * The `repository.publish` reply.
 */
export interface RepositoryPublished {
  branch: string
  /**
   * The local commit that was, or would have been, pushed.
   */
  commit: string | null
  failed_step: RepositoryPublishStep | null
  failure: string | null
  /**
   * The initial commit this publish recorded.
   */
  initial_commit: string | null
  /**
   * This publish ran `git init`.
   */
  initialized: boolean
  outcome: RepositoryPublishOutcome
  path: string
  /**
   * The remote branch was read back at `commit`.
   */
  pushed: boolean
  remote: string
  /**
   * This publish added the remote.
   */
  remote_added: boolean
  /**
   * The `repository_published` type tag.
   */
  type: 'repository_published'
  /**
   * Uncommitted changes that were not part of the push.
   */
  uncommitted_changes: boolean
  url: string
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
 * `resources.claim.resolve`: release one quarantined claim after the caller
 * has reconciled the resource outside ADE. Active claims cannot be resolved.
 */
export interface ResourcesClaimResolveRequest {
  claim_id: string
  /**
   * Must equal the claim's recorded `path`.
   */
  confirm_path: string
  op: 'resources.claim.resolve'
  /**
   * Caller-owned operation ID.
   */
  operation_id: string
}
/**
 * `resources.inspect`: read the registry status and its claims. With `path`,
 * only claims on that path, inside it, or containing it are listed.
 */
export interface ResourcesInspectRequest {
  op: 'resources.inspect'
  path?: string | null
}
/**
 * `resources.registry.accept`: bind this profile to the registry currently
 * on disk after it was replaced, went missing or became unreadable. An
 * unreadable file is moved aside, never deleted. Owners recorded only in the
 * lost registry are forgotten, which is why the caller must confirm.
 */
export interface ResourcesRegistryAcceptRequest {
  /**
   * Must equal `registry.path` from `resources.inspect`.
   */
  confirm_registry: string
  op: 'resources.registry.accept'
  /**
   * Caller-owned operation ID.
   */
  operation_id: string
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
 * The `retention.apply` reply.
 */
export interface RetentionApply {
  applied_at: number
  /**
   * True only when every previewed item was removed.
   */
  complete: boolean
  generation: string
  removed_bytes: number
  /**
   * True when this reply is the stored result of an earlier apply.
   */
  replayed: boolean
  results: RetentionItemResult[]
  /**
   * The `retention_apply` type tag.
   */
  type: 'retention_apply'
  [k: string]: unknown
}
/**
 * One item's result.
 */
export interface RetentionItemResult {
  /**
   * Bytes freed; zero unless removed.
   */
  bytes: number
  error: string | null
  id: string
  kind: RetentionKind
  outcome: RetentionOutcome
  [k: string]: unknown
}
/**
 * `retention.apply`: remove exactly the set a preview listed.
 */
export interface RetentionApplyRequest {
  /**
   * The preview's `generation`. A changed candidate set is refused.
   */
  generation: string
  op: 'retention.apply'
}
/**
 * One item the preview would remove.
 */
export interface RetentionCandidate {
  /**
   * Estimated bytes freed. Attachment and skill bytes free space inside the
   * profile database, which the file keeps until SQLite reuses it.
   */
  bytes: number
  /**
   * The attachment ID, skill content hash, service log key or log file name.
   */
  id: string
  kind: RetentionKind
  /**
   * When the item last changed, in Unix milliseconds, when known.
   */
  last_activity_at: number | null
  /**
   * Why retention selected it.
   */
  reason: string
  /**
   * The owning Conversation for an attachment; otherwise null.
   */
  scope: string | null
  [k: string]: unknown
}
/**
 * A log the daemon observes but does not remove, with its size.
 */
export interface RetentionObservedLog {
  /**
   * Null when the file is absent or unreadable.
   */
  bytes: number | null
  name: string
  note: string
  [k: string]: unknown
}
/**
 * The limits this daemon applies.
 */
export interface RetentionPolicy {
  /**
   * An unreferenced attachment younger than this may be an in-flight upload.
   */
  attachment_grace_ms: number
  /**
   * Most candidates one preview lists.
   */
  candidate_limit: number
  /**
   * Rotated diagnostic logs older than this can go; the newest file of each
   * process is always kept.
   */
  diagnostic_log_max_age_ms: number
  /**
   * How often the daemon prunes receipts.
   */
  receipt_prune_interval_ms: number
  /**
   * Effect receipts older than this lose their body and keep an expired marker.
   */
  receipt_retention_ms: number
  /**
   * A service log must be idle this long before it can go.
   */
  service_log_idle_ms: number
  [k: string]: unknown
}
/**
 * The `retention.preview` reply.
 */
export interface RetentionPreview {
  /**
   * Sorted by kind, then ID.
   */
  candidates: RetentionCandidate[]
  generated_at: number
  /**
   * Names this exact candidate set for `retention.apply`.
   */
  generation: string
  observed_logs: RetentionObservedLog[]
  policy: RetentionPolicy
  receipts: RetentionReceiptStore[]
  reclaimable_bytes: number
  /**
   * Whether more items were eligible than `candidate_limit`; apply again
   * after a new preview to reach them.
   */
  truncated: boolean
  /**
   * The `retention_preview` type tag.
   */
  type: 'retention_preview'
  withheld: RetentionWithheld[]
  [k: string]: unknown
}
/**
 * One store's receipt pruning state.
 */
export interface RetentionReceiptStore {
  /**
   * Why the last scheduled prune failed; null after a success.
   */
  last_error: string | null
  /**
   * Receipts the last prune expired.
   */
  last_expired: number | null
  /**
   * When the schedule last pruned this store, in Unix milliseconds.
   */
  last_pruned_at: number | null
  /**
   * Receipts past retention that still hold a body; null when unreadable.
   */
  past_retention: number | null
  /**
   * `sessions`, `lifecycle`, `review` or `plugins`.
   */
  store: string
  [k: string]: unknown
}
/**
 * A category the preview did not evaluate, and why. Nothing of that kind
 * is a candidate until the reason clears.
 */
export interface RetentionWithheld {
  kind: RetentionKind
  reason: string
  [k: string]: unknown
}
/**
 * `retention.preview`: list what retention would remove now.
 */
export interface RetentionPreviewRequest {
  op: 'retention.preview'
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
 * `skill.adopt`: take ownership of a skill directory a provider already reads.
 * The directory is copied into the catalog unchanged and its provider path is
 * recorded as catalog-owned. Only adoption lets a later placement replace it.
 */
export interface SkillAdoptRequest {
  /**
   * The content hash `skill.discover` reported; adoption fails when it changed.
   */
  expected_content_hash: string
  op: 'skill.adopt'
  operation_id: string
  /**
   * A path that `skill.discover` reported, directly inside a provider skill root.
   */
  path: string
  /**
   * The workspace whose provider roots contain `path`, for workspace-scoped skills.
   */
  workspace_id?: string | null
}
/**
 * `skill.discover`: scan provider skill roots and replace the stored
 * references for the scanned scopes. Reads only; never writes provider paths.
 */
export interface SkillDiscoverRequest {
  op: 'skill.discover'
  /**
   * Also scans this workspace's provider roots.
   */
  workspace_id?: string | null
}
/**
 * The `skill.discover` reply.
 */
export interface SkillDiscovery {
  references: SkillReference[]
  roots: SkillRoot[]
  /**
   * The `skill_discovery` type tag.
   */
  type: 'skill_discovery'
  [k: string]: unknown
}
/**
 * A skill directory that a provider reads and ADE does not own.
 */
export interface SkillReference {
  /**
   * The catalog bundle that owns this path through adoption.
   */
  adopted_by: string | null
  content_hash: string | null
  description: string | null
  discovered_at: number
  /**
   * The entry's directory name.
   */
  entry: string
  name: string | null
  path: string
  problem: string | null
  provider: string
  root: string
  scope: SkillScope
  status: SkillReferenceStatus
  /**
   * The link target when the entry is a symbolic link.
   */
  symlink_target: string | null
  /**
   * Set for workspace-scoped references.
   */
  workspace_id: string | null
  [k: string]: unknown
}
/**
 * One provider skill root that discovery scanned.
 */
export interface SkillRoot {
  path: string
  provider: string
  scope: SkillScope
  status: SkillRootStatus
  [k: string]: unknown
}
/**
 * One file in a bundle. Paths are relative, `/`-separated and normalized.
 */
export interface SkillFile {
  executable: boolean
  path: string
  /**
   * Lowercase hex SHA-256 of the file bytes.
   */
  sha256: string
  size: number
  [k: string]: unknown
}
/**
 * `skill.inspect`: one bundle's manifest, provenance and provider projection.
 */
export interface SkillInspectRequest {
  name: string
  op: 'skill.inspect'
  /**
   * Adds workspace-scoped provider paths to the projection.
   */
  workspace_id?: string | null
}
/**
 * The `skill.inspect` reply.
 */
export interface SkillInspection {
  manifest: SkillManifest
  projection: SkillProjection[]
  skill: SkillSummary
  /**
   * The `skill` type tag.
   */
  type: 'skill'
  [k: string]: unknown
}
/**
 * The validated contents of a bundle.
 */
export interface SkillManifest {
  compatibility?: string | null
  /**
   * Lowercase hex SHA-256 over the sorted file list (path, mode and file hash).
   */
  content_hash: string
  description: string
  /**
   * Sorted by path.
   */
  files: SkillFile[]
  license?: string | null
  name: string
  total_bytes: number
  [k: string]: unknown
}
/**
 * Where one provider would read the bundle and what placing it there needs.
 */
export interface SkillProjection {
  decision: SkillPlacementDecision
  observed: SkillObservedPlacement
  path: string
  provider: string
  reason: string | null
  root: string
  scope: SkillScope
  [k: string]: unknown
}
/**
 * One installed bundle as `skill.list` shows it.
 */
export interface SkillSummary {
  /**
   * Provider paths this catalog owns through adoption.
   */
  adopted_paths: string[]
  content_hash: string
  description: string
  file_count: number
  name: string
  provenance: SkillProvenance
  total_bytes: number
  [k: string]: unknown
}
/**
 * Where a bundle came from and what it is pinned to.
 */
export interface SkillProvenance {
  /**
   * Entries skipped while reading the directory, such as `.git`.
   */
  excluded: string[]
  installed_at: number
  kind: SkillSourceKind
  /**
   * The content hash the bundle is pinned to; equal to the manifest's.
   */
  pinned_content_hash: string
  /**
   * The same path with symlinks resolved when it was read.
   */
  resolved_path: string
  /**
   * The path the caller named.
   */
  source_path: string
  [k: string]: unknown
}
/**
 * `skill.install`: copy a local skill directory into the catalog as a pinned bundle.
 */
export interface SkillInstallRequest {
  /**
   * The bundle content hash the caller expects. The install fails closed
   * when the directory no longer hashes to it.
   */
  expected_content_hash?: string | null
  op: 'skill.install'
  operation_id: string
  /**
   * Required to replace an installed bundle of the same name: that bundle's
   * current content hash.
   */
  replace_content_hash?: string | null
  /**
   * Absolute path of the skill directory; it must hold `SKILL.md`.
   */
  source_path: string
}
/**
 * The `skill.install` and `skill.adopt` reply.
 */
export interface SkillInstalled {
  /**
   * False when the same bundle was already installed with this content.
   */
  changed: boolean
  /**
   * The content hash this install replaced, if any.
   */
  replaced_content_hash: string | null
  skill: SkillSummary
  /**
   * The `skill_installed` type tag.
   */
  type: 'skill_installed'
  [k: string]: unknown
}
/**
 * The `skill.list` reply.
 */
export interface SkillList {
  /**
   * References from the most recent discovery of each scope.
   */
  references: SkillReference[]
  skills: SkillSummary[]
  /**
   * The `skills` type tag.
   */
  type: 'skills'
  [k: string]: unknown
}
/**
 * `skill.list`: installed bundles and the stored external references.
 */
export interface SkillListRequest {
  op: 'skill.list'
}
/**
 * `skill.remove`: drop a bundle from the catalog. Provider files are never
 * deleted; adopted paths are released back to external ownership.
 */
export interface SkillRemoveRequest {
  expected_content_hash: string
  name: string
  op: 'skill.remove'
  operation_id: string
}
/**
 * The `skill.remove` reply.
 */
export interface SkillRemoved {
  content_hash: string
  name: string
  /**
   * Adopted provider paths returned to external ownership, left in place.
   */
  released_paths: string[]
  /**
   * The `skill_removed` type tag.
   */
  type: 'skill_removed'
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
/**
 * A cost total over a group of turns.
 */
export interface UsageCostMeasure {
  basis: CostBasis[]
  reported_turns: number
  unreported_turns: number
  /**
   * US dollars summed over turns that reported a cost; null when none did.
   */
  value_usd: number | null
  [k: string]: unknown
}
/**
 * Aggregated figures for one group.
 */
export interface UsageGroup {
  cache_write: UsageMeasure
  cached_input: UsageMeasure
  cost: UsageCostMeasure
  input: UsageMeasure
  /**
   * The group's ID or day. Null in the `total` row, and for turns without
   * a managed account when grouping by account.
   */
  key: string | null
  /**
   * Turns still running, whose figures may grow.
   */
  open_turns: number
  output: UsageMeasure
  reasoning: UsageMeasure
  /**
   * The scopes the counted figures cover. More than one means the group
   * mixes figures that include subagents with figures that do not.
   */
  scopes: UsageScope[]
  turns: number
  /**
   * Turns for which the provider reported nothing at all.
   */
  unreported_turns: number
  [k: string]: unknown
}
/**
 * A token total over a group of turns.
 */
export interface UsageMeasure {
  reported_turns: number
  /**
   * Turns in the group that did not report this figure. The value is
   * complete only when this is 0.
   */
  unreported_turns: number
  /**
   * The sum over turns that reported this figure; null when none did.
   */
  value: number | null
  [k: string]: unknown
}
/**
 * The `usage.limits` reply.
 */
export interface UsageLimits {
  recording: UsageRecording
  /**
   * The `usage_limits` type tag.
   */
  type: 'usage_limits'
  windows: UsageLimitWindow[]
  [k: string]: unknown
}
/**
 * `usage.limits`: the latest rate-limit windows each provider reported.
 */
export interface UsageLimitsRequest {
  account_id?: string | null
  op: 'usage.limits'
  provider?: string | null
}
/**
 * The `usage.summary` reply.
 */
export interface UsageSummary {
  group_by: UsageGroupBy
  groups: UsageGroup[]
  recording: UsageRecording
  total: UsageGroup
  /**
   * The `usage_summary` type tag.
   */
  type: 'usage_summary'
  [k: string]: unknown
}
/**
 * `usage.summary`: aggregate recorded turns by one dimension.
 */
export interface UsageSummaryRequest {
  account_id?: string | null
  conversation_id?: string | null
  group_by: UsageGroupBy
  op: 'usage.summary'
  provider?: string | null
  /**
   * Inclusive lower bound.
   */
  since?: number | null
  /**
   * Exclusive upper bound.
   */
  until?: number | null
  /**
   * Shifts day boundaries for `group_by: day`, from -840 to 840; 0 when absent.
   */
  utc_offset_minutes?: number | null
  workspace_id?: string | null
}
/**
 * Token counts for one turn. `input` counts every prompt token, including
 * tokens read from or written to the prompt cache; `cached_input` and
 * `cache_write` are parts of it. `reasoning` is part of `output`. A null
 * field was not reported by the provider.
 */
export interface UsageTokens {
  cache_write: number | null
  cached_input: number | null
  input: number | null
  output: number | null
  reasoning: number | null
  [k: string]: unknown
}
/**
 * One turn's recorded usage and its provenance.
 */
export interface UsageTurn {
  /**
   * The managed account the turn ran on; null for the provider's own login.
   */
  account_id: string | null
  conversation_id: string
  cost_basis: CostBasis | null
  cost_usd: number | null
  finished: boolean
  models: string[]
  /**
   * Why a figure is partial or unavailable, when the daemon knows.
   */
  note: string | null
  /**
   * When the daemon first observed the turn, in milliseconds since the Unix epoch.
   */
  observed_at: number
  provider: string
  /**
   * False when the provider reported nothing for this turn.
   */
  reported: boolean
  scope: UsageScope | null
  /**
   * The native event the figures came from, such as `thread/tokenUsage/updated`.
   */
  source: string | null
  tokens: UsageTokens
  turn_id: string
  updated_at: number
  workspace_id: string
  [k: string]: unknown
}
/**
 * The `usage.turns` reply.
 */
export interface UsageTurns {
  /**
   * Null when no more records remain.
   */
  next_cursor: string | null
  recording: UsageRecording
  turns: UsageTurn[]
  /**
   * The `usage_turns` type tag.
   */
  type: 'usage_turns'
  [k: string]: unknown
}
/**
 * `usage.turns`: one page of per-turn records, most recently observed first.
 */
export interface UsageTurnsRequest {
  account_id?: string | null
  conversation_id?: string | null
  /**
   * The `next_cursor` of the previous page for the same filters.
   */
  cursor?: string | null
  /**
   * Page size, 1 to 100; the daemon uses 50 when it is absent.
   */
  limit?: number
  op: 'usage.turns'
  provider?: string | null
  /**
   * Inclusive lower bound.
   */
  since?: number | null
  /**
   * Exclusive upper bound.
   */
  until?: number | null
  workspace_id?: string | null
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
 * The `worktree.archived` reply, newest first, at most 200 records.
 */
export interface WorktreeArchive {
  entries: WorktreeArchiveEntry[]
  repository_id: string
  /**
   * The `worktree_archive` type tag.
   */
  type: 'worktree_archive'
  [k: string]: unknown
}
/**
 * The record ADE keeps for a tree it removed. The branch, unless deleted,
 * is the way back to the work.
 */
export interface WorktreeArchiveEntry {
  archived_at: number
  branch: string | null
  branch_deleted: boolean
  /**
   * The commit the tree had checked out when it was removed.
   */
  head: string | null
  /**
   * The `worktree.remove` or `worktree.cleanup` operation that removed it.
   */
  operation_id: string
  path: string
  [k: string]: unknown
}
/**
 * `worktree.archived`: list the archive records of removed trees.
 */
export interface WorktreeArchivedRequest {
  op: 'worktree.archived'
  repository_id: string
}
/**
 * One changed path in the source.
 */
export interface WorktreeCarryEntry {
  blocker?: CarryBlocker | null
  change: CarryChange
  path: string
  selected: boolean
  /**
   * The index differs from `HEAD`. Carried changes arrive staged.
   */
  staged: boolean
  /**
   * The working tree differs from the index.
   */
  unstaged: boolean
  [k: string]: unknown
}
/**
 * The `worktree.carry.preview` reply. Ignored files are never listed or
 * carried; ignored-resource rules handle them.
 */
export interface WorktreeCarryPreview {
  blockers: CarryBlocker[]
  /**
   * True only when `blockers` is empty.
   */
  carriable: boolean
  entries: WorktreeCarryEntry[]
  /**
   * The source commit; pass it as `expect_head`. `null` when unborn.
   */
  head: string | null
  repository_id: string
  source: string
  /**
   * The `worktree_carry_preview` type tag.
   */
  type: 'worktree_carry_preview'
  [k: string]: unknown
}
/**
 * `worktree.carry.preview`: list a tree's uncommitted changes and whether
 * each can be carried. Changes nothing.
 */
export interface WorktreeCarryPreviewRequest {
  op: 'worktree.carry.preview'
  /**
   * Paths relative to the tree root to select; every change when absent.
   * A directory selects the changes beneath it.
   */
  paths?: string[] | null
  repository_id: string
  /**
   * The tree whose changes would move: the primary checkout or a linked tree.
   */
  source: string
}
/**
 * `worktree.carry`: move uncommitted changes from `source` into the clean,
 * ADE-owned tree `target`. The changes are first saved as a commit under
 * `refs/ade/carry/…`, which ADE never deletes, then applied to the target
 * and verified. The source is cleaned only when `clean_source` is true, the
 * target verified exactly, and the source is unchanged since the snapshot.
 * A failure never discards anything.
 */
export interface WorktreeCarryRequest {
  /**
   * Remove the carried changes from the source after verification.
   */
  clean_source?: boolean | null
  /**
   * The source `HEAD` the caller previewed; a different `HEAD` refuses.
   */
  expect_head?: string | null
  op: 'worktree.carry'
  /**
   * Caller-owned operation ID; `request_id` is accepted as an alias.
   */
  operation_id: string
  /**
   * As in `worktree.carry.preview`; every change when absent.
   */
  paths?: string[] | null
  repository_id: string
  source: string
  target: string
}
/**
 * One linked tree's cleanup classification.
 */
export interface WorktreeCleanupCandidate {
  blockers: CleanupBlocker[]
  branch?: string | null
  /**
   * True only when `blockers` is empty.
   */
  eligible: boolean
  path: string
  phase?: WorktreePhase | null
  [k: string]: unknown
}
/**
 * The `worktree.cleanup.plan` reply: every linked tree, primary excluded.
 */
export interface WorktreeCleanupPlan {
  repository_id: string
  trees: WorktreeCleanupCandidate[]
  /**
   * The `worktree_cleanup_plan` type tag.
   */
  type: 'worktree_cleanup_plan'
  [k: string]: unknown
}
/**
 * `worktree.cleanup.plan`: classify every linked tree for cleanup without
 * changing anything.
 */
export interface WorktreeCleanupPlanRequest {
  op: 'worktree.cleanup.plan'
  repository_id: string
}
/**
 * `worktree.cleanup`: run teardown hooks, remove and archive the named
 * trees. Each tree is classified again before its exclusive removal claim;
 * a blocked tree is skipped, never forced.
 */
export interface WorktreeCleanupRequest {
  /**
   * Branch policy for every removed tree; `keep` when absent.
   */
  delete_branch?: BranchPolicy | null
  op: 'worktree.cleanup'
  /**
   * Caller-owned operation ID; `request_id` is accepted as an alias.
   */
  operation_id: string
  /**
   * One to 32 tree paths, each from `worktree.cleanup.plan`.
   */
  paths: string[]
  repository_id: string
}
/**
 * The configuration a caller sends. Absent fields take their defaults; the
 * stored form is [`Config`].
 */
export interface WorktreeConfigInput {
  /**
   * Prefix for branches `worktree.create` names: letters, digits, `.`,
   * `_`, `-` and `/`, at most 64 bytes.
   */
  branch_prefix?: string | null
  /**
   * Start point for `worktree.create` when the request names none.
   */
  default_base?: string | null
  /**
   * Parent directory for new trees; the repository's parent when absent.
   */
  directory?: string | null
  /**
   * Ignored-resource rules, at most 64, applied in each tree ADE creates
   * before its setup hooks.
   */
  resources?: ResourceRule[]
  /**
   * Setup hooks, at most 8, run in order inside each tree ADE creates.
   */
  setup?: Hook[]
  /**
   * Teardown hooks, at most 8, run in order before ADE removes a tree.
   */
  teardown?: Hook[]
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
 * `worktree.create`: create a branch and a linked tree from the repository's
 * naming defaults, then run its setup hooks. With neither `name` nor
 * `branch`, the daemon generates the first free `wt-N` name.
 */
export interface WorktreeCreateRequest {
  /**
   * Start point; the configured `default_base`, then `HEAD`, when absent.
   */
  base?: string | null
  /**
   * An exact branch name, used without the prefix. Conflicts with `name`.
   */
  branch?: string | null
  /**
   * Start from a ref fetched from a configured remote, such as a pull
   * request head. Conflicts with `base`. Only the fetch is performed; ADE
   * adds no pull-request workflow.
   */
  fetch?: WorktreeFetchSource | null
  /**
   * A workspace name; the branch is the configured prefix plus its slug.
   */
  name?: string | null
  op: 'worktree.create'
  /**
   * Caller-owned operation ID; `request_id` is accepted as an alias.
   */
  operation_id: string
  /**
   * Absolute path for the tree, directly inside the configured directory.
   */
  path?: string | null
  repository_id: string
}
/**
 * A ref to fetch from a configured remote into `refs/ade/fetched/…`. The
 * new branch starts at the fetched commit.
 */
export interface WorktreeFetchSource {
  /**
   * A full ref on the remote, such as `refs/pull/12/head` or
   * `refs/merge-requests/12/head`.
   */
  ref: string
  /**
   * A remote name from `git remote`; URLs are refused.
   */
  remote: string
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
  /**
   * The tree's lifecycle phase, for trees ADE created or ran hooks in.
   */
  phase?: WorktreePhase | null
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
 * `worktree.resources.apply`: apply the repository's ignored-resource rules
 * to an ADE-owned tree, such as an adopted one. Existing files are never
 * replaced.
 */
export interface WorktreeResourcesApplyRequest {
  op: 'worktree.resources.apply'
  /**
   * Caller-owned operation ID; `request_id` is accepted as an alias.
   */
  operation_id: string
  path: string
  repository_id: string
}
/**
 * `worktree.setup`: run the setup hooks again in an ADE-owned tree, such as
 * one whose setup failed or was interrupted. Only a full success makes it ready.
 */
export interface WorktreeSetupRequest {
  op: 'worktree.setup'
  /**
   * Caller-owned operation ID; `request_id` is accepted as an alias.
   */
  operation_id: string
  path: string
  repository_id: string
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

export type Operation = "catalog.get" | "workspace.open" | "workspace.rebind.list" | "workspace.rebind" | "repository.rebind.list" | "repository.rebind" | "conversation.get" | "agent.send" | "agent.answer" | "conversation.create" | "draft.get" | "draft.save" | "draft.send.get" | "draft.send.prepare" | "draft.send.complete" | "draft.send.abort" | "draft.send.list" | "draft.send.acknowledge" | "queue.enqueue" | "queue.cancel" | "queue.pause" | "window.save" | "window.close" | "attachment.put" | "attachment.import" | "attachment.inspect" | "attachment.reclaim.preview" | "attachment.reclaim.apply" | "agent.cancel" | "agent.resume" | "agent.disconnect" | "agent.send_review" | "agent.child_transcript" | "agent.list" | "agent.account_inspect" | "provider.list" | "account.list" | "account.create" | "account.inspect" | "account.verify" | "account.disable" | "terminal.create" | "terminal.operation" | "terminal.restart" | "terminal.stop" | "terminal.retire" | "service.configure" | "service.list" | "service.inspect" | "service.start" | "service.stop" | "service.remove" | "service.health.sample" | "service.proxy.ensure" | "service.proxy.inspect" | "service.proxy.target" | "service.proxy.remap" | "service.proxy.retire" | "service.proxy.recovery.inspect" | "service.proxy.recovery.retry" | "service.proxy.recovery.reset" | "listener.list" | "review.status" | "review.diff" | "review.diff_page" | "review.hunk" | "review.stage" | "review.unstage" | "review.discard" | "review.commit" | "review.operation" | "review.operation.list" | "review.operation.acknowledge" | "review.feedback.search" | "worktree.repository" | "worktree.get" | "worktree.switch" | "worktree.adopt" | "worktree.remove" | "worktree.refresh" | "worktree.configure" | "worktree.operation" | "worktree.rebind" | "worktree.rebind.list" | "worktree.create" | "worktree.setup" | "worktree.cleanup.plan" | "worktree.cleanup" | "worktree.archived" | "worktree.carry.preview" | "worktree.carry" | "worktree.resources.apply" | "script.list" | "script.inspect" | "script.start" | "script.stop" | "script.retire" | "script.runs" | "file.list" | "file.search" | "file.preview" | "hello" | "runtime.status" | "runtime.prepare_restart" | "session.subscribe" | "browser.owner.get" | "browser.owner.register" | "browser.owner.unregister" | "browser.list" | "browser.inspect" | "browser.open" | "browser.navigate" | "browser.close" | "browser.operation" | "diagnostics.status" | "diagnostics.export" | "activity.list" | "activity.mark" | "notification.delivery.claim" | "notification.delivery.report" | "notification.delivery.list" | "mcp.server.list" | "mcp.server.inspect" | "mcp.server.add" | "mcp.server.update" | "mcp.server.remove" | "mcp.resolve" | "skill.install" | "skill.adopt" | "skill.remove" | "skill.list" | "skill.inspect" | "skill.discover" | "plugin.list" | "plugin.inspect" | "plugin.install" | "plugin.uninstall" | "plugin.enable" | "plugin.disable" | "plugin.record.get" | "plugin.record.list" | "plugin.record.put" | "plugin.record.delete" | "plugin.setting.list" | "plugin.setting.set" | "plugin.command.invoke" | "plugin.host.status" | "plugin.host.restart" | "orchestration.delegate" | "orchestration.children" | "orchestration.child.get" | "orchestration.child.send" | "orchestration.child.wait" | "orchestration.group.start" | "orchestration.groups" | "orchestration.group.get" | "orchestration.group.compare" | "history.search" | "history.list" | "history.index.status" | "history.index.rebuild" | "history.import.scan" | "history.import.session" | "resources.inspect" | "resources.claim.resolve" | "resources.registry.accept" | "checkpoint.create" | "checkpoint.list" | "checkpoint.restore.preview" | "checkpoint.restore" | "checkpoint.delete" | "usage.summary" | "usage.turns" | "usage.limits" | "remote.host.list" | "remote.host.add" | "remote.host.remove" | "remote.host.probe" | "remote.host.pair" | "remote.host.revoke" | "remote.host.start" | "retention.preview" | "retention.apply" | "browser.diagnostics.attach" | "browser.diagnostics.detach" | "browser.diagnostics.read" | "browser.recording.start" | "browser.recording.stop" | "browser.recording.get" | "repository.coverage" | "repository.clone" | "repository.publish.preview" | "repository.publish" | "hook.subscription.list" | "hook.delivery.list" | "hook.delivery.inspect" | "hook.delivery.retry" | "hook.delivery.abandon" | "provider.capabilities" | "provider.readiness" | "provider.quota" | "preset.list" | "preset.get" | "preset.save" | "preset.delete" | "adapter.list" | "adapter.put" | "adapter.remove" | "adapter.probe"

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
  "worktree.create": WorktreeCreateRequest
  "worktree.setup": WorktreeSetupRequest
  "worktree.cleanup.plan": WorktreeCleanupPlanRequest
  "worktree.cleanup": WorktreeCleanupRequest
  "worktree.archived": WorktreeArchivedRequest
  "worktree.carry.preview": WorktreeCarryPreviewRequest
  "worktree.carry": WorktreeCarryRequest
  "worktree.resources.apply": WorktreeResourcesApplyRequest
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
  "diagnostics.status": DiagnosticsStatusRequest
  "diagnostics.export": DiagnosticsExportRequest
  "activity.list": ActivityListRequest
  "activity.mark": ActivityMarkRequest
  "notification.delivery.claim": NotificationDeliveryClaimRequest
  "notification.delivery.report": NotificationDeliveryReportRequest
  "notification.delivery.list": NotificationDeliveryListRequest
  "mcp.server.list": McpServerListRequest
  "mcp.server.inspect": McpServerInspectRequest
  "mcp.server.add": McpServerAddRequest
  "mcp.server.update": McpServerUpdateRequest
  "mcp.server.remove": McpServerRemoveRequest
  "mcp.resolve": McpResolveRequest
  "skill.install": SkillInstallRequest
  "skill.adopt": SkillAdoptRequest
  "skill.remove": SkillRemoveRequest
  "skill.list": SkillListRequest
  "skill.inspect": SkillInspectRequest
  "skill.discover": SkillDiscoverRequest
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
  "plugin.command.invoke": PluginCommandInvokeRequest
  "plugin.host.status": PluginHostStatusRequest
  "plugin.host.restart": PluginHostRestartRequest
  "orchestration.delegate": DelegateRequest
  "orchestration.children": ChildrenRequest
  "orchestration.child.get": ChildGetRequest
  "orchestration.child.send": ChildSendRequest
  "orchestration.child.wait": ChildWaitRequest
  "orchestration.group.start": GroupStartRequest
  "orchestration.groups": GroupsRequest
  "orchestration.group.get": GroupGetRequest
  "orchestration.group.compare": GroupCompareRequest
  "history.search": HistorySearchRequest
  "history.list": HistoryListRequest
  "history.index.status": HistoryIndexStatusRequest
  "history.index.rebuild": HistoryIndexRebuildRequest
  "history.import.scan": HistoryImportScanRequest
  "history.import.session": HistoryImportRequest
  "resources.inspect": ResourcesInspectRequest
  "resources.claim.resolve": ResourcesClaimResolveRequest
  "resources.registry.accept": ResourcesRegistryAcceptRequest
  "checkpoint.create": CheckpointCreateRequest
  "checkpoint.list": CheckpointListRequest
  "checkpoint.restore.preview": CheckpointRestorePreviewRequest
  "checkpoint.restore": CheckpointRestoreRequest
  "checkpoint.delete": CheckpointDeleteRequest
  "usage.summary": UsageSummaryRequest
  "usage.turns": UsageTurnsRequest
  "usage.limits": UsageLimitsRequest
  "remote.host.list": RemoteHostListRequest
  "remote.host.add": RemoteHostAddRequest
  "remote.host.remove": RemoteHostRemoveRequest
  "remote.host.probe": RemoteHostProbeRequest
  "remote.host.pair": RemotePairRequest
  "remote.host.revoke": RemoteRevokeRequest
  "remote.host.start": RemoteHostStartRequest
  "retention.preview": RetentionPreviewRequest
  "retention.apply": RetentionApplyRequest
  "browser.diagnostics.attach": BrowserDiagnosticsAttachRequest
  "browser.diagnostics.detach": BrowserDiagnosticsDetachRequest
  "browser.diagnostics.read": BrowserDiagnosticsReadRequest
  "browser.recording.start": BrowserRecordingStartRequest
  "browser.recording.stop": BrowserRecordingStopRequest
  "browser.recording.get": BrowserRecordingGetRequest
  "repository.coverage": RepositoryCoverageRequest
  "repository.clone": RepositoryCloneRequest
  "repository.publish.preview": RepositoryPublishPreviewRequest
  "repository.publish": RepositoryPublishRequest
  "hook.subscription.list": HookSubscriptionListRequest
  "hook.delivery.list": HookDeliveryListRequest
  "hook.delivery.inspect": HookDeliveryInspectRequest
  "hook.delivery.retry": HookDeliveryRetryRequest
  "hook.delivery.abandon": HookDeliveryAbandonRequest
  "provider.capabilities": ProviderCapabilitiesRequest
  "provider.readiness": ProviderReadinessRequest
  "provider.quota": ProviderQuotaRequest
  "preset.list": PresetListRequest
  "preset.get": PresetGetRequest
  "preset.save": PresetSaveRequest
  "preset.delete": PresetDeleteRequest
  "adapter.list": AdapterListRequest
  "adapter.put": AdapterPutRequest
  "adapter.remove": AdapterRemoveRequest
  "adapter.probe": AdapterProbeRequest
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
  "worktree.create": WorktreeState
  "worktree.setup": WorktreeState
  "worktree.cleanup.plan": WorktreeCleanupPlan
  "worktree.cleanup": WorktreeState
  "worktree.archived": WorktreeArchive
  "worktree.carry.preview": WorktreeCarryPreview
  "worktree.carry": WorktreeState
  "worktree.resources.apply": WorktreeState
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
  "diagnostics.status": DiagnosticsStatus
  "diagnostics.export": DiagnosticsExport
  "activity.list": ActivityList
  "activity.mark": ActivityMarked
  "notification.delivery.claim": NotificationDeliveryClaim
  "notification.delivery.report": NotificationDeliveryReply
  "notification.delivery.list": NotificationDeliveries
  "mcp.server.list": McpServers
  "mcp.server.inspect": McpServerInspection
  "mcp.server.add": McpServerReply
  "mcp.server.update": McpServerReply
  "mcp.server.remove": McpServerRemoved
  "mcp.resolve": McpResolution
  "skill.install": SkillInstalled
  "skill.adopt": SkillInstalled
  "skill.remove": SkillRemoved
  "skill.list": SkillList
  "skill.inspect": SkillInspection
  "skill.discover": SkillDiscovery
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
  "plugin.command.invoke": PluginCommandResult
  "plugin.host.status": PluginHostReply
  "plugin.host.restart": PluginHostReply
  "orchestration.delegate": ChildDelegated
  "orchestration.children": ChildList
  "orchestration.child.get": ChildReply
  "orchestration.child.send": ChildMessageQueued
  "orchestration.child.wait": ChildWait
  "orchestration.group.start": GroupStarted
  "orchestration.groups": GroupList
  "orchestration.group.get": GroupReply
  "orchestration.group.compare": GroupComparison
  "history.search": HistorySearch
  "history.list": HistoryList
  "history.index.status": HistoryIndexReply
  "history.index.rebuild": HistoryIndexReply
  "history.import.scan": HistoryImportScan
  "history.import.session": HistoryImported
  "resources.inspect": HostResourcesState
  "resources.claim.resolve": HostResourcesState
  "resources.registry.accept": HostResourcesState
  "checkpoint.create": CheckpointCreated
  "checkpoint.list": CheckpointList
  "checkpoint.restore.preview": CheckpointRestorePreview
  "checkpoint.restore": CheckpointRestored
  "checkpoint.delete": CheckpointDeleted
  "usage.summary": UsageSummary
  "usage.turns": UsageTurns
  "usage.limits": UsageLimits
  "remote.host.list": RemoteHosts
  "remote.host.add": RemoteHostReply
  "remote.host.remove": RemoteHostRemoved
  "remote.host.probe": RemoteHostProbe
  "remote.host.pair": RemotePairingReply
  "remote.host.revoke": RemotePairingReply
  "remote.host.start": RemoteHostStart
  "retention.preview": RetentionPreview
  "retention.apply": RetentionApply
  "browser.diagnostics.attach": BrowserDiagnosticsState
  "browser.diagnostics.detach": BrowserDiagnosticsState
  "browser.diagnostics.read": BrowserDiagnostics
  "browser.recording.start": BrowserRecording
  "browser.recording.stop": BrowserRecording
  "browser.recording.get": BrowserRecording
  "repository.coverage": RepositoryCoverage
  "repository.clone": RepositoryCloned
  "repository.publish.preview": RepositoryPublishPreview
  "repository.publish": RepositoryPublished
  "hook.subscription.list": HookSubscriptionList
  "hook.delivery.list": HookDeliveryList
  "hook.delivery.inspect": HookDeliveryReply
  "hook.delivery.retry": HookDeliveryReply
  "hook.delivery.abandon": HookDeliveryReply
  "provider.capabilities": ProviderCapabilities
  "provider.readiness": ProviderReadiness
  "provider.quota": ProviderQuota
  "preset.list": PresetList
  "preset.get": PresetView
  "preset.save": PresetSaved
  "preset.delete": PresetDeleted
  "adapter.list": AdapterList
  "adapter.put": AdapterPut
  "adapter.remove": AdapterRemoved
  "adapter.probe": AdapterProbed
}

export type FeedFrame = CatalogFrame | ConversationChanged | ServiceChanged | ActivityChanged
