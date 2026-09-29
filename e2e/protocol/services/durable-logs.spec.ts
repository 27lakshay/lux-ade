// F086 durable service output: a run's log is bounded, belongs to that run
// only, survives a daemon handoff and a lost runtime, and inspection fails
// closed on a redirected log directory or a damaged segment. Ported from the
// legacy e2e/specs/service-durable-logs spec.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ScratchProfile } from '../fixtures'
import { logText } from '../fixtures/services'

type Durable = {
  available: boolean
  reason?: string
  run_transfer_id?: string
  start_offset?: number
  through_offset?: number
  retained_start_offset?: number
  retention_overflow?: boolean
  truncated?: boolean
  capture_error?: string
  error?: string
}

async function defaultWorkspace(profile: ScratchProfile): Promise<string> {
  return (await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })).workspace.id
}

function holdingService(marker: string, prefix = '') {
  return {
    program: process.execPath,
    args: ['-e', `${prefix}console.log("${marker}"); setInterval(()=>{},1000)`],
    cwd: '.',
    env: {},
    ports: [],
  }
}

async function inspect(profile: ScratchProfile, workspace_id: string, name: string, tail_bytes?: number) {
  const reply = await profile.call('service.inspect', {
    workspace_id,
    name,
    ...(tail_bytes ? { tail_bytes } : {}),
  })
  return reply as typeof reply & { durable_logs: Durable }
}

test('durable service output is bounded and a failed successor never exposes prior-run bytes', async ({ profile }) => {
  const workspace_id = await defaultWorkspace(profile)
  const view = () => inspect(profile, workspace_id, 'logs', 4096)
  const configure = (config: Record<string, unknown>, revision: number) =>
    profile.call('service.configure', { workspace_id, name: 'logs', revision, config } as never)
  await configure(holdingService('LAST_RUN_MARKER', 'process.stdout.write("A".repeat(1200000)); '), 0)
  expect((await view()).durable_logs).toMatchObject({ available: false, reason: 'not_started' })
  await profile.call('service.start', { workspace_id, name: 'logs' })
  await expect.poll(async () => logText((await view()).durable_logs)).toContain('LAST_RUN_MARKER')
  const running = (await view()).durable_logs
  expect(running.available).toBe(true)
  expect(running.retention_overflow).toBe(true)
  expect(running.truncated).toBe(true)
  expect(running.retained_start_offset).toBeGreaterThan(0)
  expect((running.through_offset ?? 0) - (running.start_offset ?? 0)).toBeLessThanOrEqual(4096)
  const prior = running.run_transfer_id
  await profile.call('service.stop', { workspace_id, name: 'logs' })
  expect(logText((await view()).durable_logs)).toContain('LAST_RUN_MARKER')

  // A successor that fails to start gets its own, empty log, never the prior run's bytes.
  await configure(
    { ...holdingService(''), program: '/nonexistent/ade-service-program', args: [] },
    (await view()).service.revision,
  )
  await expect(profile.call('service.start', { workspace_id, name: 'logs' })).rejects.toThrow()
  const afterFailedStart = await view()
  expect(afterFailedStart.durable_logs.available).toBe(false)
  expect(afterFailedStart.service.last_run_transfer_id).toBeTruthy()
  expect(afterFailedStart.service.last_run_transfer_id).not.toBe(prior)
  expect(logText(afterFailedStart.durable_logs)).not.toContain('LAST_RUN_MARKER')
})

