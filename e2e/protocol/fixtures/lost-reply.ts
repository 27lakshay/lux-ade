// A request whose reply never reaches the caller. The client writes one
// protocol line and closes its socket as soon as the write is flushed, so the
// daemon may accept and act on the request while its reply is lost. Specs then
// observe the outcome through queries and retries, never through a sleep.
import { createConnection } from 'node:net'
import type { ScratchProfile } from './profile'

/** Write `request` to the profile's daemon and drop the connection before any reply. */
export async function sendAndLoseReply(profile: ScratchProfile, request: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolveSent, rejectSent) => {
    const peer = createConnection(profile.socket)
    peer.once('error', rejectSent)
    peer.once('connect', () => {
      peer.write(`${JSON.stringify(request)}\n`, (error) => {
        peer.destroy()
        if (error) rejectSent(error)
        else resolveSent()
      })
    })
  })
}
