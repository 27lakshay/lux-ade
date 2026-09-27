// F081, D06 and 07-S11: a terminal outlives its attachments and the daemon.
// Reattaching restores it from xterm-replay-v1: the raw PTY output from process
// start with every resize, in order and without gaps. Past the bounded replay
// the snapshot says recovery is incomplete instead of inventing a screen.
import { expect, isRunning, test } from '../fixtures'
import {
  attachThroughTty,
  clientSdk,
  replayText,
  terminalMetrics,
  TerminalStream,
  type TerminalFrame,
} from '../fixtures/terminals'

type ReplayEvent = { type: string; offset: number; bytes_base64?: string; cols?: number; rows?: number }

/** Check the replay covers every byte from offset 0 to through_offset with no gap. */
function expectContiguous(snapshot: TerminalFrame): ReplayEvent[] {
  const recovery = snapshot.terminal_recovery as { complete: boolean; through_offset: number; events: ReplayEvent[] }
  expect(recovery.complete).toBe(true)
  let offset = 0
  for (const event of recovery.events) {
    expect(event.offset).toBe(offset)
    if (event.type === 'output') offset += Buffer.from(event.bytes_base64!, 'base64').length
    else expect(event.type).toBe('resize')
  }
  expect(offset).toBe(recovery.through_offset)
  return recovery.events
}

