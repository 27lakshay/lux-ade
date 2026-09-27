// Typed ADE wire contracts. The Rust types in crates/ade-core/src/contract are
// the authority; everything under ./generated comes from them.
import { frames, operationIdOperations, operations } from './generated/operations.js'
import type { FeedFrame, Operation, RequestByOperation, ResponseByOperation } from './generated/types.js'
import * as generatedValidators from './generated/validators.js'

export type * from './generated/types.js'
export { frames, operationIdOperations, operations }

export type Tier = (typeof operations)[Operation]['tier']
export type Request<O extends Operation = Operation> = RequestByOperation[O]
export type Response<O extends Operation = Operation> = ResponseByOperation[O]

interface ValidationError { instancePath: string; message?: string; params?: Record<string, unknown> }
type Validator = ((value: unknown) => boolean) & { errors?: ValidationError[] | null }
const validators = generatedValidators as unknown as Record<string, Validator>

/** A value that does not match its contract. */
export class ContractError extends TypeError {
  constructor(readonly at: string, detail: string) {
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
  throw new ContractError(`${at}${error?.instancePath ?? ''}`, typeof extra === 'string' ? `${detail} (${extra})` : detail)
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
