import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { managedProfileOwner, rpc, stopManagedProfiles, stopOrphanRuntime, type ManagedProfileOwner } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string
const launcher = resolve('target/debug/ade-control')
const daemonBinary = resolve('target/debug/ade-daemon')
type Profile = { id: string; home: string }
type Launch = { socket: string }

async function command(home: string, ...args: string[]): Promise<Record<string, unknown>> {
  try {
    const result = await execFileAsync(launcher, ['profiles', '--home', home, '--daemon', daemonBinary, ...args],
      { timeout: 30_000 })
    return JSON.parse(result.stdout) as Record<string, unknown>
  } catch (error) {
    const log = args[0] === 'start' ? await readFile(join(home, 'profiles', args[1], 'runtime', 'daemon.log'), 'utf8')
      .catch(() => '') : ''
    throw new Error(`${String(error)}\n${log}`)
  }
}

test('Electron guides a restored profile through lifecycle, repository and workspace rebind', async () => {
  test.setTimeout(90_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-desktop-rebind-e2e-'))
  const home = join(directory, 'profiles')
  const sourceCheckout = join(directory, 'source-checkout')
  const targetCheckout = join(directory, 'target-checkout')
  const bundle = join(directory, 'bundle')
  const owned: ManagedProfileOwner[] = []
  let application: Awaited<ReturnType<typeof electron.launch>> | null = null
  let stage = 'fixture setup'
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'main', sourceCheckout])
    await writeFile(join(sourceCheckout, 'history.txt'), 'saved history\n')
    await execFileAsync('git', ['add', 'history.txt'], { cwd: sourceCheckout })
    await execFileAsync('git', ['-c', 'user.name=Fixture', '-c',
      'user.email=fixture@example.invalid', 'commit', '-qm', 'saved'], { cwd: sourceCheckout })
    await execFileAsync('git', ['clone', '-q', sourceCheckout, targetCheckout])
    const source = (await command(home, 'create', 'Source')).profile as Profile
    const sourceLaunch = await command(home, 'start', source.id) as Launch
    stage = 'source daemon ownership'
    owned.push(await managedProfileOwner(sourceLaunch.socket))
    stage = 'source workspace and backup'
    const workspace = (await rpc(sourceLaunch.socket, { op: 'workspace.open', path: sourceCheckout }))
      .workspace as { id: string; repository_id: string }
    const conversation = (await rpc(sourceLaunch.socket, { op: 'conversation.create',
      workspace_id: workspace.id, provider: 'codex', title: 'Restored conversation' }))
      .conversation as { id: string }
    await rpc(sourceLaunch.socket, { op: 'worktree.repository', path: sourceCheckout })
    await command(home, 'backup-backend', '--out', bundle, source.id)
    const target = (await command(home, 'restore-backend', '--backup', bundle, '--name', 'Recovered'))
      .profile as Profile
    await command(home, 'select', target.id)
    stage = 'Electron launch'
    const { ADE_SOCKET: _fixedSocket, ADE_DAEMON_BIN: _parentDaemon, ...environment } = process.env
    application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
      env: { ...environment, ADE_PROFILES_HOME: home, ADE_DAEMON_BIN: daemonBinary,
        ADE_E2E_USER_DATA_DIR: join(directory, 'electron'), ADE_E2E_HIDE_WINDOW: '1' } })
    const window = await application.firstWindow()
    stage = 'Electron connection'
    await expect(window.locator('header').getByRole('status')).toHaveText('connected', { timeout: 15_000 })
    stage = 'target daemon ownership'
    const located = await execFileAsync(launcher, ['locate', '--home', target.home])
    const targetSocket = (JSON.parse(located.stdout) as { socket: string }).socket
    owned.push(await managedProfileOwner(targetSocket))
    const panel = window.getByRole('region', { name: 'Restore workspace paths' })
    await expect(panel.getByRole('status')).toContainText('3 paths remaining · Next: Worktree repository')
    await expect(window.evaluate(({ profileId, repositoryId, path }) =>
      window.adeHost.rebindRestored(profileId, 'repository', repositoryId, path),
    { profileId: source.id, repositoryId: workspace.repository_id, path: targetCheckout }))
      .rejects.toThrow(/Profile changed/)
    const folder = panel.getByRole('textbox', { name: 'Replacement folder' })
    await folder.fill(sourceCheckout)
    await panel.getByRole('button', { name: 'Bind folder' }).click()
    await expect(panel.getByRole('alert')).toContainText('saved source workspace or repository')
    await folder.fill(targetCheckout)
    await panel.getByRole('button', { name: 'Bind folder' }).click()
    await expect(panel.getByRole('status')).toContainText('2 paths remaining · Next: Git repository')
    await folder.fill(targetCheckout)
    await panel.getByRole('button', { name: 'Bind folder' }).click()
    await expect(panel.getByRole('status')).toContainText('1 path remaining · Next:')
    await folder.fill(targetCheckout)
    await panel.getByRole('button', { name: 'Bind folder' }).click()
    await expect(panel).toHaveCount(0)
    expect((await rpc(targetSocket, { op: 'catalog.get' })).catalog)
      .toMatchObject({ workspaces: expect.arrayContaining([expect.objectContaining({ id: workspace.id,
        root: await realpath(targetCheckout), needs_rebind: false })]) })
    expect((await rpc(targetSocket, { op: 'conversation.get', conversation_id: conversation.id })).conversation)
      .toMatchObject({ id: conversation.id, workspace_id: workspace.id, title: 'Restored conversation' })
    expect((await rpc(sourceLaunch.socket, { op: 'catalog.get' })).catalog)
      .toMatchObject({ workspaces: expect.arrayContaining([expect.objectContaining({ id: workspace.id,
        root: await realpath(sourceCheckout) })]) })
    await window.getByRole('combobox', { name: 'Workspace' }).selectOption(workspace.id)
    await expect(window.getByRole('button', { name: 'New conversation' })).toBeEnabled()
    await rename(targetCheckout, join(directory, 'moved-target'))
    await mkdir(targetCheckout)
    await expect(panel.getByRole('status')).toContainText('3 paths remaining', { timeout: 12_000 })
    await expect(window.getByRole('button', { name: 'New conversation' })).toBeDisabled()
    await expect(window.getByRole('heading', { name: 'Restored conversation' })).toBeVisible()
  } catch (error) {
    throw new Error(`${stage}: ${String(error)}`)
  } finally {
    await application?.close().catch(() => undefined)
    const targetProfiles = (await command(home, 'list').catch(() => ({ profiles: [] }))).profiles as Profile[]
    for (const target of targetProfiles) {
      const located = await execFileAsync(launcher, ['locate', '--home', target.home]).catch(() => null)
      if (located) {
        const socket = (JSON.parse(located.stdout) as { socket: string }).socket
        if (owned.some((item) => item.socket === socket)) continue
        const owner = await managedProfileOwner(socket).catch(() => null)
        if (owner) owned.push(owner)
      }
    }
    await stopManagedProfiles(owned)
    for (const target of targetProfiles) {
      const binding = await readFile(join(target.home, 'runtime.json'), 'utf8').catch(() => '')
      if (!binding) continue
      const dataDirectory = (JSON.parse(binding) as { data_directory?: unknown }).data_directory
      if (typeof dataDirectory === 'string') await stopOrphanRuntime(dataDirectory)
    }
    await rm(directory, { recursive: true, force: true })
  }
})
