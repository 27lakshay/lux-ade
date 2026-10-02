// Generated from the Rust contracts in crates/ade-core/src/contract by scripts/generate-contracts.mjs. Do not edit.

export type ContractDefinition =
  | AccessibilityPreference
  | Account
  | AccountAck
  | AccountChoice
  | AccountContext
  | AccountCreateRequest
  | AccountDisableRequest
  | AccountDisabled
  | AccountInspectRequest
  | AccountInspection
  | AccountListRequest
  | AccountSwitch
  | AccountSwitchListRequest
  | AccountSwitchPreview
  | AccountSwitchPreviewRequest
  | AccountSwitchRequest
  | AccountSwitched
  | AccountSwitches
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
  | AdapterPin
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
  | AgentAnswerOutcome
  | AgentAnswerRequest
  | AgentCancelOutcome
  | AgentCancelOutcomeTag
  | AgentCancelRequest
  | AgentChildTranscriptRequest
  | AgentDisconnectRequest
  | AgentList
  | AgentListRequest
  | AgentResumeRequest
  | AgentRun
  | AgentRunSpec
  | AgentSendRequest
  | AppCommand
  | Appearance
  | AppearanceDiagnostic
  | AppearanceDiagnosticCode
  | AppearancePropagation
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
  | Attention
  | BackendCompatibility
  | BoldColor
  | BoldColorMode
  | BranchPolicy
  | BrowserAttachment
  | BrowserAttachmentState
  | BrowserCaptureKind
  | BrowserClickRequest
  | BrowserCloseRequest
  | BrowserConsoleEntry
  | BrowserContextCapture
  | BrowserContextCaptureRequest
  | BrowserDiagnostics
  | BrowserDiagnosticsAttachRequest
  | BrowserDiagnosticsDetachRequest
  | BrowserDiagnosticsDropped
  | BrowserDiagnosticsReadRequest
  | BrowserDiagnosticsState
  | BrowserEvaluateRequest
  | BrowserEvaluation
  | BrowserImport
  | BrowserImportAvailability
  | BrowserImportClass
  | BrowserImportClassPreview
  | BrowserImportGetRequest
  | BrowserImportPreview
  | BrowserImportPreviewRequest
  | BrowserImportRefusal
  | BrowserImportRunRequest
  | BrowserImportSource
  | BrowserImportedClass
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
  | BrowserPartition
  | BrowserPartitionCreateRequest
  | BrowserPartitionListRequest
  | BrowserPartitionReply
  | BrowserPartitions
  | BrowserRecording
  | BrowserRecordingGetRequest
  | BrowserRecordingStartRequest
  | BrowserRecordingState
  | BrowserRecordingStopRequest
  | BrowserScreenshot
  | BrowserScreenshotRequest
  | BrowserTabRecord
  | BrowserTabReply
  | BrowserTabs
  | BrowserTypeRequest
  | BrowserWait
  | BrowserWaitRequest
  | BrowserWaitState
  | BuiltinPalette
  | Caller
  | Capability1
  | CapabilityChange
  | CapabilityRecord
  | CarryBlocker
  | CarryChange
  | CatalogFrame
  | CatalogGetRequest
  | CatalogProject
  | Catalogue
  | CellColor
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
  | Child
  | ChildAnswerRequest
  | ChildAnswered
  | ChildDelegated
  | ChildGetRequest
  | ChildList
  | ChildMessage
  | ChildMessageQueued
  | ChildMessages
  | ChildMessagesRequest
  | ChildRecord
  | ChildReply
  | ChildRequest
  | ChildSendRequest
  | ChildState
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
  | CommandEntry
  | CommandInvokeOutcome
  | CommandInvokeRequest
  | CommandInvoked
  | CommandKind
  | CommandList
  | CommandListRequest
  | CommandNativeCatalog
  | CommandProvenance
  | CommandSource
  | CommittedChanges
  | CommittedFile
  | Config
  | Config2
  | Connected
  | Content
  | Content2
  | ContextCaptureRequest
  | ContextGetRequest
  | ContextKind
  | ContextNode
  | ContextNodeReply
  | ContextOrigin
  | ContextPlan
  | ContextPlanRequest
  | ContextPreview
  | ContextProvenance
  | ContextSource
  | ContextTransfer
  | ControlAvailability
  | ControlOutcome
  | Conversation
  | ConversationCapabilities
  | ConversationChanged
  | ConversationCompactRequest
  | ConversationControl
  | ConversationControlReply
  | ConversationControls
  | ConversationControlsRequest
  | ConversationCreateRequest
  | ConversationCreated
  | ConversationDeleteRequest
  | ConversationDeleted
  | ConversationDeletedFrame
  | ConversationDeletion
  | ConversationGetRequest
  | ConversationHistory
  | ConversationHistoryRequest
  | ConversationMarkSeenRequest
  | ConversationReloadFrame
  | ConversationRewindHistory
  | ConversationRewindPreview
  | ConversationRewindPreviewRequest
  | ConversationRewindRequest
  | ConversationSnapshot
  | ConversationSnooze
  | ConversationSnoozeList
  | ConversationSnoozeListRequest
  | ConversationSnoozeReply
  | ConversationSnoozeRequest
  | ConversationSteerRequest
  | ConversationUnsnoozeRequest
  | CostBasis
  | CredentialReference
  | CursorColor
  | DaemonHello
  | DelegateRequest
  | DeliveryChannel
  | DeliveryOutcome
  | DeliveryStatus
  | Density
  | Descriptor
  | DeviceAccess
  | DeviceAppInstallRequest
  | DeviceAppInstalled
  | DeviceAppLaunchRequest
  | DeviceAppLaunched
  | DeviceBootRequest
  | DeviceBooted
  | DeviceCapability
  | DeviceCapabilityStatus
  | DeviceFamily
  | DeviceFamilyStatus
  | DeviceHost
  | DeviceInputAction
  | DeviceInputRequest
  | DeviceInputSent
  | DeviceInventory
  | DeviceKey
  | DeviceKind
  | DeviceListRequest
  | DevicePermission
  | DevicePermissionState
  | DevicePermissionStatus
  | DeviceReason
  | DeviceReasonCode
  | DeviceScreenshot
  | DeviceScreenshotRequest
  | DeviceState
  | DeviceSummary
  | DiagnosticClaims
  | DiagnosticCounter
  | DiagnosticCounterKind
  | DiagnosticHost
  | DiagnosticIdentity
  | DiagnosticLive
  | DiagnosticLogs
  | DiagnosticProcessGroup
  | DiagnosticProcessKind
  | DiagnosticProvenance
  | DiagnosticQueue
  | DiagnosticReceipts
  | DiagnosticRedaction
  | DiagnosticResources
  | DiagnosticRetention
  | DiagnosticRun
  | DiagnosticService
  | DiagnosticSeverity
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
  | DraftContextNode
  | DraftGetRequest
  | DraftHistoryEntry
  | DraftHistoryKind
  | DraftHistoryList
  | DraftHistoryListRequest
  | DraftHistoryRestoreRequest
  | DraftReply
  | DraftRestoreOutcome
  | DraftRestored
  | DraftSaveRequest
  | DraftSendAbortRequest
  | DraftSendAcknowledgeRequest
  | DraftSendCompleteRequest
  | DraftSendGetRequest
  | DraftSendListRequest
  | DraftSendPrepareRequest
  | DraftStash
  | DraftStashDropRequest
  | DraftStashDropped
  | DraftStashList
  | DraftStashListRequest
  | DraftStashReply
  | DraftStashRestoreRequest
  | DraftStashSaveOutcome
  | DraftStashSaveRequest
  | DropZone
  | Edge
  | Event
  | Excluded
  | Exclusion
  | ExecutableIdentity
  | ExecutableSettings
  | ExecutionHost
  | ExecutionHostEntry
  | ExecutionHosts
  | ExecutionState
  | Failure
  | FileEntry
  | FileKind
  | FileList
  | FileListRequest
  | FilePreview
  | FilePreviewRequest
  | FileSearch
  | FileSearchRequest
  | GhosttyAppearancePolicies
  | GhosttyExportOmission
  | GhosttyRecovery
  | GhosttyThemeExport
  | GhosttyThemeExportRequest
  | GhosttyThemeValidateRequest
  | GhosttyThemeValidation
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
  | HookPhase
  | HookSubscription
  | HookSubscriptionList
  | HookSubscriptionListRequest
  | HookVerdict
  | HostCapabilities
  | HostReadiness
  | HostResourcesState
  | Inspection
  | InstallOutcome
  | Installation
  | Item
  | KeybindingReset
  | Keybindings
  | Layout
  | LayoutAction
  | LayoutApplied
  | LayoutApplyRequest
  | LayoutChanged
  | LayoutGetRequest
  | LayoutNode
  | LayoutRecord
  | LayoutRemoved
  | LayoutReply
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
  | MessageDelivery
  | MessageDirection
  | ModelCapabilities
  | ModelFormat
  | NativeMessageLocator
  | NativeTerminalEvidence
  | NotificationDeliveries
  | NotificationDelivery
  | NotificationDeliveryClaim
  | NotificationDeliveryClaimRequest
  | NotificationDeliveryListRequest
  | NotificationDeliveryReply
  | NotificationDeliveryReportRequest
  | NotificationPreferences
  | NotificationPreferencesGetRequest
  | NotificationPreferencesSetRequest
  | OmpIdentity
  | Outcome
  | OutputCoverage
  | OutputCoverageReason
  | OutputCoverageStatus
  | PackageRegistry
  | PairingState
  | PaletteCatalog
  | PaletteMode
  | PaneCloseRequest
  | PaneNode
  | ParentMessageQueued
  | ParentSendRequest
  | PartForm
  | PathOverlap
  | PeerEndpoint
  | PendingPhase
  | PendingRequest
  | PendingSend
  | PendingSendList
  | PermissionModeCapability
  | PlacedResource
  | Placement
  | PlacementCheckRequest
  | PlacementDecision
  | PlacementHostsRequest
  | PlacementListRequest
  | PlacementRecordRequest
  | PlacementReleaseRequest
  | PlacementReleased
  | PlacementReply
  | PlacementResolveRequest
  | PlacementSource
  | Placements
  | PlainScreenRecovery
  | PlanRejection
  | PlanStep
  | PlannedPart
  | PluginActivation
  | PluginCommandContribution
  | PluginCommandInvokeRequest
  | PluginCommandOutcome
  | PluginCommandResult
  | PluginContributions
  | PluginDataRecord
  | PluginDetail
  | PluginDevEnterRequest
  | PluginDevLeaveRequest
  | PluginDevMode
  | PluginDisableRequest
  | PluginEnableRequest
  | PluginEntryPoints1
  | PluginGeneration
  | PluginGenerationListRequest
  | PluginGenerationOrigin
  | PluginGenerationState
  | PluginGenerations
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
  | PluginReload
  | PluginReloadStatus
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
  | PreviewTransport
  | ProbeOutcome
  | ProfileSettings
  | ProjectKind
  | Projected
  | PromptInput
  | ProviderCancelEvidence
  | ProviderCancelScope
  | ProviderCancelTermination
  | ProviderCapabilities
  | ProviderCapabilitiesRequest
  | ProviderHistoryConsistency
  | ProviderHistoryContext
  | ProviderHistorySnapshot
  | ProviderInspect
  | ProviderInspectRequest
  | ProviderListRequest
  | ProviderMediaSupport
  | ProviderOrigin
  | ProviderQuota
  | ProviderQuotaRequest
  | ProviderReadiness
  | ProviderReadinessRequest
  | ProviderRegistrationView
  | ProviderRegistrations
  | ProviderRegistrationsRequest
  | ProviderSelection
  | ProviderSupport
  | ProviderWorker
  | ProviderWorkerAck
  | ProviderWorkerAnswerRequest
  | ProviderWorkerAvailability
  | ProviderWorkerCancelRequest
  | ProviderWorkerCancelResult
  | ProviderWorkerCancelTag
  | ProviderWorkerCapability
  | ProviderWorkerCapabilityName
  | ProviderWorkerChildTranscriptRequest
  | ProviderWorkerCompactRequest
  | ProviderWorkerConfigureMcpRequest
  | ProviderWorkerErrorResponse
  | ProviderWorkerEventMethod
  | ProviderWorkerEventNotification
  | ProviderWorkerFailure
  | ProviderWorkerFailureCode
  | ProviderWorkerHistoryPage
  | ProviderWorkerHistoryRequest
  | ProviderWorkerInitialize
  | ProviderWorkerJsonRpcVersion
  | ProviderWorkerLimits
  | ProviderWorkerMethod
  | ProviderWorkerOpenRequest
  | ProviderWorkerOperation
  | ProviderWorkerPin
  | ProviderWorkerRequest
  | ProviderWorkerRequestId
  | ProviderWorkerRequirements
  | ProviderWorkerResponse
  | ProviderWorkerResponseId
  | ProviderWorkerResultResponse
  | ProviderWorkerRewindRequest
  | ProviderWorkerRewindResult
  | ProviderWorkerRpcError
  | ProviderWorkerSendRequest
  | ProviderWorkerSendResult
  | ProviderWorkerSteerRequest
  | ProvidersReply
  | ProxyAvailability
  | QuestionOption
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
  | RebindCatalog
  | RebindListRequest
  | RecoveredAttempt
  | RecoveredAttemptKind
  | Recovery
  | RecoveryClassification
  | RecoveryReport
  | RecoveryStatus
  | ReducedMotion
  | RegistrationState
  | RegistryScope
  | RegistryState
  | RegistryStatus
  | RejectionCode
  | RemoteDaemon
  | RemoteHost
  | RemoteHostAddRequest
  | RemoteHostInstall
  | RemoteHostInstallRequest
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
  | RepositoryRebindEntry
  | RepositoryRebindRequest
  | RepositoryRecord
  | RepositoryTransport
  | RequestAnswer
  | RequestChoice
  | RequestKind
  | RequestMetadata
  | RequestQuestion
  | RequestResolution
  | RequestSchema
  | RequestScope
  | ResolvedAppearance
  | ResolvedSyntaxAppearance
  | ResolvedTerminalAppearance
  | ResourceClaim
  | ResourceKind
  | ResourceKind2
  | ResourceMode
  | ResourceRule
  | ResourcesClaimResolveRequest
  | ResourcesDeviceHoldRequest
  | ResourcesDeviceReleaseRequest
  | ResourcesInspectRequest
  | ResourcesRegistryAcceptRequest
  | ResponseDelivery
  | RestartPrepared
  | RetentionApply
  | RetentionApplyRequest
  | RetentionCandidate
  | RetentionConfigured
  | RetentionItemResult
  | RetentionKind
  | RetentionObservedLog
  | RetentionOutcome
  | RetentionPolicy
  | RetentionPolicyGetRequest
  | RetentionPolicyReply
  | RetentionPolicySetRequest
  | RetentionPreview
  | RetentionPreviewRequest
  | RetentionReceiptStore
  | RetentionWithheld
  | ReviewAnchor
  | ReviewBranchRequest
  | ReviewCommitRequest
  | ReviewDiff
  | ReviewDiffPage
  | ReviewDiffPageRequest
  | ReviewDiffRequest
  | ReviewDiffRow
  | ReviewDiffRowKind
  | ReviewDiscardRequest
  | ReviewFeedback
  | ReviewFeedbackFormat
  | ReviewFeedbackMatch
  | ReviewFeedbackQueued
  | ReviewFeedbackSearch
  | ReviewFeedbackSearchRequest
  | ReviewFeedbackSendRequest
  | ReviewFetchRequest
  | ReviewFile
  | ReviewHunkRequest
  | ReviewMergeAction
  | ReviewMergeRequest
  | ReviewNote
  | ReviewOperationAcknowledgeRequest
  | ReviewOperationAcknowledged
  | ReviewOperationEntry
  | ReviewOperationList
  | ReviewOperationListRequest
  | ReviewOperationReply
  | ReviewOperationRequest
  | ReviewPullRequest
  | ReviewPushRequest
  | ReviewStageRequest
  | ReviewStashAction
  | ReviewStashRequest
  | ReviewStatus
  | ReviewStatusRequest
  | ReviewUnstageRequest
  | RewindScope
  | Rgb
  | Rgba
  | RunChanges
  | RunComparison
  | RunRecord
  | RunSpec
  | RuntimePrepareRestartRequest
  | RuntimeRecovery
  | RuntimeRecoveryReleaseRequest
  | RuntimeRecoveryReleased
  | RuntimeRecoveryRequest
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
  | Settings
  | SettingsAppearanceRequest
  | SettingsChanged
  | SettingsGetRequest
  | SettingsPalettesRequest
  | SettingsResetAppearanceRequest
  | SettingsSetRequest
  | SetupState
  | Side
  | SidebarFlags
  | SidebarId
  | SidebarWidths
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
  | SkillPlaceOutcome
  | SkillPlaceRequest
  | SkillPlaced
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
  | SplitDirection
  | SplitNode
  | StartOutcome
  | StepStatus
  | SubmissionDelivery
  | SubmissionDispatch
  | SubmissionNativeOutcome
  | SubmissionTerminal
  | Support
  | SwitchContinuity
  | SystemAppearanceObservation
  | Tab
  | TabCloseRequest
  | TabTarget
  | TerminalAppearance
  | TerminalAppearanceFrame
  | TerminalAppearanceProvenance
  | TerminalAppearanceRequest
  | TerminalAppearanceSetRequest
  | TerminalChanged
  | TerminalCloseRequest
  | TerminalColor
  | TerminalColorOverrides
  | TerminalConversationFrame
  | TerminalCreateRequest
  | TerminalCreated
  | TerminalCursorShape
  | TerminalDescendant
  | TerminalDetachedFrame
  | TerminalErrorFrame
  | TerminalFontKerning
  | TerminalMetrics
  | TerminalMetricsFrame
  | TerminalOperation
  | TerminalOperationRequest
  | TerminalOutputFrame
  | TerminalOwner
  | TerminalPlace
  | TerminalRecord
  | TerminalRecovery
  | TerminalResizeFrame
  | TerminalRestartRequest
  | TerminalRetireRequest
  | TerminalSnapshotFrame
  | TerminalStopRequest
  | TerminalViewportFrame
  | TerminalWarningFrame
  | ThemeBinding
  | ThemeConsumer
  | ThemeDefinition
  | ThemeDiagnostic
  | ThemeDraftPreview
  | ThemeDraftPreviewRequest
  | ThemeExport
  | ThemeExportRequest
  | ThemeFileCandidate
  | ThemeFileValidateRequest
  | ThemeFileValidation
  | ThemeInspectRequest
  | ThemeInspectResponse
  | ThemeInstallItem
  | ThemeInstallReport
  | ThemeInstallRequest
  | ThemeInstallation
  | ThemeLibrary
  | ThemeLibraryChanged
  | ThemeListRequest
  | ThemeOrigin
  | ThemePackExport
  | ThemePackExportItem
  | ThemePackExportRequest
  | ThemePackIdentity
  | ThemePreview
  | ThemePreviewRequest
  | ThemePreviewSample
  | ThemeProvenance
  | ThemeRecord
  | ThemeRemoval
  | ThemeRemovalImpact
  | ThemeRemovalPlan
  | ThemeRemovalPlanRequest
  | ThemeRemoveRequest
  | ThemeRenameRequest
  | ThemeSection
  | ThemeSections
  | ThemeSelectionSlot
  | ThemeSummary
  | ThemeValidateRequest
  | ThemeValidationResponse
  | Tier
  | TokenReference
  | TrackedDescendant
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
  | WarpThemeValidateRequest
  | WarpThemeValidation
  | Window
  | WindowAck
  | WindowBounds
  | WindowChanged
  | WindowClaimRequest
  | WindowCloseRequest
  | WindowCreateRequest
  | WindowList
  | WindowListRequest
  | WindowReopenRequest
  | WindowSetBoundsRequest
  | WindowSetViewStateRequest
  | WindowShowWorkspaceRequest
  | WindowShown
  | WindowState
  | WindowView
  | WorkspaceAck
  | WorkspaceChoice
  | WorkspaceCreateWorktreeRequest
  | WorkspaceDeleteWorktreeRequest
  | WorkspaceKind
  | WorkspaceMode
  | WorkspaceOpenRequest
  | WorkspaceRebindEntry
  | WorkspaceRebindRequest
  | WorkspaceRecord
  | WorkspaceRemoveRequest
  | WorkspaceRemoved
  | WorkspaceRenameRequest
  | WorkspaceWorktreeKind
  | WorkspaceWorktreeOperation
  | WorkspaceWorktreeOperationChanged
  | WorkspaceWorktreeStatus
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
  | WorktreeHookProgress
  | WorktreeHookRun
  | WorktreeItem
  | WorktreeOperation
  | WorktreeOperationReply
  | WorktreeOperationRequest
  | WorktreeOperationStatus
  | WorktreePhase
  | WorktreeRebindCandidate
  | WorktreeRebindRequest
  | WorktreeRefreshRequest
  | WorktreeRemoveRequest
  | WorktreeRepository
  | WorktreeRepositoryRequest
  | WorktreeResourcesApplyRequest
  | WorktreeSetupRequest
  | WorktreeState
  | WorktreeSwitchRequest
  | XtermReplayEvent
  | XtermReplayRecovery
/**
 * Accessibility preferences: follow the system, enable, or disable.
 */
export type AccessibilityPreference = 'system' | 'on' | 'off'
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
 * Which login a Conversation's Agent runs under.
 */
export type AccountContext = 'managed' | 'ambient'
/**
 * Whether ADE still owes the new native session the transferred context.
 */
export type ContextTransfer = 'none' | 'pending' | 'delivered' | 'superseded'
/**
 * How a conversation keeps going after an account switch.
 */
export type SwitchContinuity = 'native_continuation' | 'new_native_session'
/**
 * How far ADE supports one provider capability.
 */
export type Support = 'supported' | 'native_only' | 'unsupported' | 'unknown'
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
  | 'snooze_ended'
  | 'account_switched'
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
export type RequestResolution = 'outstanding' | 'resolved' | 'withdrawn' | 'expired' | 'unsupported' | 'invalidated'
export type ResponseDelivery = 'not_sent' | 'admitted' | 'dispatched' | 'acknowledged' | 'unknown' | 'rejected'
export type RequestAnswer =
  | {
      kind: 'choice'
      value: unknown
    }
  | {
      answers: {
        [k: string]: unknown[]
      }
      kind: 'questions'
    }
  | {
      kind: 'permissions'
      permissions: unknown
      scope: RequestScope
      strict_auto_review?: boolean | null
    }
export type RequestScope = 'once' | 'turn' | 'session' | 'persistent'
/**
 * What the adapter can prove after requesting a native interruption.
 */
export type ProviderCancelScope = 'turn' | 'submission' | 'session' | 'process' | 'unknown'
export type ProviderCancelTermination = 'requested' | 'confirmed' | 'unknown'
export type AgentCancelOutcomeTag = 'agent_cancel_outcome'
/**
 * An app command a key runs: the desktop's application-menu commands
 * (F015). Every client reads the same keys for them from the daemon.
 */
export type AppCommand =
  | 'new-conversation'
  | 'new-tab'
  | 'new-terminal'
  | 'close-tab'
  | 'split-right'
  | 'command-palette'
  | 'toggle-left-sidebar'
  | 'toggle-right-sidebar'
  | 'toggle-dev-panel'
  | 'open-settings'
/**
 * Light, dark, or follow the system.
 */
export type Appearance = 'light' | 'dark' | 'system'
export type AppearanceDiagnosticCode =
  'missing_theme' | 'missing_section' | 'invalid_definition' | 'wrong_mode' | 'invalid_selection'
/**
 * A palette variant has a fixed mode; system following belongs to the selection.
 */
export type PaletteMode = 'light' | 'dark'
export type AppearancePropagation =
  | {
      revision: number
      state: 'applied'
      [k: string]: unknown
    }
  | {
      applied_revision: number
      desired_revision: number
      state: 'pending'
      [k: string]: unknown
    }
  | {
      desired_revision: number
      message: string
      state: 'unavailable'
      [k: string]: unknown
    }
/**
 * Whether a Conversation needs the person, as the navigator shows it.
 */
export type Attention = 'idle' | 'running' | 'needs_you' | 'error'
/**
 * Bold color is a rendering policy; it never changes native palette/query values.
 */
export type BoldColor = Rgb | BoldColorMode
export type BoldColorMode = 'inherit' | 'bright'
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
 * A data class ADE imports. Every other class is refused, and the preview
 * lists each one with its reason.
 */
export type BrowserImportClass = 'bookmarks' | 'history'
/**
 * A browser ADE can import from, on macOS only.
 */
export type BrowserImportSource = 'chrome' | 'safari'
/**
 * Whether a class can be read from the source now.
 */
export type BrowserImportAvailability = 'ready' | 'missing' | 'permission_denied' | 'unsupported'
/**
 * Where a browser mutation stands.
 */
export type BrowserOperationState = 'accepted' | 'unknown' | 'completed'
/**
 * Where a recording stands.
 */
export type BrowserRecordingState = ('recording' | 'stopped') | 'interrupted'
/**
 * The element state `browser.wait` waits for.
 */
export type BrowserWaitState = 'attached' | 'visible' | 'detached' | 'hidden'
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
/**
 * What a project is.
 */
export type ProjectKind = 'repository' | 'folder'
/**
 * How a color consumer selects a variant independently of app chrome.
 */
export type ThemeBinding =
  | {
      kind: 'follow_app'
    }
  | {
      dark: string
      kind: 'paired'
      light: string
    }
  | {
      kind: 'fixed'
      theme_id: string
    }
/**
 * Whether a window is on screen. A closed window keeps its record, its
 * bounds and its layouts, and comes back as it was on `window.reopen`.
 */
export type WindowState = 'open' | 'closed'
export type CellColor = 'cell-foreground' | 'cell-background'
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
export type ChildState =
  'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'closed' | 'unknown'
/**
 * What a pending request asks for.
 */
export type RequestKind = 'approval' | 'question'
/**
 * How the child's workspace was chosen.
 */
export type WorkspaceMode = 'same' | 'new_worktree'
/**
 * Where a message stands in its receiver's prompt queue.
 */
export type MessageDelivery = 'queued' | 'submitted' | 'cancelled' | 'missing'
/**
 * Which way a message travelled.
 */
export type MessageDirection = 'to_child' | 'to_parent'
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
 * Whether an entry is a slash command or a skill.
 */
export type CommandKind = 'command' | 'skill'
/**
 * Whether a provider root belongs to the user or to one workspace.
 */
export type SkillScope = 'global' | 'workspace'
/**
 * Where an entry was found.
 */
export type CommandSource = 'provider_file' | 'provider_skill' | 'ade_catalog'
/**
 * How an invocation ended.
 */
export type CommandInvokeOutcome = 'queued' | 'unavailable' | 'unknown' | 'cancelled'
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
export type Content2 =
  | {
      explanation: string | null
      steps: PlanStep[]
      type: 'plan'
      [k: string]: unknown
    }
  | {
      call_id: string
      input: unknown
      is_error: boolean
      name: string
      output: string | null
      type: 'tool'
      [k: string]: unknown
    }
  | {
      agents: Child[]
      operation: string
      type: 'subagents'
      [k: string]: unknown
    }
export type StepStatus = 'pending' | 'inProgress' | 'completed' | 'blocked' | 'abandoned'
/**
 * One selection to capture.
 */
export type ContextSource =
  | {
      end_line: number
      kind: 'file_range'
      path: string
      start_line: number
      workspace_id: string
    }
  | {
      hunk: number
      kind: 'diff_hunk'
      path: string
      staged?: boolean
      token: string
      workspace_id: string
    }
  | {
      /**
       * The selection's first buffer row, when the client knows it.
       */
      first_row?: number
      kind: 'terminal_output'
      terminal_id: string
      text: string
      workspace_id: string
    }
  | {
      kind: 'service_log'
      lines: number
      service: string
      text: string
      workspace_id: string
    }
  | {
      capture_id: string
      kind: 'browser_capture'
    }
/**
 * What a context node was captured from.
 */
