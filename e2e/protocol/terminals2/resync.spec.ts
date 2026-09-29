// The callers of a terminal stream under a flood that resynchronizes them.
// The runtime does not close a viewer that falls a whole budget behind: it
// skips the output that viewer could not queue and sends a fresh snapshot
// marked `resync: true`, and live output continues from that snapshot's
// offset. Each caller must reset and restore from that snapshot:
// - the SDK tracks the offset across it and refuses a real gap;
// - the desktop adapter's TerminalFeed restores the window's Ghostty from it;
// - `ade terminal attach` resets the TTY and replays it.
import { createServer } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { expect, primaryShell, type ScratchProfile, test } from '../fixtures'
import { binaries } from '../fixtures/environment'
import type { ProcessLedger } from '../fixtures/processes'
import { attachThroughTty, clientSdk, terminalMetrics, TerminalStream, type TerminalFrame } from '../fixtures/terminals'
import { restoredScreen, terminalSource, type ScreenState } from './viewer'

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
 * A desktop-shaped viewer (SDK, TerminalFeed, Ghostty core) on a worker thread that
 * reads slowly until released. See `viewer-worker.mjs`.
 */
async function slowViewer(profile: ScratchProfile, workspaceId: string, terminalId: string, bytesPerMs: number) {
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
  await Promise.race([new Promise((resolveStart) => worker.once('message', resolveStart)), failure])
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

async function openTerminal(profile: ScratchProfile) {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const shellId = await primaryShell(profile, workspace.id)
  const target = [workspace.id, shellId] as const
  const stream = TerminalStream.open(profile, ...target)
  const runId = (await stream.snapshot()).run_id as string
  const shellPid = (await terminalMetrics(profile, ...target))!.shell_pid
  return { target, runId, shellPid, stream }
}

/** A subscribe asking for the runtime's Ghostty state, as the desktop adapter does. */
const ghosttySubscribe = { op: 'subscribe', snapshot_format: 'binary', snapshot_encoding: 'base64' }

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

test('the SDK and the desktop adapter restore exactly from a resync snapshot mid-stream', async ({ profile }) => {
  test.setTimeout(180_000)
  const { target, runId, shellPid, stream } = await openTerminal(profile)
  const viewer = await slowViewer(profile, ...target, 200)
  await expect.poll(async () => (await viewer.report()).feed.ready, { message: 'the viewer to restore' }).toBe(true)

  // About 2.8 MB of distinct lines, but about 8 MiB of frames: twice the
  // viewer budget.
  startFlood(stream, runId, 'seq 1 360000; echo "flo""od-end"')
  await expect
    .poll(async () => (await terminalMetrics(profile, ...target))!.viewer_resyncs as number, {
      message: 'the slow viewer to be resynchronized',
      timeout: 120_000,
    })
    .toBeGreaterThanOrEqual(1)
  viewer.release()

  // Once output is quiet, the viewer and a new attachment agree on every
  // byte and on the screen: same history, same viewport, cursor and modes.
  let settled: { report: ViewerReport; fresh: ScreenState; total: number } | undefined
  await expect
    .poll(
      async () => {
        const total = (await terminalMetrics(profile, ...target))!.terminal_bytes as number
        const report = await viewer.report()
        const fresh = TerminalStream.open(profile, ...target, ghosttySubscribe)
        const snapshot = await fresh.snapshot()
        fresh.close()
        const taken = (snapshot.metrics as { terminal_bytes: number }).terminal_bytes
        if (report.sdk.offset !== total || taken !== total) return false
        settled = { report, fresh: await restoredScreen(snapshot), total }
        return report.screen.lines.some((line) => line === 'flood-end')
      },
      { message: 'the viewer to catch up with quiet output', timeout: 90_000 },
    )
    .toBe(true)

  const { report, fresh, total } = settled!
  expect(total).toBeGreaterThan(2_500_000)
  expect(report.sdk.resyncs).toBeGreaterThanOrEqual(1)
  expect(report.resyncs).toBe(report.sdk.resyncs)
  expect(report.snapshots).toBe(report.sdk.resyncs + 1)
  expect(report).toMatchObject({
    errors: [],
    closed: null,
    statuses: [],
    sdk: { incarnation: runId },
    feed: { failed: false, ready: true },
  })
  expect(report.screen).toEqual(fresh)

  // The viewer is still live, and the shell is the same one.
  await typeLine(profile, target, 'echo "af""ter-resync"')
  await expect
    .poll(async () => (await viewer.report()).screen.lines.includes('after-resync'), {
      message: 'live output after the resync',
    })
    .toBe(true)
  expect(await terminalMetrics(profile, ...target)).toMatchObject({
    run_id: runId,
    shell_pid: shellPid,
    shell_running: true,
  })
  await viewer.close()
})

test('a resync after more output than xterm could replay still restores the whole screen', async ({ profile }) => {
  test.setTimeout(180_000)
  const { target, runId, shellPid, stream } = await openTerminal(profile)
  const viewer = await slowViewer(profile, ...target, 200)
  await expect.poll(async () => (await viewer.report()).feed.ready, { message: 'the viewer to restore' }).toBe(true)

  // 8 MiB: past the 4 MiB xterm replay bound. A Ghostty snapshot is the terminal's state, not its
  // output, so its size does not grow with the flood and the restore stays complete.
  const flood = 8 * 1024 * 1024
  startFlood(stream, runId, `head -c ${flood} /dev/zero | tr '\\0' s; echo; echo "flo""od-end"`)
  // About 200 KB/s: the viewer falls a budget behind within seconds and is
  // resynchronized once it has drained what was queued before that.
  await expect
    .poll(async () => (await terminalMetrics(profile, ...target))!.viewer_resyncs as number, {
      message: 'the slow viewer to be resynchronized',
      timeout: 120_000,
    })
    .toBeGreaterThanOrEqual(1)
  await expect
    .poll(async () => (await terminalMetrics(profile, ...target))!.terminal_bytes as number, {
      message: 'the flood to finish',
      timeout: 120_000,
    })
    .toBeGreaterThan(flood)
  viewer.release()
  await typeLine(profile, target, 'echo "af""ter-resync"')

  let report: ViewerReport | undefined
  await expect
    .poll(
      async () => {
        report = await viewer.report()
        const total = (await terminalMetrics(profile, ...target))!.terminal_bytes as number
        return report.sdk.offset === total && report.screen.lines.includes('after-resync')
      },
      { message: 'the viewer to catch up', timeout: 90_000 },
    )
    .toBe(true)
  expect(report!.sdk.resyncs).toBeGreaterThanOrEqual(1)
  expect(report!.resyncs).toBe(report!.sdk.resyncs)
  expect(report!).toMatchObject({ errors: [], closed: null, feed: { failed: false, ready: true } })
  expect(report!.statuses).toEqual([])
  expect(await terminalMetrics(profile, ...target)).toMatchObject({
    run_id: runId,
    shell_pid: shellPid,
    shell_running: true,
  })
  await viewer.close()
})

test('ade terminal attach resets and restores its TTY on a resync and stays attached', async ({ ade, profile }) => {
  test.setTimeout(240_000)
  const { target, runId, shellPid, stream } = await openTerminal(profile)
  const release = join(ade.root, 'tty-release')
  // The relay reads 16 KiB of TTY output every 50 ms. The CLI's TTY writes
  // block, so it reads about 1.3 MiB/s of frames, far below the flood.
  const attach = await attachThroughTty(profile, ade.ledger, ...target, {
    bytesPerTick: 16 * 1024,
    tickMs: 50,
    releaseFile: release,
  })
  await expect
    .poll(async () => (await terminalMetrics(profile, ...target))!.resize_owner, {
      message: 'the CLI to attach and claim the viewport',
    })
    .not.toBeNull()
  const before = attach.output().length

  const flood = 16 * 1024 * 1024
  startFlood(stream, runId, `head -c ${flood} /dev/zero | tr '\\0' s; echo; echo "flo""od-end"`)
  await expect
    .poll(async () => (await terminalMetrics(profile, ...target))!.viewer_resyncs as number, {
      message: 'the CLI to be resynchronized',
      timeout: 150_000,
    })
    .toBeGreaterThanOrEqual(1)
  await expect
    .poll(async () => (await terminalMetrics(profile, ...target))!.terminal_bytes as number, {
      message: 'the flood to finish',
      timeout: 150_000,
    })
    .toBeGreaterThan(flood)
  writeFileSync(release, '')

  await typeLine(profile, target, 'echo "af""ter-resync"')
  await expect
    .poll(() => attach.output().includes('after-resync'), {
      message: 'live output after the resync on the TTY',
      timeout: 90_000,
    })
    .toBe(true)
  const output = attach.output().slice(before)
  // Each resync reset the TTY (RIS) before restoring it; nothing reported a gap.
  expect(output).toContain('\x1bc')
  expect(output).not.toContain('byte gap')
  expect(output).not.toContain('"type":"error"')
  expect(attach.child.exitCode).toBeNull()

  // Ctrl-] still detaches cleanly, and the shell is the same one.
  attach.child.stdin!.write('\x1d')
  expect(await attach.exited).toBe(0)
  expect(await terminalMetrics(profile, ...target)).toMatchObject({
    run_id: runId,
    shell_pid: shellPid,
    shell_running: true,
  })
})

/** Bytes `seq 1 <lines>` writes through the PTY, which turns each LF into CRLF. */
function seqBytes(lines: number): number {
  let total = 0
  for (let digits = 1, low = 1; low <= lines; digits++, low *= 10) {
    total += (Math.min(lines, low * 10 - 1) - low + 1) * (digits + 2)
  }
  return total
}

/**
 * `ade terminal attach` under a throttled TTY during a flood of `lines`
 * distinct lines, until the CLI has been resynchronized. The TTY runs at full
 * speed from the moment the flood has finished (`flood`), or only once the
 * flood's last line has reached it after a reset (`replayed`). Returns the
 * attachment and the resync count before the flood.
 */
async function floodBehindTty(
  root: string,
  ledger: ProcessLedger,
  profile: ScratchProfile,
  lines: number,
  bytesPerTick: number,
  releaseAfter: 'flood' | 'replayed',
) {
  const { target, runId, shellPid, stream } = await openTerminal(profile)
  const release = join(root, 'tty-release')
  const attach = await attachThroughTty(profile, ledger, ...target, { bytesPerTick, tickMs: 50, releaseFile: release })
  await expect
    .poll(async () => (await terminalMetrics(profile, ...target))!.resize_owner, {
      message: 'the CLI to attach and claim the viewport',
    })
    .not.toBeNull()
  const before = attach.output().length
  const start = (await terminalMetrics(profile, ...target))!
  startFlood(stream, runId, `seq 1 ${lines}; echo "flo""od-end"`)
  await expect
    .poll(async () => (await terminalMetrics(profile, ...target))!.terminal_bytes as number, {
      message: 'the flood to finish',
      timeout: 120_000,
    })
    .toBeGreaterThanOrEqual((start.terminal_bytes as number) + seqBytes(lines) + 'flood-end\r\n'.length)
  if (releaseAfter === 'flood') writeFileSync(release, '')
  await expect
    .poll(async () => (await terminalMetrics(profile, ...target))!.viewer_resyncs as number, {
      message: 'the CLI to be resynchronized',
      timeout: 150_000,
    })
    .toBeGreaterThan(start.viewer_resyncs as number)
  if (releaseAfter === 'replayed') {
    await expect
      .poll(
        () => {
          const output = attach.output().slice(before)
          return attach.child.exitCode !== null || output.slice(output.lastIndexOf('\x1bc')).includes('flood-end')
        },
        { message: 'the replay to reach the slow TTY', timeout: 150_000 },
      )
      .toBe(true)
  }
  writeFileSync(release, '')
  return { target, runId, shellPid, attach, before, resyncsBefore: start.viewer_resyncs as number }
}

test('ade terminal attach replays the complete history after a resync within the replay bound', async ({
  ade,
  profile,
}) => {
  test.setTimeout(240_000)
  // About 2.3 MB of distinct lines: below the 4 MiB replay bound, so every
  // resync snapshot carries the complete history. The TTY first drains 4 KiB
  // every 50 ms, so the CLI reads frames far slower than the flood and falls
  // a whole budget behind. The TTY is released once the flood has finished,
  // while the runtime still drains what it queued before the lag, so the
  // resync snapshot's replay reaches a fast TTY.
  const lines = 300_000
  const { target, runId, shellPid, attach, before, resyncsBefore } = await floodBehindTty(
    ade.root,
    ade.ledger,
    profile,
    lines,
    4 * 1024,
    'flood',
  )

  await typeLine(profile, target, 'echo "af""ter-resync"')
  await expect
    .poll(() => attach.output().includes('after-resync'), {
      message: 'live output after the resync on the TTY',
      timeout: 90_000,
    })
    .toBe(true)
  const output = attach.output().slice(before)
  const resyncs = ((await terminalMetrics(profile, ...target))!.viewer_resyncs as number) - resyncsBefore
  expect(resyncs).toBeGreaterThanOrEqual(1)
  // Each resync reset the TTY (RIS) once and took the complete-history
  // branch: no replay-limit warning, no gap, no error.
  expect(output.split('\x1bc').length - 1).toBe(resyncs)
  expect(output).not.toContain('replay_limit_exceeded')
  expect(output).not.toContain('byte gap')
  expect(output).not.toContain('"type":"error"')
  // After the last reset, the TTY holds the replayed history followed by live
  // output: every line of the flood, once each and in order, from line 1.
  const restored = output.slice(output.lastIndexOf('\x1bc') + 2)
  const numbers = restored
    .split(/\r*\n/)
    .filter((line) => /^\d+$/.test(line))
    .map(Number)
  expect(numbers.length).toBe(lines)
  expect(numbers.every((value, index) => value === index + 1)).toBe(true)
  expect(restored).toMatch(/\nflood-end\r*\n/)
  expect(restored).toContain('after-resync')
  expect(attach.child.exitCode).toBeNull()

  // The runtime's own snapshot agrees that the history is still complete.
  const fresh = TerminalStream.open(profile, ...target)
  const recovery = (await fresh.snapshot()).terminal_recovery as { complete: boolean }
  fresh.close()
  expect(recovery.complete).toBe(true)

  attach.child.stdin!.write('\x1d')
  expect(await attach.exited).toBe(0)
  expect(await terminalMetrics(profile, ...target)).toMatchObject({
    run_id: runId,
    shell_pid: shellPid,
    shell_running: true,
  })
})

// Gap: the runtime's terminal writer closes an attachment whose socket
// accepts nothing for 2 s. `ade terminal attach` writes a resync replay to its
// TTY synchronously, so a complete-history replay that takes longer than 2 s
// to reach a slow TTY (2.3 MB at about 320 KB/s here) stops it reading its
// socket, and the runtime closes it: the CLI exits 3 with "Terminal
// connection closed." A slow viewer should be resynchronized again, not closed.
test.fixme('ade terminal attach survives a complete-history replay slower than the write timeout', async ({
  ade,
  profile,
}) => {
  test.setTimeout(240_000)
  const { target, attach } = await floodBehindTty(ade.root, ade.ledger, profile, 300_000, 16 * 1024, 'replayed')
  await typeLine(profile, target, 'echo "af""ter-resync"')
  await expect
    .poll(() => attach.output().includes('after-resync'), {
      message: 'live output after the resync on the TTY',
      timeout: 90_000,
    })
    .toBe(true)
  expect(attach.output()).not.toContain('Terminal connection closed.')
  expect(attach.child.exitCode).toBeNull()
  attach.child.stdin!.write('\x1d')
  expect(await attach.exited).toBe(0)
})

test('the SDK passes a resync snapshot on and refuses a real output gap', async ({ ade }) => {
  // A scripted terminal peer: snapshot, live output, a resync snapshot that
  // skips ahead, live output from its offset, then a frame after a gap.
  const socketPath = join(ade.root, 'peer.sock')
  const events = [{ type: 'output', offset: 0, bytes_base64: Buffer.from('abc').toString('base64') }]
  // Every frame is complete by the terminal stream contract, which the SDK checks.
  const metrics = (terminalBytes: number) => ({
    pid: 1,
    uptime_ms: 0,
    clients: 1,
    workspace_id: 'ws',
    terminal_id: 'term',
    run_id: 'run-1',
    transfer_id: null,
    terminal_bytes: terminalBytes,
    events: 0,
    reply_dropped_bytes: 0,
    viewer_resyncs: 0,
    viewer_queue_limit_bytes: 4 * 1024 * 1024,
    pixel_size: [0, 0],
    scrollback_bytes: terminalBytes,
    resize_owner: null,
    shell_pid: 2,
    shell_running: true,
    durable_log_error: null,
    descendants: [],
  })
  const snapshot = (throughOffset: number, extra: Record<string, unknown>) => ({
    type: 'snapshot',
    run_id: 'run-1',
    attachment: 1,
    conversation: '',
    streaming: false,
    metrics: metrics(throughOffset),
    terminal_snapshot_format: 'xterm-replay-v1',
    ...extra,
    terminal_recovery: {
      complete: throughOffset === 3,
      reason: throughOffset === 3 ? null : 'replay_limit_exceeded',
      through_offset: throughOffset,
      initial_cols: 80,
      initial_rows: 24,
      limit_bytes: 4 * 1024 * 1024,
      events: throughOffset === 3 ? events : [],
    },
  })
  const output = (offset: number, bytes: number[]) => ({
    type: 'terminal',
    run_id: 'run-1',
    offset,
    bytes,
    data: Buffer.from(bytes).toString('latin1'),
  })
  const frames = [
    snapshot(3, {}),
    output(3, [100]),
    snapshot(10, { resync: true }),
    output(10, [101, 102]),
    output(20, [103]),
  ]
  const server = createServer((connection) => {
    connection.once('data', () => connection.write(frames.map((frame) => `${JSON.stringify(frame)}\n`).join('')))
  })
  await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen))
  const { openTerminalConnection } = await clientSdk()
  const received: TerminalFrame[] = []
  let resolveClose!: (reason: string) => void
  const closed = new Promise<string>((resolve) => {
    resolveClose = resolve
  })
  const connection = openTerminalConnection(socketPath, 'ws', 'term', (frame) => received.push(frame), resolveClose)
  expect(await closed).toBe('Terminal output has a gap.')
  expect(connection.resyncs()).toBe(1)
  expect(connection.offset()).toBe(12)
  expect(received.map((frame) => [frame.type, frame.offset ?? frame.code ?? frame.resync ?? null])).toEqual([
    ['snapshot', null],
    ['terminal', 3],
    ['snapshot', true],
    ['terminal', 10],
    ['error', 'output_gap'],
  ])
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
})
