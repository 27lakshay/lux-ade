// The daemon's whole reply frame, error frames included. `profile.rpc` rejects
// an error frame with its message only, and the SDK maps codes it does not know
// (such as `host_resource_conflict`) to `daemon`, so a spec that asserts the
// daemon's typed error `code` and `recovery` reads the frame itself.
import { createConnection } from 'node:net'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ScratchProfile } from './profile'

export type ReplyFrame = Record<string, unknown> & { type: string; code?: string; recovery?: string; message?: string }

/** Send one request line and resolve with the first reply line, whatever its type. */
export async function rawReply(profile: ScratchProfile, request: Record<string, unknown>,
  timeoutMs = 30_000): Promise<ReplyFrame> {
  const started = Date.now()
  const reply = await new Promise<ReplyFrame>((resolveReply, rejectReply) => {
    const peer = createConnection(profile.socket)
    let frame = ''
    const timer = setTimeout(() => peer.destroy(new Error(`No reply to ${String(request.op)} within ${timeoutMs} ms`)), timeoutMs)
    peer.setEncoding('utf8')
    peer.once('connect', () => peer.write(`${JSON.stringify(request)}\n`))
    peer.on('data', (chunk: string) => {
      frame += chunk
      const end = frame.indexOf('\n')
      if (end < 0) return
      clearTimeout(timer)
      peer.destroy()
      try { resolveReply(JSON.parse(frame.slice(0, end)) as ReplyFrame) } catch (error) { rejectReply(error) }
    })
    peer.once('error', (error) => { clearTimeout(timer); rejectReply(error) })
    peer.once('close', () => { clearTimeout(timer); rejectReply(new Error('Connection closed before a reply')) })
  })
  await appendFile(join(profile.logsDirectory, 'operations.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), via: 'raw',
    op: request.op, request, reply: { type: reply.type, code: reply.code, message: reply.message }, ms: Date.now() - started })}\n`)
    .catch(() => undefined)
  return reply
}
