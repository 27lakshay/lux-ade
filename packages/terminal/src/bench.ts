// A terminal connection with no daemon behind it, for benchmarking the desktop with real terminals:
// it restores a snapshot holding a long scrollback, then streams coloured log output at a set rate.
// Development only; nothing in the app imports it outside the benchmark harness.
import { GhosttyTerminalCore } from './ghostty/core'
import { encodeSnapshot, outputFrame, snapshotFrame } from './ghostty/testing'
import type { TerminalBridge } from './index'

export interface BenchTerminalOptions {
  /** Lines already in the scrollback when the view attaches. */
  scrollback: number
  /** Lines of new output per second while streaming. */
  linesPerSecond: number
}

const COLOURS = [31, 32, 33, 34, 35, 36, 90]
let streaming = true
/** Pauses or resumes output on every benchmark terminal. */
export function setBenchStreaming(on: boolean): void {
  streaming = on
}

function logLine(n: number): string {
  const colour = COLOURS[n % COLOURS.length]
  const level = ['INFO', 'WARN', 'DEBUG', 'ERROR'][n % 4]
  return `\x1b[${colour}m${String(n).padStart(7)}\x1b[0m ${level} worker-${n % 13} handled request /api/items/${(n * 7919) % 100000} in ${(n % 97) + 3}ms ${'·'.repeat(n % 40)}\r\n`
}

const snapshots = new Map<number, Promise<{ frame: Awaited<ReturnType<typeof snapshotFrame>>; offset: number }>>()

/** Base64 in slices: one spread of a multi-megabyte array overflows the call stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(binary)
}

function sharedSnapshot(scrollback: number, theme: Parameters<typeof GhosttyTerminalCore.create>[4]) {
  let made = snapshots.get(scrollback)
  if (!made) {
    made = (async () => {
      const source = await GhosttyTerminalCore.create(120, 40, 8, 16, theme)
      let offset = 0
      for (let start = 0; start < scrollback; start += 500) {
        let text = ''
        for (let n = start; n < Math.min(scrollback, start + 500); n++) text += logLine(n)
        source.write(text)
        offset += new TextEncoder().encode(text).length
      }
      const bytes = await encodeSnapshot(source)
      source.dispose()
      // The frame's fields come from an empty terminal; its state is the full one.
      const empty = await GhosttyTerminalCore.create(120, 40, 8, 16, theme)
      const frame = await snapshotFrame(empty, offset, { terminal_snapshot_base64: toBase64(bytes) })
      empty.dispose()
      return { frame, offset }
    })()
    snapshots.set(scrollback, made)
  }
  return made
}

export function benchTerminalBridge(options: BenchTerminalOptions): TerminalBridge {
  return {
    async attach(_workspace, _terminal, onFrame) {
      const theme = {
        foreground: { r: 220, g: 220, b: 220 },
        background: { r: 0, g: 0, b: 0 },
        cursor: { r: 255, g: 255, b: 255 },
      }
      // A real Ghostty snapshot holding the scrollback, as the daemon sends one, made once per window
      // and shared: restoring it is what a terminal costs when its workspace comes back.
      const { frame, offset: restored } = await sharedSnapshot(options.scrollback, theme)
      onFrame(frame)
      let offset = restored
      const send = (text: string): void => {
        onFrame(outputFrame(text, offset))
        offset += new TextEncoder().encode(text).length
      }
      let n = options.scrollback
      const perTick = Math.max(1, Math.round(options.linesPerSecond / 60))
      const timer = setInterval(() => {
        if (!streaming) return
        let chunk = ''
        for (let i = 0; i < perTick; i++) chunk += logLine(n++)
        send(chunk)
      }, 1000 / 60)
      return {
        input: () => {},
        binary: () => {},
        resize: () => {},
        dispose: () => clearInterval(timer),
      }
    },
  }
}
