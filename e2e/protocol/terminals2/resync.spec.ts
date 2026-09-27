// The callers of a terminal stream under a flood that resynchronizes them.
// The runtime does not close a viewer that falls a whole budget behind: it
// skips the output that viewer could not queue and sends a fresh snapshot
// marked `resync: true`, and live output continues from that snapshot's
// offset. Each caller must reset and restore from that snapshot:
// - the SDK tracks the offset across it and refuses a real gap;
// - the desktop adapter's TerminalFeed resets xterm and replays it;
// - `ade terminal attach` resets the TTY and replays it.
import { createServer } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { expect, test, type ScratchProfile } from '../fixtures'
import { binaries } from '../fixtures/environment'
import { attachThroughTty, clientSdk, terminalMetrics, TerminalStream, type TerminalFrame } from '../fixtures/terminals'
import { feedSource, restoredScreen, terminalPackage, type ScreenState } from './xterm'

interface ViewerReport {
  sdk: { offset: number | null; resyncs: number; incarnation: string | null }
  feed: { ready: boolean; failed: boolean }
  snapshots: number
  /** Snapshots marked `resync: true` that the feed was given. */
  resyncs: number
  errors: TerminalFrame[]
  statuses: string[]
  closed: string | null
  screen: ScreenState
}

/**
 * A desktop-shaped viewer (SDK, TerminalFeed, xterm) on a worker thread that
 * reads slowly until released. See `viewer-worker.mjs`.
 */
async function slowViewer(profile: ScratchProfile, workspaceId: string, terminalId: string, bytesPerMs: number) {
  const gateBuffer = new SharedArrayBuffer(4)
  const gate = new Int32Array(gateBuffer)
  const worker = new Worker(join(__dirname, 'viewer-worker.mjs'), { workerData: {
    clientPath: binaries.client, feedPath: feedSource, terminalPackage, socket: profile.socket,
    workspaceId, terminalId, gateBuffer, bytesPerMs } })
  const failure = new Promise<never>((_, reject) => worker.once('error', reject))
  await Promise.race([new Promise((resolveStart) => worker.once('message', resolveStart)), failure])
  return {
    report: () => Promise.race([failure, new Promise<ViewerReport>((resolveReport) => {
      worker.once('message', resolveReport)
      worker.postMessage({ type: 'report' })
    })]),
    /** Let the viewer read at full speed. */
    release: () => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0) },
    close: async () => { worker.postMessage({ type: 'close' }); await worker.terminate() },
  }
}

async function openTerminal(profile: ScratchProfile) {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const target = [workspace.id, workspace.terminal_id] as const
  const stream = TerminalStream.open(profile, ...target)
  const runId = (await stream.snapshot()).run_id as string
  const shellPid = (await terminalMetrics(profile, ...target))!.shell_pid
  return { target, runId, shellPid, stream }
}

/** Starts a flood and closes the stream that typed it, so every resync counted belongs to the viewer under test. */
function startFlood(stream: TerminalStream, runId: string, command: string): void {
  stream.send({ op: 'input', run_id: runId, data: `${command}\n` })
  stream.close()
}

/** Types `text` as a new command line through the CLI. */
async function typeLine(profile: ScratchProfile, target: readonly [string, string], text: string): Promise<void> {
  const sent = await profile.cli('terminal', 'send', ...target, text)
  expect(sent.code, sent.stderr).toBe(0)
}

