// R020, headless part: the bundled ade-control cold-starts a profile's daemon
// and runtime from the bundle itself, with PATH=/usr/bin:/bin and a scratch
// HOME, and leaves an incompatible live owner running.
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { access, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { isRunning } from '../fixtures'
import { processTable } from '../fixtures/processes'
import { bundle, bundleMissing, expect, test } from '../fixtures/packaged'

test.skip(bundleMissing !== null, bundleMissing ?? '')

async function digest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

test('bundled ade-control cold-starts a profile daemon and runtime from the bundle', async ({ host }) => {
  const work = await host.create('Daily')
  expect(await work.hello()).toBeNull()

  const started = await host.control(['profiles', 'start', work.id], work.env)
  expect(started.code, started.stderr).toBe(0)
  expect(started.json).toMatchObject({ type: 'profile_started', profile: { id: work.id }, socket: work.socket })
  await host.track()
  const hello = (await work.hello())!
  expect(hello).not.toBeNull()
  expect(await isRunning(hello.pid)).toBe(true)
  expect(await isRunning(hello.runtime_pid)).toBe(true)

  // The daemon and runtime are the bundle's own executables, detached from the launcher.
  const table = new Map((await processTable()).map((row) => [row.pid, row]))
  expect(table.get(hello.pid)!.command.startsWith(bundle.daemon)).toBe(true)
  expect(table.get(hello.pid)!.ppid).toBe(1)
  expect(table.get(hello.runtime_pid)!.command.startsWith(bundle.runtime)).toBe(true)

  // The daemon identifies its build by the bundled binary, and speaks the protocols ade-control reports.
  expect(hello.build_id).toBe(await digest(bundle.daemon))
  const version = await host.control(['version'])
  expect(version.code, version.stderr).toBe(0)
  expect(hello).toMatchObject({
    application_protocol: version.json!.application_protocol,
    runtime_protocol: version.json!.runtime_protocol,
  })

  // The runtime serves the profile's own data directory under the scratch profiles home.
  const runtime = (await work.runtimeHello(hello.runtime_socket))!
  expect(await realpath(runtime.data_directory as string)).toBe(await realpath(work.dataDirectory))
  expect((await realpath(work.dataDirectory)).startsWith(await realpath(host.home))).toBe(true)

  // A second start attaches to the running daemon instead of starting another.
  const again = await host.control(['profiles', 'start', work.id], work.env)
  expect(again.code, again.stderr).toBe(0)
  expect(again.json!.daemon as Record<string, unknown>).toMatchObject({ pid: hello.pid, boot_id: hello.boot_id })

  // Clients reach it through the SDK and the bundled CLI.
  const catalog = await work.call('catalog.get', {})
  expect(catalog.boot_id).toBe(hello.boot_id)
  const status = await work.cli('status')
  expect(status.code, status.stderr).toBe(0)
  expect(status.json).toMatchObject({ pid: hello.pid, boot_id: hello.boot_id })
})

test('bundled ade-control and CLI leave an incompatible live owner running and explain recovery', async ({ host }) => {
  const future = await host.create('Future')
  const registryBefore = await readFile(join(host.home, 'registry.json'), 'utf8')
  let requests = 0
  const server = createServer((peer) => {
    peer.once('data', () => {
      requests++
      peer.end('{"type":"hello","application_protocol":"future-v2","runtime_protocol":"future-v2"}\n')
    })
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(future.socket, resolveListen)
  })
  try {
    const started = await host.control(['profiles', 'start', future.id], future.env)
    expect(started.code).not.toBe(0)
    expect(String(started.json?.message)).toContain('Existing daemon cannot hand off this runtime')
    const status = await future.cli('status')
    expect(status.code).not.toBe(0)
    expect(status.json).toMatchObject({ type: 'error' })
    expect(String(status.json!.message)).toContain('Existing daemon cannot hand off this runtime')

    // The owner was asked, left listening, and nothing else was started or rewritten.
    expect(requests).toBeGreaterThan(0)
    expect(server.listening).toBe(true)
    expect(await readFile(join(host.home, 'registry.json'), 'utf8')).toBe(registryBefore)
    // A launch opens daemon.log first; the refusal came before any launch.
    expect(
      await access(join(future.runtimeHome, 'daemon.log')).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    expect(await future.rpc({ op: 'hello' })).toMatchObject({ application_protocol: 'future-v2' })
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
})
