// A profile socket whose listen backlog is full (R004). The daemon is paused
// with SIGSTOP, so it accepts nothing, and a burst of ordinary commands fills
// the profile socket's backlog (128 on macOS). The kernel then refuses every
// further connection to it with ECONNREFUSED, deterministically, which is what
// a connection flood faster than the daemon's accept loop causes. A control
// lane has its own backlog, so a stop connects there, waits for its hello and
// is served once the daemon resumes. Only a daemon this spec started is paused.
import { createConnection } from 'node:net'
import { expect, type ScratchProfile } from '../fixtures'

export const REFUSED_AT_SOCKET = /unavailable at the selected socket/

/** How a fresh connection to `path` ends: `connected` or the error code. */
export function connectOutcome(path: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    socket.once('connect', () => { socket.destroy(); resolve('connected') })
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? String(error)))
  })
}

/**
 * A burst of `size` ordinary commands on the profile socket: reads, and steers
 * refused because they name another turn. Each resolves to `ok` or its error.
 */
export function burst(profile: ScratchProfile, conversationId: string, size: number): Promise<string[]> {
  return Promise.all(Array.from({ length: size }, (_, index) => (index % 2
    ? profile.call('conversation.get', { conversation_id: conversationId })
    : profile.call('conversation.steer', { operation_id: `burst-${index}`, conversation_id: conversationId,
      turn_id: 'not-this-turn', text: 'x' })).then(() => 'ok', (error: unknown) => String(error))))
}

/** Every burst reply was answered, refused for its own reason, or refused at the socket before it was sent. */
export function expectNoneLost(replies: string[]) {
  expect(replies.filter((reply) => reply !== 'ok'
    && !/no longer the running turn|send a message instead|not running/.test(reply) && !REFUSED_AT_SOCKET.test(reply)))
    .toEqual([])
}

export type FullBacklog = {
  /** The burst's replies, once the daemon has resumed and answered them. */
  replies: Promise<string[]>
  /** Resume the daemon. Safe to call more than once. */
  resume(): void
}

/**
 * Pause the daemon, flood its profile socket until a fresh connection is
 * refused, and return the flood. Call `resume()` in a `finally`.
 */
export async function fillBacklog(profile: ScratchProfile, conversationId: string, size = 400): Promise<FullBacklog> {
  const pid = profile.hello.pid
  let paused = true
  process.kill(pid, 'SIGSTOP')
  const resume = () => {
    if (paused) process.kill(pid, 'SIGCONT')
    paused = false
  }
  try {
    const replies = burst(profile, conversationId, size)
    await expect.poll(() => connectOutcome(profile.socket), { message: 'the profile socket to refuse connections' })
      .toBe('ECONNREFUSED')
    return { replies, resume }
  } catch (error) {
    resume()
    throw error
  }
}
