import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type IDisposable } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { TerminalFeed, type TerminalFrame } from './feed'
import { prepareTerminal, terminalOptions } from './options'

export type { TerminalFrame } from './feed'

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

export interface TerminalView {
  terminal: Terminal
  dispose(): void
}

/** Mounts a terminal without routing PTY bytes through React state. */
export function mountTerminal(
  container: HTMLElement,
  bridge: TerminalBridge,
  workspaceId: string,
  terminalId: string,
  onStatus: (message: string) => void,
): TerminalView {
  const terminal = new Terminal(terminalOptions)
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(container)
  let channel: TerminalChannel | null = null
  let disposed = false
  let failed = false
  const subscriptions: IDisposable[] = []
  const feed = new TerminalFeed(terminal, {
    status: onStatus,
    ready: () => fitAndNotify(),
    failed: () => {
      failed = true
      channel?.dispose()
    },
  })

  const fitAndNotify = (): void => {
    if (!feed.ready || !channel || disposed || !container.isConnected) return
    fit.fit()
    const box = container.getBoundingClientRect()
    channel.resize(terminal.cols, terminal.rows, Math.round(box.width), Math.round(box.height))
  }
  const observer = new ResizeObserver(fitAndNotify)
  observer.observe(container)

  subscriptions.push(...prepareTerminal(terminal))
  subscriptions.push(terminal.onData((data) => { if (feed.ready) channel?.input(data) }))
  subscriptions.push(terminal.onBinary((data) => {
    if (feed.ready) channel?.binary(Array.from(data, (character) => character.charCodeAt(0) & 255))
  }))

  void bridge.attach(workspaceId, terminalId, (frame) => {
    if (!disposed && !failed) feed.push(frame)
  }, (reason) => { if (!disposed) onStatus(reason) }).then((attached) => {
    if (disposed || failed) attached.dispose()
    else {
      channel = attached
      fitAndNotify()
    }
  }).catch((error: Error) => onStatus(error.message))

  return {
    terminal,
    dispose: () => {
      if (disposed) return
      disposed = true
      feed.dispose()
      observer.disconnect()
      for (const subscription of subscriptions) subscription.dispose()
      channel?.dispose()
      terminal.dispose()
    },
  }
}