export type ContextKind = 'file_range' | 'diff_hunk' | 'terminal_output' | 'service_log' | 'browser_capture'
/**
 * Who produced the captured bytes.
 */
export type ContextOrigin = 'daemon_read' | 'client_supplied' | 'browser_owner'
/**
 * How one attachment reaches a provider.
 */
export type PartForm = 'native_image' | 'text_block' | 'prompt_text' | 'adapter_declared'
/**
 * Why a provider would refuse an attachment or the whole prompt.
 */
export type RejectionCode =
  'unsupported_media_type' | 'image_too_large' | 'request_too_large' | 'attachments_unsupported'
/**
 * A control whose support depends on the provider or on ADE's checkpoints.
 */
export type ConversationControl = 'steer' | 'compact' | 'rewind_conversation' | 'rewind_files'
/**
 * How a control request ended.
 */
export type ControlOutcome =
  'unavailable' | 'acknowledged' | 'restored' | 'unchanged' | 'partial' | 'refused' | 'unknown'
export type SubmissionDispatch = 'pending' | 'dispatched'
/**
 * Categories carry no raw provider payload. Recovery is advice, never an
 * authorization to replay a mutation whose outcome might be unknown.
 */
export type Failure =
  | 'authentication'
  | 'rate_limit'
  | 'usage_limit'
  | 'process_exited'
  | 'disconnected'
  | 'invalid_data'
  | 'save_failed'
  | 'outcome_unknown'
  | 'unavailable'
  | 'session_unavailable'
  | 'rejected'
  | 'resource_limit'
export type SubmissionNativeOutcome = 'pending' | 'accepted' | 'rejected' | 'unknown'
export type Recovery =
  | 'sign_in'
  | 'wait_then_retry_manually'
  | 'check_account'
  | 'reconnect_and_reconcile'
  | 'check_storage'
  | 'check_provider'
export type RequestSchema =
  | {
      choices: RequestChoice[]
      kind: 'choices'
    }
  | {
      decline?: RequestChoice | null
      kind: 'questions'
      questions: RequestQuestion[]
    }
  | {
      kind: 'permissions'
      requested: unknown
      scopes: RequestScope[]
      supports_strict_auto_review: boolean
    }
  | {
      kind: 'unsupported'
      reason: string
    }
export type ProviderWorkerFailureCode =
  | 'invalid_request'
  | 'unsupported'
  | 'authentication_required'
  | 'permission_denied'
  | 'rate_limited'
  | 'resource_limit'
  | 'provider_failure'
  | 'protocol_mismatch'
  | 'transport_failure'
  | 'timeout'
  | 'shutdown'
  | 'cancelled'
  | 'integration_bug'
  | 'internal'
export type ProviderHistoryConsistency = 'snapshot' | 'best_effort'
/**
 * What a rewind returns to an earlier point.
 */
export type RewindScope = 'conversation' | 'files'
/**
 * Where a cost figure came from.
 */
export type CostBasis = 'agent_estimate'
/**
 * Where a secret lives. Serialized as `{"env": "NAME"}` or
 * `{"keychain": {"service": "...", "account": "..."}}`.
 */
export type CredentialReference =
  | {
      env: string
    }
  | {
      keychain: {
        account: string
        service: string
      }
    }
/**
 * Cursor fill is literal RGB or the resolved cursor cell color.
 */
export type CursorColor = Rgb | CellColor
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
      project_id: string
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
 * Every profile setting, each at its default until set.
 */
export type Density = 'default' | 'compact'
/**
 * Whether device and computer control is available on a host.
 */
export type DeviceAccess = 'local_host' | 'unsupported'
/**
 * An operation a device can take.
 */
export type DeviceCapability = ('screenshot' | 'boot' | 'install_app' | 'launch_app') | 'input'
/**
 * Why a family or capability is unavailable.
 */
export type DeviceReasonCode =
  | ('device_booting' | 'device_offline' | 'device_unauthorized' | 'device_no_permissions')
  | 'platform_unsupported'
  | 'tool_missing'
  | 'tool_failed'
  | 'permission_denied'
  | 'runtime_missing'
  | 'device_not_booted'
  | 'device_booted'
  | 'target_unverified'
  | 'not_supported'
/**
 * A group of devices that share one adapter and its tools.
 */
export type DeviceFamily = 'computer' | 'ios_simulator' | 'android'
/**
 * An operating-system permission a family needs.
 */
export type DevicePermission = 'screen_recording' | 'accessibility'
/**
 * What the operating system reports for a permission.
 */
export type DevicePermissionState = ('granted' | 'denied') | 'unsupported'
/**
 * One input event. Coordinates are in the device's input space: pixels on
 * Android (the screenshot's pixels), points on an iOS simulator.
 */
export type DeviceInputAction =
  | {
      kind: 'tap'
      x: number
      y: number
      [k: string]: unknown
    }
  | {
      /**
       * 1 to 10000 milliseconds; 300 when absent.
       */
      duration_ms?: number
      from_x: number
      from_y: number
      kind: 'swipe'
      to_x: number
      to_y: number
      [k: string]: unknown
    }
  | {
      kind: 'text'
      text: string
      [k: string]: unknown
    }
  | {
      key: DeviceKey
      kind: 'key'
      [k: string]: unknown
    }
/**
 * A key `device.input` can press. Not every family has every key: an iOS
 * simulator has no Back key.
 */
export type DeviceKey = 'home' | 'back' | 'enter' | 'delete' | 'tab' | 'escape'
/**
 * What kind of target a device is.
 */
export type DeviceKind = 'display' | 'simulator' | 'emulator' | 'physical'
/**
 * The device's observed state.
 */
export type DeviceState =
  | ('booted' | 'booting' | 'shutting_down' | 'shutdown' | 'unknown')
  | 'connected'
  | 'offline'
  | 'unauthorized'
  | 'no_permissions'
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
 * What a measured process group is rooted at.
 */
export type DiagnosticProcessKind = ('daemon' | 'runtime') | 'agent' | 'terminal'
/**
 * The unit a queue gauge counts.
 */
export type DiagnosticUnit = 'items' | 'bytes'
export type DiagnosticSeverity = 'error' | 'warning' | 'info'
/**
 * Where an unknown execution was found.
 */
export type DiagnosticUnknownSource = 'receipt' | 'claim' | 'terminal' | 'conversation' | 'runtime'
/**
 * Why a draft entered a window's history.
 */
export type DraftHistoryKind = 'sent' | 'discarded'
/**
 * How a restore settled.
 */
export type DraftRestoreOutcome = 'restored' | 'already_restored' | 'conflict'
/**
 * How a stash save settled.
 */
export type DraftStashSaveOutcome = ('created' | 'replaced') | 'unchanged'
/**
 * Where a dragged tab or pane lands on a pane: one of its edges (a split) or its centre.
 */
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'centre'
/**
 * An outer edge of the whole centre area.
 */
export type Edge = 'left' | 'right' | 'top' | 'bottom'
export type Event =
  | {
      error: string
      submission: string | null
      type: 'operation_failed'
      [k: string]: unknown
    }
  | {
      admitted: boolean
      dispatch?: SubmissionDispatch | null
      native_outcome?: SubmissionNativeOutcome | null
      submission: string
      turn: string | null
      type: 'submitted'
      [k: string]: unknown
    }
  | {
      session: string
      submission?: string | null
      turn: string | null
      type: 'started'
      [k: string]: unknown
    }
  | {
      error: string | null
      interrupt_requested: boolean
      native_terminal?: NativeTerminalEvidence | null
      session: string
      status: string
      submission?: string | null
      turn: string | null
      type: 'finished'
      [k: string]: unknown
    }
  | {
      item: Item
      session: string
      submission: string | null
      type: 'item'
      [k: string]: unknown
    }
  | {
      id: string
      kind: string
      role: string
      session: string
      submission: string | null
      text: string
      turn: string | null
      type: 'delta'
      [k: string]: unknown
    }
  | {
      id: unknown
      metadata?: RequestMetadata | null
      method: string
      params: unknown
      session: string
      submission: string | null
      supported: boolean
      turn: string | null
      type: 'request'
      [k: string]: unknown
    }
  | {
      id: unknown
      resolution?: RequestResolution | null
      session: string
      submission?: string | null
      type: 'resolved'
      [k: string]: unknown
    }
  | {
      report: {
        [k: string]: unknown
      }
      session: string
      source: string
      turn: string | null
      type: 'usage'
      [k: string]: unknown
    }
  | {
      error: string
      /**
       * The provider turn the error belongs to, when the provider names
       * one. An error for another turn never reaches the active one.
       */
      turn?: string | null
      type: 'error'
      [k: string]: unknown
    }
  | {
      error: string
      type: 'exited'
      [k: string]: unknown
    }
/**
 * Why an entry does not reach a provider.
 */
export type Exclusion = ('disabled' | 'outside_scope' | 'provider_not_selected') | 'unsupported'
/**
 * An execution host. `local` is the host this daemon runs on; a remote host
 * is named by its `remote.host.*` registry ID.
 */
export type ExecutionHost =
  | {
      kind: 'local'
    }
  | {
      host_id: string
      kind: 'remote'
    }
/**
 * How a service preview on this host reaches the viewer.
 */
export type PreviewTransport = 'direct' | 'ssh_forward'
/**
 * The kinds of work that carry an execution host.
 */
export type ResourceKind2 = 'workspace' | 'conversation' | 'terminal' | 'service'
/**
 * What this daemon can prove about a host being able to take new work.
 */
export type HostReadiness = 'ready' | 'started' | 'unavailable' | 'unknown'
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
export type ThemeOrigin = 'bundled' | 'imported' | 'user' | 'plugin'
/**
 * Literal sRGB or the underlying cell color after reverse-video resolution.
 */
export type TerminalColor = Rgb | Rgba | CellColor
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
/**
 * Whether a hook ran as a setup or a teardown hook.
 */
export type HookPhase = 'setup' | 'teardown'
/**
 * How one hook run ended.
 */
export type HookVerdict = 'succeeded' | 'failed' | 'timed_out' | 'unknown'
export type RegistryState = 'ready' | 'blocked'
export type InstallOutcome = 'installed' | 'already_compatible' | 'failed' | 'unknown'
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
/**
 * Which keybindings `settings.set` returns to their defaults: `"all"`, or
 * the listed commands.
 */
export type KeybindingReset = 'all' | AppCommand[]
/**
 * A pane or a split, told apart by `type`. Each variant's struct carries its
 * own tag, so clients get one flat type per node.
 */
export type LayoutNode = PaneNode | SplitNode
/**
 * `row`: side by side; `column`: stacked.
 */
export type SplitDirection = 'row' | 'column'
/**
 * The two sidebars. They only ever swap sides with each other and never hold panes.
 */
export type SidebarId = 'navigator' | 'inspector'
/**
 * What a tab shows. Records are named by ID; a file or diff by its path
 * inside the layout's workspace.
 */
export type TabTarget =
  | {
      id: string
      kind: 'conversation'
      [k: string]: unknown
    }
  | {
      id: string
      kind: 'terminal'
      [k: string]: unknown
    }
  | {
      id: string
      kind: 'browser'
      [k: string]: unknown
    }
  | {
      kind: 'file'
      path: string
      [k: string]: unknown
    }
  | {
      kind: 'diff'
      path: string
      staged: boolean
      [k: string]: unknown
    }
  | {
      kind: 'new_conversation'
      [k: string]: unknown
    }
/**
 * Every change to a layout. New pane and tab IDs come in with the action,
 * and state changes name the state they set, so applying an action twice
 * gives what applying it once gave. Only `move_pane`, `swap_panes` and
 * `dock_pane` move a pane relative to where it is now; `layout.apply`
 * requires `expected_revision` for them, so a retry is recognised.
 * Actions naming a pane, split or tab that is not there change nothing.
 */
export type LayoutAction =
  | {
      left: SidebarId
      type: 'set_sidebar_sides'
      [k: string]: unknown
    }
  | {
      collapsed: boolean
      side: Side
      type: 'set_side_collapsed'
      [k: string]: unknown
    }
  | {
      collapsed: boolean
      sidebar: SidebarId
      type: 'set_collapsed'
      [k: string]: unknown
    }
  | {
      sidebar: SidebarId
      type: 'set_width'
      width: number
      [k: string]: unknown
    }
  | {
      pane_id?: string | null
      tab: Tab
      type: 'open_tab'
      [k: string]: unknown
    }
  | {
      tab_id: string
      type: 'activate_tab'
      [k: string]: unknown
    }
  | {
      tab_id: string
      type: 'close_tab'
      [k: string]: unknown
    }
  | {
      index: number
      pane_id: string
      tab_id: string
      type: 'move_tab'
      [k: string]: unknown
    }
  | {
      new_pane_id: string
      pane_id: string
      tab_id: string
      type: 'drop_tab'
      zone: DropZone
      [k: string]: unknown
    }
  | {
      direction: SplitDirection
      new_pane_id: string
      pane_id: string
      type: 'split_pane'
      [k: string]: unknown
    }
  | {
      pane_id: string
      target_id: string
      type: 'move_pane'
      zone: DropZone
      [k: string]: unknown
    }
  | {
      pane_id: string
      target_id: string
      type: 'swap_panes'
      [k: string]: unknown
    }
  | {
      edge: Edge
      new_pane_id: string
      tab_id: string
      type: 'dock_tab'
      [k: string]: unknown
    }
  | {
      edge: Edge
      pane_id: string
      type: 'dock_pane'
      [k: string]: unknown
    }
  | {
      pane_id: string
      type: 'close_pane'
      [k: string]: unknown
    }
  | {
      pane_id: string
      type: 'focus_pane'
      [k: string]: unknown
    }
  | {
      sizes: number[]
      split_id: string
      type: 'set_split_sizes'
      [k: string]: unknown
    }
  | {
      pane_id?: string | null
      type: 'set_maximized'
      [k: string]: unknown
    }
  | {
      split_id?: string | null
      type: 'equalize_splits'
      [k: string]: unknown
    }
  | {
      type: 'reset_layout'
      [k: string]: unknown
    }
export type Side = 'left' | 'right'
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
      project_ids: string[]
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
 * One placed resource. Everything except a workspace names its workspace,
 * and must run on that workspace's host.
 */
export type PlacedResource =
  | {
      kind: 'workspace'
      workspace_id: string
    }
  | {
      conversation_id: string
      kind: 'conversation'
      workspace_id: string
    }
  | {
      kind: 'terminal'
      terminal_id: string
      workspace_id: string
    }
  | {
      kind: 'service'
      name: string
      workspace_id: string
    }
/**
 * Where a resource's host identity comes from.
 */
export type PlacementSource = 'local_state' | 'recorded'
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
 * The result of one development-mode reload attempt.
 */
export type PluginReloadStatus = 'activated' | 'unchanged' | 'refused' | 'failed'
/**
 * What started an activation generation.
 */
export type PluginGenerationOrigin = 'enable' | 'restore' | 'dev_reload'
/**
 * Where an activation generation is in its life.
 */
export type PluginGenerationState = 'current' | 'draining' | 'leased' | 'retired'
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
/**
 * Reduce motion: follow the system, always, or never.
 */
export type ReducedMotion = 'system' | 'on' | 'off'
export type TerminalCursorShape = 'block' | 'bar' | 'underline'
export type TerminalFontKerning = 'auto' | 'normal' | 'none'
export type ProviderWorkerCapabilityName =
  | 'streaming'
  | 'images'
  | 'text_attachments'
  | 'resume'
  | 'cancel'
  | 'steering'
  | 'tool_approval'
  | 'questions'
  | 'child_transcript'
export type ProviderWorkerAvailability = 'available' | 'unavailable' | 'unsupported'
/**
 * An operation handled by the current worker protocol. Unknown methods cannot be declared supported.
 */
export type ProviderWorkerMethod =
  | 'initialize'
  | 'open'
  | 'send'
  | 'steer'
  | 'cancel'
  | 'answer'
  | 'history'
  | 'configure_mcp'
  | 'compact'
  | 'rewind'
  | 'child_transcript'
/**
 * The durability tier of an operation (proposed architecture, section 4).
 */
export type Tier = 'query' | 'idempotent_command' | 'effect_command'
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
/**
 * Who registered a provider. Every origin goes through the same registry
 * and the same provider interface; none has a privileged path.
 */
export type ProviderOrigin =
  | {
      kind: 'bundled'
      [k: string]: unknown
    }
  | {
      adapter_id: string
      kind: 'adapter'
      revision: number
      [k: string]: unknown
    }
  | {
      kind: 'plugin'
      pin: ProviderWorkerPin
      [k: string]: unknown
    }
export type QuotaState = 'reported' | 'not_reported' | 'unavailable'
export type RegistrationState = 'registered' | 'refused'
export type ProviderWorkerCancelTag = 'cancel_result'
export type ProviderWorkerResponseId = string | number | null
export type ProviderWorkerJsonRpcVersion = '2.0'
export type ProviderWorkerEventMethod = 'event'
export type ProviderWorkerRequestId = string | number
/**
 * A JSON-RPC response with an ADE-owned typed failure in error.data.
 */
export type ProviderWorkerResponse = ProviderWorkerResultResponse | ProviderWorkerErrorResponse
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
/**
 * How runtime restart reconciliation classified one attempt.
 */
export type RecoveryClassification = 'settled' | 'quarantined' | 'unknown'
/**
 * What kind of execution an old runtime incarnation owned.
 */
export type RecoveredAttemptKind = 'provider_turn' | 'terminal' | 'service' | 'script'
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
export type TerminalAppearanceProvenance = 'profile' | 'terminal'
/**
 * What a claim is on.
 */
export type ResourceKind = 'checkout' | 'port' | 'device'
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
 * The review feedback format: `ade-review-feedback-v1`.
 */
export type ReviewFeedbackFormat = 'ade-review-feedback-v1'
/**
 * What `review.merge` does.
 */
export type ReviewMergeAction = 'merge' | 'abort'
/**
 * What `review.stash` does.
 */
export type ReviewStashAction = 'push' | 'pop'
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
 * What a placement did at its provider path.
 */
export type SkillPlaceOutcome = 'created' | 'replaced' | 'up_to_date' | 'external_identical'
/**
 * How a snapshot restores the screen, by snapshot format.
 */
export type TerminalRecovery = GhosttyRecovery | XtermReplayRecovery | PlainScreenRecovery
export type XtermReplayEvent =
  | {
      bytes_base64: string
      offset: number
      type: 'output'
      [k: string]: unknown
    }
  | {
      cols: number
      offset: number
      rows: number
      type: 'resize'
      [k: string]: unknown
    }
export type ThemeConsumer = 'app' | 'terminal' | 'syntax'
export type ThemeSelectionSlot = 'light' | 'dark' | 'fixed'
/**
 * Which agents a turn's figures cover.
 */
export type UsageScope = 'main_agent' | 'all_agents'
/**
 * The dimension `usage.summary` groups turns by.
 */
export type UsageGroupBy = ('conversation' | 'workspace' | 'provider') | 'account' | 'day'
/**
 * What a workspace's folder is.
 */
export type WorkspaceKind = 'primary_checkout' | 'linked_worktree' | 'folder'
/**
 * Which workspace worktree operation a state describes.
 */
export type WorkspaceWorktreeKind = 'create_worktree' | 'delete_worktree'
/**
 * Where a workspace worktree operation stands.
 */
export type WorkspaceWorktreeStatus = ('running' | 'succeeded') | 'failed'
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
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
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
 * One recorded account switch: the provenance of a conversation's account.
 */
export interface AccountSwitch {
  /**
   * True when the switch stopped the conversation's idle Agent process.
   */
  agent_stopped: boolean
  /**
   * How many ADE transcript messages the excerpt carries.
   */
  context_messages: number
  context_transfer: ContextTransfer
  /**
   * True when older messages did not fit the excerpt.
   */
  context_truncated: boolean
  continuity: SwitchContinuity
  conversation_id: string
  created_at: number
  /**
   * What does and does not carry over, in words a user can read.
   */
  disclosure: string
  /**
   * Null when the conversation used the legacy ambient account.
   */
  from_account_id: string | null
  from_generation: number | null
  /**
   * The operation ID that made the switch.
   */
  id: string
  /**
   * The native session the conversation used before the switch.
   */
  previous_native_session: string | null
  provider: string
  to_account_id: string
  to_generation: number
  [k: string]: unknown
}
/**
 * `account.switch.list`: the switches recorded for a conversation.
 */
export interface AccountSwitchListRequest {
  conversation_id: string
  op: 'account.switch.list'
}
/**
 * The `account.switch.preview` reply. Exactly one of `continuity` and
 * `refusal` is set.
 */
export interface AccountSwitchPreview {
  capability: Capability
  continuity: SwitchContinuity | null
  conversation_id: string
  disclosure: string | null
  from_account_id: string | null
  refusal: string | null
  to_account_id: string
  /**
   * Pass as `expected_generation`.
   */
  to_generation: number
  /**
   * The `account_switch_preview` type tag.
   */
  type: 'account_switch_preview'
  [k: string]: unknown
}
/**
 * The adapter's declared account-switch support and its note.
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
 * `account.switch.preview`: ask how a conversation could move to an account.
 */
export interface AccountSwitchPreviewRequest {
  /**
   * The account the conversation would use for future turns.
   */
  account_id: string
  conversation_id: string
  op: 'account.switch.preview'
}
/**
 * `account.switch`: rebind a conversation to another account of the same
 * provider for future turns. Refused while a turn is active.
 */
export interface AccountSwitchRequest {
  account_id: string
  /**
   * How a conversation keeps going after an account switch.
   */
  continuity: 'native_continuation' | 'new_native_session'
  conversation_id: string
  /**
   * The conversation's current account, or null for a legacy ambient
   * conversation. Any other current account refuses the switch.
   */
  expected_account_id?: string | null
  /**
   * The target account's `generation` from the preview or `account.list`.
   */
  expected_generation: number
  op: 'account.switch'
  /**
   * Caller-chosen; reuse it only to retry the same switch.
   */
  operation_id: string
}
/**
 * The `account.switch` reply. A retry with the same operation ID returns it again.
 */
export interface AccountSwitched {
  switch: AccountSwitch
  /**
   * The `account_switched` type tag.
   */
  type: 'account_switched'
  [k: string]: unknown
}
/**
 * The `account.switch.list` reply, oldest first.
 */
