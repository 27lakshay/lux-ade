import { TerminalFeed, type TerminalFrame } from './feed'
import type { GhosttyTheme } from './ghostty/core'
import { GhosttyTerminalSurface, type GhosttyTerminalFont } from './ghostty/surface'
import type { GhosttyTerminalPreferences } from './ghostty/surface'
import { terminalThemeFrom } from './theme'

export type { TerminalFrame } from './feed'
// For the host's `onLinkActivate`: whether a click should open a link, and where a path points.
export { isTerminalLinkActivation, resolvePathLinkTarget } from './ghostty/links'
export type { GhosttyTheme } from './ghostty/core'
export type { GhosttyTerminalFont } from './ghostty/surface'
export type { GhosttyTerminalPreferences } from './ghostty/surface'

export interface TerminalChannel {
  input(data: string): void
  binary(bytes: number[]): void
  resize(cols: number, rows: number, widthPx: number, heightPx: number): void
  dispose(): void
}

export interface TerminalBridge {
  /**
   * Attaches to a terminal. `onFrame` receives every frame in order: the
   * snapshot first, then live frames, and a later snapshot marked
   * `resync: true` whenever the runtime resynchronizes a lagging viewer.
   */
  attach(
    workspaceId: string,
    terminalId: string,
    onFrame: (frame: TerminalFrame) => void,
    onClose: (reason: string) => void,
  ): Promise<TerminalChannel>
}

export interface MountTerminalOptions {
  /** A user-facing message: a failed attach, a gap, or a closed connection. */
  onStatus(message: string): void
  /** A link the user activated (a URL or a file path, with any `:line:column`). */
  onLinkActivate?(text: string, event: MouseEvent): void
  /** A right-click the running program did not take. The host shows its menu. */
  onContextMenu?(event: MouseEvent): void
  font?: GhosttyTerminalFont
  preferences?: GhosttyTerminalPreferences
  /** Initial colors before attachment; the runtime snapshot supplies authoritative defaults. */
  theme?: GhosttyTheme
}

export interface TerminalView {
  /** Pauses drawing while the view is hidden; output is still parsed. */
  setVisible(visible: boolean): void
  /** Loads and applies a font; the grid refits to the new cell size. */
  setFont(font: GhosttyTerminalFont): Promise<void>
  setPreferences(preferences: GhosttyTerminalPreferences): Promise<void>
  focus(): void
  dispose(): void
}

/**
 * Mounts a terminal: a Ghostty surface drawing into `container`, fed by one attachment. PTY bytes
 * never pass through React state.
 */
export function mountTerminal(
  container: HTMLElement,
  bridge: TerminalBridge,
  workspaceId: string,
  terminalId: string,
  options: MountTerminalOptions,
): TerminalView {
  let surface: GhosttyTerminalSurface | null = null
  let feed: TerminalFeed | null = null
  let channel: TerminalChannel | null = null
  let visible = true
  let disposed = false
  let failed = false
  // Focus asked for before the surface exists (a terminal just opened) or while it is hidden (its tab
  // is being shown) is applied once it can take it.
  let focusPending = false
  let pendingPreferences: GhosttyTerminalPreferences | null = null
  const applyFocus = (): void => {
    if (!surface || !visible) return
    focusPending = false
    surface.focus()
  }

  const reportSize = (): void => {
    if (!surface || !channel || !feed?.ready || disposed) return
    const box = container.getBoundingClientRect()
    channel.resize(surface.cols, surface.rows, Math.round(box.width), Math.round(box.height))
  }

  const start = async (): Promise<void> => {
    const created: GhosttyTerminalSurface = await GhosttyTerminalSurface.create(container, {
      theme: options.theme ?? terminalThemeFrom(container),
      font: options.font,
      preferences: options.preferences,
      get visible() {
        return visible
      },
      onData: (data) => {
        if (feed?.ready) channel?.input(data)
      },
      onResize: reportSize,
      onSelectionChange: () => {},
      // Global shortcuts belong to the native menu, which sees them first; every other key is the
      // terminal's.
      beforeKey: () => true,
      onLinkActivate: (text, event) => options.onLinkActivate?.(text, event),
      onContextMenu: (event) => options.onContextMenu?.(event),
    })
    if (disposed) {
      created.dispose()
      return
    }
    surface = created
    if (pendingPreferences !== null) {
      const preferences = pendingPreferences
      pendingPreferences = null
      await created.setPreferences(preferences)
    }
    if (focusPending) applyFocus()
    feed = new TerminalFeed(
      {
        setTheme: (theme) => created.setTheme(theme),
        restoreSnapshot: (bytes) => created.restoreSnapshot(bytes),
        write: (bytes) => created.write(bytes),
      },
      {
        status: (message) => options.onStatus(message),
        ready: reportSize,
        failed: () => {
          failed = true
          channel?.dispose()
        },
      },
    )
    const attached = await bridge.attach(
      workspaceId,
      terminalId,
      (frame) => {
        if (!disposed && !failed) feed?.push(frame)
      },
      (reason) => {
        if (!disposed) options.onStatus(reason)
      },
    )
    if (disposed || failed) {
      attached.dispose()
      return
    }
    channel = attached
    reportSize()
  }
  start().catch((error: Error) => {
    if (!disposed) options.onStatus(error.message)
  })

  return {
    setVisible: (next) => {
      visible = next
      surface?.setVisible(next)
      // A request made for a tab that was hidden again before it showed is dropped.
      if (!next) focusPending = false
      else if (focusPending) applyFocus()
    },
    setFont: async (font) => {
      await surface?.setFont(font)
    },
    setPreferences: async (preferences) => {
      if (disposed) return
      if (surface) await surface.setPreferences(preferences)
      else pendingPreferences = { ...pendingPreferences, ...preferences }
    },
    focus: () => {
      focusPending = true
      applyFocus()
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      feed?.dispose()
      channel?.dispose()
      surface?.dispose()
    },
  }
}