test('the SDK and the xterm adapter restore exactly from a resync snapshot mid-stream', async ({ profile }) => {
  test.setTimeout(180_000)
  const { target, runId, shellPid, stream } = await openTerminal(profile)
  const viewer = await slowViewer(profile, ...target, 200)
  await expect.poll(async () => (await viewer.report()).feed.ready, { message: 'the viewer to restore' }).toBe(true)

  // About 2.8 MB of distinct lines: below the 4 MiB replay bound, so a resync
  // snapshot replays the whole history, but about 8 MiB of frames, twice the
  // viewer budget.
  startFlood(stream, runId, 'seq 1 360000; echo "flo""od-end"')
  await expect.poll(async () => (await terminalMetrics(profile, ...target))!.viewer_resyncs as number,
    { message: 'the slow viewer to be resynchronized', timeout: 120_000 }).toBeGreaterThanOrEqual(1)
  viewer.release()

  // Once output is quiet, the viewer and a new attachment agree on every
  // byte and on the screen: same history, same viewport, cursor and modes.
  let settled: { report: ViewerReport; fresh: ScreenState; total: number } | undefined
  await expect.poll(async () => {
    const total = (await terminalMetrics(profile, ...target))!.terminal_bytes as number
    const report = await viewer.report()
    const fresh = TerminalStream.open(profile, ...target)
    const snapshot = await fresh.snapshot()
    fresh.close()
    const recovery = snapshot.terminal_recovery as { through_offset: number; complete: boolean }
    if (report.sdk.offset !== total || recovery.through_offset !== total) return false
    expect(recovery.complete).toBe(true)
    settled = { report, fresh: await restoredScreen(snapshot), total }
    return report.screen.lines.some((line) => line === 'flood-end')
  }, { message: 'the viewer to catch up with quiet output', timeout: 90_000 }).toBe(true)

  const { report, fresh, total } = settled!
  expect(total).toBeGreaterThan(2_500_000)
  expect(report.sdk.resyncs).toBeGreaterThanOrEqual(1)
  expect(report.resyncs).toBe(report.sdk.resyncs)
  expect(report.snapshots).toBe(report.sdk.resyncs + 1)
  expect(report).toMatchObject({ errors: [], closed: null, statuses: [], sdk: { incarnation: runId },
    feed: { failed: false, ready: true } })
  expect(report.screen).toEqual(fresh)

  // The viewer is still live, and the shell is the same one.
  await typeLine(profile, target, 'echo "af""ter-resync"')
  await expect.poll(async () => (await viewer.report()).screen.lines.includes('after-resync'),
    { message: 'live output after the resync' }).toBe(true)
  expect(await terminalMetrics(profile, ...target)).toMatchObject({ run_id: runId, shell_pid: shellPid, shell_running: true })
  await viewer.close()
})

test('a resync past the replay bound resets the xterm view and says the history is lost', async ({ profile }) => {
  test.setTimeout(180_000)
  const { target, runId, shellPid, stream } = await openTerminal(profile)
  const viewer = await slowViewer(profile, ...target, 200)
  await expect.poll(async () => (await viewer.report()).feed.ready, { message: 'the viewer to restore' }).toBe(true)

  // 8 MiB: past the 4 MiB replay bound, so later resync snapshots carry no history.
  const flood = 8 * 1024 * 1024
  startFlood(stream, runId, `head -c ${flood} /dev/zero | tr '\\0' s; echo; echo "flo""od-end"`)
  // About 200 KB/s: the viewer falls a budget behind within seconds and is
  // resynchronized once it has drained what was queued before that.
  await expect.poll(async () => (await terminalMetrics(profile, ...target))!.viewer_resyncs as number,
    { message: 'the slow viewer to be resynchronized', timeout: 120_000 }).toBeGreaterThanOrEqual(1)
  await expect.poll(async () => (await terminalMetrics(profile, ...target))!.terminal_bytes as number,
    { message: 'the flood to finish', timeout: 120_000 }).toBeGreaterThan(flood)
  viewer.release()
  await typeLine(profile, target, 'echo "af""ter-resync"')

  let report: ViewerReport | undefined
  await expect.poll(async () => {
    report = await viewer.report()
    const total = (await terminalMetrics(profile, ...target))!.terminal_bytes as number
    return report.sdk.offset === total && report.screen.lines.includes('after-resync')
  }, { message: 'the viewer to catch up', timeout: 90_000 }).toBe(true)
  expect(report!.sdk.resyncs).toBeGreaterThanOrEqual(1)
  expect(report!.resyncs).toBe(report!.sdk.resyncs)
  expect(report!).toMatchObject({ errors: [], closed: null, feed: { failed: false, ready: true } })
  expect(report!.statuses).toContain('Terminal fell behind and its history is too large to restore; live output continues.')
  expect(report!.statuses.filter((status) => /incomplete\. Reconnect|replay queue/.test(status))).toEqual([])
  expect(await terminalMetrics(profile, ...target)).toMatchObject({ run_id: runId, shell_pid: shellPid, shell_running: true })
  await viewer.close()
})

