import { createConnection } from 'node:net'
import {
  ContractError,
  decodeTerminalFrame,
  type TerminalSnapshotFrame,
  type TerminalStreamFrame,
} from '@ade/contracts'

const MAX_FRAME_BYTES = 32 * 1024 * 1024

/** A frame of a terminal attachment, checked against its contract (crates/ade-core terminals.rs). */
export type TerminalFrame = TerminalStreamFrame

export interface TerminalConnection {
  input(data: string): void
  binary(bytes: number[]): void
  /** `claim` takes viewport ownership; without it the resize applies only for the owner. */
  resize(cols: number, rows: number, widthPx: number, heightPx: number, claim?: boolean): void
  ping(): void
  /** The stream incarnation (`run_id`) this attachment is bound to, once its snapshot arrived. */
  incarnation(): string | null
  /**
   * The offset the next live output frame must start at: the latest
   * snapshot's `through_offset` plus the live bytes after it. `null` before
   * the first snapshot.
   */
  offset(): number | null
  /** How many mid-stream `resync: true` snapshots this attachment received. */
  resyncs(): number
  /** Releases viewport ownership and closes the attachment without stopping the terminal. */
  detach(): void
  dispose(): void
}

export interface TerminalConnectionOptions {
  /** Refuse to attach unless the terminal is still this incarnation. */
  runId?: string
  /**
   * How snapshots restore the screen. `xterm-replay-v1` (the default) replays recorded output;
   * `ghostty` sends the runtime's own Ghostty terminal state as base64, which a viewer built from
   * the same Ghostty decodes exactly.
   */
  snapshotFormat?: 'xterm-replay-v1' | 'ghostty'
}

/**
 * The live-output offset a snapshot resumes at: an xterm-replay-v1 snapshot's `through_offset`, or
 * the byte count any other snapshot was taken at.
 */
function snapshotOffset(frame: TerminalSnapshotFrame): number {
  const recovery = frame.terminal_recovery
  const through = recovery && 'through_offset' in recovery ? recovery.through_offset : undefined
  return typeof through === 'number' ? through : frame.metrics.terminal_bytes
}

/**
 * Decides whether a frame belongs to the incarnation an attachment is bound to.
 * Frames without a `run_id` come from hosts that predate fencing and are kept.
 */
function sameIncarnation(bound: string | null, frame: TerminalFrame): boolean {
  const runId = 'run_id' in frame ? frame.run_id : undefined
  return bound === null || runId === undefined || runId === null || runId === bound
}

export function openTerminalConnection(
  socketPath: string,
  workspaceId: string,
  terminalId: string,
  onFrame: (frame: TerminalFrame) => void,
  onClose: (reason: string) => void,
  options: TerminalConnectionOptions = {},
): TerminalConnection {
  const socket = createConnection({ path: socketPath })
  let buffered = Buffer.alloc(0)
  let closed = false
  // Every request after the snapshot names the incarnation it was meant for,
  // so a restarted terminal refuses input and resize from this attachment.
  let incarnation: string | null = null
  // A viewer that falls a whole budget behind is not closed: the runtime
  // skips the output it could not queue and sends a fresh snapshot marked
  // `resync: true`; live output continues from that snapshot's offset. The
  // offset is tracked here so a gap is never passed on as if contiguous.
  let expected: number | null = null
  let resyncs = 0

  const line = (value: Record<string, unknown>): string => {
    const runId = incarnation ?? options.runId
    return `${JSON.stringify({
      ...value,
      workspace_id: workspaceId,
      terminal_id: terminalId,
      ...(runId === undefined ? {} : { run_id: runId }),
    })}\n`
  }
  const send = (value: Record<string, unknown>): void => {
    if (closed) return
    socket.write(line(value))
  }
  const finish = (reason: string): void => {
    if (closed) return
    closed = true
    socket.destroy()
    onClose(reason)
  }
  socket.on('connect', () =>
    send(
      options.snapshotFormat === 'ghostty'
        ? { op: 'subscribe', snapshot_format: 'binary' }
        : { op: 'subscribe', snapshot_format: 'xterm-replay-v1' },
    ),
  )
  socket.on('data', (chunk: Buffer) => {
    if (closed) return
    buffered = Buffer.concat([buffered, chunk])
    if (buffered.length > MAX_FRAME_BYTES) return finish('Terminal frame exceeded 32 MiB.')
    for (;;) {
      const end = buffered.indexOf(10)
      if (end < 0) return
      const line = buffered.subarray(0, end)
      buffered = buffered.subarray(end + 1)
      let frame: TerminalFrame
      try {
        frame = decodeTerminalFrame(JSON.parse(line.toString('utf8')))
      } catch (error) {
        if (error instanceof ContractError)
          return finish(`Terminal sent a frame that fails its contract: ${error.message}`)
        return finish('Terminal sent invalid JSON.')
      }
      if (frame.type === 'snapshot' && incarnation === null && typeof frame.run_id === 'string') {
        incarnation = frame.run_id
      } else if (!sameIncarnation(incarnation, frame)) {
        onFrame({
          type: 'error',
          code: 'stale_incarnation',
          message: 'Terminal changed incarnation; reattach to continue.',
        })
        return finish('Terminal changed incarnation.')
      }
      if (frame.type === 'snapshot') {
        if (frame.resync === true) resyncs += 1
        expected = snapshotOffset(frame)
      } else if (frame.type === 'terminal' && expected !== null) {
        const length = frame.bytes.length
        if (frame.offset !== expected) {
          onFrame({ type: 'error', code: 'output_gap', message: 'Terminal output has a gap; reattach to restore it.' })
          return finish('Terminal output has a gap.')
        }
        expected += length
      }
      onFrame(frame)
    }
  })
  socket.on('error', (error: Error) => finish(error.message))
  socket.on('close', () => finish('Terminal connection closed.'))

  return {
    input: (data) => send({ op: 'input', data }),
    binary: (bytes) => send({ op: 'input', bytes }),
    resize: (cols, rows, widthPx, heightPx, claim = false) =>
      send({ op: 'resize', cols, rows, width_px: widthPx, height_px: heightPx, claim }),
    ping: () => send({ op: 'ping' }),
    incarnation: () => incarnation,
    offset: () => expected,
    resyncs: () => resyncs,
    detach: () => {
      if (closed) return
      closed = true
      // end() flushes the detach request before closing the socket.
      socket.end(line({ op: 'detach' }))
    },
    dispose: () => {
      // After detach() the socket is already closing with its request flushed.
      if (closed) return
      closed = true
      socket.destroy()
    },
  }
}
