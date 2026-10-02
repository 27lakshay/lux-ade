import type {
  ProviderWorkerFailure,
  ProviderWorkerInitialize,
  ProviderWorkerMethod,
  ProviderWorkerRequest,
  ProviderWorkerResultResponse,
  ProviderWorkerOpenRequest,
  ProviderWorkerSendRequest,
  ProviderWorkerSendResult,
  ProviderWorkerHistoryRequest,
  ProviderWorkerHistoryPage,
  Event as ProviderEvent,
  Connected,
  ProviderWorkerSteerRequest,
  ProviderWorkerCancelRequest,
  ProviderWorkerAnswerRequest,
  ProviderWorkerCompactRequest,
  ProviderWorkerRewindRequest,
  ProviderWorkerRewindResult,
  ProviderWorkerConfigureMcpRequest,
  ProviderWorkerChildTranscriptRequest,
  ProviderWorkerAccountInspectRequest,
  ProviderWorkerAccountInspection,
  ProviderWorkerAck,
  ProviderWorkerCancelResult,
  ChildTranscriptPage,
} from '@ade/contracts'
import type { Effect, Layer, Scope, Stream } from 'effect'

export const MAX_FRAME_BYTES = 1024 * 1024
/**
 * Input frames carry a prompt with ADE's 8 MiB of attachments per prompt, base64-encoded
 * (about 10.7 MiB), with its text and envelope.
 */
export const MAX_INPUT_FRAME_BYTES = 16 * MAX_FRAME_BYTES
/** Output frames may carry a full 1 MiB message with its tool output and envelope. */
export const MAX_OUTPUT_FRAME_BYTES = 4 * MAX_FRAME_BYTES
export const PROTOCOL_VERSION = 2

export const SDK_REQUIREMENTS = {
  sdk_api_version: 2,
  sdk_version: '0.2.0',
  effect_version: '4.0.0-rc.118',
  platform_node_version: '4.0.0-rc.118',
  node_engine: '>=22',
} as const

export const DEFAULT_LIMITS = {
  max_input_frame_bytes: MAX_INPUT_FRAME_BYTES,
  max_initialize_ms: 15_000,
  max_input_entries: 1_024,
  max_output_frame_bytes: MAX_FRAME_BYTES,
  max_history_page_items: 32,
  max_output_entries: 32,
  max_concurrency: 4,
  max_partial_frame_ms: 10_000,
  max_operation_ms: 45_000,
  max_cleanup_ms: 5_000,
} as const

export type WorkerDescriptor = Omit<ProviderWorkerInitialize, 'protocol_version'>
export type WorkerInput = ProviderWorkerRequest['params']
export type WorkerOutput = ProviderWorkerResultResponse['result']
export type WorkerFailure = ProviderWorkerFailure
export type WorkerMethod = Exclude<ProviderWorkerMethod, 'initialize'>

/** Handlers run inside the worker's managed scope and declared dependency layer. */
export type ProviderWorker<R = never> = {
  readonly open?: (params: ProviderWorkerOpenRequest) => Effect.Effect<Connected, WorkerFailure, R | Scope.Scope>
  readonly send?: (
    params: ProviderWorkerSendRequest,
  ) => Effect.Effect<ProviderWorkerSendResult, WorkerFailure, R | Scope.Scope>
  readonly steer?: (
    params: ProviderWorkerSteerRequest,
  ) => Effect.Effect<ProviderWorkerSendResult, WorkerFailure, R | Scope.Scope>
  readonly cancel?: (
    params: ProviderWorkerCancelRequest,
  ) => Effect.Effect<ProviderWorkerCancelResult, WorkerFailure, R | Scope.Scope>
  readonly answer?: (
    params: ProviderWorkerAnswerRequest,
  ) => Effect.Effect<ProviderWorkerAck, WorkerFailure, R | Scope.Scope>
  readonly compact?: (
    params: ProviderWorkerCompactRequest,
  ) => Effect.Effect<ProviderWorkerAck, WorkerFailure, R | Scope.Scope>
  readonly rewind?: (
    params: ProviderWorkerRewindRequest,
  ) => Effect.Effect<ProviderWorkerRewindResult, WorkerFailure, R | Scope.Scope>
  readonly configure_mcp?: (
    params: ProviderWorkerConfigureMcpRequest,
  ) => Effect.Effect<ProviderWorkerAck, WorkerFailure, R | Scope.Scope>
  readonly child_transcript?: (
    params: ProviderWorkerChildTranscriptRequest,
  ) => Effect.Effect<ChildTranscriptPage, WorkerFailure, R | Scope.Scope>
  readonly history?: (
    params: ProviderWorkerHistoryRequest,
  ) => Effect.Effect<ProviderWorkerHistoryPage, WorkerFailure, R | Scope.Scope>
  /** Reports which native login the worker's managed account context holds; see `accountContext`. */
  readonly account_inspect?: (
    params: ProviderWorkerAccountInspectRequest,
  ) => Effect.Effect<ProviderWorkerAccountInspection, WorkerFailure, R | Scope.Scope>
  readonly events?: Stream.Stream<ProviderEvent, WorkerFailure, R | Scope.Scope>
  readonly close?: Effect.Effect<void, WorkerFailure, R | Scope.Scope>
}

/** The adapter layer and scoped acquisition are owned by the Node ManagedRuntime. */
export type ProviderFactory<R = never> = {
  readonly descriptor: WorkerDescriptor
  readonly dependencies: Layer.Layer<R, never, never>
  readonly acquire: Effect.Effect<ProviderWorker<R>, WorkerFailure, R | Scope.Scope>
}
