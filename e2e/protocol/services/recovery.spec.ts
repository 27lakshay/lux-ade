// Runtime crash with a managed service or script still running (R005, R006
// as they apply to F086 and F090): the replacement runtime never saw the run,
// so its absence is not proof of exit. Stop and retire refuse while the old
// process tree still runs, and settle only once it is observed gone. The
// stable URL registry is reloaded by the new runtime on the same address.
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, isRunning, test, type ScratchProfile } from '../fixtures'
import {
  configureService,
  httpGet,
  nodeService,
  serviceState,
  waitForReadiness,
  writeServicePrograms,
} from '../fixtures/services'

const execFileAsync = promisify(execFile)

/**
 * Wait until the daemon has recorded the process identity of a terminal run
 * (it snapshots every two seconds). No protocol operation exposes these
 * records, so this reads the profile's database read-only; it is a
 * precondition, never an assertion. Without it a runtime killed right after
 * launch is classified `unknown` rather than `quarantined`, which is correct
 * but not what these specs exercise.
 */
async function waitForAttemptRecord(profile: ScratchProfile, key: string, attempt: string): Promise<void> {
  const database = join(profile.dataDirectory, 'sessions.sqlite')
  const query = `SELECT count(*) FROM runtime_attempt_records WHERE key='${key.replace(/'/g, "''")}' AND attempt='${attempt.replace(/'/g, "''")}'`
  await expect
    .poll(
      async () => {
        const { stdout } = await execFileAsync('/usr/bin/sqlite3', [
          '-readonly',
          '-cmd',
          '.timeout 2000',
          database,
          query,
        ]).catch(() => ({ stdout: '0' }))
        return Number(stdout.trim())
      },
      { timeout: 15_000 },
    )
    .toBe(1)
}

async function killAndWait(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* Already gone. */
  }
  await expect.poll(() => isRunning(pid)).toBe(false)
}

test('a service left running by a crashed runtime is quarantined and not settled by stop until it is gone', async ({
  profile,
  repo,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  // The server ignores SIGHUP, so it outlives the PTY its runtime owned.
  const service = await configureService(
    profile,
    workspace.id,
    'web',
    nodeService(files.server, { env: { E2E_IGNORE_HUP: '1' } }),
  )
  const port = service.ports.PORT
  const started = await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  const shellPid = (started.metrics as { shell_pid: number }).shell_pid
  const owner = started.service.terminal_owner!
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
  const route = await profile.call('service.proxy.ensure', {
    workspace_id: workspace.id,
    name: 'web',
    port_variable: 'PORT',
  })
  await waitForAttemptRecord(profile, `terminal:${workspace.id}:${owner.terminal_id}`, owner.transfer_id)

  const crashed = profile.hello
  await profile.killRuntime()
  expect(await isRunning(shellPid)).toBe(true)
  const replaced = await profile.restartDaemon()
  expect(replaced.runtime_instance).not.toBe(crashed.runtime_instance)

  // The report classifies the service run from its recorded identity: still running, quarantined.
  const recovery = await profile.call('runtime.recovery', { open_only: true })
  expect(recovery.current_instance).toBe(replaced.runtime_instance)
  const report = recovery.reports.find((entry) => entry.previous_instances.includes(crashed.runtime_instance))!
  expect(report).toBeTruthy()
  const attempt = report.attempts.find((entry) => entry.key === `service:${workspace.id}:web`)!
  expect(attempt).toMatchObject({ kind: 'service', subject: 'web', classification: 'quarantined', resolved_at: null })
  expect(attempt.pids).toContain(shellPid)

  expect(await serviceState(profile, workspace.id, 'web')).toBe('unavailable')
  // The orphan still serves its port, so nothing may reuse it.
  expect((await httpGet(`http://127.0.0.1:${port}/`)).json).toMatchObject({ pid: shellPid })
  const claims = (await profile.call('resources.inspect', { resource: 'port' })).claims.filter(
    (claim) => claim.port === port,
  )
  expect(claims).toHaveLength(1)

  // Stop must not treat the run's absence from the new runtime as an exit.
  await expect(profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })).rejects.toThrow(
    new RegExp(`still running .*${shellPid}`),
  )
  await expect(profile.call('service.start', { workspace_id: workspace.id, name: 'web' })).rejects.toThrow()
  expect(await isRunning(shellPid)).toBe(true)
  const still = (await profile.call('runtime.recovery', { open_only: true })).reports
    .flatMap((entry) => entry.attempts)
    .find((entry) => entry.key === attempt.key)
  expect(still).toMatchObject({ classification: 'quarantined', resolved_at: null })
  expect(
    (await profile.call('resources.inspect', { resource: 'port' })).claims.filter((claim) => claim.port === port),
  ).toHaveLength(1)

  // The new runtime reloaded the stable URL on its original port; it refuses the unverified orphan.
  expect(
    await profile.call('service.proxy.inspect', { workspace_id: workspace.id, name: 'web', port_variable: 'PORT' }),
  ).toMatchObject({ url: route.url, route_id: route.route_id })
  expect((await httpGet(route.url!)).status).toBe(503)

  // Once the old tree is gone, stop observes that and settles the attempt and the port.
  await killAndWait(shellPid)
  const stopped = await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
  expect(stopped.service.terminal_owner).toBeNull()
  const settled = (await profile.call('runtime.recovery', {})).reports
    .flatMap((entry) => entry.attempts)
    .find((entry) => entry.key === attempt.key)!
  expect(settled.resolved_at).not.toBeNull()
  expect(settled.resolution).toMatch(/released through its own stop or retire command/)
  expect(
    (await profile.call('resources.inspect', { resource: 'port' })).claims.filter((claim) => claim.port === port),
  ).toEqual([])

  // The service starts again on its stable port, and the stable URL forwards to the new run.
  const again = await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
  expect((await httpGet(route.url!)).json).toMatchObject({
    pid: (again.metrics as { shell_pid: number }).shell_pid,
    port,
  })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
})