for (const mode of ['kill', 'graceful'] as const) {
  test(`an interactive program keeps running and replays exactly after a ${mode} daemon restart`, async ({
    profile,
  }) => {
    const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
    const target = [workspace.id, workspace.terminal_id] as const
    const stream = TerminalStream.open(profile, ...target)
    const runId = (await stream.snapshot()).run_id as string
    stream.send({ op: 'resize', cols: 90, rows: 25, width_px: 0, height_px: 0, claim: true, run_id: runId })
    await stream.waitFor('the resize', (frame) => frame.type === 'terminal_resize' && frame.cols === 90)
    // Turn on bracketed paste (a mode xterm must restore), then start an interactive program.
    stream.send({ op: 'input', data: "printf 'mode-\\033[?2004h-on\\n'\n", run_id: runId })
    await stream.waitForText(/mode-\x1b\[\?2004h-on/)
    stream.send({ op: 'input', data: 'cat\n', run_id: runId })
    stream.send({ op: 'input', data: 'line-one\n', run_id: runId })
    await stream.waitForText(/line-one\r?\n(?:.*\r?\n)?line-one/)
    const before = (await terminalMetrics(profile, ...target))!
    expect(before.shell_running).toBe(true)

    const hello = await profile.restartDaemon(mode)
    expect(hello.runtime_instance).toBe(profile.hello.runtime_instance)
    await stream.waitForClose()

    const after = (await terminalMetrics(profile, ...target))!
    expect(after).toMatchObject({ run_id: runId, shell_pid: before.shell_pid, shell_running: true })

    const reattached = TerminalStream.open(profile, ...target)
    const snapshot = await reattached.snapshot()
    expect(snapshot).toMatchObject({ terminal_snapshot_format: 'xterm-replay-v1', run_id: runId })
    expect(snapshot.terminal_recovery).toMatchObject({ complete: true, initial_cols: 100, initial_rows: 30 })
    const events = expectContiguous(snapshot)
    // The resize sits in the byte stream where it happened, before the output that followed it.
    const resizeAt = events.findIndex((event) => event.type === 'resize' && event.cols === 90 && event.rows === 25)
    expect(resizeAt).toBeGreaterThanOrEqual(0)
    const replay = replayText(snapshot)
    expect(replay).toMatch(/mode-\x1b\[\?2004h-on/)
    expect(replay).toMatch(/line-one/)
    const beforeResize = Buffer.concat(
      events
        .slice(0, resizeAt)
        .filter((event) => event.type === 'output')
        .map((event) => Buffer.from(event.bytes_base64!, 'base64')),
    ).toString('utf8')
    expect(beforeResize).not.toMatch(/mode-|line-one/)

    // The same cat is still reading, and the same shell comes back after it.
    reattached.send({ op: 'input', data: 'line-two\n', run_id: runId })
    await reattached.waitForText(/line-two\r?\n(?:.*\r?\n)?line-two/)
    reattached.send({ op: 'input', data: '\x04', run_id: runId })
    reattached.send({ op: 'input', data: 'echo "pid-$$"\n', run_id: runId })
    await reattached.waitForText(new RegExp(`pid-${before.shell_pid}`))

    // The CLI reads the same recovery format and incarnation.
    const inspected = await profile.cli('terminal', 'inspect', ...target)
    expect(inspected.code, inspected.stderr).toBe(0)
    expect(inspected.json).toMatchObject({
      type: 'snapshot',
      terminal_snapshot_format: 'xterm-replay-v1',
      run_id: runId,
    })
    reattached.close()
  })
}

test('replay past its bound reports incomplete recovery without replaying input or ending the shell', async ({
  profile,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const target = [workspace.id, workspace.terminal_id] as const
  const first = TerminalStream.open(profile, ...target)
  const snapshot = await first.snapshot()
  const runId = snapshot.run_id as string
  const limit = (snapshot.terminal_recovery as { limit_bytes: number }).limit_bytes
  first.close()
  const pid = (await terminalMetrics(profile, ...target))!.shell_pid

  // Write past the replay bound with no attachment, as while every client is closed.
  const flood = limit + 512 * 1024
  const writer = TerminalStream.open(profile, ...target, {
    op: 'input',
    data: `head -c ${flood} /dev/zero | tr '\\0' x; echo; echo "flo""od-done"\n`,
  })
  await expect
    .poll(async () => (await terminalMetrics(profile, ...target))!.terminal_bytes as number, { timeout: 30_000 })
    .toBeGreaterThan(flood)
  writer.close()

  const reattached = TerminalStream.open(profile, ...target)
  const degraded = await reattached.snapshot()
  expect(degraded.run_id).toBe(runId)
  expect(degraded.terminal_recovery).toMatchObject({ complete: false, reason: 'replay_limit_exceeded', events: [] })
  expect((degraded.terminal_recovery as { through_offset: number }).through_offset).toBeGreaterThan(flood)
  expect((await terminalMetrics(profile, ...target))!).toMatchObject({ shell_running: true, shell_pid: pid })

  // Live output continues from through_offset, and the earlier command was not run again.
  const through = (degraded.terminal_recovery as { through_offset: number }).through_offset
  reattached.send({ op: 'input', data: 'echo "af""ter-flood"\n', run_id: runId })
  const live = await reattached.waitFor('live output after the flood', (frame) => frame.type === 'terminal')
  expect(live.offset).toBeGreaterThanOrEqual(through)
  await reattached.waitForText(/after-flood/)
  expect(reattached.text()).not.toMatch(/flood-done/)
  reattached.close()
})

test('detach leaves the shell and its program running, from the SDK and from the CLI', async ({ ade, profile }) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const target = [workspace.id, workspace.terminal_id] as const
  const { openTerminalConnection } = await clientSdk()

  // SDK: attach, claim the viewport, start a program, detach.
  const frames: TerminalFrame[] = []
  const connection = openTerminalConnection(
    profile.socket,
    ...target,
    (frame) => frames.push(frame),
    () => undefined,
  )
  await expect.poll(() => connection.incarnation()).not.toBeNull()
  const runId = connection.incarnation()!
  connection.resize(110, 33, 0, 0, true)
  connection.input('sleep 600 & echo "bg""-pid:"$!\n')
  await expect
    .poll(() =>
      Buffer.concat(
        frames.filter((frame) => frame.type === 'terminal').map((frame) => Buffer.from(frame.bytes as number[])),
      ).toString('utf8'),
    )
    .toMatch(/bg-pid:\d+/)
  const background = Number(
    /bg-pid:(\d+)/.exec(
      Buffer.concat(
        frames.filter((frame) => frame.type === 'terminal').map((frame) => Buffer.from(frame.bytes as number[])),
      ).toString('utf8'),
    )![1],
  )
  await ade.ledger.own(background, 'background sleep')
  const before = (await terminalMetrics(profile, ...target))!
  expect(before.resize_owner).not.toBeNull()
  connection.detach()
  await expect.poll(async () => (await terminalMetrics(profile, ...target))!.resize_owner).toBeNull()
  const afterSdk = (await terminalMetrics(profile, ...target))!
  expect(afterSdk).toMatchObject({ shell_running: true, shell_pid: before.shell_pid, run_id: runId })
  expect(await isRunning(background)).toBe(true)

  // CLI: attach under a TTY, type, press Ctrl-] to detach.
  const attached = await attachThroughTty(profile, ade.ledger, ...target)
  await expect
    .poll(async () => (await terminalMetrics(profile, ...target))!.resize_owner, { timeout: 15_000 })
    .not.toBeNull()
  attached.child.stdin!.write('echo "via""-cli"\r')
  await expect.poll(attached.output, { timeout: 15_000 }).toMatch(/via-cli/)
  attached.child.stdin!.write('\x1d')
  expect(await attached.exited).toBe(0)
  await expect.poll(async () => (await terminalMetrics(profile, ...target))!.resize_owner).toBeNull()
  expect((await terminalMetrics(profile, ...target))!).toMatchObject({
    shell_running: true,
    shell_pid: before.shell_pid,
    run_id: runId,
  })
  expect(await isRunning(background)).toBe(true)

  // Reattach: the output the CLI produced is part of the same shell's history.
  const reattached = TerminalStream.open(profile, ...target)
  expect((await reattached.snapshot()).run_id).toBe(runId)
  expect(reattached.text()).toMatch(/via-cli/)
  reattached.close()
})
