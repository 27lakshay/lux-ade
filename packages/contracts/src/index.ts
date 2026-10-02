// Typed ADE wire contracts. The Rust types in crates/ade-core/src/contract are
// the authority; everything under ./generated comes from them.
import { frames, operationIdOperations, operations, terminalFrames } from './generated/operations.js'
import type {
  FeedFrame,
  Operation,
  RequestByOperation,
  ProviderWorkerRequest,
  ProviderWorkerResponse,
  ProviderWorkerFailure,
  ProviderWorkerInitialize,
  ProviderWorkerOpenRequest,
  ProviderWorkerSendRequest,
  ProviderWorkerSendResult,
  ProviderWorkerEventNotification,
  ProviderWorkerHistoryRequest,
  ProviderWorkerHistoryPage,
  Connected,
  ProviderWorkerSteerRequest,
  ProviderWorkerCancelRequest,
  ProviderWorkerAnswerRequest,
  ProviderWorkerCompactRequest,
  ProviderWorkerRewindRequest,
  ProviderWorkerRewindResult,
  ProviderWorkerConfigureMcpRequest,
  ProviderWorkerChildTranscriptRequest,
  ProviderWorkerAck,
  ProviderWorkerCancelResult,
  ResponseByOperation,
  TerminalStreamFrame,
} from './generated/types.js'
import * as generatedValidators from './generated/validators.js'

export type * from './generated/types.js'
export { frames, operationIdOperations, operations, terminalFrames }

export type Tier = (typeof operations)[Operation]['tier']
export type Request<O extends Operation = Operation> = RequestByOperation[O]
export type Response<O extends Operation = Operation> = ResponseByOperation[O]

interface ValidationError {
  instancePath: string
  message?: string
  params?: Record<string, unknown>
}
type Validator = ((value: unknown) => boolean) & { errors?: ValidationError[] | null }
const validators = generatedValidators as unknown as Record<string, Validator>

