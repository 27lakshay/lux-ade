// The window's terminal engine without a window: Ghostty's WebAssembly core, driven by the desktop
// adapter's TerminalFeed from the runtime's Ghostty snapshots and live output. Its parser, screens
// and modes run in Node; drawing, fit, selection, the keyboard and IME stay with Electron E2E.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type ScratchProfile } from '../fixtures'
import { clientSdk, type TerminalFrame as StreamFrame } from '../fixtures/terminals'
import { repositoryRoot } from '../fixtures/environment'
import { TerminalFeed } from '../../../packages/terminal/src/feed'
import { GHOSTTY_CELL_WIDE, GhosttyTerminalCore, type GhosttyRow } from '../../../packages/terminal/src/ghostty/core'
import { setGhosttyWasmSource } from '../../../packages/terminal/src/ghostty/runtime'

/** The desktop adapter's source, which the worker-thread viewer loads itself. */
export const terminalSource = join(repositoryRoot, 'packages/terminal/src')
const wasmPath = join(terminalSource, 'ghostty/vendor/ghostty-vt.wasm')

setGhosttyWasmSource(async () => Uint8Array.from(await readFile(wasmPath)))

// A restore adopts the snapshot's grid, so this size only holds until the first snapshot.
const theme = {
  foreground: { r: 255, g: 255, b: 255 },
  background: { r: 0, g: 0, b: 0 },
  cursor: { r: 255, g: 255, b: 255 },
}

export function newScreen(): Promise<GhosttyTerminalCore> {
  return GhosttyTerminalCore.create(100, 30, 8, 16, theme)
}

export interface ScreenState {
  buffer: 'normal' | 'alternate'
  cols: number
  rows: number
  cursor: [number, number]
  lines: string[]
  modes: {
    bracketedPasteMode: boolean
    applicationCursorKeysMode: boolean
    mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
  }
}

/** A row's text as it reads: a wide character's spacer cell adds nothing, trailing blanks are cut. */
function lineText(row: GhosttyRow): string {
  return row.cells
    .filter((cell) => cell.wide !== GHOSTTY_CELL_WIDE.spacerTail && cell.wide !== GHOSTTY_CELL_WIDE.spacerHead)
    .map((cell) => cell.text || ' ')
    .join('')
    .trimEnd()
}

/** What a user sees: the viewport lines, the cursor, the active screen and the modes. */
export function screenOf(core: GhosttyTerminalCore): ScreenState {
  const snapshot = core.snapshot()
  const mode = (number: number) => core.isModeEnabled(number)
  return {
    buffer: core.isAlternateScreen() ? 'alternate' : 'normal',
    cols: snapshot.cols,
    rows: snapshot.rows,
    cursor: [snapshot.cursorX, snapshot.cursorY],
    lines: snapshot.rowData.map(lineText),
    modes: {
      bracketedPasteMode: mode(2004),
      applicationCursorKeysMode: mode(1),
      mouseTrackingMode: mode(1003) ? 'any' : mode(1002) ? 'drag' : mode(1000) ? 'vt200' : mode(9) ? 'x10' : 'none',
    },
  }
}

export interface TerminalViewer {
  screen: GhosttyTerminalCore
  feed: TerminalFeed
  statuses: string[]
  failed(): boolean
}

/** A feed into a fresh Ghostty core, with the statuses it reported. */
export async function newViewer(): Promise<TerminalViewer> {
  const screen = await newScreen()
  const statuses: string[] = []
  let failed = false
  const feed = new TerminalFeed(screen, {
    status: (message) => statuses.push(message),
    ready: () => {},
    failed: () => {
      failed = true
    },
  })
  return { screen, feed, statuses, failed: () => failed }
}

/** The screen a new view restores from `snapshot` alone, checked against its contract first. */
export async function restoredScreen(snapshot: unknown): Promise<ScreenState> {
  const viewer = await newViewer()
  const { decodeTerminalFrame } = await clientSdk()
  viewer.feed.push(decodeTerminalFrame(snapshot))
  if (!viewer.feed.ready) throw new Error(`Restore failed: ${viewer.statuses.join('; ')}`)
  const screen = screenOf(viewer.screen)
  viewer.screen.dispose()
  return screen
}

/** A desktop-shaped view: the SDK's terminal connection, asking for Ghostty snapshots, feeding a core. */
export async function openView(profile: ScratchProfile, workspaceId: string, terminalId: string) {
  const { openTerminalConnection } = await clientSdk()
  const viewer = await newViewer()
  const frames: StreamFrame[] = []
  const connection = openTerminalConnection(
    profile.socket,
    workspaceId,
    terminalId,
    (frame) => {
      frames.push(frame)
      viewer.feed.push(frame)
    },
    () => {},
    { snapshotFormat: 'ghostty' },
  )
  await expect.poll(() => viewer.feed.ready || viewer.failed(), { message: 'the view to restore' }).toBe(true)
  if (viewer.failed()) throw new Error(`Restore failed: ${viewer.statuses.join('; ')}`)
  return {
    viewer,
    connection,
    frames,
    screen: () => screenOf(viewer.screen),
    /** Waits until the screen matches. */
    until: async (what: string, match: (screen: ScreenState) => boolean): Promise<ScreenState> => {
      let last: ScreenState | undefined
      await expect.poll(() => match((last = screenOf(viewer.screen))), { message: what }).toBe(true)
      return last!
    },
    dispose: () => {
      connection.dispose()
      viewer.feed.dispose()
      viewer.screen.dispose()
    },
  }
}
