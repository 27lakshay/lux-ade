// F005: an independent headless backend. A registered profile's daemon and
// runtime start from the CLI through ade-control, with no desktop, run
// detached from whatever started them, and serve every later client. Crashes
// and concurrent first uses never leave two daemons on one profile.
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isRunning } from '../fixtures'
import { expect, test } from '../fixtures/managed-profiles'
import { processTable } from '../fixtures/processes'

test('the CLI cold-starts a registered profile through ade-control, detached, and later clients attach to it', async ({
  host,
}) => {
  const work = await host.create('Work')

  // Registered, but nothing runs before first use.
  const listed = await host.cli('profile', 'list')
  expect(listed.code, listed.stderr).toBe(0)
  expect(listed.json).toMatchObject({
    type: 'profiles',
    selected_id: work.id,
    profiles: [{ id: work.id, name: 'Work', home: work.runtimeHome, selected: true }],
  })
  expect(await work.hello()).toBeNull()

  // The first command starts the daemon and its runtime.
  const status = await work.cli('status')
  expect(status.code, status.stderr).toBe(0)
  const first = status.json as {
    type: string
    pid: number
    boot_id: string
    runtime_pid: number
    runtime_socket: string
    runtime_instance: string
  }
  expect(first.type).toBe('hello')
  expect(await isRunning(first.pid)).toBe(true)
  expect(await isRunning(first.runtime_pid)).toBe(true)

  // The CLI and ade-control have exited; the daemon is its own session, reparented away from them.
  const table = new Map((await processTable()).map((row) => [row.pid, row]))
  const daemonRow = table.get(first.pid)!
  expect(daemonRow.command).toContain('target/debug/ade-daemon')
  expect(daemonRow.pgid).toBe(first.pid)
  expect(daemonRow.ppid).toBe(1)
  expect(table.get(first.runtime_pid)!.command).toContain('ade-runtime')

  // The runtime serves this profile's own data directory under the profiles home.
  const runtime = (await work.runtimeHello(first.runtime_socket))!
  expect(runtime.pid).toBe(first.runtime_pid)
  expect(await realpath(runtime.data_directory as string)).toBe(await realpath(work.dataDirectory))

  // Later clients attach to the same daemon: the SDK, raw protocol and another CLI run.
  const catalog = await work.call('catalog.get', {})
  expect(catalog.boot_id).toBe(first.boot_id)
  const raw = await work.rpc({ op: 'hello' })
  expect(raw).toMatchObject({ pid: first.pid, boot_id: first.boot_id })
  const again = await work.cli('status')
  expect(again.json).toMatchObject({ pid: first.pid, boot_id: first.boot_id, runtime_instance: first.runtime_instance })
  const workspaces = await work.cli('workspace', 'list')
  expect(workspaces.code, workspaces.stderr).toBe(0)
})

test('concurrent first commands on one profile start exactly one daemon', async ({ host }) => {
  const work = await host.create('Work')
  const results = await Promise.all(Array.from({ length: 4 }, () => work.cli('status')))
  for (const result of results) expect(result.code, result.stderr).toBe(0)
  const pids = new Set(results.map((result) => result.json!.pid))
  const boots = new Set(results.map((result) => result.json!.boot_id))
  const runtimes = new Set(results.map((result) => result.json!.runtime_instance))
  expect(pids.size).toBe(1)
  expect(boots.size).toBe(1)
  expect(runtimes.size).toBe(1)
  expect(await work.hello()).toMatchObject({ pid: [...pids][0], boot_id: [...boots][0] })
})

test('an unknown, malformed or conflicting profile selection is refused without starting anything', async ({
  host,
}) => {
  const work = await host.create('Work')

  const unknown = await work.cliWith({ profile: randomUUID() }, 'status')
  expect(unknown.code).toBe(2)
  expect(unknown.json).toMatchObject({ type: 'error', code: 'invalid_request' })
  expect(String(unknown.json!.message)).toMatch(/not registered/)

  const malformed = await work.cliWith({ profile: 'not-a-profile' }, 'status')
  expect(malformed.code).toBe(2)
  expect(malformed.json).toMatchObject({ type: 'error', code: 'invalid_request' })

  const conflicting = await work.cli('--socket', work.socket, 'status')
  expect(conflicting.code).toBe(2)
  expect(conflicting.json).toMatchObject({ type: 'error', code: 'usage' })

  const missingController = await work.cliWith({ env: { ADE_CONTROL_BIN: '/nonexistent/ade-control' } }, 'status')
  expect(missingController.code).toBe(3)
  expect(missingController.json).toMatchObject({ type: 'error', code: 'unavailable' })

  expect(await work.hello()).toBeNull()
})

test('after a daemon crash the next command starts a replacement that adopts the live runtime, and after a host crash a fresh one', async ({
  host,
  repo,
}) => {
  const work = await host.create('Work')
  const opened = await work.cli('workspace', 'open', repo.path)
  expect(opened.code, opened.stderr).toBe(0)
  const workspaceId = JSON.stringify(opened.json).match(/"id":"(workspace[^"]*)"/)?.[1]
  expect(workspaceId).toBeTruthy()
  const first = (await work.hello())!

  // The daemon crashes; its runtime keeps running with no daemon.
  await work.killDaemon()
  expect(await isRunning(first.runtime_pid)).toBe(true)

  const listed = await work.cli('workspace', 'list')
  expect(listed.code, listed.stderr).toBe(0)
  expect(JSON.stringify(listed.json)).toContain(workspaceId!)
  const replacement = (await work.hello())!
  expect(replacement.pid).not.toBe(first.pid)
  expect(replacement.boot_id).not.toBe(first.boot_id)
  expect(replacement.runtime_pid).toBe(first.runtime_pid)
  expect(replacement.runtime_instance).toBe(first.runtime_instance)

  // The whole backend dies: daemon and runtime. The next command starts both afresh on the same data.
  await work.killDaemon()
  await work.killRuntime(replacement.runtime_pid)
  const recovered = await work.cli('workspace', 'list')
  expect(recovered.code, recovered.stderr).toBe(0)
  expect(JSON.stringify(recovered.json)).toContain(workspaceId!)
  const fresh = (await work.hello())!
  expect(fresh.pid).not.toBe(replacement.pid)
  expect(fresh.runtime_instance).not.toBe(first.runtime_instance)
  expect(await isRunning(fresh.runtime_pid)).toBe(true)
})

test('a stopped profile leaves nothing running, and the next command starts it again on the same data', async ({
  host,
  repo,
}) => {
  const work = await host.create('Work')
  const opened = await work.cli('workspace', 'open', repo.path)
  expect(opened.code, opened.stderr).toBe(0)
  const first = (await work.hello())!

  await work.stop()
  expect(await isRunning(first.pid)).toBe(false)
  expect(await isRunning(first.runtime_pid)).toBe(false)
  expect(await work.hello()).toBeNull()

  const listed = await work.cli('workspace', 'list')
  expect(listed.code, listed.stderr).toBe(0)
  expect(JSON.stringify(listed.json)).toContain(repo.path)
  const second = (await work.hello())!
  expect(second.pid).not.toBe(first.pid)
  expect(second.runtime_instance).not.toBe(first.runtime_instance)
})
