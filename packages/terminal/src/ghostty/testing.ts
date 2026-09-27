// Test support: snapshots made the way the daemon's runtime makes them.
import type { GhosttyTerminalCore } from './core'
import { loadGhosttyRuntime } from './runtime'

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
