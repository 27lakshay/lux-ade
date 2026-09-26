import { expect, test } from '@playwright/test'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { managedProfileOwner, rpc, stopManagedProfile, type ManagedProfileOwner } from '../fixtures/daemon'

const runFile = promisify(execFile)
const control = resolve('target/debug/ade-control')
async function run(...args: string[]): Promise<Record<string, any>> {
  const result = await runFile(control, args, { timeout: 35_000 })
  return JSON.parse(result.stdout)
}

test('native profile control starts, attaches and restores a fenced backend without Python', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-native-control-'))
  const home = join(root, 'profiles')
  const bundle = join(root, 'bundle')
  const owners: ManagedProfileOwner[] = []
  try {
    const created = await run('profiles', '--home', home, 'create', 'Source')
    expect(created.profile.name).toBe('Source')
    const started = await run('profiles', '--home', home, '--daemon', resolve('target/debug/ade-daemon'), 'start')
    expect(started.type).toBe('profile_started')
    const owner = await managedProfileOwner(started.socket)
    owners.push(owner)
    const attached = await run('profiles', '--home', home, 'start')
    expect(attached.daemon.boot_id).toBe(owner.bootId)
    const restarted = await run('runtime', 'restart', '--home', created.profile.home,
      '--daemon', resolve('target/debug/ade-daemon'))
    expect(restarted.daemon.boot_id).not.toBe(owner.bootId)
    expect(restarted.daemon.runtime_instance).toBe(owner.runtimeInstance)
    owners[0] = await managedProfileOwner(started.socket)
    const workspace = await rpc(started.socket, { op: 'workspace.open', path: root })
    expect(workspace.workspace).toMatchObject({ root: await realpath(root) })
    const backup = await run('profiles', '--home', home, 'backup-backend', '--out', bundle)
    expect(backup.type).toBe('profile_backend_backup')
    expect((await run('backup', 'inspect', '--backup', join(bundle, 'backend'))).manifest.format_version).toBe(2)
    const restored = await run('profiles', '--home', home, 'restore-backend', '--backup', bundle, '--name', 'Restored')
    expect(restored).toMatchObject({ type: 'profile_backend_restored', scope: 'profile-backend-only' })
    expect(restored.profile.id).not.toBe(created.profile.id)
    const next = await run('profiles', '--home', home, 'start', restored.profile.id)
    owners.push(await managedProfileOwner(next.socket))
    const catalogue = await rpc(next.socket, { op: 'catalog.get' })
    expect(JSON.stringify(catalogue)).toContain(root)
    expect((await run('profiles', '--home', home, 'pending-restores')).profiles).toEqual([])
    await writeFile(join(bundle, 'backend', 'manifest.json'), '{"corrupt":true}')
    await expect(run('profiles', '--home', home, 'restore-backend', '--backup', bundle,
      '--name', 'Corrupt')).rejects.toThrow(/Registered backend manifest changed/)
    expect((await run('profiles', '--home', home, 'list')).profiles).toHaveLength(2)
  } finally {
    for (const owner of owners.reverse()) await stopManagedProfile(owner)
    await rm(root, { recursive: true, force: true })
  }
})

test('native browser lease releases on parent EOF and refuses a second owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-native-lease-'))
  const lock = join(root, 'lease.lock')
  const children: ReturnType<typeof spawn>[] = []
  const lease = async (): Promise<{ child: ReturnType<typeof spawn>, status: string }> => {
    const child = spawn(control, ['browser-lease', lock], { stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    const status = await new Promise<string>((resolveStatus, rejectStatus) => {
      child.once('error', rejectStatus)
      child.stdout.once('data', (chunk: Buffer) => resolveStatus(chunk.toString().trim()))
    })
    return { child, status }
  }
  try {
    const first = await lease()
    expect(first.status).toBe('ready')
    const second = await lease()
    expect(second.status).toBe('busy')
    first.child.stdin.end()
    await new Promise<void>((done) => first.child.once('exit', () => done()))
    const third = await lease()
    expect(third.status).toBe('ready')
    third.child.stdin.end()
  } finally {
    for (const child of children) { child.stdin.end(); if (child.exitCode === null) child.kill() }
    await rm(root, { recursive: true, force: true })
  }
})
