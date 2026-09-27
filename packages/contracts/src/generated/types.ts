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
  | ExecutionState
  | HealthCheckRequest
  | HealthPolicy
  | ListenerFamily
  | ListenerInventory
  | ListenerListRequest
  | ListenerOwnership
  | ListenerRow
  | Message
  | PeerEndpoint
  | PendingRequest
  | PortAssignment
  | PortObservation
  | ProxyAvailability
  | QueuedPrompt
  | Readiness
  | ReadinessBasis
  | ReadinessState
  | RecoveryStatus
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
  | TerminalOwner
  | WorkspaceRecord
/**
 * Whether a service's recorded run is live in the current runtime.
 */
export type ExecutionState = 'running' | 'exited' | 'stopped' | 'unavailable'
export type ListenerFamily = 'ipv4' | 'ipv6'
export type PortObservation = 'verified_managed' | 'contested' | 'observed_other' | 'unobserved'
export type ListenerOwnership = 'managed_service' | 'unknown'
export type ProxyAvailability = 'bound' | 'port_occupied'
export type ReadinessBasis = 'direct_process_tcp_listener' | 'execution_state' | 'identity_changed'
/**
 * What the daemon could observe about a running service's ports.
 */
export type ReadinessState =
  | 'stopped'
  | 'exited'
  | 'unknown'
  | 'unknown_no_port_check'
  | 'port_conflict'
  | 'tcp_listening'
  | 'not_observed'
  | 'observation_unavailable'
export type RecoveryStatus = 'healthy' | 'degraded' | 'corrupt'

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
export interface PeerEndpoint {
  port_variable: string
  service: string
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

export type Operation = "catalog.get" | "conversation.get" | "agent.send" | "agent.answer" | "service.configure" | "service.list" | "service.inspect" | "service.start" | "service.stop" | "service.remove" | "service.health.sample" | "service.proxy.ensure" | "service.proxy.inspect" | "service.proxy.target" | "service.proxy.remap" | "service.proxy.retire" | "service.proxy.recovery.inspect" | "service.proxy.recovery.retry" | "service.proxy.recovery.reset" | "listener.list"

export interface RequestByOperation {
  "catalog.get": CatalogGetRequest
  "conversation.get": ConversationGetRequest
  "agent.send": AgentSendRequest
  "agent.answer": AgentAnswerRequest
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
}

export interface ResponseByOperation {
  "catalog.get": CatalogFrame
  "conversation.get": ConversationSnapshot
  "agent.send": Ack
  "agent.answer": Ack
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
}

export type FeedFrame = CatalogFrame | ConversationChanged | ServiceChanged
