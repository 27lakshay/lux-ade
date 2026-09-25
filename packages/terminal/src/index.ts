import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type IDisposable } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

export type TerminalFrame = Record<string, unknown> & { type: string }

export interface TerminalChannel {
  input(data: string): void
  binary(bytes: number[]): void
  resize(cols: number, rows: number, widthPx: number, heightPx: number): void
  dispose(): void
}

export interface TerminalBridge {
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
  if (!Array.isArray(frame.bytes) || frame.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null
  return Uint8Array.from(frame.bytes as number[])
}

function write(terminal: Terminal, bytes: Uint8Array): Promise<void> {
  return new Promise((resolveWrite) => terminal.write(bytes, resolveWrite))
}

async function replay(
  terminal: Terminal,
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
  terminal.resize(cols, rows)
  let offset = 0
  for (const event of recovery.events as ReplayEvent[]) {
    if (cancelled()) throw new Error('Terminal view closed during replay.')
    if (event.offset !== offset) throw new Error('Terminal replay has a byte gap.')
    if (event.type === 'resize') {
      terminal.resize(event.cols, event.rows)
    } else if (event.type === 'output') {
      const bytes = decode(event.bytes_base64)
      await write(terminal, bytes)
      offset += bytes.length
    } else {
      throw new Error('Terminal replay contains an unknown event.')
    }
  }
  if (offset !== recovery.through_offset) throw new Error('Terminal replay offset does not match the snapshot.')
  return { complete: true, offset }
}

/** Mounts a terminal without routing PTY bytes through React state. */
export function mountTerminal(
  container: HTMLElement,
  bridge: TerminalBridge,
  workspaceId: string,
  terminalId: string,
  onStatus: (message: string) => void,
): TerminalView {
  const terminal = new Terminal({ cols: 100, rows: 30, convertEol: false, scrollback: 10_000 })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(container)
  let channel: TerminalChannel | null = null
  let disposed = false
  let ready = false
  let failed = false
  let expectedOffset = 0
  let pendingBytes = 0
  const pending: TerminalFrame[] = []
  const subscriptions: IDisposable[] = []

  const applyLive = (frame: TerminalFrame): void => {
    if (frame.type === 'terminal') {
      const bytes = outputBytes(frame)
      if (!bytes || frame.offset !== expectedOffset) {
        onStatus('Terminal output is incomplete. Reconnect to restore it.')
        return
      }
      expectedOffset += bytes.length
      terminal.write(bytes)
    } else if (frame.type === 'terminal_resize') {
      if (frame.offset !== expectedOffset) onStatus('Terminal resize order is uncertain.')
      else terminal.resize(Number(frame.cols), Number(frame.rows))
    } else if (frame.type === 'error' || frame.type === 'warning') {
      onStatus(String(frame.message ?? 'Terminal reported an error.'))
    }
  }

  const fitAndNotify = (): void => {
    if (!ready || !channel || disposed || !container.isConnected) return
    fit.fit()
    const box = container.getBoundingClientRect()
    channel.resize(terminal.cols, terminal.rows, Math.round(box.width), Math.round(box.height))
  }
  const observer = new ResizeObserver(fitAndNotify)
  observer.observe(container)

  for (const final of ['n', 'c', 't']) {
    subscriptions.push(terminal.parser.registerCsiHandler({ final }, () => true))
    subscriptions.push(terminal.parser.registerCsiHandler({ prefix: '?', final }, () => true))
    subscriptions.push(terminal.parser.registerCsiHandler({ prefix: '>', final }, () => true))
  }
  subscriptions.push(terminal.onData((data) => { if (ready) channel?.input(data) }))
  subscriptions.push(terminal.onBinary((data) => {
    if (ready) channel?.binary(Array.from(data, (character) => character.charCodeAt(0) & 255))
  }))

  void bridge.attach(workspaceId, terminalId, (frame) => {
    if (disposed || failed) return
    if (frame.type === 'snapshot') {
      void replay(terminal, frame, () => disposed || failed).then((result) => {
        if (disposed || failed) return
        expectedOffset = result.offset
        if (!result.complete) onStatus('Terminal recovery is incomplete; live output remains available.')
        ready = true
        for (const queued of pending.splice(0)) applyLive(queued)
        pendingBytes = 0
        fitAndNotify()
      }).catch((error: Error) => {
        if (disposed) return
        failed = true
        pending.length = 0
        channel?.dispose()
        onStatus(error.message)
      })
    } else if (ready) applyLive(frame)
    else {
      pendingBytes += Array.isArray(frame.bytes) ? frame.bytes.length : JSON.stringify(frame).length
      if (pending.length >= MAX_PENDING_FRAMES || pendingBytes > MAX_PENDING_BYTES) {
        failed = true
        pending.length = 0
        channel?.dispose()
        onStatus('Terminal output exceeded the replay queue; reopen this view to restore it.')
      } else pending.push(frame)
    }
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
      observer.disconnect()
      for (const subscription of subscriptions) subscription.dispose()
      channel?.dispose()
      terminal.dispose()
    },
  }
}
