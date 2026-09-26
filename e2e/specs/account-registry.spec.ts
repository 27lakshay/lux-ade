import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { access, mkdtemp, rename, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { rpc } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const profiles = resolve('scripts/profiles.py')
const daemonBinary = resolve('target/debug/ade-daemon')

type Launch = { socket: string; daemon: { boot_id: string } }
type Account = { id: string; provider: string; name: string; native_home: string; generation: number; state: string }
type Conversation = { id: string; account_id: string | null; account_context: string; provider: string }

async function profile(home: string, ...args: string[]): Promise<Record<string, unknown>> {
  const result = await execFileAsync('python3', [profiles, '--home', home, '--daemon', daemonBinary, ...args], { timeout: 30_000 })
  return JSON.parse(result.stdout) as Record<string, unknown>
}

async function stop(launch: Launch): Promise<void> {
  const hello = await rpc(launch.socket, { op: 'hello' }).catch(() => null)
  if (!hello || hello.boot_id !== launch.daemon.boot_id) return
  await rpc(launch.socket, { op: 'runtime.prepare_restart', boot_id: hello.boot_id })
  if (typeof hello.runtime_socket === 'string') {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await rpc(hello.runtime_socket, { op: 'runtime.stop', instance_id: hello.runtime_instance, stop_active: true })
        return
      } catch (error) {
        if (attempt === 49) throw error
        await delay(20)
      }
    }
  }
}

test('accounts have durable, distinct profile homes and conversations keep their account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-account-e2e-'))
  const home = join(directory, 'registry')
  let launch: Launch | null = null
  try {
    const createdProfile = (await profile(home, 'create', 'Work')).profile as { id: string }
    launch = await profile(home, 'start', createdProfile.id) as Launch
    const catalog = await rpc(launch.socket, { op: 'catalog.get' })
    const workspace = (catalog.catalog as { workspaces: Array<{ id: string }> }).workspaces[0]

    const first = (await rpc(launch.socket, { op: 'account.create', provider: 'codex', name: 'Personal' })).account as Account
    const second = (await rpc(launch.socket, { op: 'account.create', provider: 'codex', name: 'Team' })).account as Account
    expect(first).toMatchObject({ provider: 'codex', name: 'Personal', generation: 0, state: 'unverified' })
    expect(second).toMatchObject({ provider: 'codex', name: 'Team', generation: 0, state: 'unverified' })
    expect(first.id).not.toBe(second.id)
    expect(first.native_home).not.toBe(second.native_home)
    expect(first.native_home).toContain(createdProfile.id)
    expect(second.native_home).toContain(createdProfile.id)
    await access(first.native_home)
    await access(second.native_home)
    expect((await stat(first.native_home)).mode & 0o777).toBe(0o700)
    expect((await stat(second.native_home)).mode & 0o777).toBe(0o700)

    const accounts = await rpc(launch.socket, { op: 'account.list' })
    expect(accounts.accounts).toEqual([first, second])
    await expect(rpc(launch.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'claude', account_id: first.id, title: 'Wrong provider' })).rejects.toThrow(/another provider/)
    await expect(rpc(launch.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex', account_id: 'missing-account', title: 'Missing account' })).rejects.toThrow()
    await expect(rpc(launch.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex', account_id: null, title: 'Invalid account' })).rejects.toThrow(/Invalid account ID/)

    const firstConversation = (await rpc(launch.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex', account_id: first.id, title: 'Personal turn' })).conversation as Conversation
    const secondConversation = (await rpc(launch.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex', account_id: second.id, title: 'Team turn' })).conversation as Conversation
    const ambient = (await rpc(launch.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex', title: 'Earlier behavior' })).conversation as Conversation
    expect(firstConversation).toMatchObject({ account_id: first.id, account_context: 'managed' })
    expect(secondConversation).toMatchObject({ account_id: second.id, account_context: 'managed' })
    expect(ambient).toMatchObject({ account_id: null, account_context: 'legacy_ambient' })

    await stop(launch)
    launch = await profile(home, 'start', createdProfile.id) as Launch
    expect((await rpc(launch.socket, { op: 'account.list' })).accounts).toEqual([first, second])
    for (const [conversation, expected] of [[firstConversation, first.id], [secondConversation, second.id], [ambient, null]] as const) {
      const snapshot = await rpc(launch.socket, { op: 'conversation.get', conversation_id: conversation.id })
      expect(snapshot.conversation).toMatchObject({ id: conversation.id, account_id: expected,
        account_context: expected ? 'managed' : 'legacy_ambient' })
    }
    await rename(first.native_home, `${first.native_home}-saved`)
    await symlink(second.native_home, first.native_home)
    await expect(rpc(launch.socket, { op: 'account.list' })).rejects.toThrow(/redirected/)
  } finally {
    if (launch) await stop(launch).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a legacy profile database upgrades without losing ambient conversations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-account-upgrade-e2e-'))
  const home = join(directory, 'registry')
  let launch: Launch | null = null
  try {
    const selected = (await profile(home, 'create', 'Existing')).profile as { id: string; home: string }
    launch = await profile(home, 'start', selected.id) as Launch
    const catalog = await rpc(launch.socket, { op: 'catalog.get' })
    const workspace = (catalog.catalog as { workspaces: Array<{ id: string }> }).workspaces[0]
    const existing = (await rpc(launch.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex', title: 'Before accounts' })).conversation as Conversation
    await stop(launch)
    launch = null

    // Model a v8 profile after the real process has produced its other durable state.
    const database = join(selected.home, 'data', 'sessions.sqlite')
    await execFileAsync('python3', ['-c', `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
 db.execute('DROP TABLE accounts')
 db.execute('ALTER TABLE attachments DROP COLUMN created_at')
 db.execute('ALTER TABLE attachments DROP COLUMN state')
 db.execute('ALTER TABLE attachments DROP COLUMN generation')
 db.execute('DELETE FROM schema_migrations WHERE version>=9')
 db.execute('PRAGMA user_version=8')`, database])

    launch = await profile(home, 'start', selected.id) as Launch
    const restored = await rpc(launch.socket, { op: 'conversation.get', conversation_id: existing.id })
    expect(restored.conversation).toMatchObject({ id: existing.id, account_id: null,
      account_context: 'legacy_ambient' })
    const account = (await rpc(launch.socket, { op: 'account.create', provider: 'codex', name: 'New' })).account as Account
    expect(account.state).toBe('unverified')
  } finally {
    if (launch) await stop(launch).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})