/** A value that does not match its contract. */
export class ContractError extends TypeError {
  constructor(
    readonly at: string,
    detail: string,
  ) {
    super(`Invalid ${at}: ${detail}`)
    this.name = 'ContractError'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function check(name: string, value: unknown, at: string): void {
  const validate = validators[name]
  if (validate(value)) return
  const error = validate.errors?.[0]
  const extra = error?.params?.additionalProperty
  const detail = error?.message ?? 'does not match its contract'
  throw new ContractError(
    `${at}${error?.instancePath ?? ''}`,
    typeof extra === 'string' ? `${detail} (${extra})` : detail,
  )
}

export function isOperation(op: unknown): op is Operation {
  return typeof op === 'string' && Object.hasOwn(operations, op)
}

/** Validate a request line, including its `op`. */
export function decodeRequest(value: unknown): Request {
  // Validate the request as it travels: JSON drops keys whose value is undefined.
  const wire: unknown = value === undefined ? value : JSON.parse(JSON.stringify(value))
  if (!record(wire) || !isOperation(wire.op)) throw new ContractError('request.op', 'unknown operation')
  check(operations[wire.op].request, wire, 'request')
  return wire as unknown as Request
}

/** Validate a daemon reply to `op`. */
export function decodeResponse<O extends Operation>(op: O, value: unknown): Response<O> {
  check(operations[op].response, value, 'response')
  return value as Response<O>
}

/** Validate a `session.subscribe` frame whose type has a contract. */
export function decodeFeedFrame(value: unknown): FeedFrame {
  if (!record(value) || typeof value.type !== 'string' || !Object.hasOwn(frames, value.type)) {
    throw new ContractError('feed.type', 'unknown frame type')
  }
  check(frames[value.type as keyof typeof frames].frame, value, 'feed')
  return value as FeedFrame
}

/** Validate a frame of a terminal attachment stream. */
export function decodeTerminalFrame(value: unknown): TerminalStreamFrame {
  if (!record(value) || typeof value.type !== 'string' || !Object.hasOwn(terminalFrames, value.type)) {
    throw new ContractError('terminal.type', 'unknown frame type')
  }
  check(terminalFrames[value.type as keyof typeof terminalFrames].frame, value, 'terminal')
  return value as TerminalStreamFrame
}

/** Validate a provider worker request with the Rust-generated schema. */
export function decodeProviderWorkerRequest(value: unknown): ProviderWorkerRequest {
  check('ProviderWorkerRequest', value, 'provider_worker.request')
  return value as ProviderWorkerRequest
}

/** Validate a provider worker response with the Rust-generated schema. */
export function decodeProviderWorkerResponse(value: unknown): ProviderWorkerResponse {
  check('ProviderWorkerResponse', value, 'provider_worker.response')
  return value as ProviderWorkerResponse
}

/** Validate a provider worker failure payload with the Rust-generated schema. */
export function decodeProviderWorkerFailure(value: unknown): ProviderWorkerFailure {
  check('ProviderWorkerFailure', value, 'provider_worker.failure')
  return value as ProviderWorkerFailure
}

/** Validate a provider worker descriptor with the Rust-generated schema. */
export function decodeProviderWorkerInitialize(value: unknown): ProviderWorkerInitialize {
  check('ProviderWorkerInitialize', value, 'provider_worker.initialize')
  return value as ProviderWorkerInitialize
}

export function decodeProviderWorkerOpenRequest(value: unknown): ProviderWorkerOpenRequest {
  check('ProviderWorkerOpenRequest', value, 'ProviderWorkerOpenRequest')
  return value as ProviderWorkerOpenRequest
}

export function decodeProviderWorkerSendRequest(value: unknown): ProviderWorkerSendRequest {
  check('ProviderWorkerSendRequest', value, 'ProviderWorkerSendRequest')
  return value as ProviderWorkerSendRequest
}

export function decodeProviderWorkerSendResult(value: unknown): ProviderWorkerSendResult {
  check('ProviderWorkerSendResult', value, 'ProviderWorkerSendResult')
  return value as ProviderWorkerSendResult
}

export function decodeProviderWorkerEventNotification(value: unknown): ProviderWorkerEventNotification {
  check('ProviderWorkerEventNotification', value, 'ProviderWorkerEventNotification')
  return value as ProviderWorkerEventNotification
}

export function decodeProviderWorkerHistoryRequest(value: unknown): ProviderWorkerHistoryRequest {
  check('ProviderWorkerHistoryRequest', value, 'ProviderWorkerHistoryRequest')
  return value as ProviderWorkerHistoryRequest
}

export function decodeProviderWorkerHistoryPage(value: unknown): ProviderWorkerHistoryPage {
  check('ProviderWorkerHistoryPage', value, 'ProviderWorkerHistoryPage')
  return value as ProviderWorkerHistoryPage
}

export function decodeConnected(value: unknown): Connected {
  check('Connected', value, 'Connected')
  return value as Connected
}

export function decodeProviderWorkerSteerRequest(value: unknown): ProviderWorkerSteerRequest {
  check('ProviderWorkerSteerRequest', value, 'ProviderWorkerSteerRequest')
  return value as ProviderWorkerSteerRequest
}

export function decodeProviderWorkerCancelRequest(value: unknown): ProviderWorkerCancelRequest {
  check('ProviderWorkerCancelRequest', value, 'ProviderWorkerCancelRequest')
  return value as ProviderWorkerCancelRequest
}

export function decodeProviderWorkerAnswerRequest(value: unknown): ProviderWorkerAnswerRequest {
  check('ProviderWorkerAnswerRequest', value, 'ProviderWorkerAnswerRequest')
  return value as ProviderWorkerAnswerRequest
}

export function decodeProviderWorkerCompactRequest(value: unknown): ProviderWorkerCompactRequest {
  check('ProviderWorkerCompactRequest', value, 'ProviderWorkerCompactRequest')
  return value as ProviderWorkerCompactRequest
}

export function decodeProviderWorkerRewindRequest(value: unknown): ProviderWorkerRewindRequest {
  check('ProviderWorkerRewindRequest', value, 'ProviderWorkerRewindRequest')
  return value as ProviderWorkerRewindRequest
}

export function decodeProviderWorkerRewindResult(value: unknown): ProviderWorkerRewindResult {
  check('ProviderWorkerRewindResult', value, 'ProviderWorkerRewindResult')
  return value as ProviderWorkerRewindResult
}

export function decodeProviderWorkerConfigureMcpRequest(value: unknown): ProviderWorkerConfigureMcpRequest {
  check('ProviderWorkerConfigureMcpRequest', value, 'ProviderWorkerConfigureMcpRequest')
  return value as ProviderWorkerConfigureMcpRequest
}

export function decodeProviderWorkerChildTranscriptRequest(value: unknown): ProviderWorkerChildTranscriptRequest {
  check('ProviderWorkerChildTranscriptRequest', value, 'ProviderWorkerChildTranscriptRequest')
  return value as ProviderWorkerChildTranscriptRequest
}

export function decodeProviderWorkerAck(value: unknown): ProviderWorkerAck {
  check('ProviderWorkerAck', value, 'ProviderWorkerAck')
  return value as ProviderWorkerAck
}

/** Validate a provider worker cancellation result with the Rust-generated schema. */
export function decodeProviderWorkerCancelResult(value: unknown): ProviderWorkerCancelResult {
  check('ProviderWorkerCancelResult', value, 'ProviderWorkerCancelResult')
  return value as ProviderWorkerCancelResult
}
