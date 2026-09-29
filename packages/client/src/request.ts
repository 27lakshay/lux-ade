import { createConnection } from 'node:net'

const APPLICATION_PROTOCOL = 'ade-application-v1'
const SESSION_PROTOCOL = 'ade-sessions-v1'
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_REQUEST_BYTES = 128 * 1024

/**
 * The codes the client raises itself, and the general categories the daemon
 * also uses. `daemon` names a daemon error frame that carried no code.
 */
export const categoryErrorCodes = [
  'unavailable',
  'incompatible',
  'timeout',
  'protocol',
  'daemon',
  'invalid_request',
  'conflict',
  'outcome_unknown',
  'in_progress',
  'overloaded',
  'not_applied',
] as const

/**
 * The specific refusal codes the daemon sends today, each with a `recovery`
 * hint. The daemon may add codes, so `DaemonErrorCode` stays open: a code this
 * list lacks is kept exactly as the daemon sent it.
 */
export const daemonRefusalCodes = [
  'needs_rebind',
  'host_resource_conflict',
  'host_resources_unavailable',
  'restored_send_held',
  'lifecycle_command_failed',
  'lifecycle_outcome_unknown',
  'lifecycle_unavailable',
  'lifecycle_invalid_output',
  'conversation_deleted',
  'workspace_not_found',
  'workspace_removed',
  'invalid_workspace_name',
  'workspace_remove_blocked',
  'terminal_busy',
  'unsupported',
  'worktree_delete_blocked',
  'project_not_found',
  'project_not_repository',
  'unknown_setting',
  'review_anchor_stale',
  'draft_not_empty',
  'review_prompt_too_long',
  'lifecycle_busy',
  'provider_not_found',
] as const

export type KnownDaemonErrorCode = (typeof categoryErrorCodes)[number] | (typeof daemonRefusalCodes)[number]
// `string & {}` keeps completion for the known codes while admitting any other.
export type DaemonErrorCode = KnownDaemonErrorCode | (string & {})
export type RequestDelivery = 'not_sent' | 'unknown' | 'rejected'

export class DaemonRequestError extends Error {
  /**
   * The effect command's operation ID, when `call` sent one. Retrying under
   * it returns the recorded outcome instead of doing the work again.
   */
  operationId?: string
  /**
   * `code` is the daemon's own code when its error frame carried one, and
   * `recovery` is that frame's recovery hint, if it had one.
   * `replied` is true when the daemon itself sent this error as a reply frame,
   * so the connection carried a whole answer. It is false for a failure of the
   * connection (socket error, close, deadline) or of the client's own checks.
   * `details` holds the error frame's other fields, such as the `blockers`
   * of `workspace_remove_blocked`.
   */
  constructor(
    public readonly code: DaemonErrorCode,
    message: string,
    public readonly delivery: RequestDelivery = 'not_sent',
    public readonly replied = false,
    public readonly recovery?: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'DaemonRequestError'
  }
}

const categories: ReadonlySet<string> = new Set(categoryErrorCodes)

/**
 * Whether the daemon answered with a specific refusal: an error frame with no
 * code (`daemon`) or with a code outside the general categories. SDKs before
 * codes were preserved reported all of these as `daemon`.
 */
export function isDaemonRefusal(error: DaemonRequestError): boolean {
  return error.replied && (error.code === 'daemon' || !categories.has(error.code))
}

export interface RequestOptions {
  timeoutMs?: number
  /** Presented in the hello on a remote host's paired endpoint. */
  pairing?: { pairingId: string; token: string } | null
}

/** The hello line a connection opens with; a paired client presents its pairing. */
export function helloLine(pairing?: { pairingId: string; token: string } | null): string {
  return `${JSON.stringify(
    pairing ? { op: 'hello', pairing_id: pairing.pairingId, pairing_token: pairing.token } : { op: 'hello' },
  )}\n`
}

export type DaemonResponse = Record<string, unknown> & { type: string }

/**
 * The operations the daemon's control lane serves (R004): hello and health,
 * stops of existing work, and shutdown. Keep in step with
 * `crates/ade-daemon/src/bin/daemon/server/control.rs`.
 */
export const controlOperations: ReadonlySet<string> = new Set([
  'hello',
  'runtime.status',
  'diagnostics.status',
  'agent.cancel',
  'terminal.stop',
  'service.stop',
  'runtime.prepare_restart',
])

/** The control lane's socket beside a profile socket: `/x/ade.sock` becomes `/x/ade.control.sock`. */
export function controlSocketPath(socketPath: string): string {
  return socketPath.endsWith('.sock') ? `${socketPath.slice(0, -'.sock'.length)}.control.sock` : `${socketPath}.control`
}

