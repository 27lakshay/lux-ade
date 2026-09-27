// A raw `session.subscribe` or terminal viewer connection that a spec can stop reading. The SDK
// client always drains its socket, so it cannot stand in for a slow or stuck
// consumer. `pause()` stops reading at once: the kernel buffers fill and the
// daemon's writes to this connection block. `resume()` reads what the kernel
// kept. Every frame read is recorded in order, and so is the close.
import { createConnection, type Socket } from 'node:net'
import { expect } from '@playwright/test'

export type RawFeedFrame = Record<string, unknown> & { type: string; boot_id?: string; revision?: number }

export class RawFeed {
  readonly frames: RawFeedFrame[] = []
  /** Set once the peer closed or reset the connection. */
  closedReason: string | null = null
  private buffered = Buffer.alloc(0)

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk])
      for (let end = this.buffered.indexOf(10); end >= 0; end = this.buffered.indexOf(10)) {
        const line = this.buffered.subarray(0, end).toString('utf8')
        this.buffered = this.buffered.subarray(end + 1)
        try {
          this.frames.push(JSON.parse(line) as RawFeedFrame)
        } catch {
          this.frames.push({ type: 'invalid', line })
        }
      }
    })
    socket.on('error', (error) => {
      this.closedReason ??= error.message
    })
    socket.on('close', () => {
      this.closedReason ??= 'closed'
    })
  }

  /** Subscribe on `socketPath` and resolve once the initial catalog frame arrived. */
  static async open(socketPath: string): Promise<RawFeed> {
    return RawFeed.connect(socketPath, { op: 'session.subscribe' }, 'catalog')
  }

  /** Attach to a terminal as a viewer (xterm-replay-v1) and resolve once its snapshot arrived. */
  static async openTerminal(socketPath: string, workspaceId: string, terminalId: string): Promise<RawFeed> {
    return RawFeed.connect(
      socketPath,
      { workspace_id: workspaceId, terminal_id: terminalId, op: 'subscribe', snapshot_format: 'xterm-replay-v1' },
      'snapshot',
    )
  }

  private static async connect(socketPath: string, first: Record<string, unknown>, ready: string): Promise<RawFeed> {
    const socket = createConnection(socketPath)
    const feed = new RawFeed(socket)
    await new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once('error', rejectConnect)
      socket.once('connect', () => {
        socket.off('error', rejectConnect)
        resolveConnect()
      })
    })
    socket.write(`${JSON.stringify(first)}\n`)
    await expect.poll(() => feed.frames[0]?.type ?? null, { message: `the initial ${ready} frame` }).toBe(ready)
    return feed
  }

  /** Stop reading from the socket. The daemon sees a consumer that no longer drains. */
  pause(): void {
    this.socket.pause()
  }

  /** Read again, including what the kernel buffered meanwhile. */
  resume(): void {
    this.socket.resume()
  }

  get closed(): boolean {
    return this.closedReason !== null
  }

  /** Revisions of the recorded frames, in arrival order. */
  revisions(): number[] {
    return this.frames
      .map((frame) => frame.revision)
      .filter((revision): revision is number => typeof revision === 'number')
  }

  /** Wait until the peer closes the connection. */
  async waitForClose(timeout = 30_000): Promise<string> {
    await expect.poll(() => this.closed, { timeout, message: 'the feed connection to close' }).toBe(true)
    return this.closedReason!
  }

  close(): void {
    this.socket.destroy()
  }
}
