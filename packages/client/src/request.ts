import { createConnection } from 'node:net'

const APPLICATION_PROTOCOL = 'ade-application-v1'
const SESSION_PROTOCOL = 'ade-sessions-v1'
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_REQUEST_BYTES = 128 * 1024

export type DaemonErrorCode = 'unavailable' | 'incompatible' | 'timeout' | 'protocol' | 'daemon' | 'invalid_request'

export class DaemonRequestError extends Error {
  constructor(public readonly code: DaemonErrorCode, message: string) {
    super(message)
    this.name = 'DaemonRequestError'
  }
}

export interface RequestOptions {
  timeoutMs?: number
}

export type DaemonResponse = Record<string, unknown> & { type: string }

/** One version-checked request over the selected profile's Unix command socket. */
export function requestDaemon(
  socketPath: string,
  op: string,
  fields: Record<string, unknown> = {},
  options: RequestOptions = {},
): Promise<DaemonResponse> {
  if (!socketPath || !op || (op !== 'hello' && !op.includes('.')) || 'op' in fields) {
    return Promise.reject(new DaemonRequestError('invalid_request', 'A profile socket and valid operation are required.'))
  }
  const request = JSON.stringify({ ...fields, op })
  if (Buffer.byteLength(request) > MAX_REQUEST_BYTES && op !== 'attachment.put') {
    return Promise.reject(new DaemonRequestError('invalid_request', 'Request exceeds 128 KiB.'))
  }
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return Promise.reject(new DaemonRequestError('invalid_request', 'Request timeout must be a positive integer.'))
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath })
    let settled = false
    let phase: 'hello' | 'response' = 'hello'
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => fail('timeout', 'The profile daemon did not respond before the deadline.'), timeoutMs)

    function finish(response: DaemonResponse): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(response)
    }

    function fail(code: DaemonErrorCode, message: string): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(new DaemonRequestError(code, message))
    }

    socket.on('connect', () => socket.write('{"op":"hello"}\n'))
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_RESPONSE_BYTES) return fail('protocol', 'Daemon response exceeded 32 MiB.')
      for (;;) {
        const end = buffer.indexOf(10)
        if (end < 0) return
        const line = buffer.subarray(0, end)
        buffer = buffer.subarray(end + 1)
        let frame: unknown
        try { frame = JSON.parse(line.toString('utf8')) }
        catch { return fail('protocol', 'Daemon sent invalid JSON.') }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
          return fail('protocol', 'Daemon sent an invalid response.')
        }
        const response = frame as Record<string, unknown>
        if (typeof response.type !== 'string') return fail('protocol', 'Daemon response has no type.')
        if (response.type === 'error') {
          return fail('daemon', typeof response.message === 'string' ? response.message : 'Daemon rejected the request.')
        }
        if (phase === 'hello') {
          if (response.type !== 'hello') return fail('protocol', 'Daemon did not provide a hello response.')
          if (response.application_protocol !== APPLICATION_PROTOCOL || response.session_protocol !== SESSION_PROTOCOL) {
            return fail('incompatible', 'Daemon application or session protocol is incompatible with this client.')
          }
          if (op === 'hello') return finish(response as DaemonResponse)
          phase = 'response'
          socket.write(`${request}\n`)
        } else {
          return finish(response as DaemonResponse)
        }
      }
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      const unavailable = error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'EACCES'
      fail(unavailable ? 'unavailable' : 'protocol', unavailable
        ? 'Profile daemon is unavailable at the selected socket.'
        : `Profile daemon connection failed: ${error.message}`)
    })
    socket.on('close', () => fail('unavailable', 'Profile daemon closed the connection before replying.'))
  })
}
