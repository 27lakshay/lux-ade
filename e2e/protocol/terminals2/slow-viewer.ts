import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { ScratchProfile } from '../fixtures'
import { binaries } from '../fixtures/environment'
import type { TerminalFrame } from '../fixtures/terminals'
import { terminalSource, type ScreenState } from './viewer'

export interface ViewerReport {
  sdk: { offset: number | null; resyncs: number; incarnation: string | null }
  feed: { ready: boolean; failed: boolean }
  snapshots: number
  /** Snapshots marked `resync: true` that the feed was given. */
  resyncs: number
  errors: TerminalFrame[]
  statuses: string[]
  closed: string | null
  screen: ScreenState
  appearance: {
    revision: number | null
    foreground: { r: number; g: number; b: number }
    background: { r: number; g: number; b: number }
  }
}

/**
 * A desktop-shaped viewer (SDK, TerminalFeed, Ghostty core) on a worker thread that
 * reads slowly until released. See `viewer-worker.mjs`.
 */
export async function slowViewer(profile: ScratchProfile, workspaceId: string, terminalId: string, bytesPerMs: number) {
  const gateBuffer = new SharedArrayBuffer(4)
  const gate = new Int32Array(gateBuffer)
  const worker = new Worker(join(__dirname, 'viewer-worker.mjs'), {
    workerData: {
      clientPath: binaries.client,
      terminalSource,
      socket: profile.socket,
      workspaceId,
      terminalId,
      gateBuffer,
      bytesPerMs,
    },
  })
  const failure = new Promise<never>((_, reject) => worker.once('error', reject))
  try {
    await Promise.race([new Promise((resolveStart) => worker.once('message', resolveStart)), failure])
  } catch (error) {
    await worker.terminate()
    throw error
  }
  return {
    report: () =>
      Promise.race([
        failure,
        new Promise<ViewerReport>((resolveReport) => {
          worker.once('message', resolveReport)
          worker.postMessage({ type: 'report' })
        }),
      ]),
    /** Let the viewer read at full speed. */
    release: () => {
      Atomics.store(gate, 0, 1)
      Atomics.notify(gate, 0)
    },
    close: async () => {
      worker.postMessage({ type: 'close' })
      await worker.terminate()
    },
  }
}
