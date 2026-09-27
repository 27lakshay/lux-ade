// Test support: snapshots and frames made the way the daemon's runtime makes them.
import type { TerminalOutputFrame, TerminalSnapshotFrame } from '@ade/contracts'
import { GHOSTTY_SNAPSHOT_FORMAT } from '../feed'
import type { GhosttyTerminalCore } from './core'
import { loadGhosttyRuntime } from './runtime'

/**
 * A complete `snapshot` frame carrying `core`'s state as base64, taken after `offset` bytes of
 * output, as an attachment that asked for Ghostty snapshots receives it.
 */
export async function snapshotFrame(
  core: GhosttyTerminalCore,
  offset: number,
  extra: Partial<TerminalSnapshotFrame> = {},
): Promise<TerminalSnapshotFrame> {
  const state = await encodeSnapshot(core)
  return {
    type: 'snapshot',
    run_id: 'run-1',
    attachment: 1,
    conversation: '',
    streaming: false,
    response_owner: 'daemon-v1',
    terminal_snapshot_format: GHOSTTY_SNAPSHOT_FORMAT,
    terminal_snapshot_base64: btoa(String.fromCharCode(...state)),
    terminal_recovery: {
      scope: 'both-screens-history-continuation',
      history_limit_bytes: 4 * 1024 * 1024,
      continuation_limit_bytes: 1024 * 1024,
    },
    metrics: {
      pid: 1,
      uptime_ms: 0,
      clients: 1,
      workspace_id: 'ws',
      terminal_id: 'term',
      run_id: 'run-1',
      transfer_id: null,
      terminal_bytes: offset,
      events: 0,
      reply_dropped_bytes: 0,
      viewer_resyncs: 0,
      viewer_queue_limit_bytes: 4 * 1024 * 1024,
      pixel_size: [0, 0],
      scrollback_bytes: offset,
      resize_owner: null,
      shell_pid: 2,
      shell_running: true,
      durable_log_error: null,
      descendants: [],
    },
    ...extra,
  }
}

/** A `terminal` output frame carrying `text` from `offset`. */
export function outputFrame(text: string, offset: number): TerminalOutputFrame {
  const bytes = new TextEncoder().encode(text)
  return { type: 'terminal', data: text, bytes: Array.from(bytes), offset, run_id: 'run-1' }
}

/** Encodes a terminal as the daemon's runtime does (`ghostty_snapshot_encode_alloc`). */
export async function encodeSnapshot(core: GhosttyTerminalCore): Promise<Uint8Array> {
  const runtime = await loadGhosttyRuntime()
  const terminal = (core as unknown as { terminal: number }).terminal
  const out = runtime.alloc(8)
  try {
    if (runtime.call('ghostty_snapshot_encode_alloc', terminal, 0, out, out + 4) !== 0) {
      throw new Error('Ghostty could not encode the snapshot')
    }
    const pointer = runtime.view(out, 8).getUint32(0, true)
    const length = runtime.view(out, 8).getUint32(4, true)
    const bytes = runtime.bytes(pointer, length).slice()
    runtime.call('ghostty_free', 0, pointer, length)
    return bytes
  } finally {
    runtime.free(out, 8)
  }
}
