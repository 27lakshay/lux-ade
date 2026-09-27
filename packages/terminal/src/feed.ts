import type { IDisposable, Terminal } from '@xterm/xterm'

// The stream side of a terminal view: it restores xterm from snapshots and
// writes live output in order. It needs no DOM, so it runs against a real
// xterm `Terminal` that was never opened, as the protocol E2E does.

export type TerminalFrame = Record<string, unknown> & { type: string }

/** The part of an xterm `Terminal` a feed drives. */
export type FeedScreen = Pick<Terminal, 'write' | 'resize' | 'reset'>

export interface FeedEvents {
  /** A user-facing message: incomplete recovery, a gap, or a failure. */
  status(message: string): void
  /** The screen is restored and live output follows; input may flow. */
  ready(): void
  /** The feed stopped for good; the caller closes its channel. */
  failed(): void
}

/**
 * Stops xterm from answering device status, device attribute and window
 * reports. The runtime's terminal already answered them, once, when the
 * program asked; an answer from xterm, live or during a replay, would reach
 * the program a second time (decision D06).
 */
export function suppressReplies(terminal: Pick<Terminal, 'parser'>): IDisposable[] {
  const handlers: IDisposable[] = []
  for (const final of ['n', 'c', 't']) {
    handlers.push(terminal.parser.registerCsiHandler({ final }, () => true))
    handlers.push(terminal.parser.registerCsiHandler({ prefix: '?', final }, () => true))
    handlers.push(terminal.parser.registerCsiHandler({ prefix: '>', final }, () => true))
  }
  return handlers
}

type ReplayEvent =
  | { type: 'output'; offset: number; bytes_base64: string }
  | { type: 'resize'; offset: number; cols: number; rows: number }

const MAX_PENDING_FRAMES = 512
const MAX_PENDING_BYTES = 2 * 1024 * 1024

function decode(base64: string): Uint8Array {
  const binary = atob(base64)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function outputBytes(frame: TerminalFrame): Uint8Array | null {
  if (!Array.isArray(frame.bytes) || frame.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
    return null
  return Uint8Array.from(frame.bytes as number[])
}

function write(screen: FeedScreen, bytes: Uint8Array): Promise<void> {
  return new Promise((resolveWrite) => screen.write(bytes, resolveWrite))
}

async function replay(
  screen: FeedScreen,
  frame: TerminalFrame,
  cancelled: () => boolean,
): Promise<{ complete: boolean; offset: number }> {
  if (frame.terminal_snapshot_format !== 'xterm-replay-v1') throw new Error('This daemon cannot restore xterm state.')
  const recovery = frame.terminal_recovery as Record<string, unknown> | undefined
  if (!recovery || typeof recovery.through_offset !== 'number' || !Number.isSafeInteger(recovery.through_offset)) {
    throw new Error('Terminal recovery metadata is invalid.')
  }
  if (recovery.complete !== true) return { complete: false, offset: recovery.through_offset }
  if (!Array.isArray(recovery.events)) throw new Error('Terminal replay events are invalid.')
  const cols = Number(recovery.initial_cols)
  const rows = Number(recovery.initial_rows)
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) {
    throw new Error('Terminal replay geometry is invalid.')
  }
  screen.resize(cols, rows)
  let offset = 0
  for (const event of recovery.events as ReplayEvent[]) {
    if (cancelled()) throw new Error('Terminal view closed during replay.')
    if (event.offset !== offset) throw new Error('Terminal replay has a byte gap.')
    if (event.type === 'resize') {
      screen.resize(event.cols, event.rows)
    } else if (event.type === 'output') {
      const bytes = decode(event.bytes_base64)
      await write(screen, bytes)
      offset += bytes.length
    } else {
      throw new Error('Terminal replay contains an unknown event.')
    }
  }
  if (offset !== recovery.through_offset) throw new Error('Terminal replay offset does not match the snapshot.')
  return { complete: true, offset }
}

/**
 * Feeds one attachment's frames to a screen. The first snapshot restores the
 * screen. A later snapshot, which the runtime sends with `resync: true` when
 * this viewer fell a whole budget behind, resets the screen and restores it
 * again; live output then continues from that snapshot's offset. Live frames
 * that arrive during a restore wait, within a bound.
 */
export class TerminalFeed {
  private restoring = false
  private restored = false
  private stopped = false
  private expectedOffset = 0
  private pendingBytes = 0
  private readonly pending: TerminalFrame[] = []

  private readonly screen: FeedScreen
  private readonly events: FeedEvents

  // Plain fields, not parameter properties: Node strips this file's types
  // without transforming it when a protocol E2E worker loads it.
  constructor(screen: FeedScreen, events: FeedEvents) {
    this.screen = screen
    this.events = events
  }

  /** True while the screen shows restored state and live output is applied. */
  get ready(): boolean {
    return this.restored && !this.restoring && !this.stopped
  }

  push(frame: TerminalFrame): void {
    if (this.stopped) return
    if (this.restoring) return this.queue(frame)
    if (frame.type === 'snapshot') return this.restore(frame)
    if (this.restored) this.applyLive(frame)
    else this.queue(frame)
  }

  /** Stop applying frames, for example when the view closes. */
  dispose(): void {
    this.stopped = true
    this.pending.length = 0
  }

  private queue(frame: TerminalFrame): void {
    this.pendingBytes += Array.isArray(frame.bytes) ? frame.bytes.length : JSON.stringify(frame).length
    if (this.pending.length >= MAX_PENDING_FRAMES || this.pendingBytes > MAX_PENDING_BYTES) {
      this.fail('Terminal output exceeded the replay queue; reopen this view to restore it.')
    } else this.pending.push(frame)
  }

  private restore(frame: TerminalFrame): void {
    const resync = this.restored
    this.restoring = true
    if (resync) {
      // The screen shows output the runtime skipped for this viewer; start
      // from a clean terminal, as a new view would.
      this.screen.reset()
    }
    void replay(this.screen, frame, () => this.stopped)
      .then((result) => {
        if (this.stopped) return
        this.expectedOffset = result.offset
        this.restoring = false
        this.restored = true
        if (!result.complete) {
          this.events.status(
            resync
              ? 'Terminal fell behind and its history is too large to restore; live output continues.'
              : 'Terminal recovery is incomplete; live output remains available.',
          )
        }
        this.events.ready()
        const queued = this.pending.splice(0)
        this.pendingBytes = 0
        for (const next of queued) this.push(next)
      })
      .catch((error: Error) => {
        if (this.stopped) return
        this.fail(error.message)
      })
  }

  private applyLive(frame: TerminalFrame): void {
    if (frame.type === 'terminal') {
      const bytes = outputBytes(frame)
      if (!bytes || frame.offset !== this.expectedOffset) {
        this.events.status('Terminal output is incomplete. Reconnect to restore it.')
        return
      }
      this.expectedOffset += bytes.length
      this.screen.write(bytes)
    } else if (frame.type === 'terminal_resize') {
      if (frame.offset !== this.expectedOffset) this.events.status('Terminal resize order is uncertain.')
      else this.screen.resize(Number(frame.cols), Number(frame.rows))
    } else if (frame.type === 'error' || frame.type === 'warning') {
      this.events.status(typeof frame.message === 'string' ? frame.message : 'Terminal reported an error.')
    }
  }

  private fail(message: string): void {
    this.stopped = true
    this.pending.length = 0
    this.events.failed()
    this.events.status(message)
  }
}