test('ade terminal attach resets and restores its TTY on a resync and stays attached', async ({ ade, profile }) => {
  test.setTimeout(240_000)
  const { target, runId, shellPid, stream } = await openTerminal(profile)
  const release = join(ade.root, 'tty-release')
  // The relay reads 16 KiB of TTY output every 50 ms. The CLI's TTY writes
  // block, so it reads about 1.3 MiB/s of frames, far below the flood.
  const attach = await attachThroughTty(profile, ade.ledger, ...target, { bytesPerTick: 16 * 1024, tickMs: 50,
    releaseFile: release })
  await expect.poll(async () => (await terminalMetrics(profile, ...target))!.resize_owner,
    { message: 'the CLI to attach and claim the viewport' }).not.toBeNull()
  const before = attach.output().length

  const flood = 16 * 1024 * 1024
  startFlood(stream, runId, `head -c ${flood} /dev/zero | tr '\\0' s; echo; echo "flo""od-end"`)
  await expect.poll(async () => (await terminalMetrics(profile, ...target))!.viewer_resyncs as number,
    { message: 'the CLI to be resynchronized', timeout: 150_000 }).toBeGreaterThanOrEqual(1)
  await expect.poll(async () => (await terminalMetrics(profile, ...target))!.terminal_bytes as number,
    { message: 'the flood to finish', timeout: 150_000 }).toBeGreaterThan(flood)
  writeFileSync(release, '')

  await typeLine(profile, target, 'echo "af""ter-resync"')
  await expect.poll(() => attach.output().includes('after-resync'),
    { message: 'live output after the resync on the TTY', timeout: 90_000 }).toBe(true)
  const output = attach.output().slice(before)
  // Each resync reset the TTY (RIS) before restoring it; nothing reported a gap.
  expect(output).toContain('\x1bc')
  expect(output).not.toContain('byte gap')
  expect(output).not.toContain('"type":"error"')
  expect(attach.child.exitCode).toBeNull()

  // Ctrl-] still detaches cleanly, and the shell is the same one.
  attach.child.stdin!.write('\x1d')
  expect(await attach.exited).toBe(0)
  expect(await terminalMetrics(profile, ...target)).toMatchObject({ run_id: runId, shell_pid: shellPid, shell_running: true })
})

test('the SDK passes a resync snapshot on and refuses a real output gap', async ({ ade }) => {
  // A scripted terminal peer: snapshot, live output, a resync snapshot that
  // skips ahead, live output from its offset, then a frame after a gap.
  const socketPath = join(ade.root, 'peer.sock')
  const events = [{ type: 'output', offset: 0, bytes_base64: Buffer.from('abc').toString('base64') }]
  const snapshot = (throughOffset: number, extra: Record<string, unknown>) => ({ type: 'snapshot', run_id: 'run-1',
    terminal_snapshot_format: 'xterm-replay-v1', ...extra,
    terminal_recovery: { complete: throughOffset === 3, through_offset: throughOffset, initial_cols: 80,
      initial_rows: 24, events: throughOffset === 3 ? events : [] } })
  const frames = [
    snapshot(3, {}),
    { type: 'terminal', run_id: 'run-1', offset: 3, bytes: [100] },
    snapshot(10, { resync: true }),
    { type: 'terminal', run_id: 'run-1', offset: 10, bytes: [101, 102] },
    { type: 'terminal', run_id: 'run-1', offset: 20, bytes: [103] },
  ]
  const server = createServer((connection) => {
    connection.once('data', () => connection.write(frames.map((frame) => `${JSON.stringify(frame)}\n`).join('')))
  })
  await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen))
  const { openTerminalConnection } = await clientSdk()
  const received: TerminalFrame[] = []
  let resolveClose!: (reason: string) => void
  const closed = new Promise<string>((resolve) => { resolveClose = resolve })
  const connection = openTerminalConnection(socketPath, 'ws', 'term', (frame) => received.push(frame), resolveClose)
  expect(await closed).toBe('Terminal output has a gap.')
  expect(connection.resyncs()).toBe(1)
  expect(connection.offset()).toBe(12)
  expect(received.map((frame) => [frame.type, frame.offset ?? frame.code ?? frame.resync ?? null])).toEqual([
    ['snapshot', null], ['terminal', 3], ['snapshot', true], ['terminal', 10], ['error', 'output_gap'],
  ])
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
})
