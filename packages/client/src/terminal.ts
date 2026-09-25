import { createConnection } from 'node:net'

const MAX_FRAME_BYTES = 32 * 1024 * 1024

export type TerminalFrame = Record<string, unknown> & { type: string }

export interface TerminalConnection {
  input(data: string): void
  binary(bytes: number[]): void
  resize(cols: number, rows: number, widthPx: number, heightPx: number): void
  dispose(): void
}

export function openTerminalConnection(
  socketPath: string,
  workspaceId: string,
  terminalId: string,
  onFrame: (frame: TerminalFrame) => void,
  onClose: (reason: string) => void,
): TerminalConnection {
  const socket = createConnection({ path: socketPath })
  let buffered = Buffer.alloc(0)
  let closed = false

  const send = (value: Record<string, unknown>): void => {
    if (closed) return
    socket.write(`${JSON.stringify({ ...value, workspace_id: workspaceId, terminal_id: terminalId })}\n`)
  }
  const finish = (reason: string): void => {
    if (closed) return
    closed = true
    socket.destroy()
    onClose(reason)
  }
  socket.on('connect', () => send({ op: 'subscribe', snapshot_format: 'xterm-replay-v1' }))
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    if (buffered.length > MAX_FRAME_BYTES) return finish('Terminal frame exceeded 32 MiB.')
    for (;;) {
      const end = buffered.indexOf(10)
      if (end < 0) return
      const line = buffered.subarray(0, end)
      buffered = buffered.subarray(end + 1)
      let frame: TerminalFrame
      try { frame = JSON.parse(line.toString('utf8')) as TerminalFrame }
      catch { return finish('Terminal sent invalid JSON.') }
      if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
        return finish('Terminal sent an invalid frame.')
      }
      onFrame(frame)
    }
  })
  socket.on('error', (error: Error) => finish(error.message))
  socket.on('close', () => finish('Terminal connection closed.'))

  return {
    input: (data) => send({ op: 'input', data }),
    binary: (bytes) => send({ op: 'input', bytes }),
    resize: (cols, rows, widthPx, heightPx) =>
      send({ op: 'resize', cols, rows, width_px: widthPx, height_px: heightPx }),
    dispose: () => {
      closed = true
      socket.destroy()
    },
  }
}