test('durable service output survives daemon handoff and remains readable after runtime loss', async ({ profile }) => {
  const workspace_id = await defaultWorkspace(profile)
  const view = () => inspect(profile, workspace_id, 'restart', 4096)
  await profile.call('service.configure', {
    workspace_id,
    name: 'restart',
    revision: 0,
    config: holdingService('DURABLE_RESTART_MARKER'),
  })
  await profile.call('service.start', { workspace_id, name: 'restart' })
  await expect.poll(async () => logText((await view()).durable_logs)).toContain('DURABLE_RESTART_MARKER')
  const transfer = (await view()).durable_logs.run_transfer_id
  const listed = await profile.call('service.list', { workspace_id })
  const servicePid = (listed.states.restart?.metrics as { shell_pid?: number } | undefined)?.shell_pid
  try {
    await profile.restartDaemon('graceful')
    const afterHandoff = (await view()).durable_logs
    expect(afterHandoff.run_transfer_id).toBe(transfer)
    expect(logText(afterHandoff)).toContain('DURABLE_RESTART_MARKER')

    await profile.killRuntime()
    await expect.poll(async () => (await view()).execution_state).toBe('unavailable')
    const afterLoss = (await view()).durable_logs
    expect(afterLoss.run_transfer_id).toBe(transfer)
    expect(logText(afterLoss)).toContain('DURABLE_RESTART_MARKER')
  } finally {
    // The killed runtime leaves its service process behind; stop that process group.
    if (servicePid && servicePid > 0) {
      try {
        process.kill(-servicePid, 'SIGKILL')
      } catch {
        /* Already exited. */
      }
    }
  }
})

test('a redirected service log directory reports capture failure without writing outside the data directory', async ({
  profile,
}) => {
  const workspace_id = await defaultWorkspace(profile)
  await symlink(profile.defaultWorkspaceRoot, join(profile.dataDirectory, 'service-logs'))
  await profile.call('service.configure', {
    workspace_id,
    name: 'redirected',
    revision: 0,
    config: holdingService('CAPTURE_ERROR_MARKER'),
  })
  await profile.call('service.start', { workspace_id, name: 'redirected' })
  await expect
    .poll(async () => logText((await inspect(profile, workspace_id, 'redirected')).logs))
    .toContain('CAPTURE_ERROR_MARKER')
  const result = (await inspect(profile, workspace_id, 'redirected')).durable_logs
  expect(result.available).toBe(false)
  expect(result.capture_error).toContain('redirected')
  expect((await readdir(profile.defaultWorkspaceRoot)).some((name) => /^[0-9a-f]{64}\.[01]$/.test(name))).toBe(false)
  await profile.call('service.stop', { workspace_id, name: 'redirected' })
})

test('replaced FIFO, oversized segment, and overflowing offset fail bounded inspection', async ({ profile }) => {
  const workspace_id = await defaultWorkspace(profile)
  await profile.call('service.configure', {
    workspace_id,
    name: 'unsafe-file',
    revision: 0,
    config: holdingService('FILE_MARKER'),
  })
  const view = () => inspect(profile, workspace_id, 'unsafe-file')
  await profile.call('service.start', { workspace_id, name: 'unsafe-file' })
  await expect.poll(async () => logText((await view()).durable_logs)).toContain('FILE_MARKER')
  await profile.call('service.stop', { workspace_id, name: 'unsafe-file' })
  const terminalId = (await view()).service.terminal_id
  const key = createHash('sha256').update(`${workspace_id}\0${terminalId}`).digest('hex')
  const segment = join(profile.dataDirectory, 'service-logs', `${key}.0`)
  const valid = await readFile(segment)

  await unlink(segment)
  const fifo = spawnSync('mkfifo', [segment])
  expect(fifo.status, fifo.stderr.toString()).toBe(0)
  const blocked = (await view()).durable_logs
  expect(blocked).toMatchObject({ available: false, reason: 'log_unavailable' })
  expect(blocked.error).toContain('unsafe')

  await unlink(segment)
  await writeFile(segment, Buffer.alloc(48 + 512 * 1024 + 1), { mode: 0o600 })
  const oversized = (await view()).durable_logs
  expect(oversized).toMatchObject({ available: false, reason: 'log_unavailable' })
  expect(oversized.error).toContain('exceeds its limit')

  valid.writeBigUInt64LE(2n ** 64n - 1n, 40)
  await writeFile(segment, valid, { mode: 0o600 })
  const overflowing = (await view()).durable_logs
  expect(overflowing).toMatchObject({ available: false, reason: 'log_unavailable' })
  expect(overflowing.error).toContain('offset overflows')
})
