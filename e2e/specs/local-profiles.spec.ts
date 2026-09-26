import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const launcher = resolve('scripts/profiles.py')
const daemonBinary = resolve('target/debug/ade-daemon')
const runtime = resolve('scripts/runtime.py')

type Profile = { id: string; name: string; selected: boolean; home: string }
type Launch = { type: string; profile: Profile; socket: string; daemon: Record<string, unknown> }

async function profile(home: string, ...words: string[]): Promise<Record<string, unknown>> {
  const result = await execFileAsync('python3', [launcher, '--home', home, '--daemon', daemonBinary, ...words], {
    timeout: 30_000,
  })
  return JSON.parse(result.stdout) as Record<string, unknown>
}

async function stopOwned(launch: Launch): Promise<void> {
  const hello = await rpc(launch.socket, { op: 'hello' }).catch(() => null)
  if (!hello || hello.boot_id !== launch.daemon.boot_id) return
  await rpc(launch.socket, { op: 'runtime.prepare_restart', boot_id: hello.boot_id })
  const runtimeSocket = hello.runtime_socket
  if (typeof runtimeSocket !== 'string') return
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await rpc(runtimeSocket, { op: 'runtime.stop', instance_id: hello.runtime_instance, stop_active: true })
      return
    } catch (error) {
      if (attempt === 49) throw error
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    }
  }
}

test('two local profiles keep stable identities and separate daemon state after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-profiles-e2e-'))
  const home = join(directory, 'registry')
  const owned = new Map<string, Launch>()
  try {
    const first = (await profile(home, 'create', 'Personal')).profile as Profile
    const second = (await profile(home, 'create', 'Work')).profile as Profile
    expect(first.id).not.toBe(second.id)
    expect(first.selected).toBe(true)
    expect(second.selected).toBe(false)
    const beforeStart = await profile(home, 'list')
    expect(beforeStart).toMatchObject({ selected_id: first.id, profiles: [{ id: first.id }, { id: second.id }] })
    await expect(access(first.home)).rejects.toThrow()
    await expect(access(second.home)).rejects.toThrow()

    const firstLaunch = await profile(home, 'start') as Launch
    owned.set(first.id, firstLaunch)
    expect(firstLaunch.profile.id).toBe(first.id)
    const firstCatalog = await rpc(firstLaunch.socket, { op: 'catalog.get' })
    const firstWorkspace = (firstCatalog.catalog as { workspaces: Array<{ id: string; root: string }> }).workspaces[0]
    expect(firstWorkspace.root).toContain(first.id)

    await profile(home, 'select', second.id)
    const secondLaunch = await profile(home, 'start') as Launch
    owned.set(second.id, secondLaunch)
    expect(secondLaunch.profile.id).toBe(second.id)
    expect(secondLaunch.socket).not.toBe(firstLaunch.socket)
    const secondCatalog = await rpc(secondLaunch.socket, { op: 'catalog.get' })
    const secondWorkspace = (secondCatalog.catalog as { workspaces: Array<{ id: string; root: string }> }).workspaces[0]
    expect(secondWorkspace.id).not.toBe(firstWorkspace.id)
    expect(secondWorkspace.root).toContain(second.id)

    const created = await rpc(firstLaunch.socket, {
      op: 'conversation.create', workspace_id: firstWorkspace.id, provider: 'codex', title: 'Personal only',
    })
    expect(created.type).toBe('ack')
    const firstAfter = await rpc(firstLaunch.socket, { op: 'catalog.get' })
    const secondAfter = await rpc(secondLaunch.socket, { op: 'catalog.get' })
    expect((firstAfter.catalog as { conversations: Array<{ title: string }> }).conversations)
      .toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Personal only' })]))
    expect((secondAfter.catalog as { conversations: Array<{ title: string }> }).conversations)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Personal only' })]))

    const repeat = await profile(home, 'start', first.id) as Launch
    expect(repeat.daemon.boot_id).toBe(firstLaunch.daemon.boot_id)
    expect(repeat.profile.selected).toBe(false)
    await stopOwned(firstLaunch)
    owned.delete(first.id)
    const restarted = await profile(home, 'start', first.id) as Launch
    owned.set(first.id, restarted)
    expect(restarted.daemon.boot_id).not.toBe(firstLaunch.daemon.boot_id)
    expect(restarted.profile.id).toBe(first.id)
    const restored = await rpc(restarted.socket, { op: 'catalog.get' })
    expect((restored.catalog as { conversations: Array<{ title: string }> }).conversations)
      .toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Personal only' })]))
    const current = await profile(home, 'current')
    expect((current.profile as Profile).id).toBe(second.id)
  } finally {
    for (const launch of owned.values()) await stopOwned(launch).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('profile start leaves an incompatible endpoint in place', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-profile-incompatible-e2e-'))
  const home = join(directory, 'registry')
  const created = (await profile(home, 'create', 'Future')).profile as Profile
  const located = await execFileAsync('python3', [runtime, 'locate', '--home', created.home])
  const socket = (JSON.parse(located.stdout) as { socket: string }).socket
  let requests = 0
  const server = createServer((peer) => {
    peer.once('data', () => {
      requests++
      peer.end('{"type":"hello","application_protocol":"future-v2","runtime_protocol":"future-v2"}\n')
    })
  })
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(socket, resolveListen)
    })
    let failure: Error & { stderr?: string } | undefined
    try { await profile(home, 'start', created.id) }
    catch (error) { failure = error as Error & { stderr?: string } }
    expect(failure?.stderr).toContain('Existing daemon cannot hand off this runtime')
    expect(requests).toBeGreaterThan(0)
    expect(server.listening).toBe(true)
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    await rm(directory, { recursive: true, force: true })
  }
})

