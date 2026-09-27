import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { dailyUseCommand } from '@ade/client'
import { mutateBrowserOwner, readBrowserOperation, readBrowserOwner, reconcileBrowserReceipts } from './browser'

const maxRequestBytes = 64 * 1024

export class BrowserOwner {
  private constructor(readonly profileId: string, private readonly browserProfileId: string, readonly ownerId: string,
    readonly socketPath: string, private readonly server: Server) {}
  private endpoint: string | null = null
  private registeredBootId: string | null = null
  private readonly peers = new Set<Socket>()

  static async open(profileId: string, browserProfileId = profileId): Promise<BrowserOwner> {
    // macOS Unix socket paths are short; profile homes can exceed that limit.
    const directory = join('/tmp', `ade-browser-owner-${process.getuid?.() ?? 'unknown'}`)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const details = await lstat(directory)
    if (!details.isDirectory() || (details.mode & 0o077) !== 0 ||
      (process.getuid && details.uid !== process.getuid())) {
      throw new Error('Browser owner directory is not private')
    }
    const ownerId = randomUUID()
    const profileKey = createHash('sha256').update(profileId).digest('hex').slice(0, 12)
    const socketPath = join(directory, `${profileKey}-${ownerId}.sock`)
    const server = createServer()
    const owner = new BrowserOwner(profileId, browserProfileId, ownerId, socketPath, server)
    server.on('connection', (peer) => owner.accept(peer))
    server.on('error', (error) => console.error('Browser owner socket failed', error))
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(socketPath, resolveListen)
      })
      await chmod(socketPath, 0o600)
      return owner
    } catch (error) {
      server.close()
      await unlink(socketPath).catch(() => undefined)
      throw error
    }
  }

  private accept(peer: Socket): void {
    this.peers.add(peer)
    peer.on('error', () => undefined)
    peer.setEncoding('utf8')
    peer.setTimeout(5_000, () => peer.destroy())
    peer.once('close', () => this.peers.delete(peer))
    let frame = ''
    peer.on('data', (chunk: string) => {
      frame += chunk
      if (Buffer.byteLength(frame) > maxRequestBytes) { peer.destroy(); return }
      const end = frame.indexOf('\n')
      if (end < 0) return
      peer.removeAllListeners('data')
      void this.handle(frame.slice(0, end)).then((response) => {
        if (!peer.destroyed) peer.end(`${JSON.stringify(response)}\n`)
      })
    })
  }

  private async handle(frame: string): Promise<Record<string, unknown>> {
    const identity = { profile_id: this.profileId, owner_id: this.ownerId }
    try {
      const request: unknown = JSON.parse(frame)
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid browser request')
      const value = request as Record<string, unknown>
      if (value.profile_id !== this.profileId || value.owner_id !== this.ownerId) {
        throw new Error('Browser owner changed')
      }
      if (value.op !== 'browser.list' && value.op !== 'browser.inspect' && value.op !== 'browser.operation' &&
        value.op !== 'browser.open' && value.op !== 'browser.navigate' && value.op !== 'browser.close') {
        throw new Error('Unsupported browser operation')
      }
      if (value.op === 'browser.operation') {
        const result = await readBrowserOperation(this.browserProfileId, this.profileId, value.request_id)
        return { ...identity, ...result }
      }
      if (value.op === 'browser.list' || value.op === 'browser.inspect') {
        const result = await readBrowserOwner(this.browserProfileId, value.op,
          typeof value.tab_id === 'string' ? value.tab_id : undefined)
        return { ...identity, ...result }
      }
      const mutation = { request_id: value.request_id, payload_fingerprint: value.payload_fingerprint }
      try {
        const result = await mutateBrowserOwner(this.browserProfileId, this.profileId, this.ownerId,
          value.op, value.request_id, value.payload_fingerprint, value.tab_id, value.url)
        return { ...identity, ...mutation, ...result }
      } catch (error) {
        const message = String(error)
        const code = message.includes('outcome_unknown:') ? 'outcome_unknown'
          : message.includes('not_applied:') ? 'not_applied'
          : message.includes('conflicts with a different target') ? 'conflict'
            : message.includes('Invalid browser') || message.includes('fingerprint does not match') ? 'invalid_request'
              : 'unavailable'
        return { type: 'error', code, message, ...identity, ...mutation }
      }
    } catch (error) {
      return { type: 'error', code: 'unavailable', message: String(error), ...identity }
    }
  }

  async register(endpoint: string, bootId: string | null = null): Promise<void> {
    if (this.registeredBootId && bootId === this.registeredBootId && endpoint === this.endpoint) return
    // A crash of this owner's predecessor or of the daemon can leave receipts
    // pending. Settle them from the tabs before the daemon routes new work here.
    // A failure leaves them unknown; each lookup retries the reconciliation.
    await reconcileBrowserReceipts(this.browserProfileId, this.profileId)
      .catch((error) => console.error('Browser receipt reconciliation failed', error))
    await dailyUseCommand(endpoint, { op: 'browser.owner.register',
      profile_id: this.profileId, owner_id: this.ownerId, socket_path: this.socketPath,
    })
    this.endpoint = endpoint
    this.registeredBootId = bootId
  }

  async close(): Promise<void> {
    const endpoint = this.endpoint
    this.endpoint = null
    this.registeredBootId = null
    for (const peer of this.peers) peer.destroy()
    await new Promise<void>((done) => this.server.close(() => done()))
    await unlink(this.socketPath).catch(() => undefined)
    if (endpoint) await dailyUseCommand(endpoint, { op: 'browser.owner.unregister',
      profile_id: this.profileId, owner_id: this.ownerId,
    }).catch(() => undefined)
  }
}
