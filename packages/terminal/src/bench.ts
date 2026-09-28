// A terminal connection with no daemon behind it, for benchmarking the desktop with real terminals:
// it restores a snapshot holding a long scrollback, then streams coloured log output at a set rate.
// Development only; nothing in the app imports it outside the benchmark harness.
import { GhosttyTerminalCore } from './ghostty/core'
import { outputFrame, snapshotFrame } from './ghostty/testing'
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

export function benchTerminalBridge(options: BenchTerminalOptions): TerminalBridge {
  return {
    async attach(_workspace, _terminal, onFrame) {
      const theme = {
        foreground: { r: 220, g: 220, b: 220 },
        background: { r: 0, g: 0, b: 0 },
        cursor: { r: 255, g: 255, b: 255 },
      }
      // An empty terminal's snapshot, then the scrollback as a burst of output: the same state, without
      // encoding megabytes into one snapshot.
      const core = await GhosttyTerminalCore.create(120, 40, 8, 16, theme)
      onFrame(await snapshotFrame(core, 0))
      core.dispose()
      let offset = 0
      const send = (text: string): void => {
        onFrame(outputFrame(text, offset))
        offset += new TextEncoder().encode(text).length
      }
      for (let start = 0; start < options.scrollback; start += 500) {
        let text = ''
        for (let n = start; n < Math.min(options.scrollback, start + 500); n++) text += logLine(n)
        send(text)
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