test('a current profile store can be adopted by a new runtime home without losing history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-current-adopt-e2e-'))
  const home = join(directory, 'registry')
  let launch: Launch | null = null
  let adopted: Launch | null = null
  try {
    const created = (await profile(home, 'create', 'Original')).profile as Profile
    launch = await profile(home, 'start', created.id) as Launch
    const catalog = await rpc(launch.socket, { op: 'catalog.get' })
    const workspace = (catalog.catalog as { workspaces: Array<{ id: string }> }).workspaces[0]
    const conversation = await rpc(launch.socket, { op: 'conversation.create',
      workspace_id: workspace.id, provider: 'codex', title: 'Before adoption' })
    const id = (conversation.conversation as { id: string }).id
    const binding = JSON.parse(await readFile(join(created.home, 'runtime.json'), 'utf8')) as
      { data_directory: string }
    await stopOwned(launch)
    launch = null
    const newHome = join(directory, 'adopted-runtime')
    const adoption = await execFileAsync('python3', [runtime, 'adopt', '--home', newHome,
      '--data-dir', binding.data_directory, '--daemon', daemonBinary], { timeout: 30_000 })
    expect(JSON.parse(adoption.stdout)).toMatchObject({ data_directory: binding.data_directory, copied: false })
    const started = await execFileAsync('python3', [runtime, 'start', '--home', newHome,
      '--daemon', daemonBinary], { timeout: 30_000 })
    const result = JSON.parse(started.stdout) as { socket: string; daemon: Record<string, unknown> }
    adopted = { type: 'profile_started', profile: created, socket: result.socket, daemon: result.daemon }
    const restored = await rpc(adopted.socket, { op: 'conversation.get', conversation_id: id })
    expect(restored.conversation).toMatchObject({ id, title: 'Before adoption' })

    const futureStore = join(directory, 'future-store')
    await mkdir(futureStore)
    await execFileAsync('python3', ['-c', 'import sqlite3, sys; db=sqlite3.connect(sys.argv[1]); db.execute("PRAGMA user_version=12"); db.close()',
      join(futureStore, 'sessions.sqlite')])
    const futureHome = join(directory, 'future-runtime')
    await expect(execFileAsync('python3', [runtime, 'adopt', '--home', futureHome,
      '--data-dir', futureStore, '--daemon', daemonBinary], { timeout: 30_000 }))
      .rejects.toThrow(/Unsupported store version 12/)
    await expect(access(join(futureHome, 'runtime.json'))).rejects.toThrow()
  } finally {
    if (launch) await stopOwned(launch).catch(() => undefined)
    if (adopted) await stopOwned(adopted).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})
