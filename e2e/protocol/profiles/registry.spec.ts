// F007 profile registry through ade-control: profiles keep stable identities,
// selection and separate daemon state across restarts; a start never replaces
// an incompatible endpoint; the native controller attaches, restarts a daemon
// on the same runtime and restores a fenced backend; and the browser lease
// admits one owner at a time. Ported from the legacy e2e/specs/local-profiles
// and native-control specs, which drove scripts/profiles.py.
import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { expect, test, type ProfileHost } from '../fixtures/managed-profiles'
import { controlBinary } from '../fixtures/control'

type Json = Record<string, unknown>
type Profile = { id: string; name: string; selected: boolean; home: string }
type Launch = { type: string; profile: Profile; socket: string; daemon: { boot_id: string; runtime_instance: string } }

async function control(host: ProfileHost, ...args: string[]): Promise<Json> {
  const result = await host.control(args)
  expect(result.code, result.stderr).toBe(0)
  await host.track()
  return result.json!
}

test('two local profiles keep stable identities and separate daemon state after restart', async ({ host }) => {
  const personal = await host.create('Personal')
  const work = await host.create('Work')
  const list = (await control(host, 'profiles', 'list')) as { selected_id: string; profiles: Profile[] }
  expect(list).toMatchObject({ selected_id: personal.id, profiles: [{ id: personal.id }, { id: work.id }] })
  expect(list.profiles.map((profile) => profile.selected)).toEqual([true, false])
  // Nothing exists on disk for a profile's runtime before it first starts.
  for (const profile of [personal, work]) await expect(access(profile.runtimeHome)).rejects.toThrow()

  // A start with no ID starts the selected profile.
  const first = (await control(host, 'profiles', 'start')) as Launch
  expect(first.profile.id).toBe(personal.id)
  const firstWorkspace = (await personal.call('catalog.get', {})).catalog.workspaces[0]!
  expect(firstWorkspace.root).toContain(personal.id)

  await control(host, 'profiles', 'select', work.id)
  const second = (await control(host, 'profiles', 'start')) as Launch
  expect(second.profile.id).toBe(work.id)
  expect(second.socket).not.toBe(first.socket)
  const secondWorkspace = (await work.call('catalog.get', {})).catalog.workspaces[0]!
  expect(secondWorkspace.id).not.toBe(firstWorkspace.id)
  expect(secondWorkspace.root).toContain(work.id)

  const created = await personal.call('conversation.create', {
    workspace_id: firstWorkspace.id,
    provider: 'codex',
    title: 'Personal only',
  })
  expect(created.type).toBe('ack')
  const personalOnly = expect.arrayContaining([expect.objectContaining({ title: 'Personal only' })])
  expect((await personal.call('catalog.get', {})).catalog.conversations).toEqual(personalOnly)
  expect((await work.call('catalog.get', {})).catalog.conversations).not.toEqual(personalOnly)

  // Starting a running profile attaches to it; after a stop, a start is a new daemon on the same data.
  const repeat = (await control(host, 'profiles', 'start', personal.id)) as Launch
  expect(repeat.daemon.boot_id).toBe(first.daemon.boot_id)
  expect(repeat.profile.selected).toBe(false)
  await personal.stop()
  const restarted = (await control(host, 'profiles', 'start', personal.id)) as Launch
  expect(restarted.daemon.boot_id).not.toBe(first.daemon.boot_id)
  expect(restarted.profile.id).toBe(personal.id)
  expect((await personal.call('catalog.get', {})).catalog.conversations).toEqual(personalOnly)
  expect(((await control(host, 'profiles', 'current')).profile as Profile).id).toBe(work.id)
})

test('profile start leaves an incompatible endpoint in place', async ({ host }) => {
  const future = await host.create('Future')
  await mkdir(dirname(future.socket), { recursive: true, mode: 0o700 })
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
    const result = await host.control(['profiles', 'start', future.id])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('Existing daemon cannot hand off this runtime')
    expect(requests).toBeGreaterThan(0)
    expect(server.listening).toBe(true)
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
})

test('native profile control starts, attaches and restores a fenced backend without Python', async ({ ade, host }) => {
  const bundle = join(ade.root, 'bundle')
  const source = await host.create('Source')
  const started = (await control(host, 'profiles', 'start')) as Launch
  expect(started.type).toBe('profile_started')
  const attached = (await control(host, 'profiles', 'start')) as Launch
  expect(attached.daemon.boot_id).toBe(started.daemon.boot_id)
  // A runtime restart replaces the daemon and keeps the runtime.
  const restarted = (await control(host, 'runtime', 'restart', '--home', source.runtimeHome)) as Launch
  expect(restarted.daemon.boot_id).not.toBe(started.daemon.boot_id)
  expect(restarted.daemon.runtime_instance).toBe(started.daemon.runtime_instance)
  expect((await source.call('workspace.open', { path: ade.root })).workspace).toMatchObject({
    root: await realpath(ade.root),
  })

  const backup = await control(host, 'profiles', 'backup-backend', '--out', bundle)
  expect(backup.type).toBe('profile_backend_backup')
  const inspected = await control(host, 'backup', 'inspect', '--backup', join(bundle, 'backend'))
  expect((inspected.manifest as { format_version: number }).format_version).toBe(7)
  const restored = await control(host, 'profiles', 'restore-backend', '--backup', bundle, '--name', 'Restored')
  expect(restored).toMatchObject({ type: 'profile_backend_restored', scope: 'profile-backend-only' })
  const record = restored.profile as Profile
  expect(record.id).not.toBe(source.id)
  const target = await host.register(record)
  await control(host, 'profiles', 'start', target.id)
  expect(JSON.stringify(await target.call('catalog.get', {}))).toContain(await realpath(ade.root))
  expect((await control(host, 'profiles', 'pending-restores')).profiles).toEqual([])

  // A bundle whose backend manifest changed is refused.
  await writeFile(join(bundle, 'backend', 'manifest.json'), '{"corrupt":true}')
  const corrupt = await host.control(['profiles', 'restore-backend', '--backup', bundle, '--name', 'Corrupt'])
  expect(corrupt.code).not.toBe(0)
  expect(corrupt.stderr).toMatch(/Registered backend manifest changed/)
  expect((await control(host, 'profiles', 'list')).profiles).toHaveLength(2)
})

test('native browser lease releases on parent EOF and refuses a second owner', async ({ ade }) => {
  const lock = join(ade.root, 'lease.lock')
  const children: ChildProcess[] = []
  const lease = async (): Promise<{ child: ChildProcess; status: string }> => {
    const child = spawn(controlBinary, ['browser-lease', lock], { stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    // Listen before anything else awaits, so the first line is never missed.
    const status = new Promise<string>((resolveStatus, rejectStatus) => {
      child.once('error', rejectStatus)
      child.stdout!.once('data', (chunk: Buffer) => resolveStatus(chunk.toString().trim()))
    })
    await ade.ledger.own(child.pid!, 'browser lease')
    return { child, status: await status }
  }
  const exited = (child: ChildProcess) =>
    new Promise<void>((done) => (child.exitCode !== null ? done() : child.once('exit', () => done())))
  try {
    const first = await lease()
    expect(first.status).toBe('ready')
    const second = await lease()
    expect(second.status).toBe('busy')
    // Closing the owner's stdin releases the lease.
    first.child.stdin!.end()
    await exited(first.child)
    const third = await lease()
    expect(third.status).toBe('ready')
  } finally {
    for (const child of children) {
      child.stdin!.end()
      await exited(child)
    }
  }
})
