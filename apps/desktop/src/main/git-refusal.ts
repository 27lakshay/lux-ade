// Whether a Git mutation's local outbox record may be released after its request
// failed. The record exists so a lost admission reply can be retried with the
// same ID and parameters; it is released only with proof the daemon never
// admitted the request. That proof has two parts: the send failed with a
// definite refusal, not a lost or unreadable reply, and afterwards the daemon
// neither knows the ID (`review.operation` answers `Unknown review operation`)
// nor lists it (`review.operation.list`). Anything else keeps the record.

/** The fields of a failed daemon request that this decision reads. */
export type RequestFailure = {
  code: string
  delivery: string
  message: string
  /** The daemon answered with a specific refusal code, such as `needs_rebind` (the SDK's `isDaemonRefusal`). */
  refusal?: boolean
}

// Codes a daemon error frame carries for a request it answered. `unavailable`,
// `timeout`, `protocol` and `incompatible` are also raised locally for a closed
// socket or unreadable reply, and `outcome_unknown` and `in_progress` say the
// outcome is open, so none of them proves a refusal. A specific daemon code
// (`needs_rebind`, `host_resource_conflict`, ...) arrives with `refusal` set.
const answeredCodes = new Set(['daemon', 'invalid_request', 'conflict', 'overloaded', 'not_applied'])

/** Whether a failed Git mutation request was definitely refused rather than lost. */
export function definiteRefusal(failure: RequestFailure | null): boolean {
  if (!failure) return false
  if (failure.delivery === 'not_sent' || failure.delivery === 'rejected') return true
  return failure.delivery === 'unknown' && (answeredCodes.has(failure.code) || failure.refusal === true)
}

/** Whether a `review.operation` lookup failed because the daemon has no receipt for the ID. */
export function unknownOperation(failure: RequestFailure | null): boolean {
  return failure !== null && failure.code === 'daemon' && failure.message === 'Unknown review operation'
}

/**
 * Decide the local record after a Git mutation request failed. `lookup` is the
 * failure of the follow-up `review.operation` call (null if it returned a
 * receipt), and `listed` the IDs `review.operation.list` returned, or null if
 * that call failed.
 */
export function decideRefusedGitRecord(
  requestId: string,
  send: RequestFailure | null,
  lookup: RequestFailure | null,
  listed: readonly string[] | null,
): 'release' | 'keep' {
  if (!definiteRefusal(send) || !unknownOperation(lookup) || listed === null) return 'keep'
  return listed.includes(requestId) ? 'keep' : 'release'
}
