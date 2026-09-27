// A real xterm.js terminal core, never opened, driven by the desktop
// adapter's TerminalFeed. xterm's parser, buffers and modes run without a
// DOM; rendering, fit, selection, the keyboard and IME do not, so those stay
// with Electron E2E.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Terminal } from '@xterm/xterm'
import { expect, type ScratchProfile } from '../fixtures'
import { clientSdk, type TerminalFrame as StreamFrame } from '../fixtures/terminals'
import { repositoryRoot } from '../fixtures/environment'
import { TerminalFeed, type TerminalFrame } from '../../../packages/terminal/src/feed'
import { prepareTerminal, terminalOptions } from '../../../packages/terminal/src/options'

export { TerminalFeed }

/** Where the desktop adapter's source and its xterm dependency live. */
export const terminalPackage = join(repositoryRoot, 'packages/terminal')
export const feedSource = join(terminalPackage, 'src/feed.ts')

const load = createRequire(join(terminalPackage, 'package.json'))

/**
 * An xterm terminal with the adapter's options, prepared as the adapter
 * prepares it (Unicode 11 widths, no replies). `prepared: false` leaves
 * xterm's defaults, for a control.
 */
export function newXterm({ prepared = true } = {}): Terminal {
  const { Terminal: XtermTerminal } = load('@xterm/xterm') as typeof import('@xterm/xterm')
  const terminal = new XtermTerminal(terminalOptions)
  if (prepared) prepareTerminal(terminal)
  return terminal
}

/** Resolves once xterm has parsed everything written so far. */
export function flushed(terminal: Terminal): Promise<void> {
  return new Promise((resolveFlush) => terminal.write('', resolveFlush))
}

export interface ScreenState {
  buffer: string
  cols: number
  rows: number
  cursor: [number, number]
  lines: string[]
  modes: Terminal['modes']
}

/** What a user sees: the viewport lines, the cursor, the active buffer and the modes. */
export async function screenOf(terminal: Terminal): Promise<ScreenState> {
  await flushed(terminal)
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let row = 0; row < terminal.rows; row++) {
    lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
  }
  return { buffer: buffer.type, cols: terminal.cols, rows: terminal.rows, cursor: [buffer.cursorX, buffer.cursorY],
    lines, modes: { ...terminal.modes } }
}

export interface XtermView {
  terminal: Terminal
  feed: TerminalFeed
  statuses: string[]
  failed(): boolean
  /** Resolves when the feed next finishes a restore; rejects if it fails. */
  restored(): Promise<void>
}

/** A feed into a fresh xterm, with the statuses it reported. */
export function xtermView(): XtermView {
  const terminal = newXterm()
  const statuses: string[] = []
  let failed = false
  let waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
  const settle = (error?: Error): void => {
    const current = waiters
    waiters = []
    for (const waiter of current) {
      if (error) waiter.reject(error)
      else waiter.resolve()
    }
  }
  const feed = new TerminalFeed(terminal, {
    status: (message) => statuses.push(message),
    ready: () => settle(),
    failed: () => { failed = true; queueMicrotask(() => settle(new Error(`Restore failed: ${statuses.join('; ')}`))) },
  })
  return { terminal, feed, statuses, failed: () => failed,
    restored: () => new Promise<void>((resolve, reject) => waiters.push({ resolve, reject })) }
}

/** The screen a new view restores from `snapshot` alone. */
export async function restoredScreen(snapshot: TerminalFrame): Promise<ScreenState> {
  const view = xtermView()
  const restored = view.restored()
  view.feed.push(snapshot)
  await restored
  const screen = await screenOf(view.terminal)
  view.terminal.dispose()
  return screen
}

/** A desktop-shaped view: the SDK's terminal connection feeding xterm through TerminalFeed. */
export async function openView(profile: ScratchProfile, workspaceId: string, terminalId: string) {
  const { openTerminalConnection } = await clientSdk()
  const view: XtermView = xtermView()
  const frames: StreamFrame[] = []
  const restored = view.restored()
  const connection = openTerminalConnection(profile.socket, workspaceId, terminalId, (frame) => {
    frames.push(frame)
    view.feed.push(frame)
  }, () => {})
  view.terminal.onData((data) => { if (view.feed.ready) connection.input(data) })
  await restored
  return {
    view, connection, frames,
    screen: () => screenOf(view.terminal),
    /** Waits until the screen, once xterm has parsed what arrived, matches. */
    until: async (what: string, match: (screen: ScreenState) => boolean): Promise<ScreenState> => {
      let last: ScreenState | undefined
      await expect.poll(async () => match(last = await screenOf(view.terminal)), { message: what }).toBe(true)
      return last!
    },
  }
}