test('a script left running by a crashed runtime is not retired until it is gone', async ({ profile, repo }) => {
  await mkdir(join(repo.path, '.ade'), { recursive: true })
  await writeFile(
    join(repo.path, 'linger.mjs'),
    "process.on('SIGHUP', () => {}); console.log('lingering ' + process.pid); setInterval(() => {}, 1 << 30)\n",
  )
  await writeFile(
    join(repo.path, '.ade/scripts.json'),
    JSON.stringify({
      schema_version: 1,
      scripts: { linger: { program: process.execPath, args: [join(repo.path, 'linger.mjs')] } },
    }),
  )
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const run = await profile.call('script.start', { workspace_id: workspace.id, name: 'linger' })
  const pid = (run.metrics as { shell_pid: number }).shell_pid
  await waitForAttemptRecord(
    profile,
    `terminal:${workspace.id}:${run.run_id}`,
    (run.metrics as { transfer_id: string }).transfer_id,
  )

  const crashed = profile.hello
  await profile.killRuntime()
  expect(await isRunning(pid)).toBe(true)
  await profile.restartDaemon()

  const attempt = (await profile.call('runtime.recovery', { open_only: true })).reports
    .filter((entry) => entry.previous_instances.includes(crashed.runtime_instance))
    .flatMap((entry) => entry.attempts)
    .find((entry) => entry.key === `script:${workspace.id}:${run.run_id}`)!
  expect(attempt).toMatchObject({ kind: 'script', classification: 'quarantined' })
  expect(attempt.pids).toContain(pid)

  await expect(profile.call('script.retire', { workspace_id: workspace.id, run_id: run.run_id })).rejects.toThrow(
    new RegExp(`still running .*${pid}`),
  )
  expect(await isRunning(pid)).toBe(true)

  await killAndWait(pid)
  await profile.call('script.retire', { workspace_id: workspace.id, run_id: run.run_id })
  const settled = (await profile.call('runtime.recovery', {})).reports
    .flatMap((entry) => entry.attempts)
    .find((entry) => entry.key === attempt.key)!
  expect(settled.resolved_at).not.toBeNull()
})
