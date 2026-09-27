// The stream side of a terminal view: it restores the screen from the runtime's Ghostty snapshots
// and writes live output in order. It needs no DOM, so the protocol E2E drives a bare
// `GhosttyTerminalCore` with it in Node, as the window drives a `GhosttyTerminalSurface`.

import type { TerminalSnapshotFrame, TerminalStreamFrame } from '@ade/contracts'

/** A frame of a terminal attachment. The SDK has checked it against its contract. */
export type TerminalFrame = TerminalStreamFrame

/**
 * The snapshot format of the runtime's Ghostty. The window's Ghostty is built from the same pinned
 * source (scripts/build-ghostty-wasm.mjs), so it decodes these exactly; a daemon on another pin
 * names another format and the feed refuses it.
 */
export const GHOSTTY_SNAPSHOT_FORMAT = 'ghostty-snapshot-v1-herdr-9c96f7d'

/** The part of a Ghostty terminal a feed drives: `GhosttyTerminalCore` or the surface. */
export interface FeedScreen {
  /** Replaces the screen with a snapshot; false, keeping the screen, if it is rejected. */
  restoreSnapshot(bytes: Uint8Array): boolean
  write(bytes: Uint8Array): void
}

export interface FeedEvents {
  /** A user-facing message: a gap, a rejected snapshot, or a failure. */
  status(message: string): void
  /** The screen is restored and live output follows; input may flow. */
  ready(): void
  /** The feed stopped for good; the caller closes its channel. */
  failed(): void
}

const MAX_PENDING_FRAMES = 512
const MAX_PENDING_BYTES = 2 * 1024 * 1024

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

/** The snapshot's Ghostty state and the live offset it was taken at. Throws if it has none. */
function readSnapshot(frame: TerminalSnapshotFrame): { bytes: Uint8Array; offset: number } {
  if (frame.terminal_snapshot_format !== GHOSTTY_SNAPSHOT_FORMAT) {
    throw new Error('This daemon runs a different Ghostty; its terminal state cannot be restored here.')
  }
  const offset = frame.metrics.terminal_bytes
  if (typeof frame.terminal_snapshot_base64 === 'string') {
    return { bytes: decodeBase64(frame.terminal_snapshot_base64), offset }
  }
  if (frame.terminal_snapshot_bytes) return { bytes: Uint8Array.from(frame.terminal_snapshot_bytes), offset }
  throw new Error('Terminal snapshot has no state.')
}

/**
 * Feeds one attachment's frames to a screen. The first snapshot restores the screen. A later
 * snapshot, which the runtime sends with `resync: true` when this viewer fell a whole budget
 * behind, replaces the screen again; live output then continues from that snapshot's offset.
 * Live frames that arrive before the first snapshot wait, within a bound.
 */
export class TerminalFeed {
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
    return this.restored && !this.stopped
  }

  push(frame: TerminalFrame): void {
    if (this.stopped) return
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
    this.pendingBytes += frame.type === 'terminal' ? frame.bytes.length : JSON.stringify(frame).length
    if (this.pending.length >= MAX_PENDING_FRAMES || this.pendingBytes > MAX_PENDING_BYTES) {
      this.fail('Terminal output exceeded the restore queue; reopen this view to restore it.')
    } else this.pending.push(frame)
  }

  private restore(frame: TerminalSnapshotFrame): void {
    let snapshot: { bytes: Uint8Array; offset: number }
    try {
      snapshot = readSnapshot(frame)
    } catch (error) {
      return this.fail((error as Error).message)
    }
    if (!this.screen.restoreSnapshot(snapshot.bytes)) {
      return this.fail('Terminal state could not be restored; reopen this view to try again.')
    }
    this.expectedOffset = snapshot.offset
    this.restored = true
    this.events.ready()
    const queued = this.pending.splice(0)
    this.pendingBytes = 0
    for (const next of queued) this.push(next)
  }

  private applyLive(frame: TerminalFrame): void {
    if (frame.type === 'terminal') {
      if (frame.offset !== this.expectedOffset) {
        this.events.status('Terminal output is incomplete. Reconnect to restore it.')
        return
      }
      this.expectedOffset += frame.bytes.length
      this.screen.write(Uint8Array.from(frame.bytes))
    } else if (frame.type === 'error' || frame.type === 'warning') {
      this.events.status(frame.message)
    }
    // `terminal_resize` needs nothing here: the view sizes its own grid from its container and
    // reports it (`onResize`), and Ghostty reflows the screen when it changes.
  }

  private fail(message: string): void {
    this.stopped = true
    this.pending.length = 0
    this.events.failed()
    this.events.status(message)
  }
}