/**
 * One version-checked request over the selected profile's Unix command socket.
 * A control operation goes over the profile's control lane, which ordinary
 * traffic cannot saturate. It falls back to the profile socket only when the
 * control lane took nothing: the daemon could not open it, or it refused or
 * closed the connection before the request was sent.
 */
export async function requestDaemon(
  socketPath: string,
  op: string,
  fields: Record<string, unknown> = {},
  options: RequestOptions = {},
): Promise<DaemonResponse> {
  if (socketPath && controlOperations.has(op) && !options.pairing) {
    try {
      return await requestOnce(controlSocketPath(socketPath), op, fields, options)
    } catch (error) {
      if (
        !(error instanceof DaemonRequestError) ||
        error.code !== 'unavailable' ||
        error.delivery !== 'not_sent' ||
        error.replied
      )
        throw error
    }
  }
  return requestOnce(socketPath, op, fields, options)
}

function requestOnce(
  socketPath: string,
  op: string,
  fields: Record<string, unknown>,
  options: RequestOptions,
): Promise<DaemonResponse> {
  if (!socketPath || !op || (op !== 'hello' && !op.includes('.')) || 'op' in fields) {
    return Promise.reject(
      new DaemonRequestError('invalid_request', 'A profile socket and valid operation are required.'),
    )
  }
  const request = JSON.stringify({ ...fields, op })
  // Attachments and client-supplied context text are the only large requests.
  if (Buffer.byteLength(request) > MAX_REQUEST_BYTES && op !== 'attachment.put' && op !== 'context.capture') {
    return Promise.reject(new DaemonRequestError('invalid_request', 'Request exceeds 128 KiB.'))
  }
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return Promise.reject(new DaemonRequestError('invalid_request', 'Request timeout must be a positive integer.'))
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath })
    let settled = false
    let requestSent = false
    let phase: 'hello' | 'response' = 'hello'
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(
      () => fail('timeout', 'The profile daemon did not respond before the deadline.'),
      timeoutMs,
    )

    function finish(response: DaemonResponse): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(response)
    }

    function fail(
      code: DaemonErrorCode,
      message: string,
      delivery: RequestDelivery = requestSent ? 'unknown' : 'not_sent',
      replied = false,
      recovery?: string,
      details?: Record<string, unknown>,
    ): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(new DaemonRequestError(code, message, delivery, replied, recovery, details))
    }

    socket.on('connect', () => socket.write(helloLine(options.pairing)))
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_RESPONSE_BYTES) return fail('protocol', 'Daemon response exceeded 32 MiB.')
      for (;;) {
        const end = buffer.indexOf(10)
        if (end < 0) return
        const line = buffer.subarray(0, end)
        buffer = buffer.subarray(end + 1)
        let frame: unknown
        try {
          frame = JSON.parse(line.toString('utf8'))
        } catch {
          return fail('protocol', 'Daemon sent invalid JSON.')
        }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
          return fail('protocol', 'Daemon sent an invalid response.')
        }
        const response = frame as Record<string, unknown>
        if (typeof response.type !== 'string') return fail('protocol', 'Daemon response has no type.')
        if (response.type === 'error') {
          // Keep the daemon's code and recovery hint as sent; only a frame with no code is `daemon`.
          const code = typeof response.code === 'string' && response.code ? response.code : 'daemon'
          const recovery = typeof response.recovery === 'string' && response.recovery ? response.recovery : undefined
          const { type: _type, code: _code, message, recovery: _recovery, ...details } = response
          return fail(
            code,
            typeof message === 'string' ? message : 'Daemon rejected the request.',
            phase === 'hello' ? 'not_sent' : response.pre_admission_rejected === true ? 'rejected' : 'unknown',
            true,
            recovery,
            details,
          )
        }
        if (phase === 'hello') {
          if (response.type !== 'hello') return fail('protocol', 'Daemon did not provide a hello response.')
          if (
            response.application_protocol !== APPLICATION_PROTOCOL ||
            response.session_protocol !== SESSION_PROTOCOL
          ) {
            return fail('incompatible', 'Daemon application or session protocol is incompatible with this client.')
          }
          if (op === 'hello') return finish(response as DaemonResponse)
          phase = 'response'
          requestSent = true
          socket.write(`${request}\n`)
        } else {
          return finish(response as DaemonResponse)
        }
      }
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      const unavailable = error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'EACCES'
      fail(
        unavailable ? 'unavailable' : 'protocol',
        unavailable
          ? 'Profile daemon is unavailable at the selected socket.'
          : `Profile daemon connection failed: ${error.message}`,
      )
    })
    socket.on('close', () => fail('unavailable', 'Profile daemon closed the connection before replying.'))
  })
}
