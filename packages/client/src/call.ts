// The generic typed command API (F101, F103). Every operation in @ade/contracts
// is callable through `call`: its request and reply types come from the
// generated contracts, the request is validated before anything is sent, and
// the reply is validated with `decodeResponse` before it is returned.
import { randomUUID } from 'node:crypto'
import { decodeRequest, decodeResponse, isOperation, operationIdOperations, type Operation, type Request,
  type Response } from '@ade/contracts'
import { DaemonRequestError, requestDaemon, type RequestOptions } from './request.js'

/** The effect commands whose request carries a caller-supplied `operation_id`. */
export type OperationIdOperation = typeof operationIdOperations[number]

/**
 * An operation's request body: its contract without the `op` tag. An effect
 * command's `operation_id` may be left out; `call` then sends a fresh one and
 * names it on any error, so the caller can retry under the same ID.
 */
export type CallRequest<O extends Operation> = O extends OperationIdOperation
  ? Omit<Request<O>, 'op' | 'operation_id'> & { operation_id?: string }
  : Omit<Request<O>, 'op'>

const identified: ReadonlySet<string> = new Set(operationIdOperations)

/** Whether `op` is an effect command whose request carries an `operation_id`. */
export function takesOperationId(op: string): op is OperationIdOperation {
  return identified.has(op)
}

/**
 * Validate `op` and its body as they would travel, and return the wire fields.
 * A request that fails its contract is never sent, so it reports `not_sent`.
 */
export function encodeCall(op: unknown, request: unknown): { op: Operation; fields: Record<string, unknown> } {
  if (!isOperation(op)) {
    throw new DaemonRequestError('invalid_request', `Unknown operation ${JSON.stringify(op)}.`, 'not_sent')
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new DaemonRequestError('invalid_request', `The ${op} request must be an object.`, 'not_sent')
  }
  if ('op' in request) {
    throw new DaemonRequestError('invalid_request', `Pass ${op} as the operation, not as a request field.`, 'not_sent')
  }
  const body = takesOperationId(op) && (request as Record<string, unknown>).operation_id === undefined
    ? { ...request, operation_id: randomUUID() } : request
  let wire: Record<string, unknown>
  try { wire = decodeRequest({ ...body, op }) as unknown as Record<string, unknown> }
  catch (error) {
    throw new DaemonRequestError('invalid_request', `The ${op} request failed its contract: ${errorText(error)}`, 'not_sent')
  }
  const fields = { ...wire }
  delete fields.op
  return { op, fields }
}

/**
 * Check a daemon reply against `op`'s contract. The request was delivered, so a
 * reply that fails its contract leaves the outcome unknown: the caller must
 * inspect before retrying an effect.
 */
export function decodeCallReply<O extends Operation>(op: O, reply: unknown): Response<O> {
  try { return decodeResponse(op, reply) }
  catch (error) {
    throw new DaemonRequestError('protocol', `Daemon ${op} reply failed its contract: ${errorText(error)}`, 'unknown')
  }
}

/** Call one operation on the profile daemon at `endpoint` and return its validated reply. */
export async function call<O extends Operation>(endpoint: string, op: O, request: CallRequest<O>,
  options: RequestOptions = {}): Promise<Response<O>> {
  const encoded = encodeCall(op, request)
  const operationId = typeof encoded.fields.operation_id === 'string' && takesOperationId(op)
    ? encoded.fields.operation_id : undefined
  try {
    const reply = await requestDaemon(endpoint, encoded.op, encoded.fields, options)
    return decodeCallReply(op, reply)
  } catch (error) {
    if (error instanceof DaemonRequestError && operationId !== undefined) error.operationId = operationId
    throw error
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
