// 07-S11 and R008 under a terminal flood. An attachment opened while the
// shell floods its PTY gets its snapshot and then live output in order, even
// when the snapshot is large. A viewer that reads slower than the flood is
// not closed: once it falls a whole budget behind, the runtime stops queueing
// for it and, when its queue drains, sends a fresh snapshot and resumes live
// output after it. Memory stays bounded while it lags (architecture section 6).
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { expect, test, type ScratchProfile } from '../fixtures'
import { terminalMetrics, TerminalStream, type TerminalFrame } from '../fixtures/terminals'

/** The live-frame offset a snapshot is taken at. */
function watermark(snapshot: TerminalFrame): number {
  return (snapshot.metrics as { terminal_bytes: number }).terminal_bytes
}

/**
 * Check every live output frame follows the snapshot before it with no gap
 * and no overlap. Returns the offset the frames reached and the counts.
 * It checks in plain code and asserts once: an `expect` per frame costs
 * seconds over a flood, and a test that stalls its own event loop that long
 * becomes a viewer that stops reading.
 */
function expectOrdered(frames: TerminalFrame[]): { reached: number; snapshots: number; live: number } {
  let expected: number | null = null
  let snapshots = 0
  let live = 0
  let violation: string | null = null
  for (const frame of frames) {
    if (frame.type === 'snapshot') {
      const at = watermark(frame)
      if (expected !== null && at < expected) violation ??= `snapshot ${snapshots} went back from ${expected} to ${at}`
      expected = at
      snapshots += 1
    } else if (frame.type === 'terminal') {
      if (expected === null) violation ??= 'live output arrived before any snapshot'
      else if (frame.offset !== expected)
        violation ??= `live frame ${live} after snapshot ${snapshots} is at ${frame.offset}, not ${expected}`
      expected = (expected ?? (frame.offset as number)) + (frame.bytes as number[]).length
      live += 1
    }
  }
  expect(violation).toBeNull()
  return { reached: expected ?? 0, snapshots, live }
}

/**
 * Wait for the flood's closing marker in the latest output. Only the last
 * frames are read: rebuilding the whole flood's text on every frame would
 * make the test itself the slow viewer.
 */
async function floodEnded(frames: TerminalFrame[], timeout: number): Promise<void> {
  await expect
    .poll(
      () =>
        frames
          .filter((frame) => frame.type === 'terminal')
          .slice(-4)
          .map((frame) => Buffer.from(frame.bytes as number[]).toString('utf8'))
          .join('')
          .includes('flood-end'),
      { message: 'the flood to end', timeout },
    )
    .toBe(true)
}

/** Resident memory of a process, in bytes, from ps. */
function residentBytes(pid: number): number {
  return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) * 1024
}

/**
 * A terminal attachment that reads at a fixed rate, slower than the flood:
 * the socket stays paused except for `bytesPerTick` every tick.
 */
class SlowViewer {
  readonly frames: TerminalFrame[] = []
  private buffered = Buffer.alloc(0)
  private allowance = 0
  private closedReason: string | null = null
  private readonly timer: NodeJS.Timeout
  private readonly socket: Socket

  constructor(profile: ScratchProfile, workspaceId: string, terminalId: string, bytesPerTick: number, tickMs: number) {
    this.socket = createConnection(profile.socket)
    this.socket.on('data', (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk])
      for (let end = this.buffered.indexOf(10); end >= 0; end = this.buffered.indexOf(10)) {
        const line = this.buffered.subarray(0, end).toString('utf8')
        this.buffered = this.buffered.subarray(end + 1)
        try {
          this.frames.push(JSON.parse(line) as TerminalFrame)
        } catch {
          this.frames.push({ type: 'invalid', line })
        }
      }
      this.allowance -= chunk.length
      if (this.allowance <= 0) this.socket.pause()
    })
    this.socket.on('error', (error) => {
      this.closedReason ??= error.message
    })
    this.socket.on('close', () => {
      this.closedReason ??= 'closed'
    })
    this.socket.write(
      `${JSON.stringify({
        workspace_id: workspaceId,
        terminal_id: terminalId,
        op: 'subscribe',
        snapshot_format: 'xterm-replay-v1',
      })}\n`,
    )
    this.socket.pause()
    // A rate limiter, not a wait: every tick lets a little more through.
    this.timer = setInterval(() => {
      this.allowance = Math.min(this.allowance + bytesPerTick, bytesPerTick)
      if (this.allowance > 0) this.socket.resume()
    }, tickMs)
  }

  get closed(): string | null {
    return this.closedReason
  }

  /** Stop limiting: read at full speed from now on. */
  unthrottle(): void {
    clearInterval(this.timer)
    this.allowance = Number.POSITIVE_INFINITY
    this.socket.resume()
  }

  close(): void {
    clearInterval(this.timer)
    this.socket.destroy()
  }
}

