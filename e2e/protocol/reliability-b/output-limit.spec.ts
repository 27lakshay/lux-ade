// R008: output recovery reports its limit. Terminal output written past the
// runtime's bounded replay while no daemon runs is reported by the next
// daemon as incomplete recovery, with the offset it reached. The shell is not
// reported as exited, no input is replayed, and live output continues. Every
// client, through the SDK and through the CLI, sees the same limit.
import { access, writeFile } from 'node:fs/promises'
import { expect, test } from '../fixtures'
import { terminalMetrics, TerminalStream } from '../fixtures/terminals'

test('terminal output past the replay bound while the daemon is down is reported as incomplete, not as an exit', async ({
  profile,
}) => {
  test.setTimeout(120_000)
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const target = [workspace.id, workspace.terminal_id] as const
  const first = TerminalStream.open(profile, ...target)
  const snapshot = await first.snapshot()
  const runId = snapshot.run_id as string
  const limit = (snapshot.terminal_recovery as { limit_bytes: number }).limit_bytes
  // The flood waits for a file the spec creates once the daemon is gone, and
  // leaves a file behind when it has written everything.
  const gate = `${profile.root}/flood-gate`
  const done = `${profile.root}/flood-written`
  first.send({
    op: 'input',
    run_id: runId,
    data:
      `while [ ! -f ${gate} ]; do sleep 0.05; done; ` +
      `head -c ${limit + 1024 * 1024} /dev/zero | tr '\\0' z; echo; touch ${done}\n`,
  })
  const before = (await terminalMetrics(profile, ...target))!
  const instance = profile.hello.runtime_instance

  await profile.killDaemon()
  await writeFile(gate, '')
  await expect
    .poll(
      () =>
        access(done).then(
          () => true,
          () => false,
        ),
      { timeout: 60_000 },
    )
    .toBe(true)
  const after = await profile.restartDaemon()
  expect(after.runtime_instance).toBe(instance)
  await expect
    .poll(async () => (await terminalMetrics(profile, ...target))!.terminal_bytes as number, { timeout: 30_000 })
    .toBeGreaterThan(limit + 1024 * 1024)
  expect((await profile.call('runtime.recovery', {})).reports).toEqual([])

  const reattached = TerminalStream.open(profile, ...target)
  const degraded = await reattached.snapshot()
  expect(degraded.run_id).toBe(runId)
  expect(degraded.terminal_recovery).toMatchObject({
    complete: false,
    reason: 'replay_limit_exceeded',
    events: [],
    limit_bytes: limit,
  })
  const through = (degraded.terminal_recovery as { through_offset: number }).through_offset
  expect(through).toBeGreaterThan(limit)
  expect(await terminalMetrics(profile, ...target)).toMatchObject({
    run_id: runId,
    shell_pid: before.shell_pid,
    shell_running: true,
  })

  // The CLI reads the same limit.
  const inspected = await profile.cli('terminal', 'inspect', ...target)
  expect(inspected.code, inspected.stderr).toBe(0)
  expect(inspected.json).toMatchObject({
    run_id: runId,
    terminal_recovery: { complete: false, reason: 'replay_limit_exceeded' },
  })

  // Live output continues from where recovery stopped; the flood command was not run again.
  reattached.send({ op: 'input', run_id: runId, data: 'echo "st""ill-alive"\n' })
  await reattached.waitForText(/still-alive/)
  const live = reattached.frames.filter((frame) => frame.type === 'terminal')
  expect(live[0].offset as number).toBeGreaterThanOrEqual(through)
  expect(reattached.text()).not.toMatch(/z{64}/)
  reattached.close()
})
