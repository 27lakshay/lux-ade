// The generic typed command API (F101, F103). Every operation in @ade/contracts
// is callable through `call`: its request and reply types come from the
// generated contracts, the request is validated before anything is sent, and
// the reply is validated with `decodeResponse` before it is returned.
import { decodeRequest, decodeResponse, isOperation, type Operation, type Request,
  type Response } from '@ade/contracts'
import { DaemonRequestError, requestDaemon, type RequestOptions } from './request.js'

/** An operation's request body: its contract without the `op` tag. */
export type CallRequest<O extends Operation> = Omit<Request<O>, 'op'>

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
  let wire: Record<string, unknown>
  try { wire = decodeRequest({ ...request, op }) as unknown as Record<string, unknown> }
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
  const reply = await requestDaemon(endpoint, encoded.op, encoded.fields, options)
  return decodeCallReply(op, reply)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