test('attachments opened during a flood each get their snapshot, then live output in order', async ({ profile }) => {
  test.setTimeout(120_000)
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const target = [workspace.id, workspace.terminal_id] as const
  const driver = TerminalStream.open(profile, ...target)
  const runId = (await driver.snapshot()).run_id as string
  const stop = join(profile.root, 'flood-stop')
  driver.send({
    op: 'input',
    run_id: runId,
    data: `while [ ! -e '${stop}' ]; do head -c 262144 /dev/zero | tr '\\0' f; done; ` + 'echo; echo "flo""od-end"\n',
  })
  await expect
    .poll(async () => (await terminalMetrics(profile, ...target))!.terminal_bytes as number, {
      message: 'the flood to start',
    })
    .toBeGreaterThan(1024 * 1024)

  // Large replay snapshots (below the 4 MiB replay bound) and screen snapshots,
  // then small incomplete ones once the replay bound is passed.
  const formats: Array<Record<string, unknown>> = [
    { op: 'subscribe', snapshot_format: 'xterm-replay-v1' },
    { op: 'subscribe', snapshot_format: 'binary', snapshot_encoding: 'base64' },
  ]
  for (let round = 0; round < 8; round++) {
    const viewer = TerminalStream.open(profile, ...target, formats[round % formats.length])
    const snapshot = await viewer.snapshot()
    expect(snapshot).toMatchObject({ run_id: runId })
    await viewer.waitFor(
      'live output after the snapshot',
      () => viewer.frames.filter((frame) => frame.type === 'terminal').length >= 20,
      { timeout: 30_000 },
    )
    expect(viewer.closed).toBe(false)
    const ordered = expectOrdered(viewer.frames)
    expect(ordered.live).toBeGreaterThanOrEqual(20)
    viewer.close()
  }

  writeFileSync(stop, '')
  await floodEnded(driver.frames, 60_000)
  expect(expectOrdered(driver.frames).reached).toBe((await terminalMetrics(profile, ...target))!.terminal_bytes)
  driver.close()
})

test('a viewer slower than the flood is resynchronized from fresh snapshots, never closed, with bounded memory', async ({
  profile,
}) => {
  test.setTimeout(180_000)
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const target = [workspace.id, workspace.terminal_id] as const
  const driver = TerminalStream.open(profile, ...target)
  const runId = (await driver.snapshot()).run_id as string
  const before = (await terminalMetrics(profile, ...target))!
  const limit = before.viewer_queue_limit_bytes as number
  expect(limit).toBeGreaterThan(0)
  expect(before.viewer_resyncs).toBe(0)
  const runtimePid = profile.hello.runtime_pid
  const baseline = residentBytes(runtimePid)

  // About 16 MiB of output, several MiB of frames per second. The slow viewer
  // reads 64 KiB every 50 ms, about 1.3 MiB/s, far less than the flood.
  const slow = new SlowViewer(profile, ...target, 64 * 1024, 50)
  await expect
    .poll(() => slow.frames.some((frame) => frame.type === 'snapshot'), { message: 'the first snapshot' })
    .toBe(true)
  const flood = 16 * 1024 * 1024
  driver.send({
    op: 'input',
    run_id: runId,
    data: `head -c ${flood} /dev/zero | tr '\\0' s; echo; echo "flo""od-end"\n`,
  })

  // While the flood runs, the runtime's memory stays near its baseline: a
  // lagging viewer holds at most its budget, not the flood.
  let peak = baseline
  await expect
    .poll(
      async () => {
        peak = Math.max(peak, residentBytes(runtimePid))
        return (await terminalMetrics(profile, ...target))!.viewer_resyncs as number
      },
      { message: 'the slow viewer to be resynchronized', timeout: 90_000 },
    )
    .toBeGreaterThanOrEqual(1)
  await floodEnded(driver.frames, 150_000)
  peak = Math.max(peak, residentBytes(runtimePid))
  expect(slow.closed).toBeNull()
  // Unbounded queueing would hold the flood's frames, about 80 MiB of JSON.
  // The growth allowed covers the 4 MiB replay, the screen and the budgets.
  expect(peak - baseline, `runtime RSS grew from ${baseline} to ${peak}`).toBeLessThan(limit * 4 + 8 * 1024 * 1024)

  // The viewer that kept up saw every byte in order on one snapshot.
  const total = (await terminalMetrics(profile, ...target))!.terminal_bytes as number
  expect(total).toBeGreaterThan(flood)
  expect(expectOrdered(driver.frames)).toMatchObject({ reached: total, snapshots: 1 })

  // The slow viewer catches up once it reads freely: fresh snapshots marked
  // as resyncs, each followed by live output in order, and it reaches the end.
  slow.unthrottle()
  await expect
    .poll(() => ({ reached: expectOrdered(slow.frames).reached, closed: slow.closed }), {
      message: 'the slow viewer to catch up',
      timeout: 60_000,
    })
    .toEqual({ reached: total, closed: null })
  const resyncs = slow.frames.filter((frame) => frame.type === 'snapshot' && frame.resync === true)
  expect(resyncs.length).toBeGreaterThanOrEqual(1)
  for (const frame of resyncs) expect(frame).toMatchObject({ run_id: runId, attachment: slow.frames[0].attachment })
  expect(slow.frames.filter((frame) => frame.type === 'invalid' || frame.type === 'error')).toEqual([])

  // It is still live: new output reaches it directly.
  driver.send({ op: 'input', run_id: runId, data: 'echo "af""ter-resync"\n' })
  await expect
    .poll(
      () =>
        slow.frames.some(
          (frame) =>
            frame.type === 'terminal' &&
            Buffer.from(frame.bytes as number[])
              .toString('utf8')
              .includes('after-resync'),
        ),
      { message: 'live output after the resync' },
    )
    .toBe(true)
  expect(slow.closed).toBeNull()
  expectOrdered(slow.frames)
  slow.close()
  driver.close()
})