export interface AccountSwitches {
  switches: AccountSwitch[]
  /**
   * The `account_switches` type tag.
   */
  type: 'account_switches'
  [k: string]: unknown
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
 * The adapter definition one run launches. A conversation starts on one
 * definition revision; a run carries that definition so the runtime never
 * reads the profile's store, and a later edit never changes a running agent.
 */
export interface AdapterPin {
  definition: AdapterDefinition
  revision: number
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
 * `agent.answer`: the durable effect receipt and latest native resolution evidence.
 */
export interface AgentAnswerOutcome {
  error?: string | null
  operation_id: string
  request_id: string
  request_revision: number
  resolution: RequestResolution
  response_delivery: ResponseDelivery
  source_attempt_id?: string | null
  /**
   * The `agent_answer_outcome` type tag.
   */
  type: 'agent_answer_outcome'
}
/**
 * An answer is fenced by the caller's durable operation and exact request revision.
 */
export interface AgentAnswerRequest {
  answer: RequestAnswer
  conversation_id: string
  op: 'agent.answer'
  operation_id: string
  request_id: string
  request_revision: number
  source_attempt_id?: string | null
}
/**
 * Native interruption evidence attached to the durable agent.cancel operation receipt.
 */
export interface AgentCancelOutcome {
  conversation_id: string
  evidence: ProviderCancelEvidence
  operation_id: string
  source_attempt_id: string
  submission_id: string
  turn_id?: string | null
  type: AgentCancelOutcomeTag
  [k: string]: unknown
}
/**
 * Evidence returned by a native cancellation command and any follow-up status sample.
 */
export interface ProviderCancelEvidence {
  /**
   * Null means the provider has no evidence about remaining foreground work.
   */
  active_work_remaining: boolean | null
  /**
   * Null means the provider has no evidence about background work.
   */
  background_work_remaining: boolean | null
  interruption_requested: boolean
  /**
   * Unix milliseconds for a point-in-time native state sample, when available.
   */
  observed_at_ms: number | null
  /**
   * Null means the provider has no queue-depth evidence.
   */
  queued_work_count: number | null
  scope: ProviderCancelScope
  termination: ProviderCancelTermination
}
/**
 * `agent.cancel`: target one immutable ADE runtime attempt and submission.
 */
export interface AgentCancelRequest {
  conversation_id: string
  op: 'agent.cancel'
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
  /**
   * Runtime attempt and ADE submission are the immutable target identity.
   */
  source_attempt_id: string
  submission_id: string
  /**
   * Native turn, when known. Absence is never a wildcard.
   */
  turn_id?: string
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
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
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
   * The processes the runtime tracks in the provider's tree other than the
   * provider itself, as last observed. It includes descendants that left
   * the provider's process group. The daemon records them with the attempt,
   * so one that escapes between the daemon's own observations stays
   * attributed after a runtime loss (R006). Absent from a runtime that
   * does not track provider trees.
   */
  descendants?: TrackedDescendant[] | null
  /**
   * The provider process ID, when the adapter has one.
   */
  pid: number | null
  spec: AgentRunSpec
  [k: string]: unknown
}
/**
 * One process a runtime tracks by identity: a PID with the platform start
 * stamp that tells a reused PID apart.
 */
export interface TrackedDescendant {
  pid: number
  /**
   * Platform start stamp; only equality and ordering are meaningful.
   */
  started: number
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
  /**
   * The generic adapter definition an `adapter:` run launches, pinned by
   * revision; absent for every other provider.
   */
  adapter?: AdapterPin | null
  conversation: string
  provider: string
  root: string
  run: string
  /**
   * The plugin provider worker a plugin-provider run is leased to; absent
   * for bundled providers.
   */
  worker?: ProviderWorker | null
  [k: string]: unknown
}
/**
 * What the runtime needs to start one plugin provider worker.
 */
export interface ProviderWorker {
  /**
   * The absolute, version-addressed artifact directory.
   */
  artifact_path: string
  /**
   * The manifest's `entry_points.provider`, relative to `artifact_path`.
   */
  entry: string
  pin: ProviderWorkerPin
  /**
   * `plugin:<plugin_id>`.
   */
  provider: string
}
/**
 * The artifact a provider worker runs. A session started on one pin stays
 * on it: a newer version serves new sessions only (architecture section 8).
 */
export interface ProviderWorkerPin {
  /**
   * The plugin activation that published the registration. A lease does
   * not depend on it: re-enabling the same artifact does not change code.
   */
  activation_generation: number
  /**
   * `sha256:<hex>` over the installed artifact's files.
   */
  artifact_digest: string
  plugin_id: string
  version: string
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
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
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
export interface AppearanceDiagnostic {
  code: AppearanceDiagnosticCode
  fallback_id: string
  message: string
  selected_id: string | null
  slot: PaletteMode
  [k: string]: unknown
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
   * `message`, `draft`, `queued_prompt`, `send_intent`, `draft_stash` or `already_discarded`.
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
export interface Rgb {
  b: number
  g: number
  r: number
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
 * `browser.click`: a trusted left click at the centre of the first element the
 * selector matches, once it is visible, enabled, stable and not covered.
 * The fingerprint covers the operation, profile, owner, tab and selector;
 * `timeout_ms` is not part of it.
 */
export interface BrowserClickRequest {
  op: 'browser.click'
  operation_id: string
  owner_id: string
  profile_id: string
  /**
   * A CSS selector of 1 to 1024 characters without control characters.
   */
  selector: string
  tab_id: string
  /**
   * How long to wait for the element to become actionable, 100 to 10000
   * milliseconds; 5000 when absent.
   */
  timeout_ms?: number
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
 * The `browser.context.capture` reply.
 */
export interface BrowserContextCapture {
  capture_id: string
  captured_at_ms: number
  context: Attachment1
  conversation_id: string
  /**
   * The element's lowercase tag name.
   */
  element: string
  owner_id: string
  profile_id: string
  screenshot: Attachment | null
  /**
   * Why there is no screenshot: `not_requested`, `not_visible`,
   * `too_large` or `capture_failed`.
   */
  screenshot_unavailable: string | null
  tab_id: string
  title: string
  /**
   * Parts of the context cut to stay within bounds, such as `html`,
   * `text` or `attributes`.
   */
  truncated: string[]
  /**
   * The `browser_context_capture` type tag.
   */
  type: 'browser_context_capture'
  /**
   * The page URL without user information, query or fragment.
   */
  url: string
  [k: string]: unknown
}
/**
 * The `ade-design-context-v1` document.
 */
export interface Attachment1 {
  id: string
  media_type: string
  name: string
  size: number
  [k: string]: unknown
}
/**
 * `browser.context.capture`: capture one element of one exact tab into two
 * conversation attachments. The first is a UTF-8 JSON document
 * (`ade-design-context-v1`) with the element's redacted HTML snippet,
 * computed styles and geometry. The second, when the element is visible, is a
 * PNG or JPEG screenshot of it. The owner reads the named tab only; it never
 * substitutes the selected or focused tab, and a page that navigates during
 * the capture fails it.
 *
 * `capture_id` is caller-owned and becomes the context attachment's ID; the
 * screenshot's is `<capture_id>-screenshot`. Repeating a capture with the
 * same ID and request returns the stored capture and never captures again;
 * the same ID with another request conflicts.
 */
export interface BrowserContextCaptureRequest {
  /**
   * 1 to 100 ASCII letters, digits, `-` or `_`.
   */
  capture_id: string
  conversation_id: string
  op: 'browser.context.capture'
  owner_id: string
  profile_id: string
  /**
   * Take a screenshot of the element; true when absent.
   */
  screenshot?: boolean | null
  /**
   * A CSS selector of 1 to 1024 characters; its first match is captured.
   */
  selector: string
  tab_id: string
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
 * `browser.evaluate`: evaluate a read-only JavaScript expression in the tab's
 * page. The debugger refuses any expression whose side effects it cannot rule
 * out, such as an assignment, a DOM write or a network call; that is an
 * `invalid_request`. The value returns as JSON and is bounded.
 */
export interface BrowserEvaluateRequest {
  /**
   * 1 to 8192 characters.
   */
  expression: string
  op: 'browser.evaluate'
  owner_id: string
  profile_id: string
  tab_id: string
  /**
   * Execution limit, 50 to 5000 milliseconds; 1000 when absent.
   */
  timeout_ms?: number
}
/**
 * The `browser.evaluate` reply. A value or an exception is reported, never both.
 */
export interface BrowserEvaluation {
  /**
   * The thrown exception's text, cut to 1024 characters.
   */
  exception: string | null
  owner_id: string
  profile_id: string
  tab_id: string
  /**
   * The value's JSON exceeded 65536 bytes and was left out.
   */
  truncated: boolean
  /**
   * The `browser_evaluation` type tag.
   */
  type: 'browser_evaluation'
  /**
   * The page URL without user information, query or fragment; empty when
   * the page is not HTTP(S).
   */
  url: string
  /**
   * The value as JSON; `null` when it has no JSON form, was left out or threw.
   */
  value: unknown
  /**
   * The JavaScript type: `undefined`, `boolean`, `number`, `string`,
   * `bigint`, `object`, `function` or `symbol`; `null` after an exception.
   */
  value_type: string | null
  [k: string]: unknown
}
/**
 * The `browser.import.run` and `browser.import.get` reply.
 */
export interface BrowserImport {
  classes: BrowserImportedClass[]
  import_id: string
  imported_at_ms: number
  partition_id: string
  profile_id: string
  /**
   * What this source holds that was not imported.
   */
  refused: BrowserImportRefusal[]
  source: BrowserImportSource
  source_profile: string | null
  /**
   * The `browser_import` type tag.
   */
  type: 'browser_import'
  [k: string]: unknown
}
/**
 * One imported class.
 */
export interface BrowserImportedClass {
  class: BrowserImportClass
  format: string
  imported: number
  skipped: number
  truncated: number
  [k: string]: unknown
}
/**
 * A class ADE never imports from this source, and why.
 */
export interface BrowserImportRefusal {
  /**
   * Such as `cookies`, `passwords` or `open_tabs`.
   */
  class: string
  reason: string
  [k: string]: unknown
}
/**
 * One class as the source holds it.
 */
export interface BrowserImportClassPreview {
  availability: BrowserImportAvailability
  class: BrowserImportClass
  /**
   * The detected format, such as `chrome-bookmarks-json-1` or
   * `chrome-history-sqlite-68`.
   */
  format: string | null
  /**
   * Entries that would be imported.
   */
  importable: number
  /**
   * The file this class reads.
   */
  path: string
  reason: string | null
  /**
   * Entries skipped: non-HTTP(S) or over-long URLs.
   */
  skipped: number
  /**
   * Entries beyond the import bound that would be left out.
   */
  truncated: number
  [k: string]: unknown
}
/**
 * `browser.import.get`: read a stored import by its ID.
 */
export interface BrowserImportGetRequest {
  import_id: string
  op: 'browser.import.get'
  profile_id?: string | null
}
/**
 * The `browser.import.preview` reply.
 */
export interface BrowserImportPreview {
  classes: BrowserImportClassPreview[]
  profile_id: string
  refused: BrowserImportRefusal[]
  source: BrowserImportSource
  source_profile: string | null
  /**
   * The `browser_import_preview` type tag.
   */
  type: 'browser_import_preview'
  [k: string]: unknown
}
/**
 * `browser.import.preview`: what an import from one source would read. It
 * stores nothing in ADE and never writes the source.
 */
export interface BrowserImportPreviewRequest {
  op: 'browser.import.preview'
  profile_id?: string | null
  source: BrowserImportSource
  /**
   * Chrome only: `Default` or `Profile N`; `Default` when absent. Safari
   * takes none.
   */
  source_profile?: string | null
}
/**
 * `browser.import.run`: import the named classes into a partition's library.
 * `import_id` is caller-owned. The import is one transaction: every requested
 * class is read and stored, or nothing is. Repeating it with the same ID and
 * request returns the stored import without reading the source again; the
 * same ID with another request conflicts.
 */
export interface BrowserImportRunRequest {
  /**
   * One or more distinct classes.
   */
  classes: BrowserImportClass[]
  /**
   * 1 to 128 ASCII letters, digits, `-` or `_`.
   */
  import_id: string
  op: 'browser.import.run'
  /**
   * `default` or a registered partition.
   */
  partition_id: string
  profile_id?: string | null
  source: BrowserImportSource
  source_profile?: string | null
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
 * The `browser.open`, `browser.navigate`, `browser.close`, `browser.click` and
 * `browser.type` reply, relayed from the owner. `payload_fingerprint` is the
 * daemon's fingerprint of the operation, its profile, owner, tab and URL, and
 * for click and type the selector and typed input.
 */
export interface BrowserMutation {
  op: string
  operation_id: string
  owner_id: string
  payload_fingerprint: string
  profile_id: string
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
 * ID.
 */
export interface BrowserOpenRequest {
  op: 'browser.open'
  operation_id: string
  owner_id: string
  /**
   * The browser partition the tab lives in, from `browser.partition.list`.
   * The `default` partition when absent. The partition is part of the
   * operation's fingerprint only when present.
   */
  partition_id?: string | null
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
  operation_id: string
  owner_id: string
  payload_fingerprint: string
  profile_id: string
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
 * One browser partition.
 */
export interface BrowserPartition {
  /**
   * Wall-clock milliseconds; `null` for `default`.
   */
  created_at_ms: number | null
  name: string
  partition_id: string
  [k: string]: unknown
}
/**
 * `browser.partition.create`: register a named partition. `partition_id` is
 * caller-owned: repeating a create with the same ID and name returns the
 * partition unchanged, and the same ID with another name conflicts. The
 * browser owner creates its storage when a tab first opens in it.
 */
export interface BrowserPartitionCreateRequest {
  /**
   * 1 to 64 characters without control characters.
   */
  name: string
  op: 'browser.partition.create'
  /**
   * 1 to 64 lowercase ASCII letters, digits, `-` or `_`, starting with a
   * letter or digit. `default` is reserved.
   */
  partition_id: string
  profile_id?: string | null
}
/**
 * `browser.partition.list`: the profile's browser partitions. A partition is
 * a named browser profile inside an ADE profile, with its own cookies,
 * storage and cache. `default` always exists: it is the storage every tab
 * used before partitions, and it cannot be created or renamed.
 */
export interface BrowserPartitionListRequest {
  op: 'browser.partition.list'
  /**
   * Defaults to this daemon's profile; any other profile is unavailable.
   */
  profile_id?: string | null
}
/**
 * The `browser.partition.create` reply.
 */
export interface BrowserPartitionReply {
  /**
   * False when the partition already existed with this name.
   */
  created: boolean
  partition: BrowserPartition
  profile_id: string
  /**
   * The `browser_partition` type tag.
   */
  type: 'browser_partition'
  [k: string]: unknown
}
/**
 * The `browser.partition.list` reply, `default` first.
 */
export interface BrowserPartitions {
  /**
   * The most named partitions a profile holds.
   */
  limit: number
  partitions: BrowserPartition[]
  profile_id: string
  /**
   * The `browser_partitions` type tag.
   */
  type: 'browser_partitions'
  [k: string]: unknown
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
 * The `browser.screenshot` reply.
 */
export interface BrowserScreenshot {
  captured_at_ms: number
  /**
   * Base64 image bytes.
   */
  data: string
  height: number
  /**
   * `image/png` or `image/jpeg`.
   */
  media_type: string
  owner_id: string
  profile_id: string
  /**
   * The capture was scaled down to fit.
   */
  scaled: boolean
  tab_id: string
  /**
   * The `browser_screenshot` type tag.
   */
  type: 'browser_screenshot'
  /**
   * The page URL without user information, query or fragment; empty when
   * the page is not HTTP(S).
   */
  url: string
  width: number
  [k: string]: unknown
}
/**
 * `browser.screenshot`: the visible viewport of the tab's page, scaled so no
 * side exceeds 1600 pixels and encoded within 512 KiB.
 */
export interface BrowserScreenshotRequest {
  op: 'browser.screenshot'
  owner_id: string
  profile_id: string
  tab_id: string
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
   * The tab's browser partition; absent for `default`.
   */
  partitionId?: string | null
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
 * `browser.type`: focus the first editable element the selector matches and
 * insert text as trusted input. The caret moves to the end of the element's
 * content first, or the content is selected and replaced when `replace` is
 * true. The fingerprint covers the operation, profile, owner, tab, selector,
 * text and `replace`; `timeout_ms` is not part of it. The owner's receipt
 * never stores the text.
 */
export interface BrowserTypeRequest {
  op: 'browser.type'
  operation_id: string
  owner_id: string
  profile_id: string
  /**
   * Replace the element's content; false when absent.
   */
  replace?: boolean | null
  /**
   * A CSS selector of 1 to 1024 characters without control characters.
   */
  selector: string
  tab_id: string
  /**
   * 1 to 4096 characters. Tab and line feed are the only control characters.
   */
  text: string
  /**
   * 100 to 10000 milliseconds; 5000 when absent.
   */
  timeout_ms?: number
}
/**
 * The `browser.wait` reply.
 */
export interface BrowserWait {
  elapsed_ms: number
  owner_id: string
  profile_id: string
  satisfied: boolean
  selector: string
  state: BrowserWaitState
  tab_id: string
  /**
   * The `browser_wait` type tag.
   */
  type: 'browser_wait'
  /**
   * The page URL without user information, query or fragment; empty when
   * the page is not HTTP(S).
   */
  url: string
  [k: string]: unknown
}
/**
 * `browser.wait`: wait until the selector reaches a state in the tab's page.
 * A wait that runs out of time is an answer, not an error: `satisfied` is
 * false.
 */
export interface BrowserWaitRequest {
  op: 'browser.wait'
  owner_id: string
  profile_id: string
  /**
   * A CSS selector of 1 to 1024 characters without control characters.
   */
  selector: string
  /**
   * `visible` when absent.
   */
  state?: BrowserWaitState | null
  tab_id: string
  /**
   * 0 to 10000 milliseconds; 5000 when absent. 0 checks once.
   */
  timeout_ms?: number
}
export interface BuiltinPalette {
  id: string
  mode: PaletteMode
  name: string
  tokens: {
    [k: string]: string
  }
  [k: string]: unknown
}
/**
 * One capability and why it has that support.
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
  managed_accounts: Capability12
  models: ModelCapabilities
  name: string
  permission_modes: PermissionModeCapability[]
  provider: string
  quota: Capability15
  reasoning: ReasoningCapabilities
  /**
   * Raised by the adapter whenever the declared capabilities change.
   */
  revision: number
  [k: string]: unknown
}
export interface ConversationCapabilities {
  account_switch: Capability2
  compaction: Capability3
  fork: Capability4
  import: Capability5
  resume: Capability6
  rewind: Capability7
  steering: Capability8
  [k: string]: unknown
}
/**
 * Changing account inside one conversation.
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
 * Summarizing earlier context on request.
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
 * Branching a native session into a new one.
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
 * Importing native history that ADE did not create.
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
 * Reopening a native session after a restart.
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
 * Returning the conversation, and possibly files, to an earlier point.
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
 * Adding input to a running turn.
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
 * How long an approval can last. ADE never widens a grant while mapping it.
 */
export interface GrantCapabilities {
  once: Capability9
  persistent: Capability10
  session: Capability11
  [k: string]: unknown
}
/**
 * Approving one request only.
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
 * Approving similar requests in saved native settings.
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
 * Approving similar requests for the rest of the session.
 */
export interface Capability11 {
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
export interface Capability12 {
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
  discovery: Capability13
  format: ModelFormat
  selection: Capability14
  [k: string]: unknown
}
/**
 * Listing the models an account can use.
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
 * Choosing a model when a conversation starts.
 */
export interface Capability14 {
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
export interface Capability15 {
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
  selection: Capability16
  /**
   * True when the provider offers a different subset per model.
   */
  varies_by_model: boolean
  [k: string]: unknown
}
/**
 * Choosing a reasoning level when a conversation starts.
 */
export interface Capability16 {
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
  /**
   * The projects of the listed workspaces, in the order their first
   * workspace was registered.
   */
  projects: CatalogProject[]
  /**
   * The listed workspaces' terminals, in creation order.
   */
  terminals: TerminalRecord[]
  /**
   * Every window, open and closed, as `window.list` gives them.
   */
  windows: Window[]
  workspaces: WorkspaceRecord[]
  [k: string]: unknown
}
export interface Conversation {
  account_context: AccountContext
  account_id: string | null
  active_turn_id: string | null
  /**
   * Derived from `status` and open requests
   * (`crate::workspaces::attention`). Set on every reply, never stored.
   */
  attention: 'idle' | 'running' | 'needs_you' | 'error'
  error: string | null
  /**
   * The ADE placement of this Conversation; filled from the profile placement record for each reply.
   */
  execution_host:
    | {
        kind: 'local'
      }
    | {
        host_id: string
        kind: 'remote'
      }
  /**
   * The orchestration group this child runs in, if any. Set on every
   * reply, never stored.
   */
  group_id: string | null
  id: string
  /**
   * The Conversation that delegated this one, when it is an
   * orchestration child. Set on every reply, never stored.
   */
  parent_conversation_id: string | null
  provider: string
  provider_config: unknown
  provider_thread_id: string | null
  queue_paused: boolean
  /**
   * The turn that was active when the person resumed the queue. That
   * turn's interruption or failure then leaves the queue running, so a
   * wake received while an older run cleans up is kept (R003).
   */
  queue_resumed_during?: string | null
  runtime_cursor: number
  runtime_run: string | null
  runtime_submission: string | null
  status: string
  title: string
  /**
   * Whether the Conversation has a message the person did not write
   * (a reply, a notice) newer than the profile's seen mark
   * (`conversation.mark_seen`). Status changes show in `attention`
   * instead. Set on every reply, never stored.
   */
  unread: boolean
  updated_at: number
  workspace_id: string
  [k: string]: unknown
}
/**
 * A project as the catalog lists it. Every workspace names its project in
 * `WorkspaceRecord::project_id`, and the worktree lifecycle takes a
 * repository project's ID as its `project_id`.
 */
export interface CatalogProject {
  id: string
  kind: ProjectKind
  /**
   * The display name: a repository's checkout folder (see
   * `crate::workspaces::project_name`), or the folder's own name.
   */
  name: string
  /**
   * A repository's Git common directory, or the folder.
   */
  root: string
  [k: string]: unknown
}
/**
 * A terminal as the catalog lists it. It is owned by its workspace and
 * stored by the daemon; `status`, `busy`, `foreground` and a title the
 * program set follow the runtime and reach the feed as `terminal_changed`.
 */
export interface TerminalRecord {
  appearance_binding: ThemeBinding | null
  /**
   * A process other than the terminal's own program holds its foreground,
   * such as a command started from the shell. Closing asks first.
   */
  busy: boolean
  /**
   * Set when `status` is `exited` and the process reported a code. A
   * process ended by a signal reports 128 plus the signal number.
   */
  exit_code: number | null
  /**
   * The busy foreground process's command name, such as `sleep`.
   */
  foreground: string | null
  id: string
  /**
   * A `TerminalKind`. The contract keeps it an open string so a client
   * built before a new kind still reads the catalog.
   */
  kind: string
  /**
   * The workspace's first shell. Closing it gives the workspace a new one.
   */
  primary: boolean
  script_run_id: string | null
  service_id: string | null
  /**
   * A `TerminalStatus`, an open string for the same reason as `kind`.
   */
  status: string
  /**
   * The title given at creation, else the title the program set, else
   * its command or the service or script name.
   */
  title: string
  workspace_id: string
  [k: string]: unknown
}
/**
 * A window: which workspace it shows, where it is and its view state. Its
 * panes and tabs are in one [`LayoutRecord`] per workspace it has shown.
 */
export interface Window {
  /**
   * Null until a UI sets them.
   */
  bounds: WindowBounds | null
  id: string
  /**
   * The revision of each layout the window has stored, by workspace ID.
   * After missing feed frames (a reconnect), a client compares these with
   * the revisions it holds and reads each layout that differs with
   * `layout.get`; a workspace absent here has the default layout.
   */
  layouts: {
    [k: string]: number
  }
  state: WindowState
  view: WindowView
  /**
   * The workspace the window shows.
   */
  workspace_id: string
  [k: string]: unknown
}
/**
 * A window's position and size, in screen points. The daemon checks only
 * that they are finite and positive; a UI applies its own minimum size.
 */
export interface WindowBounds {
  height: number
  width: number
  x: number
  y: number
  [k: string]: unknown
}
/**
 * Per-window view state a second UI on the same window shares. Focus,
 * scroll, hover and drag state stay local to each UI.
 */
export interface WindowView {
  /**
   * Project IDs whose rows the navigator shows collapsed.
   */
  collapsed_projects: string[]
  /**
   * Workspaces this window showed, most recent first; the first is the
   * one it shows now.
   */
  recent_workspaces: string[]
  [k: string]: unknown
}
export interface WorkspaceRecord {
  /**
   * Whether ADE made (or adopted) this linked worktree and may delete it.
   */
  ade_owned: boolean
  /**
   * The branch the checkout's `HEAD` names; null when `HEAD` is detached
   * or the workspace is not a Git checkout. The daemon refreshes it on
   * open, after its own Git operations and when `HEAD` changes.
   */
  branch: string | null
  /**
   * Whether this is the daemon's own workspace: attachments that name no
   * workspace open their terminal here, and it cannot be removed. Set on
   * every reply, never stored.
   */
  default: boolean
  id: string
  /**
   * Whether this is a repository's primary checkout, a linked worktree or
   * a plain folder.
   */
  kind: 'primary_checkout' | 'linked_worktree' | 'folder'
  name: string
  needs_rebind: boolean
  /**
   * The project this workspace belongs to; never empty. A repository
   * workspace's project is its repository; a plain folder is a project of
   * its own.
   */
  project_id: string
  root: string
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
export interface Child {
  id: string
  name: string | null
  session_id: string | null
  state: ChildState
  summary: string | null
  [k: string]: unknown
}
/**
 * `orchestration.child.answer`: answer a question or approval a child is
 * waiting on, from the parent's view.
 */
export interface ChildAnswerRequest {
  /**
   * Structured answers; required by the `answer` decision.
   */
  answers?: unknown
  caller: Caller
  child_conversation_id: string
  /**
   * As for `agent.answer`: accept, decline, cancel or answer.
   */
  decision: string
  op: 'orchestration.child.answer'
  /**
   * One of the child's `pending_requests`.
   */
  request_id: string
}
/**
 * The `orchestration.child.answer` reply: the answer is on its way to the
 * child's Agent.
 */
export interface ChildAnswered {
  attribution: string
  child_conversation_id: string
  request_id: string
  /**
   * The `child_answered` type tag.
   */
  type: 'child_answered'
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
  /**
   * Questions and approvals the child waits on, oldest first. Answer each
   * once with `orchestration.child.answer`.
   */
  pending_requests: ChildRequest[]
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
 * A question or approval the child waits on, as its parent sees it.
 */
export interface ChildRequest {
  kind: RequestKind
  /**
   * The provider's request method.
   */
  method: string
  /**
   * The provider's request, including its questions or command.
   */
  params: unknown
  request_id: string
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
 * One message between a child and its parent.
 */
export interface ChildMessage {
  /**
   * `user`, or `agent:` followed by the sending Conversation ID.
   */
  attribution: string
  created_at: number
  delivery: MessageDelivery
  direction: MessageDirection
  message_id: string
  operation_id: string
  /**
   * The Conversation that receives it.
   */
  receiver_conversation_id: string
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
 * The `orchestration.child.messages` reply.
 */
export interface ChildMessages {
  child_conversation_id: string
  messages: ChildMessage[]
  parent_conversation_id: string
  /**
   * The `child_messages` type tag.
   */
  type: 'child_messages'
  [k: string]: unknown
}
/**
 * `orchestration.child.messages`: every message between a child and its
 * parent, oldest first.
 */
export interface ChildMessagesRequest {
  child_conversation_id: string
  op: 'orchestration.child.messages'
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
 * One command or skill and whether ADE can hand it to the provider.
 */
export interface CommandEntry {
  /**
   * The provider's argument hint, such as `<file>`.
   */
  argument_hint: string | null
  description: string | null
  invocable: boolean
  /**
   * The native text the provider receives without arguments, such as `/review`.
   */
  invocation: string | null
  kind: CommandKind
  /**
   * The native path ADE uses, such as `claude.prompt_slash`.
   */
  mechanism: string | null
  name: string
  provenance: CommandProvenance
  /**
   * Why the entry cannot be invoked, or a caveat when it can.
   */
  reason: string | null
  [k: string]: unknown
}
/**
 * Where an entry came from.
 */
export interface CommandProvenance {
  /**
   * The ADE catalog bundle with the same content, if any.
   */
  catalog_name: string | null
  /**
   * The skill bundle content hash, when the entry is a valid skill.
   */
  content_hash: string | null
  /**
   * The file or directory ADE read.
   */
  path: string | null
  /**
   * Absent for catalog-only bundles.
   */
  scope: SkillScope | null
  source: CommandSource
  [k: string]: unknown
}
/**
 * `command.invoke`: hand a listed command or skill to the Conversation's
 * provider in its native form. The invocation joins the Conversation's
 * prompt queue under the derived queue ID `<operation_id>:command`.
 */
export interface CommandInvokeRequest {
  /**
   * Free text passed after the command, as the provider's own input would.
   */
  arguments?: string
  conversation_id: string
  kind: CommandKind
  /**
   * The entry name as `command.list` reported it, without a leading slash.
   */
  name: string
  op: 'command.invoke'
  operation_id: string
}
/**
 * The `command.invoke` reply.
 */
export interface CommandInvoked {
  conversation_id: string
  kind: CommandKind
  mechanism: string | null
  name: string
  /**
   * The exact text queued for the provider.
   */
  native_text: string | null
  operation_id: string
  outcome: CommandInvokeOutcome
  /**
   * The queued prompt's ID.
   */
  queue_id: string | null
  reason: string | null
  /**
   * The `command_invoked` type tag.
   */
  type: 'command_invoked'
  [k: string]: unknown
}
/**
 * The `command.list` reply.
 */
export interface CommandList {
  conversation_id: string
  /**
   * Sorted by kind, then name, then path.
   */
  entries: CommandEntry[]
  native_catalog: CommandNativeCatalog
  provider: string
  /**
   * Provider paths or scopes this listing did not read, and why.
   */
  skipped: string[]
  /**
   * The `command_list` type tag.
   */
  type: 'command_list'
  [k: string]: unknown
}
/**
 * What the provider itself reports about its commands. ADE does not yet ask
 * a live provider session for its list, so built-in and plugin commands are
 * not shown and cannot be invoked through ADE.
 */
export interface CommandNativeCatalog {
  /**
   * The provider method that would list them, when one exists.
   */
  method: string | null
  queried: boolean
  reason: string
  [k: string]: unknown
}
/**
 * `command.list`: the commands and skills available to one Conversation.
 * Reads provider paths and the skill catalog; writes nothing.
 */
export interface CommandListRequest {
  conversation_id: string
  op: 'command.list'
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
export interface Config2 {
  model: string | null
  permission_mode: string
  setting_sources: string[]
}
export interface Connected {
  history: Item[]
  /**
   * Set when a rewind forked `session` from this one after the Agent
   * opened (F039): a daemon that reattaches may still hold it.
   */
  rewound_from?: string | null
  session: string
  [k: string]: unknown
}
export interface Item {
  client_id: string | null
  content?: Content2 | null
  id: string
  kind: string
  native_message?: NativeMessageLocator | null
  role: string
  status: string
  text: string
  turn: string | null
  [k: string]: unknown
}
export interface PlanStep {
  status: StepStatus
  step: string
  [k: string]: unknown
}
/**
 * Provider-native transcript identity. It is independent of ADE message IDs,
 * client IDs, and turn IDs, and is valid only in its native session.
 */
export interface NativeMessageLocator {
  message_id: string
  provider: string
  session: string
  [k: string]: unknown
}
export interface Content {
  attachment: Attachment
  data: string
  [k: string]: unknown
}
/**
 * `context.capture`: capture one selection into a context node.
 */
export interface ContextCaptureRequest {
  conversation_id: string
  op: 'context.capture'
  /**
   * The node ID, and the ID of the attachment a text capture stores.
   */
  request_id: string
  source: ContextSource
}
/**
 * `context.get`: read one recorded context node.
 */
export interface ContextGetRequest {
  conversation_id: string
  node_id: string
  op: 'context.get'
}
/**
 * One captured selection and the attachments that carry it.
 */
export interface ContextNode {
  /**
   * Add these to a draft or send to include the node.
   */
  attachments: Attachment[]
  captured_at: number
  conversation_id: string
  id: string
  kind: ContextKind
  omitted_bytes: number
  omitted_lines: number
  origin: ContextOrigin
  provenance: ContextProvenance
  /**
   * Lowercase hex SHA-256 of each attachment's bytes, in order.
   */
  sha256: string[]
  /**
   * Whether bounds cut the selection. The stored document says so too.
   */
  truncated: boolean
  [k: string]: unknown
}
/**
 * Where a node came from. Fields that do not apply to its kind are null.
 */
export interface ContextProvenance {
  capture_id: string | null
  diff_token: string | null
  end_line: number | null
  hunk: number | null
  path: string | null
  service: string | null
  staged: boolean | null
  /**
   * The captured lines, 1-based and inclusive, within the source.
   */
  start_line: number | null
  terminal_id: string | null
  title: string | null
  /**
   * The source's line count when the daemon read the whole source.
   */
  total_lines: number | null
  /**
   * The captured page's URL, without user information, query or fragment.
   */
  url: string | null
  workspace_id: string | null
  [k: string]: unknown
}
/**
 * The `context.capture` and `context.get` reply.
 */
export interface ContextNodeReply {
  /**
   * False when an attachment was reclaimed; attach the context again.
   */
  available: boolean
  node: ContextNode
  /**
   * Each live attachment in order. A text attachment carries the exact
   * document the provider receives after its plan's `text_prefix`.
   */
  previews: ContextPreview[]
  /**
   * The `context_node` type tag.
   */
  type: 'context_node'
  [k: string]: unknown
}
/**
 * What one node attachment holds, for a preview before sending.
 */
export interface ContextPreview {
  attachment_id: string
  media_type: string
  /**
   * The UTF-8 document of a `text/plain` attachment; null for an image.
   */
  text: string | null
  [k: string]: unknown
}
/**
 * The `context.plan` reply.
 */
export interface ContextPlan {
  /**
   * True only when there are no rejections.
   */
  admissible: boolean
  parts: PlannedPart[]
  rejections: PlanRejection[]
  support: ProviderMediaSupport
  /**
   * The `context_plan` type tag.
   */
  type: 'context_plan'
  [k: string]: unknown
}
/**
 * One attachment's planned form.
 */
export interface PlannedPart {
  attachment_id: string
  form: PartForm
  /**
   * The exact text placed before a text attachment's contents.
   */
  text_prefix: string | null
  [k: string]: unknown
}
/**
 * One refusal found before dispatch.
 */
export interface PlanRejection {
  /**
   * Null when the refusal covers the whole prompt.
   */
  attachment_id: string | null
  code: RejectionCode
  message: string
  [k: string]: unknown
}
/**
 * What a provider accepts, and where each limit comes from.
 */
export interface ProviderMediaSupport {
  image_form: string | null
  image_types: string[]
  /**
   * False for a provider ADE has no table for, such as a generic adapter.
   */
  known: boolean
  /**
   * The largest image, in raw bytes, this provider takes.
   */
  max_image_bytes: number | null
  /**
   * The largest whole prompt request, in bytes, this provider takes.
   */
  max_request_bytes: number | null
  provider: string
  /**
   * Where the limits come from.
   */
  sources: string[]
  text_form: string | null
  [k: string]: unknown
}
/**
 * `context.plan`: how the conversation's provider would receive these
 * attachments, and which it would refuse, before anything is sent.
 */
export interface ContextPlanRequest {
  attachments?: Attachment[]
  conversation_id: string
  op: 'context.plan'
  /**
   * The prompt text, which counts toward request limits.
   */
  text?: string
}
/**
 * Whether one control may run on a Conversation now.
 */
export interface ControlAvailability {
  available: boolean
  control: ConversationControl
  /**
   * What performs the control: a native provider method such as
   * `turn/steer`, or `ade.checkpoints` for file rewind. Absent when nothing does.
   */
  mechanism: string | null
  /**
   * Why the control is unavailable; absent when it is available.
   */
  reason: string | null
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
  delivery?: SubmissionDelivery | null
  id: string
  kind: string
  native_message?: NativeMessageLocator | null
  provider_item_id: string | null
  review_feedback?: unknown
  role: string
  sequence: number
  status: string
  text: string
  turn_id: string | null
  [k: string]: unknown
}
/**
 * Durable, request-correlated send evidence. A command acknowledgement is not native acceptance.
 */
export interface SubmissionDelivery {
  admitted: boolean
  dispatch: SubmissionDispatch
  error: Failure | null
  native_outcome: SubmissionNativeOutcome
  native_turn_id: string | null
  /**
   * The saved user Message whose prompt/attachments remain available for manual recovery.
   */
  recoverable_message_id: string
  recovery: Recovery | null
  request_id: string
  terminal: SubmissionTerminal | null
}
export interface SubmissionTerminal {
  /**
   * False until the send receipt proves this native turn belongs to request_id.
   */
  correlated: boolean
  error: Failure | null
  interrupt_requested: boolean
  native_terminal?: NativeTerminalEvidence | null
  /**
   * Native terminal status, including unknown provider values; not derived from assistant text.
   */
  status: string
  turn_id?: string | null
}
/**
 * Provider-reported terminal evidence, kept separate from ADE's interrupt request.
 */
export interface NativeTerminalEvidence {
  api_error_status?: unknown
  errors?: unknown
  is_error?: boolean | null
  stop_reason?: string | null
  subtype?: string | null
  terminal_reason?: string | null
}
export interface QueuedPrompt {
  attachments?: Attachment[]
  conversation_id: string
  id: string
  status: string
  text: string
  [k: string]: unknown
}
/**
 * Client-facing state; raw provider params and answers remain private.
 */
export interface PendingRequest {
  conversation_id: string
  id: string
  metadata: RequestMetadata
  resolution: RequestResolution
  response_delivery: ResponseDelivery
  response_operation_id?: string | null
  /**
   * ADE-owned revision, separate from source-attempt and native revisions.
   */
  revision: number
  source_attempt_id?: string | null
}
/**
 * Immutable, versioned display schema supplied by the provider adapter.
 */
export interface RequestMetadata {
  /**
   * Preserve absence when the provider does not state whether this blocks.
   */
  blocking: boolean | null
  created_at_ms?: number | null
  expires_at_ms?: number | null
  native_callback_id?: unknown
  native_item_id?: string | null
  native_request_id: unknown
  native_revision?: unknown
  native_session_id?: string | null
  native_turn_id?: string | null
  schema: RequestSchema
  schema_version: number
  summary: string
}
/**
 * A native choice. `value` is the provider's ID or decision, not an ADE ID.
 */
export interface RequestChoice {
  duration?: string | null
  label: string
  scope?: RequestScope | null
  value: unknown
}
export interface RequestQuestion {
  allow_other: boolean
  header?: string | null
  id: string
  multiple: boolean
  options?: QuestionOption[] | null
  prompt: string
  secret: boolean
}
export interface QuestionOption {
  description: string
  label: string
  value: unknown
}
/**
 * `conversation.compact`: ask the provider to compact its context now.
 */
export interface ConversationCompactRequest {
  conversation_id: string
  op: 'conversation.compact'
  operation_id: string
}
/**
 * The reply to `conversation.steer`, `conversation.compact` and `conversation.rewind`.
 */
export interface ConversationControlReply {
  control: ConversationControl
  conversation_id: string
  /**
   * The checkpoint restore result of a file rewind.
   */
  files: CheckpointRestored | null
  /**
   * What a Conversation rewind removed, and the new history epoch.
   */
  history?: ConversationRewindHistory | null
  operation_id: string
  outcome: ControlOutcome
  reason: string | null
  /**
   * The turn the provider accepted steered input into.
   */
  turn_id: string | null
  /**
   * The `conversation_control` type tag.
   */
  type: 'conversation_control'
  [k: string]: unknown
}
/**
 * What a Conversation rewind removes, or removed.
 */
export interface ConversationRewindHistory {
  /**
   * The first removed message: the user message that started `turn_id`.
   */
  before_message_id: string
  /**
   * The history epoch: current for a preview, the new one after a rewind.
   */
  history_epoch: number
  kept_messages: number
  /**
   * Provider-native locator for the prompt the rewind removes; distinct from ADE IDs.
   */
  native_message?: NativeMessageLocator | null
  /**
   * After a rewind the provider performed by forking: the native session
   * the Conversation continues in. The earlier one is kept unchanged.
   */
  native_session?: string | null
  /**
   * After a forking rewind: the native session the Conversation left.
   */
  previous_native_session?: string | null
  removed_messages: number
  removed_turns: number
  /**
   * Names the previewed history; a rewind refuses a history that changed.
   */
  state_token: string
  /**
   * The provider turn the rewind returns to before.
   */
  turn_id: string
  [k: string]: unknown
}
export interface ConversationControls {
  controls: ControlAvailability[]
  conversation_id: string
  provider: string
  /**
   * The active snooze, if any.
   */
  snooze: ConversationSnooze | null
  /**
   * The `conversation_controls` type tag.
   */
  type: 'conversation_controls'
  [k: string]: unknown
}
/**
 * A durable snooze: attention to the Conversation is deferred until `until`.
 * It never stops or starts agent work.
 */
export interface ConversationSnooze {
  conversation_id: string
  snoozed_at: number
  /**
   * Wake time, milliseconds since the Unix epoch.
   */
  until: number
  [k: string]: unknown
}
/**
 * `conversation.controls`: which controls the Conversation supports now.
 */
export interface ConversationControlsRequest {
  conversation_id: string
  op: 'conversation.controls'
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
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
  /**
   * A saved preset whose provider, model and permission mode the
   * Conversation uses. Refused when the provider's current capabilities
   * conflict with it; never combined with `provider_config`. A preset
   * carries no account, so it never changes `account_id`.
   */
  preset?: string
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
 * `conversation.delete`: delete a Conversation that is not running a turn.
 * An idle Agent is stopped first. The daemon removes its messages, pending
 * requests, drafts, draft history and stashes, queue, send intents and
 * snooze, closes its tabs in every layout, and leaves a tombstone: every later read,
 * write, page or search that names the Conversation is refused as deleted.
 * Attachment payloads stay until retention reclaims them.
 */
export interface ConversationDeleteRequest {
  conversation_id: string
  op: 'conversation.delete'
  /**
   * The caller's operation ID. The deletion and its receipt commit in one
   * transaction; a retry with the same ID returns the recorded reply.
   */
  operation_id: string
}
/**
 * The `conversation.delete` reply.
 */
export interface ConversationDeleted {
  /**
   * Live attachment payloads the deletion left in place. Nothing references
   * them any more, so retention reclaims each once its grace period passes.
   */
  attachments_left_for_retention: number
  conversation_id: string
  /**
   * When the tombstone was written, in Unix milliseconds.
   */
  deleted_at: number
  operation_id: string
  removed: ConversationDeletion
  /**
   * The `conversation_deleted` type tag.
   */
  type: 'conversation_deleted'
  workspace_id: string
  [k: string]: unknown
}
/**
 * What one deletion removed.
 */
export interface ConversationDeletion {
  draft_history: number
  draft_stashes: number
  drafts: number
  /**
   * Layouts that showed the Conversation in a tab and no longer do.
   */
  layouts_changed: number
  messages: number
  queued_prompts: number
  requests: number
  send_intents: number
  snoozes: number
  [k: string]: unknown
}
/**
 * The `conversation_deleted` feed frame. A client drops its view of the
 * Conversation; a snapshot or page read earlier is stale.
 */
export interface ConversationDeletedFrame {
  boot_id: string
  conversation_id: string
  deleted_at: number
  revision: number
  /**
   * The `conversation_deleted` type tag.
   */
  type: 'conversation_deleted'
  workspace_id: string
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
   * The `history_epoch` of the snapshot the caller is paging from. An
   * older page (`before` set) is refused once a rewind replaced history,
   * so a client never splices pages of two histories together.
   */
  history_epoch?: number
  /**
   * Page size; defaults to 32 and may not exceed 32. ADE sequence/epoch paging is unchanged.
   */
  limit?: number
  op: 'conversation.get'
}
export interface ConversationHistory {
  /**
   * False for a failed or truncated read, including a single oversized item.
   */
  complete: boolean
  conversation_id: string
  error: ProviderWorkerFailure | null
  history_epoch: number
  messages: Message[]
  next_native_cursor: string | null
  /**
   * Actual encoded retained Message array bytes, not a claimed source/page limit.
   */
  retained_bytes: number
  /**
   * Null only when an initial read failed before identifying its native source.
   */
  snapshot: ProviderHistorySnapshot | null
  /**
   * True only for safely matching identified content retained after a temporary refusal.
   */
  stale: boolean
  /**
   * The `conversation_history` type tag.
   */
  type: 'conversation_history'
}
export interface ProviderWorkerFailure {
  code: ProviderWorkerFailureCode
  message: string
}
/**
 * Native snapshot identity; never an ADE feed cursor or message sequence.
 */
export interface ProviderHistorySnapshot {
  account_id?: string | null
  consistency: ProviderHistoryConsistency
  execution_id: string
  generation: string
  invalidation_epoch: number
  lineage?: string | null
  /**
   * Native source timestamp in milliseconds since Unix epoch; unknown is absent/null.
   */
  modified_at_ms?: number | null
  provider: string
  session: string
  /**
   * Actual measured native file bytes; unknown is absent/null, never a page cap or synthetic zero.
   */
  size_bytes?: number | null
  source: string
}
/**
 * Read native history through the owning daemon, not the provider SDK or runtime.
 * The daemon constructs and validates execution/account/source context. Native
 * cursors below are distinct from conversation.get's ADE message sequence.
 */
export interface ConversationHistoryRequest {
  conversation_id: string
  /**
   * ADE's durable invalidation fence, never a native cursor or source generation.
   */
  history_epoch?: number | null
  max_bytes?: number
  max_items?: number
  native_cursor?: string | null
  op: 'conversation.history'
  /**
   * Echo a previously returned native snapshot; null/absent starts an identified read.
   */
  snapshot?: ProviderHistorySnapshot | null
}
/**
 * `conversation.mark_seen`: the person has seen the Conversation, so it is
 * no longer `unread`. The mark only moves forward; a `conversation_changed`
 * frame follows when `unread` changes.
 */
export interface ConversationMarkSeenRequest {
  conversation_id: string
  op: 'conversation.mark_seen'
  /**
   * The newest message `sequence` the client showed; the newest message
   * when absent. A later sequence counts as the newest, so a message the
   * client has not shown yet stays unread.
   */
  through?: number | null
}
/**
 * The `conversation_reload` feed frame: the Conversation's messages changed
 * in a way a delta cannot carry (a rewind, or an Agent run replacing its
 * history). A client holding its messages reads a new snapshot.
 */
export interface ConversationReloadFrame {
  boot_id: string
  conversation: Conversation
  revision: number
  /**
   * The `conversation_reload` type tag.
   */
  type: 'conversation_reload'
  [k: string]: unknown
}
export interface ConversationRewindPreview {
  availability: ControlAvailability
  conversation_id: string
  /**
   * The checkpoint restore preview; present for an available file rewind.
   */
  files: CheckpointRestorePreview | null
  /**
   * What an available Conversation rewind would remove.
   */
  history?: ConversationRewindHistory | null
  scope: RewindScope
  /**
   * The `conversation_rewind_preview` type tag.
   */
  type: 'conversation_rewind_preview'
  [k: string]: unknown
}
/**
 * `conversation.rewind.preview`: whether a rewind may run, and what a file
 * rewind would change.
 */
export interface ConversationRewindPreviewRequest {
  /**
   * The user message a Conversation rewind removes, with every later
   * message; required for `conversation`.
   */
  before_message_id?: string | null
  /**
   * The checkpoint a file rewind restores; required for `files`.
   */
  checkpoint_id?: string | null
  conversation_id: string
  op: 'conversation.rewind.preview'
  scope: RewindScope
}
/**
 * `conversation.rewind`: perform a previewed rewind.
 */
export interface ConversationRewindRequest {
  /**
   * Required for `conversation`: the user message to remove with every later message.
   */
  before_message_id?: string | null
  /**
   * Required for `files`.
   */
  checkpoint_id?: string | null
  /**
   * Required when the preview listed uncommitted work it would overwrite.
   */
  confirm_overwrite?: boolean
  conversation_id: string
  /**
   * The preview's `state_token` (of `files` or `history`); required for both scopes.
   */
  expected_state?: string | null
  /**
   * Exact provider-native locator returned by the matching history preview.
   */
  native_message?: NativeMessageLocator | null
  op: 'conversation.rewind'
  operation_id: string
  scope: RewindScope
}
/**
 * The `conversation.get` reply.
 */
export interface ConversationSnapshot {
  boot_id: string
  conversation: Conversation
  /**
   * Durable; grows each time a rewind replaces this Conversation's history.
   */
  history_epoch: number
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
export interface ConversationSnoozeList {
  snoozes: ConversationSnooze[]
  /**
   * The `conversation_snooze_list` type tag.
   */
  type: 'conversation_snooze_list'
  [k: string]: unknown
}
/**
 * `conversation.snooze.list`: active snoozes, soonest wake first.
 */
export interface ConversationSnoozeListRequest {
  /**
   * Page size, at most 500; the daemon uses 100 when it is absent.
   */
  limit?: number | null
  op: 'conversation.snooze.list'
}
export interface ConversationSnoozeReply {
  conversation_id: string
  /**
   * The snooze after the command; absent when none is active.
   */
  snooze: ConversationSnooze | null
  /**
   * The `conversation_snooze` type tag.
   */
  type: 'conversation_snooze'
  [k: string]: unknown
}
/**
 * `conversation.snooze`: defer attention until a future time, at most 366 days ahead.
 */
export interface ConversationSnoozeRequest {
  conversation_id: string
  op: 'conversation.snooze'
  /**
   * Wake time, milliseconds since the Unix epoch.
   */
  until: number
}
/**
 * `conversation.steer`: add input to the running turn. The provider must
 * accept it into `turn_id`; it is never queued as a new prompt.
 */
export interface ConversationSteerRequest {
  conversation_id: string
  op: 'conversation.steer'
  /**
   * Caller-owned operation ID; it also becomes the steered message's ID.
   */
  operation_id: string
  /**
   * At most 1 MiB.
   */
  text: string
  /**
   * The turn the caller saw running. Steering refuses when another turn is active.
   */
  turn_id: string
}
/**
 * `conversation.unsnooze`: end a snooze now without recording a wake.
 */
export interface ConversationUnsnoozeRequest {
  conversation_id: string
  op: 'conversation.unsnooze'
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
  /**
   * Context for the child, stated explicitly: live attachments of the
   * parent Conversation, at most 8. The daemon copies them to the child
   * under new IDs and sends them with the task; the child's provider must
   * accept each. None when absent.
   */
  context_attachments?: Attachment[]
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
 * `device.app.install`: install an app bundle on one booted device. The
 * path is on the device's host: a `.app` directory for a simulator or an
 * `.apk` file for Android. The daemon reads the app's identity from the
 * bundle and confirms the device reports it installed at that version.
 */
export interface DeviceAppInstallRequest {
  app_path: string
  device_id: string
  host_id: string
  op: 'device.app.install'
  operation_id: string
}
/**
 * The `device.app.install` reply.
 */
export interface DeviceAppInstalled {
  /**
   * The bundle identifier or Android package name.
   */
  app_id: string
  device_id: string
  host_id: string
  operation_id: string
  /**
   * The `device_app_installed` type tag.
   */
  type: 'device_app_installed'
  /**
   * `CFBundleVersion` or the Android version code.
   */
  version: string
  [k: string]: unknown
}
/**
 * `device.app.launch`: launch an installed app on one booted device.
 */
export interface DeviceAppLaunchRequest {
  /**
   * The bundle identifier or Android package name.
   */
  app_id: string
  device_id: string
  host_id: string
  op: 'device.app.launch'
  operation_id: string
}
/**
 * The `device.app.launch` reply. It is sent only once the device reports a
 * process for the app.
 */
export interface DeviceAppLaunched {
  app_id: string
  device_id: string
  host_id: string
  operation_id: string
  /**
   * The app's process ID on the device.
   */
  pid: number
  /**
   * The `device_app_launched` type tag.
   */
  type: 'device_app_launched'
  [k: string]: unknown
}
/**
 * `device.boot`: boot one simulator or AVD and wait until it is usable.
 * Booting a booted device records that it already was.
 */
export interface DeviceBootRequest {
  device_id: string
  host_id: string
  op: 'device.boot'
  operation_id: string
  /**
   * How long to wait for the boot to finish, 5000 to 300000 milliseconds;
   * 120000 when absent. A boot still running at the deadline stays open:
   * repeat the same operation ID to reconcile it.
   */
  timeout_ms?: number
}
/**
 * The `device.boot` reply.
 */
export interface DeviceBooted {
  /**
   * True when the device was booted before this operation ran.
   */
  already_booted: boolean
  device_id: string
  host_id: string
  operation_id: string
  /**
   * The adb serial of a booted Android device.
   */
  serial: string | null
  /**
   * The `device_booted` type tag.
   */
  type: 'device_booted'
  [k: string]: unknown
}
/**
 * Whether one capability is available on one device now.
 */
export interface DeviceCapabilityStatus {
  available: boolean
  capability: DeviceCapability
  /**
   * Why it is unavailable; null when available.
   */
  reason: DeviceReason | null
  [k: string]: unknown
}
/**
 * A reason with the plain-language detail to show a user.
 */
export interface DeviceReason {
  code: DeviceReasonCode
  detail: string
  [k: string]: unknown
}
/**
 * One family's availability on the host.
 */
export interface DeviceFamilyStatus {
  available: boolean
  family: DeviceFamily
  permissions: DevicePermissionStatus[]
  /**
   * Why the family, or part of it, is unavailable.
   */
  reasons: DeviceReason[]
  /**
   * The tools the adapter found, such as `/usr/bin/xcrun`.
   */
  tools: string[]
  [k: string]: unknown
}
/**
 * One permission as the operating system reports it to the daemon.
 */
export interface DevicePermissionStatus {
  permission: DevicePermission
  state: DevicePermissionState
  /**
   * Which process the answer is for. macOS attributes the daemon's
   * permission to the application that launched it.
   */
  subject: string
  [k: string]: unknown
}
/**
 * The physical host whose devices these are.
 */
export interface DeviceHost {
  /**
   * Stable across restarts and renames: `host-` and 16 hex digits.
   */
  host_id: string
  host_name: string
  /**
   * `macos`, `linux` or another Rust target OS name.
   */
  platform: string
  [k: string]: unknown
}
/**
 * `device.input`: send one input event to one exact booted device. The
 * daemon never sends it to the focused, booted or only device instead, and
 * records who asked.
 */
export interface DeviceInputRequest {
  action: DeviceInputAction
  /**
   * Who asks. An Agent caller names its own Conversation; the daemon records
   * the attribution and refuses an Agent that acts as another Conversation.
   */
  caller:
    | {
        kind: 'user'
        [k: string]: unknown
      }
    | {
        conversation_id: string
        kind: 'agent'
        [k: string]: unknown
      }
  device_id: string
  host_id: string
  op: 'device.input'
  operation_id: string
}
/**
 * The `device.input` reply, sent once the device's tool accepted the event.
 */
export interface DeviceInputSent {
  action: DeviceInputAction
  /**
   * `user`, or `agent:<conversation ID>`.
   */
  attribution: string
  device_id: string
  host_id: string
  operation_id: string
  /**
   * The adb serial the event went to on Android; null for a simulator.
   */
  serial: string | null
  /**
   * The `device_input_sent` type tag.
   */
  type: 'device_input_sent'
  [k: string]: unknown
}
/**
 * The `device.list` reply.
 */
export interface DeviceInventory {
  devices: DeviceSummary[]
  families: DeviceFamilyStatus[]
  host: DeviceHost
  observed_at_ms: number
  /**
   * The `device_inventory` type tag.
   */
  type: 'device_inventory'
  [k: string]: unknown
}
/**
 * One device on the host.
 */
export interface DeviceSummary {
  capabilities: DeviceCapabilityStatus[]
  /**
   * The stable identity every targeted operation names.
   */
  device_id: string
  family: DeviceFamily
  kind: DeviceKind
  name: string
  /**
   * The simulator runtime, such as `iOS 26.4`, or the AVD's name.
   */
  runtime: string | null
  /**
   * The current adb serial of a running Android device. It can change
   * between boots and is never a target.
   */
  serial: string | null
  state: DeviceState
  [k: string]: unknown
}
/**
 * `device.list`: discover the host's devices and why any are unavailable.
 */
export interface DeviceListRequest {
  /**
   * Probe only this family; every family when absent.
   */
  family?: DeviceFamily | null
  op: 'device.list'
}
/**
 * The `device.screenshot` reply.
 */
export interface DeviceScreenshot {
  bytes: number
  /**
   * Standard base64 of the PNG, at most 16 MiB before encoding.
   */
  bytes_base64: string
  captured_at_ms: number
  device_id: string
  height: number
  host_id: string
  /**
   * The `image/png` type tag.
   */
  mime: 'image/png'
  /**
   * Lowercase hex SHA-256 of the PNG bytes.
   */
  sha256: string
  /**
   * The `device_screenshot` type tag.
   */
  type: 'device_screenshot'
  width: number
  [k: string]: unknown
}
/**
 * `device.screenshot`: capture one exact device as a PNG.
 */
export interface DeviceScreenshotRequest {
  device_id: string
  host_id: string
  op: 'device.screenshot'
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
 * Host capacity at `observed_at`.
 */
export interface DiagnosticHost {
  /**
   * The one-minute load average times 1000 (1.5 is 1500).
   */
  load_average_milli: number | null
  logical_cpus: number | null
  memory_bytes: number | null
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
 * One process and its descendants, measured once at `observed_at`.
 */
export interface DiagnosticProcessGroup {
  /**
   * Summed user and system CPU time of `pids` since each started.
   */
  cpu_time_ms: number | null
  /**
   * Summed physical footprint of `pids`, or `null` when none could be read.
   */
  footprint_bytes: number | null
  /**
   * The Agent run or terminal incarnation, when there is one.
   */
  incarnation: string | null
  kind: DiagnosticProcessKind
  note: string
  /**
   * Every process counted in this group: the root and its descendants.
   * Groups nest (the runtime's tree holds its Agents and terminals), so a
   * process can appear in more than one group.
   */
  pids: number[]
  /**
   * How far a reported number can be trusted.
   */
  provenance: 'exact' | 'approximate' | 'unavailable'
  root_pid: number
  /**
   * The daemon boot, runtime incarnation, Conversation or terminal.
   */
  subject: string
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
   * `sessions`, `lifecycle`, `review`, `plugins` or `browser`.
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
 * Measured process and host resources (F136).
 */
export interface DiagnosticResources {
  groups: DiagnosticProcessGroup[]
  host: DiagnosticHost
  /**
   * How memory was measured, such as `phys_footprint`, which leaves out
   * memory shared with other processes.
   */
  method: string
  /**
   * False when the process table could not be read; every group is then
   * `unavailable` and the totals are `null`.
   */
  observed: boolean
  /**
   * When the measurement was taken, in Unix milliseconds. A client shows
   * the values as stale once this is old.
   */
  observed_at: number
  total_cpu_time_ms: number | null
  /**
   * Footprint of the distinct processes, each counted once.
   */
  total_footprint_bytes: number | null
  /**
   * Distinct processes across all groups; nested groups are counted once.
   */
  total_processes: number
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
  resources: DiagnosticResources
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
  context_nodes?: DraftContextNode[]
  revision: number
  text: string
  [k: string]: unknown
}
/**
 * A reference the prompt carried besides its text and attachments, such as a
 * file, selection, terminal excerpt or review comment. ADE keeps `data`
 * exactly as the client supplied it.
 */
export interface DraftContextNode {
  data: unknown
  id: string
  kind: string
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
 * One recalled draft of a window.
 */
export interface DraftHistoryEntry {
  attachments: Attachment[]
  context_nodes: DraftContextNode[]
  conversation_id: string
  /**
   * The window draft revision this text had when it was recorded.
   */
  draft_revision: number
  id: number
  kind: DraftHistoryKind
  /**
   * Milliseconds since the Unix epoch.
   */
  recorded_at: number
  text: string
  window_id: string
  [k: string]: unknown
}
/**
 * The `draft.history.list` reply.
 */
export interface DraftHistoryList {
  entries: DraftHistoryEntry[]
  /**
   * The `before` value of the next page; null on the last page.
   */
  next_before: number | null
  /**
   * The `draft_history` type tag.
   */
  type: 'draft_history'
  [k: string]: unknown
}
/**
 * `draft.history.list`: a Conversation's recalled drafts, newest first.
 */
export interface DraftHistoryListRequest {
  /**
   * Return entries with an ID below this one.
   */
  before?: number
  conversation_id: string
  /**
   * Page size from 1 to 100; the daemon uses 20 when it is absent.
   */
  limit?: number | null
  op: 'draft.history.list'
  /**
   * Only this window's drafts; every window's when it is absent, so a
   * closed or crashed window's drafts stay reachable.
   */
  window_id?: string
}
/**
 * `draft.history.restore`: make a recalled draft the window's draft. The
 * entry may come from any window of the Conversation.
 */
export interface DraftHistoryRestoreRequest {
  conversation_id: string
  entry_id: number
  /**
   * The window draft revision the caller last saw; 0 when it saw none.
   */
  expected_revision: number
  op: 'draft.history.restore'
  /**
   * The revision the restored draft takes; greater than `expected_revision`.
   */
  revision: number
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
 * The `draft.history.restore` and `draft.stash.restore` reply.
 */
export interface DraftRestored {
  /**
   * The restored context nodes. The window draft does not store them, so
   * the caller reattaches them; empty on a conflict.
   */
  context_nodes: DraftContextNode[]
  /**
   * The history entry that keeps the draft this restore replaced; null
   * when it replaced nothing worth keeping.
   */
  displaced_entry_id: number | null
  draft: Draft1
  outcome: DraftRestoreOutcome
  /**
   * The `draft_restore` type tag.
   */
  type: 'draft_restore'
  [k: string]: unknown
}
/**
 * The schema of [`Draft`], which the model defines without one.
 */
export interface Draft1 {
  attachments?: Attachment[]
  context_nodes?: DraftContextNode[]
  revision: number
  text: string
  [k: string]: unknown
}
/**
 * `draft.save`: store a newer draft revision for one window.
 */
export interface DraftSaveRequest {
  attachments?: Attachment[]
  /**
   * Context nodes the window attached, such as `context.capture` nodes.
   * They are kept with this revision and restored after a crash.
   */
  context_nodes?: DraftContextNode[]
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
  context_nodes?: DraftContextNode[]
  conversation_id: string
  draft_text: string
  op: 'draft.send.prepare'
  request_id: string
  revision: number
  text: string
  window_id: string
}
/**
 * A named draft kept for a Conversation.
 */
export interface DraftStash {
  attachments: Attachment[]
  context_nodes: DraftContextNode[]
  conversation_id: string
  name: string
  /**
   * Starts at 1 and grows each time the stash is replaced.
   */
  revision: number
  /**
   * Milliseconds since the Unix epoch.
   */
  saved_at: number
  text: string
  /**
   * The window that last saved it.
   */
  window_id: string
  [k: string]: unknown
}
/**
 * `draft.stash.drop`: delete a stash at the revision the caller saw.
 */
export interface DraftStashDropRequest {
  conversation_id: string
  name: string
  op: 'draft.stash.drop'
  stash_revision: number
}
/**
 * The `draft.stash.drop` reply. `dropped` is false when no stash had the name.
 */
export interface DraftStashDropped {
  conversation_id: string
  dropped: boolean
  name: string
  /**
   * The `draft_stash_dropped` type tag.
   */
  type: 'draft_stash_dropped'
  [k: string]: unknown
}
/**
 * The `draft.stash.list` reply.
 */
export interface DraftStashList {
  stashes: DraftStash[]
  /**
   * The `draft_stashes` type tag.
   */
  type: 'draft_stashes'
  [k: string]: unknown
}
/**
 * `draft.stash.list`: a Conversation's stashes, most recently saved first.
 */
export interface DraftStashListRequest {
  conversation_id: string
  op: 'draft.stash.list'
}
/**
 * The `draft.stash.save` reply.
 */
export interface DraftStashReply {
  outcome: DraftStashSaveOutcome
  stash: DraftStash
  /**
   * The `draft_stash` type tag.
   */
  type: 'draft_stash'
  [k: string]: unknown
}
/**
 * `draft.stash.restore`: make a stash the window's draft. The stash stays.
 */
export interface DraftStashRestoreRequest {
  conversation_id: string
  /**
   * The window draft revision the caller last saw; 0 when it saw none.
   */
  expected_revision: number
  name: string
  op: 'draft.stash.restore'
  /**
   * The revision the restored draft takes; greater than `expected_revision`.
   */
  revision: number
  /**
   * The stash revision the caller listed; a replaced stash is refused.
   */
  stash_revision: number
  window_id: string
}
/**
 * `draft.stash.save`: keep a draft under a name. Saving a different draft
 * under a taken name needs the stash's current revision.
 */
export interface DraftStashSaveRequest {
  attachments?: Attachment[]
  context_nodes?: DraftContextNode[]
  conversation_id: string
  /**
   * Replace the stash only if it is still at this revision.
   */
  expected_revision?: number
  /**
   * 1 to 128 characters, without control characters.
   */
  name: string
  op: 'draft.stash.save'
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
 * One execution host and what this daemon knows about it.
 */
export interface ExecutionHostEntry {
  capabilities: HostCapabilities
  host: ExecutionHost
  label: string
  readiness: HostReadiness
  /**
   * Why the host is not ready, or what the client must still confirm.
   */
  reason: string | null
  /**
   * Remote hosts only: the remote profile from its last start.
   */
  remote_profile_id: string | null
  /**
   * Remote hosts only: the remote daemon's socket from its last start.
   */
  remote_socket: string | null
  [k: string]: unknown
}
/**
 * What a host can run and expose.
 */
export interface HostCapabilities {
  devices: DeviceAccess
  previews: PreviewTransport
  /**
   * The resource kinds a placement may target on this host.
   */
  resources: ResourceKind2[]
  [k: string]: unknown
}
/**
 * The `placement.hosts` reply. The local host is always first.
 */
export interface ExecutionHosts {
  hosts: ExecutionHostEntry[]
  /**
   * The `execution_hosts` type tag.
   */
  type: 'execution_hosts'
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
 * Independently accepted profile settings, never part of an installed color definition.
 */
export interface GhosttyAppearancePolicies {
  bold_color: BoldColor | null
  minimum_contrast: number | null
  [k: string]: unknown
}
export interface GhosttyExportOmission {
  path: string
  reason: string
  [k: string]: unknown
}
/**
 * A Ghostty snapshot: both screens, history up to the limit, and any
 * unfinished escape sequence.
 */
export interface GhosttyRecovery {
  continuation_limit_bytes: number
  history_limit_bytes: number
  scope: string
  [k: string]: unknown
}
export interface GhosttyThemeExport {
  omissions: GhosttyExportOmission[]
  source: string
  theme: ThemeSummary
  /**
   * The `ghostty_theme_export` type tag.
   */
  type: 'ghostty_theme_export'
  [k: string]: unknown
}
export interface ThemeSummary {
  bundled: boolean
  id: string
  mode: PaletteMode
  name: string
  provenance: ThemeProvenance
  /**
   * A record revision is the library revision at which its definition last changed.
   * Bundled definitions use revision 0 and are immutable.
   */
  revision: number
  sections: ThemeSections
  [k: string]: unknown
}
export interface ThemeProvenance {
  author: string | null
  kind: ThemeOrigin
  license: string | null
  source: string | null
  source_digest: string | null
  source_version: string | null
}
export interface ThemeSections {
  app: boolean
  syntax: boolean
  terminal: boolean
  [k: string]: unknown
}
export interface GhosttyThemeExportRequest {
  expected_revision: number
  id: string
  op: 'themes.ghostty.export'
}
/**
 * Theme text with inert optional setting proposals. Source names never cause filesystem access.
 */
export interface GhosttyThemeValidateRequest {
  id: string
  mode: PaletteMode
  name: string
  op: 'themes.ghostty.validate'
  source: string
  source_name?: string | null
}
export interface GhosttyThemeValidation {
  policies: GhosttyAppearancePolicies
  /**
   * Resolved candidate colors for an isolated local renderer; never applied to real terminals.
   */
  preview: TerminalAppearance | null
  /**
   * Canonical ADE source for explicit review and the ordinary revision-checked installation.
   */
  source: string | null
  /**
   * The `ghostty_theme_validation` type tag.
   */
  type: 'ghostty_theme_validation'
  validation: ThemeValidationResponse
  [k: string]: unknown
}
export interface TerminalAppearance {
  background: Rgb
  bold_color: BoldColor
  cursor: CursorColor
  cursor_text: TerminalColor
  dark: boolean
  foreground: Rgb
  minimum_contrast: number
  /**
   * @minItems 256
   * @maxItems 256
   */
  palette: [
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb,
    Rgb
  ]
  revision: number
  selection_background: TerminalColor
  selection_foreground: TerminalColor
  [k: string]: unknown
}
/**
 * Eight-bit alpha is retained exactly; only view rendering composites it.
 */
export interface Rgba {
  a: number
  b: number
  g: number
  r: number
}
export interface ThemeValidationResponse {
  definition: ThemeDefinition | null
  diagnostics: ThemeDiagnostic[]
  /**
   * Existing stable ID at validation time, for explicit revision-checked replacement.
   */
  target: ThemeSummary | null
  /**
   * The `theme_validation` type tag.
   */
  type: 'theme_validation'
  valid: boolean
  [k: string]: unknown
}
export interface ThemeDefinition {
  app: ThemeSection | null
  format: string
  id: string
  mode: PaletteMode
  name: string
  pack?: ThemePackIdentity | null
  provenance: ThemeProvenance
  syntax: ThemeSection | null
  terminal: ThemeSection | null
  version: number
  [k: string]: unknown
}
/**
 * A declared default is resolved independently of current profile appearance.
 */
export interface ThemeSection {
  defaults: string | null
  tokens: {
    [k: string]: string
  }
  [k: string]: unknown
}
export interface ThemePackIdentity {
  id: string
  name: string
}
/**
 * Offsets and lengths count UTF-8 bytes; line and column are one-based (column counts characters).
 */
export interface ThemeDiagnostic {
  code: string
  column: number
  length: number
  line: number
  message: string
  offset: number
  path: string
  severity: DiagnosticSeverity
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
   * The success result: `{head, output}` for a commit, `{changed, action,
   * receipt}` for a file change, and `{action, branch, head, ...}` for a
   * branch, stash, merge, fetch, pull or push. A merge or stash pop that
   * stopped on conflicts fails with `{action, conflicts}` here.
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
  /**
   * Questions and approvals the child waits on, oldest first. Answer each
   * once with `orchestration.child.answer`.
   */
  pending_requests: ChildRequest[]
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
        project_id: string
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
  /**
   * A paired client's pairing (`remote.host.pair`). Required on a remote
   * daemon's paired endpoint, together with `pairing_token`; ignored on
   * the owner socket.
   */
  pairing_id?: string | null
  /**
   * The pairing's token. The daemon compares its SHA-256 with the grant
   * and never stores or logs it.
   */
  pairing_token?: string | null
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
  /**
   * The conversation's `history_epoch` when this match was read. A rewind
   * reuses sequence numbers, so pass it with `before` to `conversation.get`
   * when opening the match: a late match is then refused, not shown at a
   * position that now holds another message.
   */
  history_epoch: number
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
  /**
   * The claimed device, for a device claim.
   */
  device_id?: string | null
  generation: string
  /**
   * Who inside the owning profile holds the claim: a service run
   * (`service:<workspace>/<name>#<identity>`) or a device hold's run.
   */
  holder?: string | null
  host_id: string
  id: string
  inode: string
  /**
   * The listener PID a port claim was bound to once ADE verified that the
   * service's own process tree listens on the port.
   */
  listener_pid?: number | null
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
   * For a checkout, the canonical path when the claim was taken
   * (informational only). For a port, `tcp:<port>`; for a device, its
   * device ID. `resources.claim.resolve` confirms this value.
   */
  path: string
  phase: ClaimPhase
  /**
   * The claimed TCP port, for a port claim.
   */
  port?: number | null
  purpose: ClaimPurpose
  /**
   * Why the claim is quarantined.
   */
  reason: string | null
  /**
   * What a claim is on.
   */
  resource: 'checkout' | 'port' | 'device'
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
 * Every app command's key: an Electron accelerator, or null when the
 * command has no key.
 */
export interface Keybindings {
  'close-tab': string | null
  'command-palette': string | null
  'new-conversation': string | null
  'new-tab': string | null
  'new-terminal': string | null
  'open-settings': string | null
  'split-right': string | null
  'toggle-dev-panel': string | null
  'toggle-left-sidebar': string | null
  'toggle-right-sidebar': string | null
}
/**
 * One window's arrangement of one workspace: the sidebars and the tree of
 * panes in the centre with their tabs.
 */
export interface Layout {
  collapsed: SidebarFlags
  focused_pane: string
  /**
   * A pane shown alone across the whole centre, or null. Always the focused pane.
   */
  maximized: string | null
  root: LayoutNode
  /**
   * `[left, right]`.
   *
   * @minItems 2
   * @maxItems 2
   */
  sidebars: [SidebarId, SidebarId]
  /**
   * Every tab placed in a pane, by ID.
   */
  tabs: {
    [k: string]: Tab
  }
  widths: SidebarWidths
  [k: string]: unknown
}
export interface SidebarFlags {
  inspector: boolean
  navigator: boolean
  [k: string]: unknown
}
/**
 * A leaf of the pane tree: a strip of tabs.
 */
export interface PaneNode {
  active: string | null
  id: string
  /**
   * Tab IDs, in strip order.
   */
  tabs: string[]
  /**
   * The `pane` type tag.
   */
  type: 'pane'
  [k: string]: unknown
}
/**
 * Two or more nodes side by side (`row`) or stacked (`column`).
 */
export interface SplitNode {
  children: LayoutNode[]
  direction: SplitDirection
  id: string
  /**
   * Percentages of the split, one per child, summing to 100.
   */
  sizes: number[]
  /**
   * The `split` type tag.
   */
  type: 'split'
  [k: string]: unknown
}
/**
 * One tab: a stable ID in its layout and what it shows.
 */
export interface Tab {
  id: string
  target: TabTarget
  [k: string]: unknown
}
/**
 * Sidebar widths in pixels, from 200 to 480.
 */
export interface SidebarWidths {
  inspector: number
  navigator: number
  [k: string]: unknown
}
/**
 * The `layout.apply`, `tab.close` and `pane.close` reply. `changed` is false when
 * the layout was already so; its revision then stays.
 */
export interface LayoutApplied {
  changed: boolean
  layout: LayoutRecord
  /**
   * The `layout` type tag.
   */
  type: 'layout'
  [k: string]: unknown
}
/**
 * A stored layout: one per window and workspace, with a revision that
 * grows by one with each change.
 */
export interface LayoutRecord {
  layout: Layout
  /**
   * 0 for a layout never changed: the default the daemon gives a window
   * the first time it shows a workspace.
   */
  revision: number
  window_id: string
  workspace_id: string
  [k: string]: unknown
}
/**
 * `layout.apply`: apply one action to a window's layout for a workspace.
 *
 * It never ends a process. A change that would remove the last tab, counted
 * across every window's layouts, of a running shell terminal is refused with
 * `tab_close_required`, listing those tabs in `tabs`; `tab.close` and
 * `pane.close` close such tabs and their shells.
 */
export interface LayoutApplyRequest {
  action: LayoutAction
  /**
   * The revision the caller last saw. A stale one is refused with
   * `layout_conflict`, except for the repeat of the last applied action
   * from that revision, which returns its result.
   */
  expected_revision?: number | null
  op: 'layout.apply'
  window_id: string
  /**
   * The workspace; the one the window shows when omitted.
   */
  workspace_id?: string | null
}
/**
 * The `layout_changed` feed frame. `layout.revision` is the layout's own
 * revision; a client keeps the higher of it and what `layout.get` gave.
 * After a reconnect, a client reads `window.list` (or the catalog's
 * windows) and re-reads every layout whose revision in `Window.layouts`
 * differs from its own.
 */
export interface LayoutChanged {
  boot_id: string
  layout: LayoutRecord
  revision: number
  /**
   * The `layout_changed` type tag.
   */
  type: 'layout_changed'
  [k: string]: unknown
}
/**
 * `layout.get`: one window's layout for one workspace.
 */
export interface LayoutGetRequest {
  op: 'layout.get'
  window_id: string
  /**
   * The workspace; the one the window shows when omitted.
   */
  workspace_id?: string | null
}
/**
 * The `layout_removed` feed frame: a removed workspace took its layouts.
 */
export interface LayoutRemoved {
  boot_id: string
  revision: number
  /**
   * The `layout_removed` type tag.
   */
  type: 'layout_removed'
  window_id: string
  workspace_id: string
  [k: string]: unknown
}
/**
 * The `layout.get` reply.
 */
export interface LayoutReply {
  layout: LayoutRecord
  /**
   * The `layout` type tag.
   */
  type: 'layout'
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
 * client or an earlier outcome already holds the delivery, or when the
 * profile's preferences or a snooze suppressed it.
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
 * The profile's notification preferences. A profile that never set them
 * notifies desktop for every activity kind.
 */
export interface NotificationPreferences {
  desktop: boolean
  /**
   * In the order they were set, without repeats.
   */
  muted_kinds: ActivityKind[]
  /**
   * The `notification_preferences` type tag.
   */
  type: 'notification_preferences'
  /**
   * When the preferences were last set; null for the defaults.
   */
  updated_at: number | null
  [k: string]: unknown
}
/**
 * `notification.preferences.get`: the profile's notification preferences.
 */
export interface NotificationPreferencesGetRequest {
  op: 'notification.preferences.get'
}
/**
 * `notification.preferences.set`: replace the profile's notification preferences.
 */
export interface NotificationPreferencesSetRequest {
  /**
   * Whether any activity notifies on the desktop.
   */
  desktop: boolean
  /**
   * Activity kinds that never notify; repeats are ignored.
   */
  muted_kinds: ActivityKind[]
  op: 'notification.preferences.set'
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
export interface PaletteCatalog {
  palettes: BuiltinPalette[]
  /**
   * The `palettes` type tag.
   */
  type: 'palettes'
  [k: string]: unknown
}
/**
 * `pane.close`: close a pane and its tabs, closing each shell terminal whose
 * last tab it holds, as `tab.close` does.
 */
export interface PaneCloseRequest {
  force?: boolean | null
  op: 'pane.close'
  /**
   * The caller's operation ID, as for `tab.close`.
   */
  operation_id: string
  pane_id: string
  window_id: string
  workspace_id?: string | null
}
/**
 * The `orchestration.parent.send` reply: the message is durably queued for
 * the parent.
 */
export interface ParentMessageQueued {
  attribution: string
  child_conversation_id: string
  message_id: string
  parent_conversation_id: string
  /**
   * The `parent_message_queued` type tag.
   */
  type: 'parent_message_queued'
  [k: string]: unknown
}
/**
 * `orchestration.parent.send`: queue a message from a delegated child to
 * its parent Conversation.
 */
export interface ParentSendRequest {
  /**
   * Who asks. An Agent caller names its own Conversation; the daemon records
   * the attribution and refuses an Agent that acts as another Conversation.
   */
  caller:
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
   * The child that sends; its parent receives.
   */
  child_conversation_id: string
  op: 'orchestration.parent.send'
  /**
   * Caller-owned operation ID; a retry with the same payload returns the same message.
   */
  operation_id: string
  /**
   * At most 64 KiB. The parent receives it after a line naming the child.
   */
  text: string
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
  context_nodes: DraftContextNode[]
  conversation_id: string
  draft_revision: number
  draft_text: string
  request_id: string
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
 * One resource and its execution host.
 */
export interface Placement {
  host: ExecutionHost
  /**
   * When the record was written; null for local state.
   */
  recorded_at_ms: number | null
  resource: PlacedResource
  source: PlacementSource
  [k: string]: unknown
}
/**
 * `placement.check`: may new work of `resource` kind be placed on `host`?
 */
export interface PlacementCheckRequest {
  host: ExecutionHost
  op: 'placement.check'
  resource: ResourceKind2
  /**
   * For anything but a workspace: the workspace the work belongs to. Its
   * host must be `host`.
   */
  workspace_id?: string | null
}
/**
 * The `placement.check` reply.
 */
export interface PlacementDecision {
  /**
   * True only when this daemon's evidence allows the placement.
   */
  admitted: boolean
  host: ExecutionHost
  /**
   * Why the placement is refused, or what the client must still confirm.
   */
  reason: string | null
  /**
   * True for a remote host: the work is sent through the remote transport,
   * which must be connected to this host at that moment.
   */
  requires_remote_transport: boolean
  resource: ResourceKind2
  /**
   * The `placement_decision` type tag.
   */
  type: 'placement_decision'
  [k: string]: unknown
}
/**
 * `placement.hosts`: every execution host.
 */
export interface PlacementHostsRequest {
  op: 'placement.hosts'
}
/**
 * `placement.list`: recorded placements, all or for one remote host.
 */
export interface PlacementListRequest {
  host_id?: string | null
  op: 'placement.list'
}
/**
 * `placement.record`: record the host of a resource created on a remote host.
 */
export interface PlacementRecordRequest {
  host: ExecutionHost
  op: 'placement.record'
  resource: PlacedResource
}
/**
 * `placement.release`: forget one recorded placement.
 */
export interface PlacementReleaseRequest {
  op: 'placement.release'
  resource: PlacedResource
}
/**
 * The `placement.release` reply. `released` is false when nothing was recorded.
 */
export interface PlacementReleased {
  released: boolean
  resource: PlacedResource
  /**
   * The `placement_released` type tag.
   */
  type: 'placement_released'
  [k: string]: unknown
}
/**
 * The `placement.record` and `placement.resolve` reply.
 */
export interface PlacementReply {
  placement: Placement
  /**
   * The `placement` type tag.
   */
  type: 'placement'
  [k: string]: unknown
}
/**
 * `placement.resolve`: the host of one resource.
 */
export interface PlacementResolveRequest {
  op: 'placement.resolve'
  resource: PlacedResource
}
/**
 * The `placement.list` reply.
 */
export interface Placements {
  placements: Placement[]
  /**
   * The `placements` type tag.
   */
  type: 'placements'
  [k: string]: unknown
}
/**
 * The active screen's text grid as the runtime's parser holds it.
 */
export interface PlainScreenRecovery {
  alternate_screen: boolean
  cols: number
  cursor_col: number
  cursor_row: number
  cursor_visible: boolean
  parser: string
  parser_ground: boolean
  rows: number
  scope: string
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
  /**
   * Static, validated declarative theme definitions contributed by this plugin.
   */
  themes?: ThemeDefinition[]
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
  /**
   * Static, validated declarative theme definitions contributed by this plugin.
   */
  themes?: ThemeDefinition[]
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
 * `plugin.dev.enter`: watch an enabled plugin's local source directory and
 * reload it on change. Each reload that changes the artifact starts a new
 * activation generation; a reload that fails leaves the current one running.
 * Entering again only updates the debounce. Disabling the plugin ends
 * development mode.
 */
export interface PluginDevEnterRequest {
  /**
   * How long the source must stay unchanged before a reload, 50 to 10000
   * ms. Defaults to 300 ms. A source that keeps changing reloads at most
   * 10 s after its first unsettled change.
   */
  debounce_ms?: number | null
  op: 'plugin.dev.enter'
  plugin_id: string
}
/**
 * `plugin.dev.leave`: stop watching. The last reloaded artifact stays
 * installed and active. Leaving a plugin not in development mode succeeds.
 */
export interface PluginDevLeaveRequest {
  op: 'plugin.dev.leave'
  plugin_id: string
}
/**
 * A plugin's development mode.
 */
export interface PluginDevMode {
  debounce_ms: number
  entered_at: number
  /**
   * When the watcher last saw the source change.
   */
  last_change_at: number | null
  last_reload: PluginReload | null
  /**
   * When the pending change will reload, if one is pending.
   */
  reload_due_at: number | null
  /**
   * The watched source directory: the plugin's local source locator.
   */
  source_path: string
  /**
   * Why the last scan of the source directory failed, until one succeeds.
   */
  watch_error: string | null
  /**
   * Whether this daemon is watching the source now.
   */
  watching: boolean
  [k: string]: unknown
}
/**
 * The last development-mode reload attempt.
 */
export interface PluginReload {
  at: number
  /**
   * The generation it activated.
   */
  generation: number | null
  /**
   * Why it was refused or failed, or why the new backend host did not start.
   */
  message: string | null
  status: PluginReloadStatus
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
 * One activation generation of one plugin.
 */
export interface PluginGeneration {
  activated_at: number
  artifact_digest: string
  generation: number
  origin: PluginGenerationOrigin
  /**
   * Provider sessions that lease this generation.
   */
  provider_leases: number
  retired_at: number | null
  state: PluginGenerationState
  /**
   * When a newer generation replaced it or the plugin was disabled.
   */
  superseded_at: number | null
  /**
   * The artifact version the generation ran.
   */
  version: string
  [k: string]: unknown
}
/**
 * `plugin.generation.list`: the plugin's activation generations, newest
 * first, and its development mode. It records the retirement of generations
 * nothing holds any more; it never starts or stops a host.
 */
export interface PluginGenerationListRequest {
  op: 'plugin.generation.list'
  plugin_id: string
}
/**
 * The `plugin.dev.enter`, `plugin.dev.leave` and `plugin.generation.list` reply.
 */
export interface PluginGenerations {
  /**
   * Null when the plugin is not in development mode.
   */
  dev: PluginDevMode | null
  /**
   * Newest first. Only the last 20 retired generations are kept.
   */
  generations: PluginGeneration[]
  plugin_id: string
  /**
   * The `plugin_generations` type tag.
   */
  type: 'plugin_generations'
  [k: string]: unknown
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
 * `outcome_unknown`. The error code `not_applied` means the request was
 * refused before any host was touched. The code `failed` means a start was
 * attempted and failed, after the old host, if one ran, was already
 * stopped; `plugin.host.status` then shows the backoff or errored host.
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
export interface ProfileSettings {
  app_dark_theme: string
  app_light_theme: string
  appearance: Appearance
  appearance_revision: number
  code_font_family: string
  code_font_size: number
  density: Density
  differentiate_without_color: AccessibilityPreference
  high_contrast: AccessibilityPreference
  keybindings: Keybindings
  reduced_motion: ReducedMotion
  reduced_transparency: AccessibilityPreference
  syntax_binding: ThemeBinding
  terminal_binding: ThemeBinding
  terminal_bold_color: BoldColor
  terminal_color_overrides: TerminalColorOverrides
  terminal_cursor_blink: boolean
  terminal_cursor_shape: TerminalCursorShape
  terminal_font_family: string
  terminal_font_kerning: TerminalFontKerning
  terminal_font_size: number
  terminal_line_height: number
  terminal_minimum_contrast: number
  ui_font_family: string
  ui_font_size: number
  [k: string]: unknown
}
/**
 * Explicit profile overrides; omitted roles retain the selected theme's colors.
 */
export interface TerminalColorOverrides {
  cursor_text?: TerminalColor | null
  selection_background?: TerminalColor | null
  selection_foreground?: TerminalColor | null
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
 * Pinned by the daemon/runtime for this query. Querying never implicitly opens/resumes execution.
 */
export interface ProviderHistoryContext {
  account_id: string | null
  execution_id: string
  invalidation_epoch: number
  lineage: string | null
  provider: string
}
export interface ProviderInspect {
  descriptor: ProviderWorkerInitialize | null
  provider: string
  reason: string
  state: ReadinessState2
  /**
   * The `provider_inspect` type tag.
   */
  type: 'provider_inspect'
  version: string | null
  [k: string]: unknown
}
/**
 * Exact JSON-RPC initialize reply; every field is required and unknown fields are rejected.
 */
export interface ProviderWorkerInitialize {
  capabilities: ProviderWorkerCapability[]
  compatible_protocol_versions: number[]
  limits: ProviderWorkerLimits
  name: string
  operations: ProviderWorkerOperation[]
  permission_modes: string[]
  protocol_version: number
  requirements: ProviderWorkerRequirements
}
/**
 * A capability advertised by a provider worker. Support and current availability are independent.
 */
export interface ProviderWorkerCapability {
  available: boolean
  name: ProviderWorkerCapabilityName
  reason: string
  support: Support
}
export interface ProviderWorkerLimits {
  max_cleanup_ms: number
  max_concurrency: number
  /**
   * Maximum visible transcript items returned by open, history or child transcript.
   */
  max_history_page_items: number
  max_initialize_ms: number
  /**
   * Maximum immediate child values in any input JSON object or array.
   */
  max_input_entries: number
  max_input_frame_bytes: number
  max_operation_ms: number
  /**
   * Maximum immediate child values in any output JSON object or array.
   */
  max_output_entries: number
  max_output_frame_bytes: number
  max_partial_frame_ms: number
}
export interface ProviderWorkerOperation {
  availability: ProviderWorkerAvailability
  method: ProviderWorkerMethod
  reason: string
  tier: Tier
}
/**
 * Version metadata declared by the packaged SDK worker.
 */
export interface ProviderWorkerRequirements {
  effect_version: string
  node_engine: string
  platform_node_version: string
  sdk_api_version: number
  sdk_version: string
}
/**
 * Inspect one enabled plugin worker without opening a session or submitting input.
 */
export interface ProviderInspectRequest {
  op: 'provider.inspect'
  provider: string
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
 * One registration and its outcome.
 */
export interface ProviderRegistrationView {
  name: string
  origin: ProviderOrigin
  provider: string
  /**
   * Null when registered.
   */
  reason: string | null
  state: RegistrationState
  [k: string]: unknown
}
/**
 * The `provider.registrations` reply.
 */
export interface ProviderRegistrations {
  /**
   * Why the plugin registry could not be read, when it could not. Plugin
   * providers are then missing from `providers`, not reported as absent.
   */
  plugins_unavailable: string | null
  providers: ProviderRegistrationView[]
  /**
   * The `provider_registrations` type tag.
   */
  type: 'provider_registrations'
  [k: string]: unknown
}
/**
 * `provider.registrations`: every registered provider and its origin.
 */
export interface ProviderRegistrationsRequest {
  op: 'provider.registrations'
}
export interface ProviderWorkerAck {}
export interface ProviderWorkerAnswerRequest {
  answer: RequestAnswer
  id: unknown
  operation_id: string
  reason?: string | null
}
export interface ProviderWorkerCancelRequest {
  session: string
  source_attempt_id: string
  submission_id: string
  turn?: string | null
}
export interface ProviderWorkerCancelResult {
  evidence: ProviderCancelEvidence
  type: ProviderWorkerCancelTag
}
export interface ProviderWorkerChildTranscriptRequest {
  child: string
  cursor: string | null
  offset: number
  session: string
}
export interface ProviderWorkerCompactRequest {
  operation: string
  session: string
}
export interface ProviderWorkerConfigureMcpRequest {
  servers: {
    [k: string]: unknown
  }
}
export interface ProviderWorkerErrorResponse {
  error: ProviderWorkerRpcError
  id: ProviderWorkerResponseId
  jsonrpc: ProviderWorkerJsonRpcVersion
}
export interface ProviderWorkerRpcError {
  code: number
  data: ProviderWorkerFailure
  message: string
}
export interface ProviderWorkerEventNotification {
  jsonrpc: ProviderWorkerJsonRpcVersion
  method: ProviderWorkerEventMethod
  params: Event
}
export interface ProviderWorkerHistoryPage {
  complete: boolean
  /**
   * A failed refresh may retain only content with this exact snapshot identity.
   */
  error: ProviderWorkerFailure | null
  /**
   * Genuine native continuation after each item, when the source supports exact byte-window trimming.
   *
   * @maxItems 32
   */
  item_cursors?: string[]
  items: Item[]
  next_cursor: string | null
  retained_bytes: number
  snapshot: ProviderHistorySnapshot
}
export interface ProviderWorkerHistoryRequest {
  context: ProviderHistoryContext
  cursor: string | null
  max_bytes: number
  max_items: number
  session: string
  snapshot: ProviderHistorySnapshot | null
}
export interface ProviderWorkerOpenRequest {
  config: Config2
  resume: string | null
}
/**
 * The request envelope spoken by every provider worker. Parameters remain
 * provider-specific JSON, but the JSON-RPC envelope and method are generated.
 */
export interface ProviderWorkerRequest {
  id: ProviderWorkerRequestId
  jsonrpc: ProviderWorkerJsonRpcVersion
  method: ProviderWorkerMethod
  params: {
    [k: string]: unknown
  }
}
export interface ProviderWorkerResultResponse {
  id: ProviderWorkerResponseId
  jsonrpc: ProviderWorkerJsonRpcVersion
  result: unknown
}
export interface ProviderWorkerRewindRequest {
  native_message?: NativeMessageLocator | null
  operation: string
  session: string
  turn: string | null
}
export interface ProviderWorkerRewindResult {
  previous_session?: string | null
  scope?: RewindScope | null
  session: string | null
}
export interface ProviderWorkerSendRequest {
  attachments: Content[]
  message_id: string | null
  session: string
  source_attempt_id: string
  submission: string
  text: string
}
export interface ProviderWorkerSendResult {
  admitted: boolean
  dispatch: SubmissionDispatch
  native_outcome: SubmissionNativeOutcome
  turn: string | null
}
export interface ProviderWorkerSteerRequest {
  attachments: Content[]
  message_id: string
  session: string
  text: string
  turn: string
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
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
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
 * The `rebind.list` reply.
 */
export interface RebindCatalog {
  /**
   * The worktree lifecycle's repositories.
   */
  lifecycle: WorktreeRebindCandidate[]
  /**
   * The catalog's repositories.
   */
  repositories: RepositoryRebindEntry[]
  /**
   * The `rebind_catalog` type tag.
   */
  type: 'rebind_catalog'
  workspaces: WorkspaceRebindEntry[]
  [k: string]: unknown
}
/**
 * One lifecycle repository in `rebind.list`.
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
 * `rebind.list`: what a restored profile needs bound to a folder again, in
 * the order a person binds it: lifecycle repositories (`worktree.rebind`),
 * catalog repositories (`repository.rebind`), then workspaces
 * (`workspace.rebind`).
 */
export interface RebindListRequest {
  op: 'rebind.list'
}
/**
 * One attempt an old runtime incarnation owned.
 */
export interface RecoveredAttempt {
  /**
   * The run ID or terminal transfer ID, when recorded.
   */
  attempt: string | null
  classification: RecoveryClassification
  /**
   * Stable within the report: `agent:<conversation>`,
   * `terminal:<workspace>:<terminal>`, `service:<workspace>:<name>` or
   * `script:<workspace>:<run>`.
   */
  key: string
  kind: RecoveredAttemptKind
  /**
   * A provider turn was in flight: its effects are unknown and it was not replayed.
   */
  outcome_unknown: boolean
  /**
   * Processes observed still running, for a quarantined attempt.
   */
  pids: number[]
  /**
   * The evidence behind the classification, in one sentence.
   */
  reason: string
  /**
   * How it was resolved.
   */
  resolution: string | null
  /**
   * When a later observation or the user resolved a quarantined or unknown attempt.
   */
  resolved_at: number | null
  /**
   * The runtime incarnation that owned it, when recorded.
   */
  runtime_instance: string | null
  /**
   * The Conversation ID, terminal ID, service name or script run ID.
   */
  subject: string
  workspace_id: string
  [k: string]: unknown
}
/**
 * One runtime restart reconciliation.
 */
export interface RecoveryReport {
  attempts: RecoveredAttempt[]
  /**
   * The runtime incarnation the daemon found instead.
   */
  current_instance: string
  detected_at: number
  id: string
  /**
   * Attempts still quarantined or unknown and not resolved.
   */
  open: number
  /**
   * The runtime incarnations that had stopped.
   */
  previous_instances: string[]
  [k: string]: unknown
}
/**
 * The remote daemon's identity as its `hello` reported it.
 */
export interface RemoteDaemon {
  application_protocol: string
  boot_id: string
  build_id: string | null
  /**
   * The paired endpoint on the remote host that the start granted this
   * profile's pairing on. Clients forward to it and present the pairing ID
   * and token in `hello`; revoking the pairing closes it to them.
   */
  paired_socket?: string | null
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
  /**
   * The pinned public key, `type base64`. A public value: clients pin every
   * SSH connection they open to this host to it, as the daemon does.
   */
  host_public_key: string
  /**
   * The `ade-control` that `remote.host.install` put on the host. Probe and
   * start use it when `backend_path` is null. Absent until an install succeeds.
   */
  installed_backend_path?: string | null
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
 * The `remote.host.install` reply.
 */
export interface RemoteHostInstall {
  /**
   * The installed `ade-control`, when installed or already compatible.
   */
  control_path: string | null
  detail: string | null
  host_id: string
  /**
   * The artifacts this attempt wrote on the host.
   */
  installed: string[]
  operation_id: string
  outcome: InstallOutcome
  /**
   * The `remote_host_install` type tag.
   */
  type: 'remote_host_install'
  [k: string]: unknown
}
/**
 * `remote.host.install`: install this installation's backend on the host.
 */
export interface RemoteHostInstallRequest {
  host_id: string
  op: 'remote.host.install'
  operation_id: string
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
   * Why a revocation has not reached the host yet; revoking again retries.
   */
  detail?: string | null
  /**
   * Where the pairing is enforced. `local_profile`: only this profile
   * refuses a revoked pairing; a pairing is granted on the host when
   * `remote.host.start` runs, and a revocation that could not reach the
   * host has not taken effect there yet. `remote_daemon`: the host itself
   * recorded the revocation and refuses the pairing on its paired endpoint.
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
 * `repository.rebind`: bind a restored Git repository to a verified checkout.
 */
export interface RepositoryRebindRequest {
  op: 'repository.rebind'
  path: string
  project_id: string
}
export interface ResolvedAppearance {
  dark_palette: BuiltinPalette
  diagnostics: AppearanceDiagnostic[]
  light_palette: BuiltinPalette
  mode: PaletteMode
  preference: Appearance
  propagation: AppearancePropagation
  revision: number
  syntax: ResolvedSyntaxAppearance
  terminal: TerminalAppearance
  terminal_diagnostics: AppearanceDiagnostic[]
  theme_id: string
  tokens: {
    [k: string]: string
  }
  /**
   * The `appearance` type tag.
   */
  type: 'appearance'
  [k: string]: unknown
}
/**
 * Independently selected code colors and surface tokens. App chrome is separate.
 */
export interface ResolvedSyntaxAppearance {
  binding: ThemeBinding
  dark_palette: BuiltinPalette
  diagnostics: AppearanceDiagnostic[]
  light_palette: BuiltinPalette1
  palette: BuiltinPalette
  selected_id: string
  [k: string]: unknown
}
/**
 * Both startup variants; a valid fixed binding repeats its palette in both slots.
 */
export interface BuiltinPalette1 {
  id: string
  mode: PaletteMode
  name: string
  tokens: {
    [k: string]: string
  }
  [k: string]: unknown
}
export interface ResolvedTerminalAppearance {
  appearance: TerminalAppearance
  binding: ThemeBinding
  diagnostics: AppearanceDiagnostic[]
  fallback: boolean
  mode: PaletteMode
  propagation: AppearancePropagation
  provenance: TerminalAppearanceProvenance
  resolved_id: string
  revision: number
  selected_id: string
  terminal_id: string
  /**
   * The `terminal_appearance` type tag.
   */
  type: 'terminal_appearance'
  [k: string]: unknown
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
 * `resources.device.hold`: claim a simulator or emulator exclusively for one
 * run of this profile. Repeating the hold with the same `holder` returns the
 * same claim. Other profiles' device effects and holds, and other runs'
 * holds, are refused while it is held; this profile's own device effects are
 * admitted.
 */
export interface ResourcesDeviceHoldRequest {
  /**
   * An ADE device ID from `device.list`, such as `ios-sim:<udid>`.
   */
  device_id: string
  /**
   * The caller's run identity, 1 to 128 printable ASCII characters.
   */
  holder: string
  op: 'resources.device.hold'
}
/**
 * `resources.device.release`: end this daemon's hold for `holder` on the
 * device. Releasing a hold that is already gone converges. A quarantined hold
 * is refused and needs `resources.claim.resolve`.
 */
export interface ResourcesDeviceReleaseRequest {
  device_id: string
  holder: string
  op: 'resources.device.release'
}
/**
 * `resources.inspect`: read the registry status and its claims. With `path`,
 * only checkout claims on that path, inside it, or containing it are listed.
 * With `resource`, only claims of that kind are listed.
 */
export interface ResourcesInspectRequest {
  op: 'resources.inspect'
  path?: string | null
  resource?: ResourceKind | null
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
 * The configured limits, as stored; null means the default applies.
 */
export interface RetentionConfigured {
  diagnostic_log_max_age_ms: number | null
  service_log_idle_ms: number | null
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
   * The configuration revision; 0 until `retention.policy.set` first changes it.
   */
  revision: number
  /**
   * A service log must be idle this long before it can go.
   */
  service_log_idle_ms: number
  [k: string]: unknown
}
/**
 * `retention.policy.get`: the policy retention applies now.
 */
export interface RetentionPolicyGetRequest {
  op: 'retention.policy.get'
}
/**
 * The `retention.policy.get` and `retention.policy.set` reply.
 */
export interface RetentionPolicyReply {
  /**
   * False when a set found the policy already as requested.
   */
  changed: boolean
  configured: RetentionConfigured
  policy: RetentionPolicy1
  /**
   * The `retention_policy` type tag.
   */
  type: 'retention_policy'
  [k: string]: unknown
}
/**
 * The effective policy; its `revision` guards the next change.
 */
export interface RetentionPolicy1 {
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
   * The configuration revision; 0 until `retention.policy.set` first changes it.
   */
  revision: number
  /**
   * A service log must be idle this long before it can go.
   */
  service_log_idle_ms: number
  [k: string]: unknown
}
/**
 * `retention.policy.set`: configure the limits a user may change. An absent
 * field returns that limit to its default. Each limit is 1 to 365 days.
 */
export interface RetentionPolicySetRequest {
  diagnostic_log_max_age_ms?: number | null
  /**
   * The policy `revision` the caller saw; a newer stored policy is refused.
   */
  expected_revision: number
  op: 'retention.policy.set'
  service_log_idle_ms?: number | null
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
 * One selected line or range in a workspace's diff, as `review.diff_page`
 * showed it. The daemon checks it is still current before using it.
 */
export interface ReviewAnchor {
  /**
   * The last line of a range, with its text.
   */
  end_line?: number | null
  end_text?: string | null
  /**
   * The hunk header, starting `@@ `.
   */
  hunk: string
  /**
   * The new-side line number, from 1.
   */
  line: number
  /**
   * Relative to the workspace root.
   */
  path: string
  /**
   * The `review.status` revision the diff was read at.
   */
  revision: string
  staged: boolean
  /**
   * The selected line's text.
   */
  text: string
  /**
   * The `review.diff_page` token of the file's diff.
   */
  token: string
  workspace_id: string
}
/**
 * `review.branch`: create a branch at HEAD, switch to a local branch, or both.
 * Git refuses a switch that would overwrite local changes.
 */
export interface ReviewBranchRequest {
  /**
   * Create the branch at HEAD first; it must not exist yet.
   */
  create?: boolean
  /**
   * The status `index_token` the user reviewed.
   */
  index_token: string
  /**
   * The local branch name, checked with `git check-ref-format --branch`.
   */
  name: string
  op: 'review.branch'
  operation_id: string
  /**
   * Switch to the branch. At least one of `create` and `switch` is true.
   */
  switch?: boolean
  workspace_id: string
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
 * A batch of notes, each on its own anchor, as `formatReviewFeedback` in
 * `@ade/client` formats it.
 */
export interface ReviewFeedback {
  format: ReviewFeedbackFormat
  /**
   * 1 to 16 notes.
   */
  notes: ReviewNote[]
  workspace_id: string
}
/**
 * One note on one anchor.
 */
export interface ReviewNote {
  anchor: ReviewAnchor
  /**
   * 1 to 4096 bytes.
   */
  note: string
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
 * The `review.feedback.send` reply: the prompt is queued on the Conversation.
 */
export interface ReviewFeedbackQueued {
  conversation_id: string
  /**
   * The queued prompt's ID: the operation ID.
   */
  queued_prompt_id: string
  /**
   * The prompt as queued.
   */
  text: string
  /**
   * The `review_feedback_queued` type tag.
   */
  type: 'review_feedback_queued'
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
 * `review.feedback.send`: build the review prompt from anchors in the
 * Conversation's workspace and queue it on the Conversation.
 *
 * Send either `anchors` with one `note` (one anchor on one line gives the
 * one-line prompt; anything else the batch form, the note under each
 * anchor), or `feedback` with a note per anchor. Before queueing, the daemon
 * checks every anchor against the workspace's current status and diff and
 * refuses a moved one with `review_anchor_stale`. With `window_id`, it also
 * refuses while that window's draft for the Conversation holds text or
 * attachments (`draft_not_empty`), which the prompt would otherwise
 * replace. The queued prompt's ID is the operation ID, and the delivered
 * message keeps the feedback for `review.feedback.search`.
 */
export interface ReviewFeedbackSendRequest {
  /**
   * 1 to 16 anchors for one note; excludes `feedback`.
   */
  anchors?: ReviewAnchor[]
  conversation_id: string
  /**
   * A note per anchor; excludes `anchors` and `note`.
   */
  feedback?: ReviewFeedback | null
  /**
   * The note on `anchors`: 1 byte to 64 KiB for one anchor, 4 KiB for several.
   */
  note?: string | null
  op: 'review.feedback.send'
  /**
   * The caller's operation ID; it also names the queued prompt.
   */
  operation_id: string
  /**
   * The window whose draft must be empty first; no draft check when absent.
   */
  window_id?: string | null
}
/**
 * `review.fetch`: fetch one configured remote. Only remote-tracking refs change.
 */
export interface ReviewFetchRequest {
  op: 'review.fetch'
  operation_id: string
  /**
   * A configured remote name; the current branch's upstream remote, else
   * `origin`, when absent. URLs are refused.
   */
  remote?: string
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
 * `review.merge`: merge a branch or commit into the current branch, or abort
 * a stopped merge. A merge that stops on conflicts fails and lists them in
 * the receipt's `result.conflicts`; resolve, stage and commit, or abort.
 */
export interface ReviewMergeRequest {
  action: ReviewMergeAction
  /**
   * The status `index_token` the user reviewed.
   */
  index_token: string
  op: 'review.merge'
  operation_id: string
  /**
   * Merge only: a local branch, remote-tracking branch, tag or commit.
   */
  target?: string
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
 * `review.pull`: fetch the current branch's upstream and fast-forward to it.
 * A diverged branch fails; fetch and merge explicitly instead.
 */
export interface ReviewPullRequest {
  /**
   * The status `index_token` the user reviewed.
   */
  index_token: string
  op: 'review.pull'
  operation_id: string
  workspace_id: string
}
/**
 * `review.push`: push the current branch without force, to its upstream, or
 * to the same-named branch on `remote`, which then becomes the upstream.
 */
export interface ReviewPushRequest {
  /**
   * The status `index_token` the user reviewed.
   */
  index_token: string
  op: 'review.push'
  operation_id: string
  /**
   * Required when the branch has no upstream; must be a configured remote name.
   */
  remote?: string
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
 * `review.stash`: save or restore uncommitted changes.
 */
export interface ReviewStashRequest {
  action: ReviewStashAction
  /**
   * Push only: also save untracked files.
   */
  include_untracked?: boolean
  /**
   * Push only: the stash message.
   */
  message?: string
  op: 'review.stash'
  operation_id: string
  /**
   * The status `revision` the user reviewed; a changed tree fails as stale.
   */
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
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
}
/**
 * The `runtime.recovery` reply.
 */
export interface RuntimeRecovery {
  current_instance: string
  reports: RecoveryReport[]
  /**
   * The `runtime_recovery` type tag.
   */
  type: 'runtime_recovery'
  [k: string]: unknown
}
/**
 * `runtime.recovery.release`: accept an `unknown` attempt as stopped without
 * proof, so its workspace can admit new work. An attempt whose processes are
 * observed running is refused. Nothing is replayed. Repeating it after the
 * attempt is resolved returns the same report.
 */
export interface RuntimeRecoveryReleaseRequest {
  /**
   * The attempt's `key` from the report.
   */
  attempt_key: string
  op: 'runtime.recovery.release'
  report_id: string
}
/**
 * The `runtime.recovery.release` reply.
 */
export interface RuntimeRecoveryReleased {
  attempt_key: string
  report: RecoveryReport
  /**
   * The `runtime_recovery_released` type tag.
   */
  type: 'runtime_recovery_released'
  [k: string]: unknown
}
/**
 * `runtime.recovery`: read the reports the daemon wrote when it found that
 * the runtime restarted under a new incarnation. Newest first.
 */
export interface RuntimeRecoveryRequest {
  op: 'runtime.recovery'
  /**
   * Only reports that still hold a quarantined or unknown attempt.
   */
  open_only?: boolean | null
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
   * An execution host. `local` is the host this daemon runs on; a remote host
   * is named by its `remote.host.*` registry ID.
   */
  execution_host:
    | {
        kind: 'local'
      }
    | {
        host_id: string
        kind: 'remote'
      }
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
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
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
   * An execution host. `local` is the host this daemon runs on; a remote host
   * is named by its `remote.host.*` registry ID.
   */
  execution_host:
    | {
        kind: 'local'
      }
    | {
        host_id: string
        kind: 'remote'
      }
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
  /**
   * An execution host. `local` is the host this daemon runs on; a remote host
   * is named by its `remote.host.*` registry ID.
   */
  execution_host:
    | {
        kind: 'local'
      }
    | {
        host_id: string
        kind: 'remote'
      }
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
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
  workspace_id: string
}
/**
 * `script.stop`: stop a run and wait up to five seconds for it to exit.
 */
export interface ScriptStopRequest {
  op: 'script.stop'
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
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
    /**
     * Names of `env` entries whose values are secret. ADE never stores or
     * returns their values: each shows as [`REDACTED`], and sending
     * [`REDACTED`] back keeps the stored reference. A value sent here is
     * moved into the Keychain and replaced by a reference in `secret_refs`.
     */
    secret_env?: string[]
    /**
     * Where each secret's value lives. Resolved only when the service
     * launches; a reference that cannot be resolved refuses the start before
     * anything is reserved. A secret with no reference was withheld by a
     * backup and must be sent again.
     */
    secret_refs?: {
      [k: string]: CredentialReference
    }
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
export interface TerminalOwner {
  runtime_instance: string
  terminal_id: string
  transfer_id: string
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
    /**
     * Names of `env` entries whose values are secret. ADE never stores or
     * returns their values: each shows as [`REDACTED`], and sending
     * [`REDACTED`] back keeps the stored reference. A value sent here is
     * moved into the Keychain and replaced by a reference in `secret_refs`.
     */
    secret_env?: string[]
    /**
     * Where each secret's value lives. Resolved only when the service
     * launches; a reference that cannot be resolved refuses the start before
     * anything is reserved. A secret with no reference was withheld by a
     * backup and must be sent again.
     */
    secret_refs?: {
      [k: string]: CredentialReference
    }
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
   * An execution host. `local` is the host this daemon runs on; a remote host
   * is named by its `remote.host.*` registry ID.
   */
  execution_host:
    | {
        kind: 'local'
      }
    | {
        host_id: string
        kind: 'remote'
      }
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
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
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
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
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
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
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
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
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
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
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
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
  workspace_id: string
}
/**
 * `service.stop`: stop a service and confirm its process exited.
 */
export interface ServiceStopRequest {
  name: string
  op: 'service.stop'
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
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
 * The `settings.get` and `settings.set` reply: every setting as it is now.
 */
export interface Settings {
  settings: ProfileSettings
  /**
   * The `settings` type tag.
   */
  type: 'settings'
  [k: string]: unknown
}
/**
 * Inspect the saved projection and independently acknowledged runtime state.
 */
export interface SettingsAppearanceRequest {
  op: 'settings.appearance'
}
/**
 * The `settings_changed` feed frame: every setting after a change.
 */
export interface SettingsChanged {
  boot_id: string
  revision: number
  settings: ProfileSettings
  /**
   * The `settings_changed` type tag.
   */
  type: 'settings_changed'
  [k: string]: unknown
}
/**
 * `settings.get`: read every profile setting.
 */
export interface SettingsGetRequest {
  op: 'settings.get'
}
/**
 * Built-in app palette variants, including their explicit mode and complete semantic tokens.
 */
export interface SettingsPalettesRequest {
  op: 'settings.palettes'
}
/**
 * Restore the core appearance defaults without changing other preferences.
 */
export interface SettingsResetAppearanceRequest {
  expected_appearance_revision: number
  op: 'settings.appearance.reset'
}
/**
 * `settings.set`: change the named settings and leave the others. A key the
 * profile does not keep, or a command in `keybindings` or
 * `reset_keybindings` that does not exist, is refused with
 * `unknown_setting`, before anything changes.
 *
 * `keybindings` binds each named command to an Electron accelerator, or
 * unbinds it with null; the other commands keep their keys.
 * `reset_keybindings` first returns the named commands, or `"all"`, to their
 * default keys; a command may not appear in both. A key that is not an
 * accelerator is `invalid_keybinding`; two commands left on the same key is
 * `keybinding_conflict`. Either refusal changes nothing.
 */
export interface SettingsSetRequest {
  app_dark_theme?: string | null
  app_light_theme?: string | null
  appearance?: Appearance | null
  code_font_family?: string | null
  code_font_size?: number | null
  density?: Density | null
  differentiate_without_color?: AccessibilityPreference | null
  /**
   * Reject the entire change if another appearance edit has committed since this revision.
   */
  expected_appearance_revision?: number | null
  /**
   * Fence custom definitions captured by a selection or preview, including inactive variants.
   */
  expected_theme_revisions?: {
    [k: string]: number
  } | null
  high_contrast?: AccessibilityPreference | null
  keybindings?: {
    'close-tab'?: string | null
    'command-palette'?: string | null
    'new-conversation'?: string | null
    'new-tab'?: string | null
    'new-terminal'?: string | null
    'open-settings'?: string | null
    'split-right'?: string | null
    'toggle-dev-panel'?: string | null
    'toggle-left-sidebar'?: string | null
    'toggle-right-sidebar'?: string | null
  } | null
  op: 'settings.set'
  reduced_motion?: ReducedMotion | null
  reduced_transparency?: AccessibilityPreference | null
  reset_keybindings?: KeybindingReset | null
  syntax_binding?: ThemeBinding | null
  terminal_binding?: ThemeBinding | null
  terminal_bold_color?: BoldColor | null
  terminal_color_overrides?: TerminalColorOverrides | null
  terminal_cursor_blink?: boolean | null
  terminal_cursor_shape?: TerminalCursorShape | null
  terminal_font_family?: string | null
  terminal_font_kerning?: TerminalFontKerning | null
  terminal_font_size?: number | null
  terminal_line_height?: number
  terminal_minimum_contrast?: number
  ui_font_family?: string | null
  ui_font_size?: number | null
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
 * `skill.place`: write an installed bundle where one provider reads skills,
 * so that provider's adapter rules invoke it. The path must be absent or
 * catalog-owned and unchanged; an external skill is never overwritten.
 */
export interface SkillPlaceRequest {
  /**
   * The installed bundle's content hash the caller reviewed.
   */
  expected_content_hash: string
  name: string
  op: 'skill.place'
  operation_id: string
  /**
   * `claude`, `codex`, `opencode` or `omp`: whose skill root receives it.
   */
  provider: string
  scope: SkillScope
  /**
   * Required for `workspace` scope. Placement is local: a workspace on a
   * remote host is refused, never placed on this host instead.
   */
  workspace_id?: string | null
}
/**
 * The `skill.place` reply.
 */
export interface SkillPlaced {
  content_hash: string
  name: string
  outcome: SkillPlaceOutcome
  path: string
  provider: string
  scope: SkillScope
  /**
   * The `skill_placed` type tag.
   */
  type: 'skill_placed'
  workspace_id: string | null
  [k: string]: unknown
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
 * A sequenced OS observation from the registered local desktop owner.
 */
export interface SystemAppearanceObservation {
  mode: PaletteMode
  op: 'settings.appearance.observe'
  owner_id: string
  profile_id: string
  sequence: number
}
/**
 * `tab.close`: close a tab, following its target (daemon-authority decision
 * 5). When the tab is the last one, across every window's layouts, of a
 * shell terminal, the terminal closes as `terminal.close` would: every busy
 * shell is found before any closes, and a busy one refuses with
 * `terminal_busy`, listing each in `terminals`, unless `force` is true.
 * Service, script and Conversation terminal tabs and every other target only
 * leave the layout. A closed shell's tabs leave every layout.
 */
export interface TabCloseRequest {
  force?: boolean | null
  op: 'tab.close'
  /**
   * The caller's operation ID. A retry with the same ID and payload
   * returns the recorded outcome; the same ID with another payload is a
   * conflict.
   */
  operation_id: string
  tab_id: string
  window_id: string
  workspace_id?: string | null
}
/**
 * A default appearance update, ordered with PTY output under the terminal lock.
 */
export interface TerminalAppearanceFrame {
  appearance: TerminalAppearance
  run_id: string
  /**
   * The `terminal_appearance` type tag.
   */
  type: 'terminal_appearance'
  [k: string]: unknown
}
export interface TerminalAppearanceRequest {
  op: 'terminal.appearance.get'
  terminal_id: string
  workspace_id: string
}
export interface TerminalAppearanceSetRequest {
  /**
   * Null removes this terminal's override and follows the profile binding.
   */
  binding: ThemeBinding | null
  expected_appearance_revision: number
  op: 'terminal.appearance.set'
  terminal_id: string
  workspace_id: string
}
/**
 * The `terminal_changed` feed frame: a terminal's status, busy state or
 * title changed. At most four per second per terminal. A terminal added or
 * removed arrives as a `catalog` frame instead.
 */
export interface TerminalChanged {
  boot_id: string
  revision: number
  terminal: TerminalRecord
  /**
   * The `terminal_changed` type tag.
   */
  type: 'terminal_changed'
  [k: string]: unknown
}
/**
 * `terminal.close`: stop a terminal and remove it from its workspace.
 *
 * A busy terminal (a command holds its foreground) is refused with
 * `terminal_busy`, naming the command in `foreground`, unless `force` is
 * true. The primary shell's workspace gets a new, not yet started primary
 * shell. Service, script and Conversation terminals are closed through
 * their own commands and are refused here.
 */
export interface TerminalCloseRequest {
  /**
   * Close even when busy, ending the running command.
   */
  force?: boolean | null
  op: 'terminal.close'
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
  terminal_id: string
}
/**
 * The runtime's simulated conversation (a prototype leftover), broadcast to
 * every attachment while `simulate` runs.
 */
export interface TerminalConversationFrame {
  streaming: boolean
  text: string
  /**
   * The `conversation` type tag.
   */
  type: 'conversation'
  [k: string]: unknown
}
/**
 * `terminal.create`: add another terminal to a workspace.
 *
 * `operation_id` is the caller-owned receipt ID. Without one, every call
 * creates a new terminal.
 */
export interface TerminalCreateRequest {
  op: 'terminal.create'
  /**
   * Absent or a string of 1 to 256 bytes; the daemon rejects `null`.
   */
  operation_id?: string
  /**
   * Open a tab `tab-<terminal_id>` for the new terminal in the window's
   * layout for this workspace, in the same transaction. An unknown window
   * is `window_not_found` and creates no terminal.
   */
  place?: TerminalPlace | null
  /**
   * The terminal's title, 1 to 100 characters with no control characters.
   * Without one the title follows the program.
   */
  title?: string | null
  workspace_id: string
}
/**
 * Where `terminal.create` opens the new terminal's tab: a window, and a pane
 * in it (the focused pane when absent).
 */
export interface TerminalPlace {
  pane_id?: string | null
  window_id: string
  [k: string]: unknown
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
export interface TerminalDescendant {
  pid: number
  started: number
  [k: string]: unknown
}
/**
 * The reply to `detach`; the connection closes after it.
 */
export interface TerminalDetachedFrame {
  attachment: number
  run_id: string
  /**
   * The `detached` type tag.
   */
  type: 'detached'
  [k: string]: unknown
}
/**
 * A refused or failed request, a failed restore, or the process exiting.
 * `code` is set for refusals a client acts on: `stale_incarnation` and
 * `incarnation_exited` from the runtime, `needs_rebind` and other typed codes
 * from the daemon, and the SDK's own `output_gap`.
 */
export interface TerminalErrorFrame {
  code?: string | null
  message: string
  recovery?: string | null
  run_id?: string | null
  /**
   * The `error` type tag.
   */
  type: 'error'
  [k: string]: unknown
}
export interface TerminalMetrics {
  /**
   * Attachments and session subscribers.
   */
  clients: number
  descendants: TerminalDescendant[]
  durable_log_error: string | null
  events: number
  /**
   * How the process ended, once it has. Its shape varies with how it ended
   * and whether its process tree was confirmed stopped.
   */
  exit_status?: unknown
  /**
   * The runtime supervisor's process ID.
   */
  pid: number
  /**
   * `[width, height]` in pixels.
   *
   * @minItems 2
   * @maxItems 2
   */
  pixel_size: [unknown, unknown]
  reply_dropped_bytes: number
  /**
   * The attachment that owns the terminal's size.
   */
  resize_owner: number | null
  run_id: string
  scrollback_bytes: number
  shell_pid: number | null
  shell_running: boolean
  /**
   * All output so far, in bytes: the offset the next output frame starts at.
   */
  terminal_bytes: number
  terminal_id: string
  /**
   * A service or script run's incarnation; null for shells.
   */
  transfer_id: string | null
  uptime_ms: number
  viewer_queue_limit_bytes: number
  viewer_resyncs: number
  workspace_id: string
  [k: string]: unknown
}
/**
 * The reply to `ping`, and a broadcast every second while the shell runs.
 */
export interface TerminalMetricsFrame {
  metrics: TerminalMetrics
  /**
   * The `metrics` type tag.
   */
  type: 'metrics'
  [k: string]: unknown
}
/**
 * The `terminal.operation` reply. `operation_id` echoes the requested
 * operation ID.
 */
export interface TerminalOperation {
  operation_id: string
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
 */
export interface TerminalOperationRequest {
  op: 'terminal.operation'
  operation_id: string
  workspace_id: string
}
/**
 * PTY output. `offset` is where these bytes start in the terminal's output.
 */
export interface TerminalOutputFrame {
  bytes: number[]
  /**
   * The bytes as lossy UTF-8.
   */
  data: string
  offset: number
  run_id: string
  /**
   * The `terminal` type tag.
   */
  type: 'terminal'
  [k: string]: unknown
}
/**
 * Recorded output and resizes from the start of the process, up to a limit.
 */
export interface XtermReplayRecovery {
  /**
   * False when the output passed `limit_bytes`; `events` is then empty.
   */
  complete: boolean
  events: XtermReplayEvent[]
  initial_cols: number
  initial_rows: number
  limit_bytes: number
  reason: string | null
  /**
   * The live-output offset the replay reaches.
   */
  through_offset: number
  [k: string]: unknown
}
/**
 * The PTY's size changed, at this point in its output.
 */
export interface TerminalResizeFrame {
  cols: number
  offset: number
  rows: number
  run_id: string
  /**
   * The `terminal_resize` type tag.
   */
  type: 'terminal_resize'
  [k: string]: unknown
}
/**
 * `terminal.restart`: start a new shell in an exited terminal. Without
 * `workspace_id` the daemon uses its default workspace; without
 * `terminal_id` it uses the workspace's primary terminal.
 */
export interface TerminalRestartRequest {
  op: 'terminal.restart'
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
  terminal_id?: string | null
  workspace_id?: string | null
}
/**
 * `terminal.retire`: remove a stopped terminal from its workspace.
 */
export interface TerminalRetireRequest {
  op: 'terminal.retire'
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
  terminal_id: string
  workspace_id: string
}
/**
 * The first frame of an attachment, and a later one marked `resync` when the
 * runtime skipped output this viewer could not keep up with. Which recovery
 * fields it carries depends on the `snapshot_format` the attachment asked for.
 */
export interface TerminalSnapshotFrame {
  /**
   * Present for terminal snapshots; absent for conversation-only streams.
   */
  appearance?: TerminalAppearance | null
  attachment: number
  /**
   * The runtime's simulated conversation text (a prototype leftover).
   */
  conversation: string
  metrics: TerminalMetrics
  response_owner?: string | null
  /**
   * Set on a snapshot that replaces the screen mid-stream.
   */
  resync?: boolean | null
  /**
   * The terminal incarnation this attachment is bound to.
   */
  run_id: string
  streaming: boolean
  terminal_recovery?: TerminalRecovery | null
  /**
   * The active screen, in a plain snapshot.
   */
  terminal_screen_bytes?: number[] | null
  terminal_screen_error?: string | null
  /**
   * The Ghostty snapshot, base64 encoded, when the attachment asked for
   * `snapshot_format: binary`.
   */
  terminal_snapshot_base64?: string | null
  /**
   * `ghostty-snapshot-v1-herdr-<pin>` or `xterm-replay-v1`.
   */
  terminal_snapshot_format?: string | null
  /**
   * The `snapshot` type tag.
   */
  type: 'snapshot'
  [k: string]: unknown
}
/**
 * `terminal.stop`: stop a workspace terminal's shell.
 */
export interface TerminalStopRequest {
  op: 'terminal.stop'
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
  terminal_id: string
  workspace_id: string
}
/**
 * This attachment gained or lost ownership of the terminal's size.
 */
export interface TerminalViewportFrame {
  attachment: number
  owner: boolean
  run_id: string
  /**
   * The `viewport` type tag.
   */
  type: 'viewport'
  [k: string]: unknown
}
/**
 * Something went wrong that the terminal keeps running through, such as
 * dropped PTY replies.
 */
export interface TerminalWarningFrame {
  message: string
  /**
   * The `warning` type tag.
   */
  type: 'warning'
  [k: string]: unknown
}
export interface ThemeDraftPreview {
  /**
   * Declared app projection for role inspection, absent for terminal-only themes.
   */
  app: BuiltinPalette | null
  dark: ThemePreviewSample
  definition: ThemeDefinition
  diagnostics: ThemeDiagnostic[]
  light: ThemePreviewSample
  /**
   * Declared syntax projection for role inspection, absent for other themes.
   */
  syntax: BuiltinPalette | null
  /**
   * Declared terminal projection for role inspection, absent for other themes.
   */
  terminal: TerminalAppearance | null
  /**
   * The `theme_draft_preview` type tag.
   */
  type: 'theme_draft_preview'
  valid: boolean
  [k: string]: unknown
}
export interface ThemePreviewSample {
  app: BuiltinPalette
  diagnostics: AppearanceDiagnostic[]
  syntax: BuiltinPalette
  terminal: TerminalAppearance
  terminal_name: string
  [k: string]: unknown
}
/**
 * Resolves an unsaved definition for editor rendering without installing or applying it.
 */
export interface ThemeDraftPreviewRequest {
  op: 'themes.draft.preview'
  source: string
}
export interface ThemeExport {
  source: string
  theme: ThemeSummary
  /**
   * The `theme_export` type tag.
   */
  type: 'theme_export'
  [k: string]: unknown
}
export interface ThemeExportRequest {
  expected_revision?: number | null
  id: string
  op: 'themes.export'
}
export interface ThemeFileCandidate {
  /**
   * Accepted definition data; pack identity is materialized without selecting the member.
   */
  source: string
  validation: ThemeValidationResponse
  [k: string]: unknown
}
export interface ThemeFileValidateRequest {
  op: 'themes.file.validate'
  source: string
}
export interface ThemeFileValidation {
  /**
   * Valid members may be explicitly accepted even when another member has a required color error.
   */
  candidates: ThemeFileCandidate[]
  /**
   * False for invalid/unsupported pack headers, ambiguous structure or bounded-source failures.
   */
  container_valid: boolean
  diagnostics: ThemeDiagnostic[]
  pack: ThemePackIdentity | null
  /**
   * The `theme_file_validation` type tag.
   */
  type: 'theme_file_validation'
  [k: string]: unknown
}
export interface ThemeInspectRequest {
  id: string
  op: 'themes.inspect'
}
export interface ThemeInspectResponse {
  theme: ThemeRecord
  /**
   * The `theme_record` type tag.
   */
  type: 'theme_record'
  [k: string]: unknown
}
export interface ThemeRecord {
  definition: ThemeDefinition
  diagnostics: ThemeDiagnostic[]
  revision: number
  /**
   * Accepted source is retained independently of the original file.
   */
  source: string
  [k: string]: unknown
}
export interface ThemeInstallItem {
  /**
   * Zero creates an absent ID. A replacement names the currently inspected revision.
   * Repeating already-committed identical normalized content returns its current record unchanged.
   */
  expected_revision: number
  source: string
  [k: string]: unknown
}
export interface ThemeInstallReport {
  diagnostics: ThemeDiagnostic[]
  index: number
  theme: ThemeSummary | null
  valid: boolean
  [k: string]: unknown
}
export interface ThemeInstallRequest {
  /**
   * Only the explicitly accepted definitions belong here. The entire set validates before mutation.
   */
  items: ThemeInstallItem[]
  op: 'themes.install'
}
export interface ThemeInstallation {
  changed: boolean
  committed: boolean
  items: ThemeInstallReport[]
  revision: number
  /**
   * The `theme_installation` type tag.
   */
  type: 'theme_installation'
  [k: string]: unknown
}
export interface ThemeLibrary {
  next_id: string | null
  revision: number
  themes: ThemeSummary[]
  /**
   * The `theme_library` type tag.
   */
  type: 'theme_library'
  [k: string]: unknown
}
export interface ThemeLibraryChanged {
  boot_id: string
  changed_ids: string[]
  library_revision: number
  /**
   * Feed ordering is independent of durable theme library revisions.
   */
  revision: number
  /**
   * The `theme_library_changed` type tag.
   */
  type: 'theme_library_changed'
  [k: string]: unknown
}
export interface ThemeListRequest {
  /**
   * Exclusive stable ID cursor. Pages contain at most 16 summaries.
   */
  after_id?: string | null
  op: 'themes.list'
}
export interface ThemePackExport {
  pack: ThemePackIdentity
  source: string
  themes: ThemeSummary[]
  /**
   * The `theme_pack_export` type tag.
   */
  type: 'theme_pack_export'
  [k: string]: unknown
}
export interface ThemePackExportItem {
  expected_revision: number
  id: string
  [k: string]: unknown
}
export interface ThemePackExportRequest {
  id: string
  items: ThemePackExportItem[]
  name: string
  op: 'themes.pack.export'
}
export interface ThemePreview {
  appearance_revision: number
  expected_theme_revisions: {
    [k: string]: number
  }
  samples: ThemePreviewSample[]
  /**
   * The `theme_preview` type tag.
   */
  type: 'theme_preview'
  [k: string]: unknown
}
export interface ThemePreviewRequest {
  app_dark_theme: string
  app_light_theme: string
  op: 'themes.preview'
  syntax_binding: ThemeBinding
  terminal_binding: ThemeBinding
}
export interface ThemeRemoval {
  appearance_revision: number
  changed: boolean
  id: string
  revision: number
  /**
   * The `theme_removal` type tag.
   */
  type: 'theme_removal'
  [k: string]: unknown
}
export interface ThemeRemovalImpact {
  consumer: ThemeConsumer
  fallback_id: string
  /**
   * Follow-app references change through their app slot; their binding remains follow-app.
   */
  indirect: boolean
  key: string
  slot: ThemeSelectionSlot
  terminal_id: string | null
  workspace_id: string | null
  [k: string]: unknown
}
export interface ThemeRemovalPlan {
  appearance_revision: number
  impacts: ThemeRemovalImpact[]
  next_key: string | null
  removable: boolean
  theme: ThemeSummary
  total: number
  /**
   * The `theme_removal_plan` type tag.
   */
  type: 'theme_removal_plan'
  [k: string]: unknown
}
export interface ThemeRemovalPlanRequest {
  /**
   * Exclusive impact key. Pages contain at most 16 affected selections.
   */
  after_key?: string | null
  id: string
  op: 'themes.removal'
}
export interface ThemeRemoveRequest {
  expected_appearance_revision: number
  expected_revision: number
  id: string
  op: 'themes.remove'
}
export interface ThemeRenameRequest {
  expected_revision: number
  id: string
  name: string
  op: 'themes.rename'
}
export interface ThemeValidateRequest {
  op: 'themes.validate'
  source: string
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
 * Warp YAML becomes a standard ADE terminal definition after preview.
 */
export interface WarpThemeValidateRequest {
  id: string
  op: 'themes.warp.validate'
  source: string
  source_name?: string | null
}
export interface WarpThemeValidation {
  preview: TerminalAppearance | null
  source: string | null
  /**
   * The `warp_theme_validation` type tag.
   */
  type: 'warp_theme_validation'
  validation: ThemeValidationResponse
  [k: string]: unknown
}
/**
 * The reply of every window command: the window as it now stands.
 */
export interface WindowAck {
  /**
   * The `window` type tag.
   */
  type: 'window'
  window: Window
  [k: string]: unknown
}
/**
 * The `window_changed` feed frame: a window was created or changed.
 */
export interface WindowChanged {
  boot_id: string
  revision: number
  /**
   * The `window_changed` type tag.
   */
  type: 'window_changed'
  window: Window
  [k: string]: unknown
}
/**
 * `window.claim`: a window record for a UI window that has none, such as a
 * window the desktop opened before the daemon answered. In order:
 *
 * 1. the first open window, in creation order, not in `claimed`;
 * 2. else the last closed window whose workspace is still listed, reopened;
 * 3. else a new window `window_id` on the first listed workspace.
 *
 * `claimed` names the windows the caller already shows, so a UI with several
 * windows claims a different record for each. A profile with no workspace
 * to show is `invalid_layout`.
 */
export interface WindowClaimRequest {
  /**
   * Windows the caller already shows; at most 256.
   */
  claimed?: string[]
  op: 'window.claim'
  /**
   * The caller's ID for the window, used when a new one is made.
   */
  window_id: string
}
/**
 * `window.close`: hide the window. Its record and layouts stay.
 */
export interface WindowCloseRequest {
  op: 'window.close'
  window_id: string
}
/**
 * `window.create`: a window on a workspace, open, with a default layout.
 * Creating an existing window ID on the same workspace returns it
 * unchanged; on another workspace it is refused.
 */
export interface WindowCreateRequest {
  bounds?: WindowBounds | null
  op: 'window.create'
  /**
   * The caller's ID for the new window.
   */
  window_id: string
  workspace_id: string
}
/**
 * The `window.list` reply, in creation order.
 */
export interface WindowList {
  /**
   * The `windows` type tag.
   */
  type: 'windows'
  windows: Window[]
  [k: string]: unknown
}
/**
 * `window.list`: every window of the profile, open and closed.
 */
export interface WindowListRequest {
  op: 'window.list'
}
/**
 * `window.reopen`: show a closed window again, as it was.
 */
export interface WindowReopenRequest {
  op: 'window.reopen'
  window_id: string
}
/**
 * `window.set_bounds`: record the window's position and size.
 */
export interface WindowSetBoundsRequest {
  bounds: WindowBounds
  op: 'window.set_bounds'
  window_id: string
}
/**
 * `window.set_view_state`: the project rows the navigator shows collapsed.
 */
export interface WindowSetViewStateRequest {
  collapsed_projects: string[]
  op: 'window.set_view_state'
  window_id: string
}
/**
 * `window.show_workspace`: which workspace the window shows. It moves to
 * the front of `recent_workspaces`; its layout is kept per workspace. The
 * reply carries the layout the window now shows.
 */
export interface WindowShowWorkspaceRequest {
  op: 'window.show_workspace'
  window_id: string
  workspace_id: string
}
/**
 * The `window.show_workspace` reply: the window, and its layout for the
 * workspace it now shows, so the caller draws it without a `layout.get`.
 */
export interface WindowShown {
  layout: LayoutRecord
  /**
   * The `window` type tag.
   */
  type: 'window'
  window: Window
  [k: string]: unknown
}
/**
 * The `workspace.open`, `workspace.rename` and `workspace.rebind` reply.
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
 * `workspace.create_worktree`: create a linked worktree of a repository
 * project and open it as a workspace named `name`.
 *
 * The daemon creates the branch and tree through the worktree lifecycle
 * (`worktree.create` with the project's naming defaults, setup hooks
 * included), then opens the tree as a workspace, renames it to `name` and
 * marks it ADE-owned. The reply carries the operation's state at once; the
 * workspace appears in the catalog when it is ready. The lifecycle step's
 * progress is readable with `worktree.operation` under the project ID and
 * this operation ID. A retry with the same ID and payload returns the
 * current state. While another operation holds the repository, the
 * creation waits, `running`, and starts after it.
 *
 * Refused before anything is recorded: an unknown project
 * (`project_not_found`), a plain folder project (`project_not_repository`),
 * an invalid name (`invalid_workspace_name`), or an operation ID the
 * worktree lifecycle already used for a command of its own (`conflict`).
 */
export interface WorkspaceCreateWorktreeRequest {
  /**
   * Start point; the project's configured default base, then `HEAD`.
   */
  base?: string | null
  /**
   * The name ADE shows; the branch is the project's branch prefix plus
   * its slug. Trimmed, 1 to 100 characters, no control characters.
   */
  name: string
  op: 'workspace.create_worktree'
  /**
   * The caller's operation ID.
   */
  operation_id: string
  /**
   * A repository project.
   */
  project_id: string
  /**
   * A window to show the new workspace in once it is ready, as
   * `window.show_workspace` would. A window closed or gone by then is
   * left as it is; the creation still succeeds.
   */
  show_in?: string | null
}
/**
 * `workspace.delete_worktree`: remove a linked worktree's workspace from
 * ADE, then remove the tree.
 *
 * Before changing anything the daemon checks the workspace's
 * `workspace.remove` blockers and the tree's `worktree.cleanup.plan`
 * blockers (except `active_work`, `setup_incomplete` and
 * `teardown_incomplete`, which the removal itself resolves), and refuses with
 * `worktree_delete_blocked` and `blockers: [{kind, id, label}]`. A primary
 * checkout is refused with `primary_checkout`, a plain folder with
 * `not_a_worktree`. A workspace already removed from ADE is accepted.
 *
 * While another operation holds the repository, the deletion waits before
 * removing anything; it then checks the blockers again, so a tree that
 * became dirty meanwhile fails the operation with `worktree_delete_blocked`
 * and the workspace untouched. If the tree cannot be removed after the
 * workspace was, the workspace is restored, but without its previous
 * layouts and terminals; the failed state's `error` says so, or says the
 * restore failed too. A crash between the two steps is recovered when the
 * daemon starts again.
 */
export interface WorkspaceDeleteWorktreeRequest {
  /**
   * What happens to the tree's branch; `keep` when absent.
   */
  delete_branch?: BranchPolicy | null
  op: 'workspace.delete_worktree'
  /**
   * The caller's operation ID.
   */
  operation_id: string
  workspace_id: string
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
 * `workspace.rebind`: bind a restored workspace to a verified directory.
 */
export interface WorkspaceRebindRequest {
  op: 'workspace.rebind'
  path: string
  workspace_id: string
}
/**
 * `workspace.remove` ("Remove from ADE"): hide a workspace from the catalog
 * without touching its files.
 *
 * - Refused with `workspace_remove_blocked` while a Conversation turn runs, a
 *   service runs, a script run is still running, or the workspace is the
 *   daemon's default. The error frame carries `blockers`:
 *   `[{kind, id, label}]`, where `kind` is `conversation_running`,
 *   `service_running`, `script_running` or `default_workspace`.
 * - Otherwise it disconnects the workspace's idle Agents, records the
 *   removal, stops every terminal (primary, extra and exited script runs)
 *   and retires all but service terminals, so no process or worktree lease
 *   remains. A later `worktree.remove` of the folder sees no `active_work`.
 * - The record stays, so Conversations keep their workspace. They leave the
 *   catalog with it. `workspace.open` on the same folder restores the same
 *   workspace ID and its Conversations.
 * - Removing a removed workspace succeeds and changes nothing. An unknown ID
 *   is `workspace_not_found`.
 */
export interface WorkspaceRemoveRequest {
  op: 'workspace.remove'
  /**
   * The caller's operation ID. A retry with the same ID and payload returns
   * the recorded outcome; the same ID with another payload is a conflict.
   */
  operation_id: string
  workspace_id: string
}
/**
 * The `workspace.remove` reply: the workspace is removed and none of its
 * terminals runs.
 */
export interface WorkspaceRemoved {
  /**
   * The `workspace_removed` type tag.
   */
  type: 'workspace_removed'
  workspace_id: string
  [k: string]: unknown
}
/**
 * `workspace.rename`: change the name ADE shows for a workspace. The folder,
 * its path and any Git branch are unchanged.
 *
 * The daemon trims `name` and refuses an empty name, one longer than 100
 * characters or one with a control character (`invalid_workspace_name`). An
 * unknown ID is `workspace_not_found`; a removed workspace is
 * `workspace_removed`. The new name persists and a `catalog` frame follows.
 */
export interface WorkspaceRenameRequest {
  name: string
  op: 'workspace.rename'
  workspace_id: string
}
/**
 * The `workspace.create_worktree` and `workspace.delete_worktree` reply:
 * the operation's current state.
 */
export interface WorkspaceWorktreeOperation {
  code: string | null
  error: string | null
  kind: WorkspaceWorktreeKind
  operation_id: string
  project_id: string
  status: WorkspaceWorktreeStatus
  /**
   * The `workspace_worktree_operation` type tag.
   */
  type: 'workspace_worktree_operation'
  /**
   * The new workspace once created, or the workspace being deleted.
   */
  workspace_id: string | null
  /**
   * The tree's path once the lifecycle names it.
   */
  worktree_path: string | null
  [k: string]: unknown
}
/**
 * The `workspace_worktree_operation_changed` feed frame: a
 * `workspace.create_worktree` or `workspace.delete_worktree` operation was
 * admitted or took a step. A client waiting for one watches for its
 * `operation_id` to leave `running`; after missing frames (a reconnect) it
 * sends the command again under the same ID, whose reply is the state now.
 */
export interface WorkspaceWorktreeOperationChanged {
  boot_id: string
  operation: WorkspaceWorktreeOperation
  revision: number
  /**
   * The `workspace_worktree_operation_changed` type tag.
   */
  type: 'workspace_worktree_operation_changed'
  [k: string]: unknown
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
  /**
   * The caller's operation ID. The daemon keeps a receipt under it: a
   * retry with the same ID and payload returns the recorded outcome, and
   * the same ID with another payload is a conflict.
   */
  operation_id: string
  path: string
  project_id: string
}
/**
 * The `worktree.archived` reply, newest first, at most 200 records.
 */
export interface WorktreeArchive {
  entries: WorktreeArchiveEntry[]
  project_id: string
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
  project_id: string
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
  project_id: string
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
  project_id: string
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
   * Caller-owned operation ID.
   */
  operation_id: string
  /**
   * As in `worktree.carry.preview`; every change when absent.
   */
  paths?: string[] | null
  project_id: string
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
  project_id: string
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
  project_id: string
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
   * Caller-owned operation ID.
   */
  operation_id: string
  /**
   * One to 32 tree paths, each from `worktree.cleanup.plan`.
   */
  paths: string[]
  project_id: string
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
  project_id: string
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
   * Caller-owned operation ID.
   */
  operation_id: string
  /**
   * Absolute path for the tree, directly inside the configured directory.
   */
  path?: string | null
  project_id: string
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
  project_id: string
}
/**
 * A hook that is still running: which one, how far the operation has got,
 * and the latest output, bounded to its last 16 KiB.
 */
export interface WorktreeHookProgress {
  /**
   * The hooks of this phase that have finished, without their output.
   */
  completed: WorktreeHookRun[]
  elapsed_ms: number
  /**
   * The hook's position in its phase, from 0.
   */
  index: number
  name: string
  /**
   * The last 16 KiB of stdout and stderr, interleaved as they arrived.
   */
  output: string
  /**
   * The tree the hook runs in.
   */
  path: string
  phase: HookPhase
  started_at: number
  /**
   * How many hooks the phase has configured.
   */
  total: number
  /**
   * Whether earlier output was dropped.
   */
  truncated: boolean
  [k: string]: unknown
}
/**
 * One hook run, as recorded in an operation's `result.hooks` or in a
 * cleanup tree's `hooks`.
 */
export interface WorktreeHookRun {
  elapsed_ms: number
  exit_code: number | null
  name: string
  /**
   * The last 64 KiB of stdout, then of stderr. `worktree_state` omits it.
   */
  output?: string | null
  phase: HookPhase
  /**
   * Whether earlier output was dropped.
   */
  truncated: boolean
  verdict: HookVerdict
  [k: string]: unknown
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
  project_id: string
  recovery?: string | null
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
   * The setup or teardown hook the operation is running now. Present only
   * while a hook runs; the daemon keeps it in memory, so a restarted daemon
   * reports the interrupted operation without it.
   */
  running_hook?: WorktreeHookProgress | null
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
   * The operation's ID.
   */
  operation_id: string
  project_id: string
}
/**
 * `worktree.rebind`: bind a restored lifecycle repository to a verified checkout.
 */
export interface WorktreeRebindRequest {
  op: 'worktree.rebind'
  path: string
  project_id: string
}
/**
 * `worktree.refresh`: re-read the Git worktree listing under the repository lock.
 */
export interface WorktreeRefreshRequest {
  op: 'worktree.refresh'
  /**
   * Caller-owned operation ID.
   */
  operation_id: string
  project_id: string
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
   * Caller-owned operation ID.
   */
  operation_id: string
  path: string
  project_id: string
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
   * Caller-owned operation ID.
   */
  operation_id: string
  path: string
  project_id: string
}
/**
 * `worktree.setup`: run the setup hooks again in an ADE-owned tree, such as
 * one whose setup failed or was interrupted. Only a full success makes it ready.
 */
export interface WorktreeSetupRequest {
  op: 'worktree.setup'
  /**
   * Caller-owned operation ID.
   */
  operation_id: string
  path: string
  project_id: string
}
/**
 * A repository's lifecycle state: the reply to every command except
 * `worktree.operation`.
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
   * Caller-owned operation ID.
   */
  operation_id: string
  /**
   * Absolute path for a new tree, directly inside the configured directory.
   */
  path?: string | null
  project_id: string
  /**
   * A branch name, or the path of an existing linked tree.
   */
  target: string
}

export type Operation = "catalog.get" | "workspace.open" | "workspace.rename" | "workspace.remove" | "workspace.create_worktree" | "workspace.delete_worktree" | "rebind.list" | "workspace.rebind" | "repository.rebind" | "conversation.get" | "conversation.history" | "agent.send" | "agent.answer" | "conversation.create" | "conversation.mark_seen" | "draft.get" | "draft.save" | "draft.send.get" | "draft.send.prepare" | "draft.send.complete" | "draft.send.abort" | "draft.send.list" | "draft.send.acknowledge" | "queue.enqueue" | "queue.cancel" | "queue.pause" | "attachment.put" | "attachment.import" | "attachment.inspect" | "attachment.reclaim.preview" | "attachment.reclaim.apply" | "conversation.controls" | "conversation.steer" | "conversation.compact" | "conversation.rewind.preview" | "conversation.rewind" | "conversation.snooze" | "conversation.unsnooze" | "conversation.snooze.list" | "conversation.delete" | "draft.history.list" | "draft.history.restore" | "draft.stash.save" | "draft.stash.list" | "draft.stash.restore" | "draft.stash.drop" | "agent.cancel" | "agent.resume" | "agent.disconnect" | "agent.child_transcript" | "agent.list" | "agent.account_inspect" | "provider.list" | "account.list" | "account.create" | "account.inspect" | "account.verify" | "account.disable" | "account.switch.preview" | "account.switch" | "account.switch.list" | "terminal.appearance.get" | "terminal.appearance.set" | "terminal.create" | "terminal.operation" | "terminal.restart" | "terminal.stop" | "terminal.retire" | "terminal.close" | "service.configure" | "service.list" | "service.inspect" | "service.start" | "service.stop" | "service.remove" | "service.health.sample" | "service.proxy.ensure" | "service.proxy.inspect" | "service.proxy.target" | "service.proxy.remap" | "service.proxy.retire" | "service.proxy.recovery.inspect" | "service.proxy.recovery.retry" | "service.proxy.recovery.reset" | "listener.list" | "review.status" | "review.diff" | "review.diff_page" | "review.hunk" | "review.stage" | "review.unstage" | "review.discard" | "review.commit" | "review.branch" | "review.stash" | "review.merge" | "review.fetch" | "review.pull" | "review.push" | "review.operation" | "review.operation.list" | "review.operation.acknowledge" | "review.feedback.search" | "review.feedback.send" | "worktree.repository" | "worktree.get" | "worktree.switch" | "worktree.adopt" | "worktree.remove" | "worktree.refresh" | "worktree.configure" | "worktree.operation" | "worktree.rebind" | "worktree.create" | "worktree.setup" | "worktree.cleanup.plan" | "worktree.cleanup" | "worktree.archived" | "worktree.carry.preview" | "worktree.carry" | "worktree.resources.apply" | "script.list" | "script.inspect" | "script.start" | "script.stop" | "script.retire" | "script.runs" | "file.list" | "file.search" | "file.preview" | "hello" | "runtime.status" | "runtime.prepare_restart" | "session.subscribe" | "browser.owner.get" | "browser.owner.register" | "browser.owner.unregister" | "browser.list" | "browser.inspect" | "browser.open" | "browser.navigate" | "browser.close" | "browser.operation" | "diagnostics.status" | "diagnostics.export" | "runtime.recovery" | "runtime.recovery.release" | "activity.list" | "activity.mark" | "notification.delivery.claim" | "notification.delivery.report" | "notification.delivery.list" | "notification.preferences.get" | "notification.preferences.set" | "mcp.server.list" | "mcp.server.inspect" | "mcp.server.add" | "mcp.server.update" | "mcp.server.remove" | "mcp.resolve" | "skill.install" | "skill.adopt" | "skill.remove" | "skill.place" | "skill.list" | "skill.inspect" | "skill.discover" | "plugin.list" | "plugin.inspect" | "plugin.install" | "plugin.uninstall" | "plugin.enable" | "plugin.disable" | "plugin.record.get" | "plugin.record.list" | "plugin.record.put" | "plugin.record.delete" | "plugin.setting.list" | "plugin.setting.set" | "plugin.command.invoke" | "plugin.host.status" | "plugin.host.restart" | "plugin.dev.enter" | "plugin.dev.leave" | "plugin.generation.list" | "orchestration.delegate" | "orchestration.children" | "orchestration.child.get" | "orchestration.child.send" | "orchestration.child.wait" | "orchestration.child.answer" | "orchestration.parent.send" | "orchestration.child.messages" | "orchestration.group.start" | "orchestration.groups" | "orchestration.group.get" | "orchestration.group.compare" | "history.search" | "history.list" | "history.index.status" | "history.index.rebuild" | "history.import.scan" | "history.import.session" | "resources.inspect" | "resources.claim.resolve" | "resources.registry.accept" | "resources.device.hold" | "resources.device.release" | "checkpoint.create" | "checkpoint.list" | "checkpoint.restore.preview" | "checkpoint.restore" | "checkpoint.delete" | "usage.summary" | "usage.turns" | "usage.limits" | "remote.host.list" | "remote.host.add" | "remote.host.remove" | "remote.host.probe" | "remote.host.pair" | "remote.host.revoke" | "remote.host.start" | "remote.host.install" | "retention.preview" | "retention.apply" | "retention.policy.get" | "retention.policy.set" | "browser.diagnostics.attach" | "browser.diagnostics.detach" | "browser.diagnostics.read" | "browser.recording.start" | "browser.recording.stop" | "browser.recording.get" | "browser.partition.list" | "browser.partition.create" | "browser.import.preview" | "browser.import.run" | "browser.import.get" | "browser.context.capture" | "browser.click" | "browser.type" | "browser.evaluate" | "browser.wait" | "browser.screenshot" | "repository.coverage" | "repository.clone" | "repository.publish.preview" | "repository.publish" | "hook.subscription.list" | "hook.delivery.list" | "hook.delivery.inspect" | "hook.delivery.retry" | "hook.delivery.abandon" | "provider.capabilities" | "provider.readiness" | "provider.quota" | "provider.inspect" | "provider.registrations" | "preset.list" | "preset.get" | "preset.save" | "preset.delete" | "adapter.list" | "adapter.put" | "adapter.remove" | "adapter.probe" | "device.list" | "device.screenshot" | "device.boot" | "device.app.install" | "device.app.launch" | "device.input" | "placement.hosts" | "placement.check" | "placement.record" | "placement.resolve" | "placement.list" | "placement.release" | "command.list" | "command.invoke" | "context.capture" | "context.get" | "context.plan" | "window.list" | "window.create" | "window.close" | "window.reopen" | "window.claim" | "window.set_bounds" | "window.show_workspace" | "window.set_view_state" | "layout.get" | "layout.apply" | "tab.close" | "pane.close" | "settings.appearance.observe" | "settings.palettes" | "settings.appearance.reset" | "settings.appearance" | "settings.get" | "settings.set" | "themes.ghostty.export" | "themes.ghostty.validate" | "themes.warp.validate" | "themes.file.validate" | "themes.pack.export" | "themes.validate" | "themes.list" | "themes.inspect" | "themes.install" | "themes.rename" | "themes.export" | "themes.preview" | "themes.draft.preview" | "themes.removal" | "themes.remove"

export interface RequestByOperation {
  "catalog.get": CatalogGetRequest
  "workspace.open": WorkspaceOpenRequest
  "workspace.rename": WorkspaceRenameRequest
  "workspace.remove": WorkspaceRemoveRequest
  "workspace.create_worktree": WorkspaceCreateWorktreeRequest
  "workspace.delete_worktree": WorkspaceDeleteWorktreeRequest
  "rebind.list": RebindListRequest
  "workspace.rebind": WorkspaceRebindRequest
  "repository.rebind": RepositoryRebindRequest
  "conversation.get": ConversationGetRequest
  "conversation.history": ConversationHistoryRequest
  "agent.send": AgentSendRequest
  "agent.answer": AgentAnswerRequest
  "conversation.create": ConversationCreateRequest
  "conversation.mark_seen": ConversationMarkSeenRequest
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
  "attachment.put": AttachmentPutRequest
  "attachment.import": AttachmentImportRequest
  "attachment.inspect": AttachmentInspectRequest
  "attachment.reclaim.preview": AttachmentReclaimPreviewRequest
  "attachment.reclaim.apply": AttachmentReclaimApplyRequest
  "conversation.controls": ConversationControlsRequest
  "conversation.steer": ConversationSteerRequest
  "conversation.compact": ConversationCompactRequest
  "conversation.rewind.preview": ConversationRewindPreviewRequest
  "conversation.rewind": ConversationRewindRequest
  "conversation.snooze": ConversationSnoozeRequest
  "conversation.unsnooze": ConversationUnsnoozeRequest
  "conversation.snooze.list": ConversationSnoozeListRequest
  "conversation.delete": ConversationDeleteRequest
  "draft.history.list": DraftHistoryListRequest
  "draft.history.restore": DraftHistoryRestoreRequest
  "draft.stash.save": DraftStashSaveRequest
  "draft.stash.list": DraftStashListRequest
  "draft.stash.restore": DraftStashRestoreRequest
  "draft.stash.drop": DraftStashDropRequest
  "agent.cancel": AgentCancelRequest
  "agent.resume": AgentResumeRequest
  "agent.disconnect": AgentDisconnectRequest
  "agent.child_transcript": AgentChildTranscriptRequest
  "agent.list": AgentListRequest
  "agent.account_inspect": AgentAccountInspectRequest
  "provider.list": ProviderListRequest
  "account.list": AccountListRequest
  "account.create": AccountCreateRequest
  "account.inspect": AccountInspectRequest
  "account.verify": AccountVerifyRequest
  "account.disable": AccountDisableRequest
  "account.switch.preview": AccountSwitchPreviewRequest
  "account.switch": AccountSwitchRequest
  "account.switch.list": AccountSwitchListRequest
  "terminal.appearance.get": TerminalAppearanceRequest
  "terminal.appearance.set": TerminalAppearanceSetRequest
  "terminal.create": TerminalCreateRequest
  "terminal.operation": TerminalOperationRequest
  "terminal.restart": TerminalRestartRequest
  "terminal.stop": TerminalStopRequest
  "terminal.retire": TerminalRetireRequest
  "terminal.close": TerminalCloseRequest
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
  "review.branch": ReviewBranchRequest
  "review.stash": ReviewStashRequest
  "review.merge": ReviewMergeRequest
  "review.fetch": ReviewFetchRequest
  "review.pull": ReviewPullRequest
  "review.push": ReviewPushRequest
  "review.operation": ReviewOperationRequest
  "review.operation.list": ReviewOperationListRequest
  "review.operation.acknowledge": ReviewOperationAcknowledgeRequest
  "review.feedback.search": ReviewFeedbackSearchRequest
  "review.feedback.send": ReviewFeedbackSendRequest
  "worktree.repository": WorktreeRepositoryRequest
  "worktree.get": WorktreeGetRequest
  "worktree.switch": WorktreeSwitchRequest
  "worktree.adopt": WorktreeAdoptRequest
  "worktree.remove": WorktreeRemoveRequest
  "worktree.refresh": WorktreeRefreshRequest
  "worktree.configure": WorktreeConfigureRequest
  "worktree.operation": WorktreeOperationRequest
  "worktree.rebind": WorktreeRebindRequest
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
  "runtime.recovery": RuntimeRecoveryRequest
  "runtime.recovery.release": RuntimeRecoveryReleaseRequest
  "activity.list": ActivityListRequest
  "activity.mark": ActivityMarkRequest
  "notification.delivery.claim": NotificationDeliveryClaimRequest
  "notification.delivery.report": NotificationDeliveryReportRequest
  "notification.delivery.list": NotificationDeliveryListRequest
  "notification.preferences.get": NotificationPreferencesGetRequest
  "notification.preferences.set": NotificationPreferencesSetRequest
  "mcp.server.list": McpServerListRequest
  "mcp.server.inspect": McpServerInspectRequest
  "mcp.server.add": McpServerAddRequest
  "mcp.server.update": McpServerUpdateRequest
  "mcp.server.remove": McpServerRemoveRequest
  "mcp.resolve": McpResolveRequest
  "skill.install": SkillInstallRequest
  "skill.adopt": SkillAdoptRequest
  "skill.remove": SkillRemoveRequest
  "skill.place": SkillPlaceRequest
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
  "plugin.dev.enter": PluginDevEnterRequest
  "plugin.dev.leave": PluginDevLeaveRequest
  "plugin.generation.list": PluginGenerationListRequest
  "orchestration.delegate": DelegateRequest
  "orchestration.children": ChildrenRequest
  "orchestration.child.get": ChildGetRequest
  "orchestration.child.send": ChildSendRequest
  "orchestration.child.wait": ChildWaitRequest
  "orchestration.child.answer": ChildAnswerRequest
  "orchestration.parent.send": ParentSendRequest
  "orchestration.child.messages": ChildMessagesRequest
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
  "resources.device.hold": ResourcesDeviceHoldRequest
  "resources.device.release": ResourcesDeviceReleaseRequest
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
  "remote.host.install": RemoteHostInstallRequest
  "retention.preview": RetentionPreviewRequest
  "retention.apply": RetentionApplyRequest
  "retention.policy.get": RetentionPolicyGetRequest
  "retention.policy.set": RetentionPolicySetRequest
  "browser.diagnostics.attach": BrowserDiagnosticsAttachRequest
  "browser.diagnostics.detach": BrowserDiagnosticsDetachRequest
  "browser.diagnostics.read": BrowserDiagnosticsReadRequest
  "browser.recording.start": BrowserRecordingStartRequest
  "browser.recording.stop": BrowserRecordingStopRequest
  "browser.recording.get": BrowserRecordingGetRequest
  "browser.partition.list": BrowserPartitionListRequest
  "browser.partition.create": BrowserPartitionCreateRequest
  "browser.import.preview": BrowserImportPreviewRequest
  "browser.import.run": BrowserImportRunRequest
  "browser.import.get": BrowserImportGetRequest
  "browser.context.capture": BrowserContextCaptureRequest
  "browser.click": BrowserClickRequest
  "browser.type": BrowserTypeRequest
  "browser.evaluate": BrowserEvaluateRequest
  "browser.wait": BrowserWaitRequest
  "browser.screenshot": BrowserScreenshotRequest
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
  "provider.inspect": ProviderInspectRequest
  "provider.registrations": ProviderRegistrationsRequest
  "preset.list": PresetListRequest
  "preset.get": PresetGetRequest
  "preset.save": PresetSaveRequest
  "preset.delete": PresetDeleteRequest
  "adapter.list": AdapterListRequest
  "adapter.put": AdapterPutRequest
  "adapter.remove": AdapterRemoveRequest
  "adapter.probe": AdapterProbeRequest
  "device.list": DeviceListRequest
  "device.screenshot": DeviceScreenshotRequest
  "device.boot": DeviceBootRequest
  "device.app.install": DeviceAppInstallRequest
  "device.app.launch": DeviceAppLaunchRequest
  "device.input": DeviceInputRequest
  "placement.hosts": PlacementHostsRequest
  "placement.check": PlacementCheckRequest
  "placement.record": PlacementRecordRequest
  "placement.resolve": PlacementResolveRequest
  "placement.list": PlacementListRequest
  "placement.release": PlacementReleaseRequest
  "command.list": CommandListRequest
  "command.invoke": CommandInvokeRequest
  "context.capture": ContextCaptureRequest
  "context.get": ContextGetRequest
  "context.plan": ContextPlanRequest
  "window.list": WindowListRequest
  "window.create": WindowCreateRequest
  "window.close": WindowCloseRequest
  "window.reopen": WindowReopenRequest
  "window.claim": WindowClaimRequest
  "window.set_bounds": WindowSetBoundsRequest
  "window.show_workspace": WindowShowWorkspaceRequest
  "window.set_view_state": WindowSetViewStateRequest
  "layout.get": LayoutGetRequest
  "layout.apply": LayoutApplyRequest
  "tab.close": TabCloseRequest
  "pane.close": PaneCloseRequest
  "settings.appearance.observe": SystemAppearanceObservation
  "settings.palettes": SettingsPalettesRequest
  "settings.appearance.reset": SettingsResetAppearanceRequest
  "settings.appearance": SettingsAppearanceRequest
  "settings.get": SettingsGetRequest
  "settings.set": SettingsSetRequest
  "themes.ghostty.export": GhosttyThemeExportRequest
  "themes.ghostty.validate": GhosttyThemeValidateRequest
  "themes.warp.validate": WarpThemeValidateRequest
  "themes.file.validate": ThemeFileValidateRequest
  "themes.pack.export": ThemePackExportRequest
  "themes.validate": ThemeValidateRequest
  "themes.list": ThemeListRequest
  "themes.inspect": ThemeInspectRequest
  "themes.install": ThemeInstallRequest
  "themes.rename": ThemeRenameRequest
  "themes.export": ThemeExportRequest
  "themes.preview": ThemePreviewRequest
  "themes.draft.preview": ThemeDraftPreviewRequest
  "themes.removal": ThemeRemovalPlanRequest
  "themes.remove": ThemeRemoveRequest
}

export interface ResponseByOperation {
  "catalog.get": CatalogFrame
  "workspace.open": WorkspaceAck
  "workspace.rename": WorkspaceAck
  "workspace.remove": WorkspaceRemoved
  "workspace.create_worktree": WorkspaceWorktreeOperation
  "workspace.delete_worktree": WorkspaceWorktreeOperation
  "rebind.list": RebindCatalog
  "workspace.rebind": WorkspaceAck
  "repository.rebind": RepositoryAck
  "conversation.get": ConversationSnapshot
  "conversation.history": ConversationHistory
  "agent.send": Ack
  "agent.answer": AgentAnswerOutcome
  "conversation.create": ConversationCreated
  "conversation.mark_seen": Ack
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
  "attachment.put": AttachmentReply
  "attachment.import": AttachmentReply
  "attachment.inspect": AttachmentInspection
  "attachment.reclaim.preview": AttachmentReclaimPreviewReply
  "attachment.reclaim.apply": AttachmentReclaim
  "conversation.controls": ConversationControls
  "conversation.steer": ConversationControlReply
  "conversation.compact": ConversationControlReply
  "conversation.rewind.preview": ConversationRewindPreview
  "conversation.rewind": ConversationControlReply
  "conversation.snooze": ConversationSnoozeReply
  "conversation.unsnooze": ConversationSnoozeReply
  "conversation.snooze.list": ConversationSnoozeList
  "conversation.delete": ConversationDeleted
  "draft.history.list": DraftHistoryList
  "draft.history.restore": DraftRestored
  "draft.stash.save": DraftStashReply
  "draft.stash.list": DraftStashList
  "draft.stash.restore": DraftRestored
  "draft.stash.drop": DraftStashDropped
  "agent.cancel": AgentCancelOutcome
  "agent.resume": Ack
  "agent.disconnect": Ack
  "agent.child_transcript": ChildTranscriptPage
  "agent.list": AgentList
  "agent.account_inspect": AgentAccountInspection
  "provider.list": ProvidersReply
  "account.list": AccountsReply
  "account.create": AccountAck
  "account.inspect": AccountInspection
  "account.verify": AccountAck
  "account.disable": AccountDisabled
  "account.switch.preview": AccountSwitchPreview
  "account.switch": AccountSwitched
  "account.switch.list": AccountSwitches
  "terminal.appearance.get": ResolvedTerminalAppearance
  "terminal.appearance.set": ResolvedTerminalAppearance
  "terminal.create": TerminalCreated
  "terminal.operation": TerminalOperation
  "terminal.restart": Ack
  "terminal.stop": Ack
  "terminal.retire": Ack
  "terminal.close": Ack
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
  "review.branch": ReviewOperationReply
  "review.stash": ReviewOperationReply
  "review.merge": ReviewOperationReply
  "review.fetch": ReviewOperationReply
  "review.pull": ReviewOperationReply
  "review.push": ReviewOperationReply
  "review.operation": ReviewOperationReply
  "review.operation.list": ReviewOperationList
  "review.operation.acknowledge": ReviewOperationAcknowledged
  "review.feedback.search": ReviewFeedbackSearch
  "review.feedback.send": ReviewFeedbackQueued
  "worktree.repository": WorktreeState
  "worktree.get": WorktreeState
  "worktree.switch": WorktreeState
  "worktree.adopt": WorktreeState
  "worktree.remove": WorktreeState
  "worktree.refresh": WorktreeState
  "worktree.configure": WorktreeState
  "worktree.operation": WorktreeOperationReply
  "worktree.rebind": WorktreeState
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
  "runtime.recovery": RuntimeRecovery
  "runtime.recovery.release": RuntimeRecoveryReleased
  "activity.list": ActivityList
  "activity.mark": ActivityMarked
  "notification.delivery.claim": NotificationDeliveryClaim
  "notification.delivery.report": NotificationDeliveryReply
  "notification.delivery.list": NotificationDeliveries
  "notification.preferences.get": NotificationPreferences
  "notification.preferences.set": NotificationPreferences
  "mcp.server.list": McpServers
  "mcp.server.inspect": McpServerInspection
  "mcp.server.add": McpServerReply
  "mcp.server.update": McpServerReply
  "mcp.server.remove": McpServerRemoved
  "mcp.resolve": McpResolution
  "skill.install": SkillInstalled
  "skill.adopt": SkillInstalled
  "skill.remove": SkillRemoved
  "skill.place": SkillPlaced
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
  "plugin.dev.enter": PluginGenerations
  "plugin.dev.leave": PluginGenerations
  "plugin.generation.list": PluginGenerations
  "orchestration.delegate": ChildDelegated
  "orchestration.children": ChildList
  "orchestration.child.get": ChildReply
  "orchestration.child.send": ChildMessageQueued
  "orchestration.child.wait": ChildWait
  "orchestration.child.answer": ChildAnswered
  "orchestration.parent.send": ParentMessageQueued
  "orchestration.child.messages": ChildMessages
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
  "resources.device.hold": HostResourcesState
  "resources.device.release": HostResourcesState
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
  "remote.host.install": RemoteHostInstall
  "retention.preview": RetentionPreview
  "retention.apply": RetentionApply
  "retention.policy.get": RetentionPolicyReply
  "retention.policy.set": RetentionPolicyReply
  "browser.diagnostics.attach": BrowserDiagnosticsState
  "browser.diagnostics.detach": BrowserDiagnosticsState
  "browser.diagnostics.read": BrowserDiagnostics
  "browser.recording.start": BrowserRecording
  "browser.recording.stop": BrowserRecording
  "browser.recording.get": BrowserRecording
  "browser.partition.list": BrowserPartitions
  "browser.partition.create": BrowserPartitionReply
  "browser.import.preview": BrowserImportPreview
  "browser.import.run": BrowserImport
  "browser.import.get": BrowserImport
  "browser.context.capture": BrowserContextCapture
  "browser.click": BrowserMutation
  "browser.type": BrowserMutation
  "browser.evaluate": BrowserEvaluation
  "browser.wait": BrowserWait
  "browser.screenshot": BrowserScreenshot
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
  "provider.inspect": ProviderInspect
  "provider.registrations": ProviderRegistrations
  "preset.list": PresetList
  "preset.get": PresetView
  "preset.save": PresetSaved
  "preset.delete": PresetDeleted
  "adapter.list": AdapterList
  "adapter.put": AdapterPut
  "adapter.remove": AdapterRemoved
  "adapter.probe": AdapterProbed
  "device.list": DeviceInventory
  "device.screenshot": DeviceScreenshot
  "device.boot": DeviceBooted
  "device.app.install": DeviceAppInstalled
  "device.app.launch": DeviceAppLaunched
  "device.input": DeviceInputSent
  "placement.hosts": ExecutionHosts
  "placement.check": PlacementDecision
  "placement.record": PlacementReply
  "placement.resolve": PlacementReply
  "placement.list": Placements
  "placement.release": PlacementReleased
  "command.list": CommandList
  "command.invoke": CommandInvoked
  "context.capture": ContextNodeReply
  "context.get": ContextNodeReply
  "context.plan": ContextPlan
  "window.list": WindowList
  "window.create": WindowAck
  "window.close": WindowAck
  "window.reopen": WindowAck
  "window.claim": WindowAck
  "window.set_bounds": WindowAck
  "window.show_workspace": WindowShown
  "window.set_view_state": WindowAck
  "layout.get": LayoutReply
  "layout.apply": LayoutApplied
  "tab.close": LayoutApplied
  "pane.close": LayoutApplied
  "settings.appearance.observe": Settings
  "settings.palettes": PaletteCatalog
  "settings.appearance.reset": Settings
  "settings.appearance": ResolvedAppearance
  "settings.get": Settings
  "settings.set": Settings
  "themes.ghostty.export": GhosttyThemeExport
  "themes.ghostty.validate": GhosttyThemeValidation
  "themes.warp.validate": WarpThemeValidation
  "themes.file.validate": ThemeFileValidation
  "themes.pack.export": ThemePackExport
  "themes.validate": ThemeValidationResponse
  "themes.list": ThemeLibrary
  "themes.inspect": ThemeInspectResponse
  "themes.install": ThemeInstallation
  "themes.rename": ThemeInstallation
  "themes.export": ThemeExport
  "themes.preview": ThemePreview
  "themes.draft.preview": ThemeDraftPreview
  "themes.removal": ThemeRemovalPlan
  "themes.remove": ThemeRemoval
}

export type FeedFrame = CatalogFrame | WorkspaceWorktreeOperationChanged | ConversationChanged | ConversationDeletedFrame | ConversationReloadFrame | TerminalChanged | ServiceChanged | ActivityChanged | WindowChanged | LayoutChanged | LayoutRemoved | SettingsChanged | ThemeLibraryChanged

export type TerminalStreamFrame = TerminalSnapshotFrame | TerminalOutputFrame | TerminalAppearanceFrame | TerminalResizeFrame | TerminalViewportFrame | TerminalMetricsFrame | TerminalDetachedFrame | TerminalWarningFrame | TerminalErrorFrame | TerminalConversationFrame | Ack
