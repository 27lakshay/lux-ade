// One request on any Unix socket, such as the runtime's, with the first reply
// line or the fact that the peer closed without one. `rawReply` covers only the
// daemon socket and rejects a close; authentication specs need both outcomes.
import { createConnection } from 'node:net'
import { stat } from 'node:fs/promises'

export type SocketOutcome = { frame: Record<string, unknown> | null; closed: boolean }

/** Send one line to `path` and resolve with the first reply line, or with `frame: null` if the peer closed first. */
export async function socketReply(
  path: string,
  request: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<SocketOutcome> {
  return new Promise<SocketOutcome>((resolveReply, rejectReply) => {
    const peer = createConnection(path)
    let text = ''
    let settled = false
    const finish = (outcome: SocketOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      peer.destroy()
      resolveReply(outcome)
    }
    const timer = setTimeout(() => {
      settled = true
      peer.destroy()
      rejectReply(new Error(`No reply from ${path} to ${String(request.op)} within ${timeoutMs} ms`))
    }, timeoutMs)
    peer.setEncoding('utf8')
    peer.once('connect', () => peer.write(`${JSON.stringify(request)}\n`))
    peer.on('data', (chunk: string) => {
      text += chunk
      const end = text.indexOf('\n')
      if (end < 0) return
      try {
        finish({ frame: JSON.parse(text.slice(0, end)) as Record<string, unknown>, closed: false })
      } catch (error) {
        settled = true
        clearTimeout(timer)
        rejectReply(error)
      }
    })
    // A peer that writes its refusal and closes may reset the connection.
    peer.once('error', () => finish({ frame: null, closed: true }))
    peer.once('close', () => finish({ frame: null, closed: true }))
  })
}

/** The permission bits and owner of a socket file. */
export async function socketAccess(path: string): Promise<{ mode: number; uid: number; socket: boolean }> {
  const info = await stat(path)
  return { mode: info.mode & 0o777, uid: info.uid, socket: info.isSocket() }
}
