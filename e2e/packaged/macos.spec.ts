import { expect, test, _electron as electron } from '@playwright/test'
import { packagedEnvironment } from '../protocol/fixtures/packaged'
import { once } from 'node:events'
import { execFileSync, spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import {
  managedProfileOwner,
  stopManagedProfile,
  stopManagedProfiles,
  stopOrphanRuntime,
  type ManagedProfileOwner,
  rpc,
} from '../fixtures/daemon'

const app = resolve(process.env.ADE_E2E_PACKAGE_APP ?? 'dist/electron/mac-arm64/Lux ADE.app')
const executable = join(app, 'Contents/MacOS/Lux ADE')
const resources = join(app, 'Contents/Resources')
const nativeControl = join(app, 'Contents/MacOS/ade-control')
const bundledBun = join(resources, 'bin/bun')
const installedCli = join(app, 'Contents/MacOS/ade')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

async function isolatedEnvironment(directory: string): Promise<Record<string, string>> {
  const home = join(directory, 'home')
  await mkdir(home, { recursive: true, mode: 0o700 })
  return packagedEnvironment(home, { ADE_DEBUG_PORT: '0', ADE_DEV_STATE_PORT: '0' })
}

test('installed CLI uses bundled Node and targets GUI profiles without switching the desktop', async () => {
  test.setTimeout(120_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-package-cli-e2e-'))
  const folders = [join(directory, 'first project'), join(directory, 'second project')]
  await Promise.all(folders.map((folder) => mkdir(folder)))
  const profilesHome = join(directory, 'profiles')
  const env = {
    ...(await isolatedEnvironment(directory)),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    ADE_PROFILES_HOME: profilesHome,
    ADE_E2E_USER_DATA_DIR: join(directory, 'electron'),
    ADE_E2E_HIDE_WINDOW: '1',
  }
  const cliEnv = { ...env, PATH: '/no-system-tools', ADE_PYTHON_BIN: join(directory, 'missing-python') }
  const cliAlias = join(directory, 'ade')
  await symlink(installedCli, cliAlias)
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const cli = async (...args: string[]): Promise<Record<string, any>> =>
    JSON.parse((await execFileAsync(cliAlias, args, { env: cliEnv, cwd: directory, timeout: 35_000 })).stdout)
  const profileHomes = new Map<string, string>()
  const owners = new Map<string, ManagedProfileOwner>()
  const confirmedStopped = new Set<string>()
  const restartMayHaveLaunched = new Set<string>()
  let application: Awaited<ReturnType<typeof electron.launch>> | null = null
  try {
    application = await electron.launch({ executablePath: executable, cwd: directory, env })
    const window = await application.firstWindow()
    const profiles: Array<{ id: string; home: string; root: string }> = []
    for (const [index, name] of ['First', 'Second'].entries()) {
      await window.getByRole('textbox', { name: 'New profile' }).fill(name)
      await window.getByRole('button', { name: 'Create' }).click()
      await expect(window.getByText(`Active profile: ${name}`)).toBeVisible()
      await expect(window.locator('header').getByRole('status')).toHaveText('connected')
      const state = await window.evaluate(() => window.adeHost.getProfileState())
      const profile = state.profiles.find((item) => item.id === state.activeId)
      expect(profile).toBeDefined()
      const canonicalRegistry = await realpath(profilesHome)
      const canonicalProfile = await realpath(profile!.home)
      if (!canonicalProfile.startsWith(`${canonicalRegistry}${sep}`)) {
        throw new Error(`GUI profile home is outside the test registry: ${canonicalProfile}`)
      }
      profileHomes.set(profile!.id, canonicalProfile)
      const located = await execFileAsync(nativeControl, ['locate', '--home', profile!.home])
      owners.set(profile!.id, await managedProfileOwner((JSON.parse(located.stdout) as { socket: string }).socket))
      await window.getByRole('textbox', { name: 'Open folder' }).fill(folders[index])
      await window.getByRole('button', { name: 'Open folder' }).click()
      const root = await realpath(folders[index])
      await expect(window.getByText(root, { exact: true })).toBeVisible()
      profiles.push({ id: profile!.id, home: profile!.home, root })
    }

    const listed = await cli('profile', 'list')
    expect(listed.type).toBe('profiles')
    expect((listed.profiles as Array<{ id: string }>).map((item) => item.id)).toEqual(profiles.map((item) => item.id))
    expect(listed.selected_id).toBe(profiles[1].id)
    const first = await cli('--profile', profiles[0].id, 'workspace', 'list')
    const second = await cli('--profile', profiles[1].id, 'workspace', 'list')
    expect((first.workspaces as Array<{ root: string }>).map((item) => item.root)).toEqual([profiles[0].root])
    expect((second.workspaces as Array<{ root: string }>).map((item) => item.root)).toEqual([profiles[1].root])
    const browserTab = await window.evaluate(() => window.adeHost.browser.open('http://127.0.0.1:65534/installed'))
    const browserTabId = browserTab.tabs[0].id
    await expect.poll(async () => (await cli('--profile', profiles[1].id, 'browser', 'owner')).owner_id).toBeTruthy()
    const browserOwnerId = (await cli('--profile', profiles[1].id, 'browser', 'owner')).owner_id as string
    expect((await cli('--profile', profiles[1].id, 'browser', 'list', browserOwnerId)).tabs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: browserTabId })]),
    )
    expect((await cli('--profile', profiles[1].id, 'browser', 'inspect', browserOwnerId, browserTabId)).tab_id).toBe(
      browserTabId,
    )
    const cliTab = await cli(
      '--profile',
      profiles[1].id,
      'browser',
      'open',
      browserOwnerId,
      'http://127.0.0.1:65534/cli',
      '--operation-id',
      'installed-browser-open',
    )
    const cliTabId = cliTab.tab_id as string
    expect(
      (
        await cli(
          '--profile',
          profiles[1].id,
          'browser',
          'open',
          browserOwnerId,
          'http://127.0.0.1:65534/cli',
          '--operation-id',
          'installed-browser-open',
        )
      ).tab_id,
    ).toBe(cliTabId)
    expect((await cli('--profile', profiles[1].id, 'browser', 'operation', 'installed-browser-open')).state).toBe(
      'completed',
    )
    expect(
      (
        await cli(
          '--profile',
          profiles[1].id,
          'browser',
          'navigate',
          browserOwnerId,
          cliTabId,
          'http://127.0.0.1:65534/cli-next',
          '--operation-id',
          'installed-browser-navigate',
        )
      ).tab_id,
    ).toBe(cliTabId)
    expect(
      (
        await cli(
          '--profile',
          profiles[1].id,
          'browser',
          'close',
          browserOwnerId,
          cliTabId,
          '--operation-id',
          'installed-browser-close',
        )
      ).tab_id,
    ).toBe(cliTabId)
    expect(
      (await cli('--profile', profiles[1].id, 'browser', 'list', browserOwnerId)).tabs.map(
        (tab: { id: string }) => tab.id,
      ),
    ).toEqual([browserTabId])
    const inactiveBrowser = await execFileAsync(cliAlias, ['--profile', profiles[0].id, 'browser', 'owner'], {
      env: cliEnv,
      cwd: directory,
      timeout: 35_000,
    }).catch((error: Error & { stderr?: string }) => error)
    expect(inactiveBrowser).toHaveProperty('stderr')
    expect(
      JSON.parse((inactiveBrowser as { stderr: string }).stderr),
      (inactiveBrowser as { stderr: string }).stderr,
    ).toMatchObject({ type: 'error', code: 'unavailable' })
    const workspaceId = (first.workspaces as Array<{ id: string }>)[0].id
    const createdTerminal = await cli(
      '--profile',
      profiles[0].id,
      'terminal',
      'create',
      workspaceId,
      '--operation-id',
      'installed-cli-terminal',
    )
    const terminalId = createdTerminal.terminal_id as string
    expect(
      (
        await cli(
          '--profile',
          profiles[0].id,
          'terminal',
          'create',
          workspaceId,
          '--operation-id',
          'installed-cli-terminal',
        )
      ).terminal_id,
    ).toBe(terminalId)
    expect(
      (await cli('--profile', profiles[0].id, 'terminal', 'operation', workspaceId, 'installed-cli-terminal'))
        .terminal_id,
    ).toBe(terminalId)
    expect((await cli('--profile', profiles[0].id, 'terminal', 'inspect', workspaceId, terminalId)).type).toBe(
      'snapshot',
    )
    expect((await cli('--profile', profiles[0].id, 'terminal', 'stop', workspaceId, terminalId)).type).toBe('ack')
    await expect
      .poll(async () => {
        const runtime = await cli('--profile', profiles[0].id, 'request', 'runtime.status')
        return (runtime.terminals as Array<{ metrics: { terminal_id: string; shell_running: boolean } }>).find(
          (item) => item.metrics.terminal_id === terminalId,
        )?.metrics.shell_running
      })
      .toBe(false)
    expect((await cli('--profile', profiles[0].id, 'terminal', 'retire', workspaceId, terminalId)).type).toBe('ack')
    expect((await cli('--profile', profiles[0].id, 'terminal', 'list')).terminals).not.toContainEqual({
      workspace_id: workspaceId,
      terminal_id: terminalId,
    })
    const wrong = await execFileAsync(
      installedCli,
      ['--profile', '00000000-0000-4000-8000-000000000000', 'workspace', 'list'],
      { env: cliEnv, cwd: directory, timeout: 35_000 },
    ).catch((error: Error & { stderr?: string }) => error)
    expect(wrong).toHaveProperty('stderr')
    expect(JSON.parse((wrong as { stderr: string }).stderr)).toMatchObject({ type: 'error', code: 'invalid_request' })
    expect((await cli('profile', 'list')).selected_id).toBe(profiles[1].id)
    await expect(window.getByText('Active profile: Second')).toBeVisible()
    await expect(window.getByText(profiles[0].root, { exact: true })).toHaveCount(0)

    await application.close()
    application = null
    const closedBrowser = await execFileAsync(cliAlias, ['--profile', profiles[1].id, 'browser', 'owner'], {
      env: cliEnv,
      cwd: directory,
      timeout: 35_000,
    }).catch((error: Error & { stderr?: string }) => error)
    expect(closedBrowser).toHaveProperty('stderr')
    expect(JSON.parse((closedBrowser as { stderr: string }).stderr)).toMatchObject({
      type: 'error',
      code: 'unavailable',
    })
    const prior = owners.get(profiles[0].id)!
    await stopManagedProfile(prior)
    owners.delete(profiles[0].id)
    confirmedStopped.add(profiles[0].id)
    restartMayHaveLaunched.add(profiles[0].id)
    let restarted: Record<string, any>
    try {
      restarted = await cli('--profile', profiles[0].id, 'status')
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'EACCES')
      ) {
        restartMayHaveLaunched.delete(profiles[0].id)
      }
      throw error
    }
    expect(restarted.type).toBe('hello')
    const located = await execFileAsync(nativeControl, ['locate', '--home', profiles[0].home])
    const newOwner = await managedProfileOwner((JSON.parse(located.stdout) as { socket: string }).socket)
    owners.set(profiles[0].id, newOwner)
    confirmedStopped.delete(profiles[0].id)
    restartMayHaveLaunched.delete(profiles[0].id)
    expect(newOwner.bootId).not.toBe(prior.bootId)
    expect((await cli('profile', 'list')).selected_id).toBe(profiles[1].id)
  } finally {
    let cleanupError: unknown
    try {
      await application?.close()
    } catch (error) {
      cleanupError = error
    }
    try {
      const registry = JSON.parse(
        (await execFileAsync(nativeControl, ['profiles', '--home', profilesHome, 'list'])).stdout,
      ) as {
        profiles: Array<{ id: string; home: string }>
      }
      const canonicalHome = await realpath(profilesHome)
      for (const profile of registry.profiles) {
        const candidate = await realpath(profile.home)
        if (!candidate.startsWith(`${canonicalHome}${sep}`)) {
          throw new Error(`Refusing cleanup outside test profiles home: ${candidate}`)
        }
        profileHomes.set(profile.id, candidate)
      }
    } catch (error) {
      cleanupError ??= error
    }
    for (const [profileId, home] of profileHomes) {
      try {
        const located = await execFileAsync(nativeControl, ['locate', '--home', home])
        const socket = (JSON.parse(located.stdout) as { socket: string }).socket
        const live = await rpc(socket, { op: 'hello' }, 500).catch(() => null)
        const known = owners.get(profileId)
        if (known) {
          if (known.socket !== socket) throw new Error(`Profile ${profileId} endpoint changed during cleanup`)
          await stopManagedProfile(known)
        } else if (live) {
          const owner = await managedProfileOwner(socket)
          const runtime = await rpc(owner.runtimeSocket, { op: 'hello' }, 500)
          expect(await realpath(runtime.data_directory as string)).toBe(await realpath(join(home, 'data')))
          await stopManagedProfile(owner)
        } else if (!confirmedStopped.has(profileId) || restartMayHaveLaunched.has(profileId)) {
          throw new Error(`Cannot confirm test profile ${profileId} daemon has exited; preserving ${home}`)
        }
        await stopOrphanRuntime(join(home, 'data'))
      } catch (error) {
        cleanupError ??= error
      }
    }
    if (cleanupError) throw cleanupError
    await rm(directory, { recursive: true, force: true })
  }
})

test('installed startup, browser lease, backup and interrupted restore use native control', async () => {
  test.setTimeout(90_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-package-native-control-'))
  const profilesHome = join(directory, 'profiles')
  const bundle = join(directory, 'backend-bundle')
  const signal = join(directory, 'published')
  const release = join(directory, 'release')
  const asar = await readFile(join(resources, 'app.asar'))
  expect(asar.includes('/usr/bin/python3')).toBe(false)
  expect(asar.includes('profiles.py')).toBe(false)
  expect((await readdir(resources)).filter((item) => item.endsWith('.py'))).toEqual([])
  const env = {
    ...(await isolatedEnvironment(directory)),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    ADE_PROFILES_HOME: profilesHome,
    ADE_E2E_USER_DATA_DIR: join(directory, 'electron'),
    ADE_E2E_HIDE_WINDOW: '1',
    ADE_PYTHON_BIN: join(directory, 'missing-python'),
  }
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = async (...args: string[]): Promise<Record<string, any>> =>
    JSON.parse(
      (await promisify(execFile)(nativeControl, args, { env: { ...env, PATH: '/no-system-tools' }, timeout: 35_000 }))
        .stdout,
    )
  let application = await electron.launch({ executablePath: executable, cwd: directory, env })
  let owner: ManagedProfileOwner | null = null
  try {
    const window = await application.firstWindow()
    await window.getByRole('textbox', { name: 'New profile' }).fill('Native')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const profile = (await window.evaluate(() => window.adeHost.getProfileState())).profiles[0]
    const located = await run('locate', '--home', profile.home)
    owner = await managedProfileOwner(located.socket)
    const busy = spawn(nativeControl, ['browser-lease', join(profile.home, '.ade-browser-session.lock')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, PATH: '/no-system-tools' },
    })
    const state = await new Promise<string>((done) =>
      busy.stdout.once('data', (chunk: Buffer) => done(chunk.toString().trim())),
    )
    expect(state).toBe('busy')
    busy.stdin.end()
    expect((await run('profiles', '--home', profilesHome, 'backup-backend', '--out', bundle)).type).toBe(
      'profile_backend_backup',
    )
    const restore = spawn(
      nativeControl,
      ['profiles', '--home', profilesHome, 'restore-backend', '--backup', bundle, '--name', 'Recovered'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...env,
          PATH: '/no-system-tools',
          ADE_E2E_RESTORE_PUBLISHED_SIGNAL: signal,
          ADE_E2E_RESTORE_PUBLISHED_RELEASE: release,
        },
      },
    )
    await expect.poll(async () => readFile(signal, 'utf8').catch(() => '')).not.toBe('')
    restore.kill('SIGKILL')
    await new Promise<void>((done) => restore.once('exit', () => done()))
    const pending = await run('profiles', '--home', profilesHome, 'pending-restores')
    expect(pending.profiles).toHaveLength(1)
    const resumed = await run('profiles', '--home', profilesHome, 'resume-restore', pending.profiles[0].id)
    expect(resumed).toMatchObject({ type: 'profile_backend_restored', scope: 'profile-backend-only' })
    expect((await run('profiles', '--home', profilesHome, 'pending-restores')).profiles).toEqual([])
    await application.close()
    const free = spawn(nativeControl, ['browser-lease', join(profile.home, '.ade-browser-session.lock')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, PATH: '/no-system-tools' },
    })
    const next = await new Promise<string>((done) =>
      free.stdout.once('data', (chunk: Buffer) => done(chunk.toString().trim())),
    )
    expect(next).toBe('ready')
    free.stdin.end()
  } finally {
    await application.close().catch(() => undefined)
    if (owner) await stopManagedProfile(owner)
    await rm(directory, { recursive: true, force: true })
  }
})

async function executableWrapper(filename: string, binary: string, script: string): Promise<void> {
  await writeFile(filename, `#!/bin/sh\nexec ${shellQuote(binary)} ${shellQuote(script)} "$@"\n`, { mode: 0o755 })
}

test('packaged macOS app runs from its own resources and retains work across reopen', async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-package-e2e-'))
  const folder = join(directory, 'project')
  const fixture = join(directory, 'codex-mock.py')
  const mockDirectory = join(directory, 'codex-calls')
  await mkdir(folder)
  await copyFile(resolve('scripts/fixtures/codex_mock.py'), fixture)
  const env = {
    ...(await isolatedEnvironment(directory)),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    ADE_PROFILES_HOME: join(directory, 'profiles'),
    ADE_E2E_USER_DATA_DIR: join(directory, 'electron'),
    ADE_CODEX_TRANSPORT: 'stdio',
    ADE_CODEX_BIN: fixture,
    ADE_MOCK_DIR: mockDirectory,
    ADE_PACKAGED_SENTINEL: '__ADE_PACKAGED_TERMINAL_EXECUTED__',
  }
  let application = await electron.launch({ executablePath: executable, cwd: directory, env })
  let owned: ManagedProfileOwner | null = null
  let runtimeHome: string | null = null
  try {
    let window = await application.firstWindow()
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false)
    await expect(window.getByText('No active profile')).toBeVisible()
    await window.getByRole('textbox', { name: 'New profile' }).fill('Packaged')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.getByText('Active profile: Packaged')).toBeVisible()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const profile = (await window.evaluate(() => window.adeHost.getProfileState())).profiles[0]
    runtimeHome = profile.home
    const locate = await import('node:child_process')
    const { promisify } = await import('node:util')
    const result = await promisify(locate.execFile)(nativeControl, ['locate', '--home', profile.home])
    const socket = (JSON.parse(result.stdout) as { socket: string }).socket
    const hello = await rpc(socket, { op: 'hello' })
    owned = await managedProfileOwner(socket)
    const runtimeInstance = hello.runtime_instance

    await window.getByRole('textbox', { name: 'Open folder' }).fill(folder)
    await window.getByRole('button', { name: 'Open folder' }).click()
    const canonicalFolder = await realpath(folder)
    await expect(window.getByText(canonicalFolder, { exact: true })).toBeVisible()
    const surface = window.locator('.terminal-surface')
    await expect(surface.locator('.xterm-rows')).toBeVisible()
    await surface.click()
    await window.keyboard.type('printf "%s\\n" "$ADE_PACKAGED_SENTINEL"')
    await window.keyboard.press('Enter')
    await expect(surface.locator('.xterm-rows')).toContainText('__ADE_PACKAGED_TERMINAL_EXECUTED__')
    const before = await rpc(socket, { op: 'runtime.status' })
    const shellPid = (before.terminals as Array<{ metrics: { shell_pid: number } }>)[0].metrics.shell_pid
    expect(shellPid).toBeGreaterThan(0)

    await window.getByRole('button', { name: 'New conversation' }).click()
    const conversation = window.getByRole('region', { name: 'Conversation' })
    await conversation.getByRole('textbox', { name: 'Prompt' }).fill('packaged-turn')
    await conversation.getByRole('button', { name: 'Send' }).click()
    await expect(conversation.locator('.message-assistant')).toContainText('Hello world')
    const calls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(calls.filter((line) => JSON.parse(line).method === 'turn/start')).toHaveLength(1)

    await application.close()
    expect((await rpc(socket, { op: 'hello' })).boot_id).toBe(hello.boot_id)
    expect((await rpc(socket, { op: 'hello' })).runtime_instance).toBe(runtimeInstance)
    application = await electron.launch({ executablePath: executable, cwd: directory, env })
    window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect(window.getByText('Active profile: Packaged')).toBeVisible()
    await expect(window.getByRole('region', { name: 'Conversation' }).locator('.message-assistant')).toContainText(
      'Hello world',
    )
    expect((await rpc(socket, { op: 'hello' })).boot_id).toBe(hello.boot_id)
    const after = await rpc(socket, { op: 'runtime.status' })
    expect((after.terminals as Array<{ metrics: { shell_pid: number } }>)[0].metrics.shell_pid).toBe(shellPid)
  } catch (error) {
    if (runtimeHome) {
      const log = await readFile(join(runtimeHome, 'daemon.log')).catch(() => Buffer.from('No daemon log was written'))
      await testInfo.attach('packaged-daemon.log', { body: log.subarray(-64 * 1024), contentType: 'text/plain' })
    }
    throw error
  } finally {
    await application.close().catch(() => undefined)
    if (owned) await stopManagedProfile(owned)
    await rm(directory, { recursive: true, force: true })
  }
})

test('packaged macOS app runs scripts with the project npm and Node from a Finder-like PATH', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-package-scripts-e2e-'))
  const folder = join(directory, 'project')
  await mkdir(folder)
  await writeFile(
    join(folder, 'package.json'),
    JSON.stringify({
      name: 'ade-packaged-script',
      private: true,
      packageManager: `npm@${execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()}`,
      scripts: { check: 'node -e "console.log(\'PACKAGED_SCRIPT_READY\')"' },
    }),
  )
  await writeFile(join(folder, '.node-version'), `${process.version.slice(1)}\n`)
  await mkdir(join(folder, '.ade'))
  await writeFile(
    join(folder, '.ade', 'scripts.json'),
    JSON.stringify({
      schema_version: 1,
      scripts: {
        recipe_check: {
          program: 'node',
          args: ['-e', "console.log('PACKAGED_RECIPE_READY')"],
          cwd: '.',
        },
      },
    }),
  )
  const env = {
    ...(await isolatedEnvironment(directory)),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    ADE_PROFILES_HOME: join(directory, 'profiles'),
    ADE_E2E_USER_DATA_DIR: join(directory, 'electron'),
  }
  let application = await electron.launch({ executablePath: executable, cwd: directory, env })
  let owned: (ManagedProfileOwner & { home: string }) | null = null
  try {
    let window = await application.firstWindow()
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false)
    await window.getByRole('textbox', { name: 'New profile' }).fill('Scripts')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const profile = (await window.evaluate(() => window.adeHost.getProfileState())).profiles[0]
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const located = await promisify(execFile)(nativeControl, ['locate', '--home', profile.home])
    const socket = (JSON.parse(located.stdout) as { socket: string }).socket
    owned = { ...(await managedProfileOwner(socket)), home: profile.home }
    await window.getByRole('textbox', { name: 'Open folder' }).fill(folder)
    await window.getByRole('button', { name: 'Open folder' }).click()
    await expect(window.getByText(await realpath(folder), { exact: true })).toBeVisible()
    const pane = window.getByRole('region', { name: 'Workspace scripts' })
    await pane.getByRole('article', { name: 'Script check' }).getByRole('button', { name: 'Run' }).click()
    const run = pane.getByRole('article', { name: 'Script run check' })
    await expect(run).toContainText('PACKAGED_SCRIPT_READY')
    await expect(run).toContainText('succeeded')
    await pane.getByRole('article', { name: 'Script recipe_check' }).getByRole('button', { name: 'Run' }).click()
    const recipeRun = pane.getByRole('article', { name: 'Script run recipe_check' })
    await expect(recipeRun).toContainText('PACKAGED_RECIPE_READY')
    await expect(recipeRun).toContainText('succeeded')
    await application.close()
    application = await electron.launch({ executablePath: executable, cwd: directory, env })
    window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const restored = window
      .getByRole('region', { name: 'Workspace scripts' })
      .getByRole('article', { name: 'Script run check' })
    await expect(restored).toContainText('succeeded')
    await restored.getByRole('button', { name: 'Inspect output' }).click()
    await expect(restored).toContainText('PACKAGED_SCRIPT_READY')
    const restoredRecipe = window
      .getByRole('region', { name: 'Workspace scripts' })
      .getByRole('article', { name: 'Script run recipe_check' })
    await expect(restoredRecipe).toContainText('succeeded')
    await restoredRecipe.getByRole('button', { name: 'Inspect output' }).click()
    await expect(restoredRecipe).toContainText('PACKAGED_RECIPE_READY')
  } catch (error) {
    if (owned) {
      const log = await readFile(join(owned.home, 'daemon.log')).catch(() => Buffer.from('No daemon log was written'))
      await testInfo.attach('packaged-script-daemon.log', { body: log.subarray(-64 * 1024), contentType: 'text/plain' })
    }
    throw error
  } finally {
    await application.close().catch(() => undefined)
    if (owned) await stopManagedProfile(owned)
    await rm(directory, { recursive: true, force: true })
  }
})

test('packaged macOS app keeps two profile daemons, terminals and conversations isolated across reopen', async ({}, testInfo) => {
  test.setTimeout(150_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-package-profiles-e2e-'))
  const folders = [join(directory, 'alpha-project'), join(directory, 'beta-project')]
  await Promise.all(folders.map((folder) => mkdir(folder)))
  const fixture = join(directory, 'codex-mock.py')
  await copyFile(resolve('scripts/fixtures/codex_mock.py'), fixture)
  const env = {
    ...(await isolatedEnvironment(directory)),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    ADE_PROFILES_HOME: join(directory, 'profiles'),
    ADE_E2E_USER_DATA_DIR: join(directory, 'electron'),
    ADE_CODEX_TRANSPORT: 'stdio',
    ADE_CODEX_BIN: fixture,
    ADE_MOCK_DIR: join(directory, 'codex-calls'),
    ADE_E2E_STARTUP_PROFILE_RELEASE_FILE: join(directory, 'release-startup-profile'),
  }
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  let application = await electron.launch({ executablePath: executable, cwd: directory, env })
  const owned: Array<ManagedProfileOwner & { id: string; home: string }> = []
  const profiles: Array<{ id: string; name: string; workspace: string; conversationId: string; shellPid: number }> = []
  try {
    let window = await application.firstWindow()
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false)
    for (const [index, name] of ['Alpha', 'Beta'].entries()) {
      await window.getByRole('textbox', { name: 'New profile' }).fill(name)
      await window.getByRole('button', { name: 'Create' }).click()
      await expect(window.getByText(`Active profile: ${name}`)).toBeVisible()
      await expect(window.locator('header').getByRole('status')).toHaveText('connected')
      const active = await window.evaluate(() => window.adeHost.getProfileState())
      const profile = active.profiles.find((item) => item.id === active.activeId)
      expect(profile?.name).toBe(name)
      const located = await execFileAsync(nativeControl, ['locate', '--home', profile!.home])
      const socket = (JSON.parse(located.stdout) as { socket: string }).socket
      await rpc(socket, { op: 'hello' })
      owned.push({ ...(await managedProfileOwner(socket)), id: profile!.id, home: profile!.home })

      await window.getByRole('textbox', { name: 'Open folder' }).fill(folders[index])
      await window.getByRole('button', { name: 'Open folder' }).click()
      const workspace = await realpath(folders[index])
      await expect(window.getByText(workspace, { exact: true })).toBeVisible()
      const terminal = window.locator('.terminal-surface')
      await expect(terminal.locator('.xterm-rows')).toBeVisible()
      await terminal.click()
      await window.keyboard.type(
        `export ADE_PROFILE_VALUE=${name.toUpperCase()}; printf 'PROFILE_%s_SHELL\\n' "$ADE_PROFILE_VALUE"`,
      )
      await window.keyboard.press('Enter')
      await expect(terminal.locator('.xterm-rows')).toContainText(`PROFILE_${name.toUpperCase()}_SHELL`)

      await window.getByRole('button', { name: 'New conversation' }).click()
      const conversation = window.getByRole('region', { name: 'Conversation' })
      await conversation.getByRole('textbox', { name: 'Prompt' }).fill(`profile-${name.toLowerCase()}-turn`)
      await conversation.getByRole('button', { name: 'Send' }).click()
      await expect(conversation.locator('.message-assistant')).toContainText('Hello world')
      const catalog = await rpc(socket, { op: 'catalog.get' })
      const records = catalog.catalog as {
        workspaces: Array<{ id: string; root: string }>
        conversations: Array<{ id: string; workspace_id: string }>
      }
      expect(records.workspaces.map((item) => item.root)).toEqual([workspace])
      expect(records.conversations).toHaveLength(1)
      const runtime = await rpc(socket, { op: 'runtime.status' })
      const shellPid = (runtime.terminals as Array<{ metrics: { shell_pid: number } }>)[0].metrics.shell_pid
      expect(shellPid).toBeGreaterThan(0)
      profiles.push({ id: profile!.id, name, workspace, conversationId: records.conversations[0].id, shellPid })
      if (index === 1) {
        await expect(window.getByText(profiles[0].workspace, { exact: true })).toHaveCount(0)
        expect(records.conversations.some((item) => item.id === profiles[0].conversationId)).toBe(false)
      }
    }

    await expect(window.getByRole('combobox', { name: 'Profile' })).toHaveValue(profiles[1].id)
    await expect(
      window.evaluate(() => window.adeHost.selectProfile('00000000-0000-4000-8000-000000000000')),
    ).rejects.toThrow('Unknown profile')
    await expect(window.getByText('Active profile: Beta')).toBeVisible()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')

    await application.close()
    for (const owner of owned) expect((await rpc(owner.socket, { op: 'hello' })).boot_id).toBe(owner.bootId)
    application = await electron.launch({ executablePath: executable, cwd: directory, env })
    window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect(window.getByText('Active profile: Beta')).toBeVisible()
    const profilePicker = window.getByRole('combobox', { name: 'Profile' })
    await profilePicker.selectOption(profiles[0].id)
    await expect(profilePicker).toBeDisabled()
    await expect(window.getByText('Active profile: Beta')).toBeVisible()
    await writeFile(env.ADE_E2E_STARTUP_PROFILE_RELEASE_FILE, '')
    for (const [index, profile] of [profiles[0], profiles[1], profiles[0]].entries()) {
      if (index > 0) await window.getByRole('combobox', { name: 'Profile' }).selectOption(profile.id)
      await expect(window.getByText(`Active profile: ${profile.name}`)).toBeVisible()
      await expect(window.locator('header').getByRole('status')).toHaveText('connected')
      await expect(window.getByText(profile.workspace, { exact: true })).toBeVisible()
      await expect(window.getByRole('region', { name: 'Conversation' }).locator('.message-assistant')).toContainText(
        'Hello world',
      )
      await expect(window.getByText(profiles[profile.name === 'Alpha' ? 1 : 0].workspace, { exact: true })).toHaveCount(
        0,
      )
      const owner = owned.find((item) => item.id === profile.id)
      expect(owner).toBeDefined()
      expect((await rpc(owner!.socket, { op: 'hello' })).boot_id).toBe(owner!.bootId)
      const runtime = await rpc(owner!.socket, { op: 'runtime.status' })
      expect((runtime.terminals as Array<{ metrics: { shell_pid: number } }>)[0].metrics.shell_pid).toBe(
        profile.shellPid,
      )
      const terminal = window.locator('.terminal-surface')
      await expect(terminal.locator('.xterm-rows')).toBeVisible()
      await terminal.hover()
      await window.mouse.wheel(0, 10_000)
      await expect(terminal.locator('.xterm-rows')).toContainText(`PROFILE_${profile.name.toUpperCase()}_SHELL`, {
        timeout: 30_000,
      })
      await expect(terminal.locator('.xterm-rows')).toContainText('❯')
      await terminal.click()
      await window.keyboard.type('printf "RESTORED_%s\\n" "$ADE_PROFILE_VALUE"')
      await window.keyboard.press('Enter')
      await window.mouse.wheel(0, 10_000)
      await expect(terminal.locator('.xterm-rows')).toContainText(`RESTORED_${profile.name.toUpperCase()}`)
      const snapshot = await rpc(owner!.socket, { op: 'conversation.get', conversation_id: profile.conversationId })
      expect(
        (snapshot.messages as Array<{ role: string; text: string }>).some(
          (message) => message.role === 'user' && message.text === `profile-${profile.name.toLowerCase()}-turn`,
        ),
      ).toBe(true)
    }
  } catch (error) {
    for (const owner of owned) {
      const log = await readFile(join(owner.home, 'daemon.log')).catch(() => Buffer.from('No daemon log was written'))
      await testInfo.attach(`packaged-${owner.home.split('/').at(-1)}-daemon.log`, {
        body: log.subarray(-64 * 1024),
        contentType: 'text/plain',
      })
    }
    throw error
  } finally {
    await application.close().catch(() => undefined)
    await stopManagedProfiles(owned)
    await rm(directory, { recursive: true, force: true })
  }
})

test('packaged macOS app keeps two Codex fixture accounts separate while closed and after reopen', async ({}, testInfo) => {
  test.setTimeout(150_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-package-accounts-e2e-'))
  const folder = join(directory, 'project')
  const cli = join(directory, 'codex-fixture')
  await mkdir(folder)
  await copyFile(resolve('e2e/fixtures/codex_account_server.py'), cli)
  await chmod(cli, 0o700)
  const env = {
    ...(await isolatedEnvironment(directory)),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    ADE_PROFILES_HOME: join(directory, 'profiles'),
    ADE_E2E_USER_DATA_DIR: join(directory, 'electron'),
    ADE_CODEX_BIN: cli,
    ADE_CODEX_TRANSPORT: 'shared',
    OPENAI_API_KEY: 'ambient-must-not-leak',
    CODEX_API_KEY: 'ambient-must-not-leak',
    CODEX_AWS_BEARER_TOKEN: 'ambient-must-not-leak',
  }
  type Account = {
    id: string
    name: string
    native_home: string
    generation: number
    state: string
    codex_identity?: { email: string; chatgpt_account_id: string }
  }
  type Conversation = {
    id: string
    account_id: string | null
    account_context: string
    provider_thread_id: string | null
    status: string
  }
  const names = ['Personal Codex', 'Work Codex'] as const
  const prompts = ['personal packaged turn', 'work packaged turn'] as const
  const closedPrompts = ['personal while closed', 'work while closed'] as const
  const credentialMarkers = ['fixture-personal-credential', 'fixture-work-credential'] as const
  const turnMarkers = async (account: Account): Promise<Array<string | undefined>> =>
    (await readFile(join(account.native_home, 'calls.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; fixture_credential_marker?: string })
      .filter((call) => call.method === 'turn/start')
      .map((call) => call.fixture_credential_marker)
  let application = await electron.launch({ executablePath: executable, cwd: directory, env })
  let owned: ManagedProfileOwner | null = null
  let profileHome: string | null = null
  try {
    let window = await application.firstWindow()
    await window.getByRole('textbox', { name: 'New profile' }).fill('Managed accounts')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const profile = (await window.evaluate(() => window.adeHost.getProfileState())).profiles[0]
    profileHome = profile.home
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const located = await promisify(execFile)(nativeControl, ['locate', '--home', profile.home], { env })
    const socket = (JSON.parse(located.stdout) as { socket: string }).socket
    owned = await managedProfileOwner(socket)
    const bootId = (await rpc(socket, { op: 'hello' })).boot_id

    await window.getByRole('textbox', { name: 'Open folder' }).fill(folder)
    await window.getByRole('button', { name: 'Open folder' }).click()
    await expect(window.getByText(await realpath(folder), { exact: true })).toBeVisible()
    const panel = window.getByRole('region', { name: 'Accounts' })
    const accounts: Account[] = []
    const conversations: Conversation[] = []
    for (const [index, name] of names.entries()) {
      await panel.getByLabel('New account provider').selectOption('codex')
      await panel.getByRole('textbox', { name: 'New account name' }).fill(name)
      await panel.getByRole('button', { name: 'Add' }).click()
      await expect
        .poll(
          async () =>
            ((await rpc(socket, { op: 'account.list' })).accounts as Account[]).find((item) => item.name === name)
              ?.state,
        )
        .toBe('unverified')
      const account = ((await rpc(socket, { op: 'account.list' })).accounts as Account[]).find(
        (item) => item.name === name,
      )
      expect(account).toBeDefined()
      accounts.push(account!)
      expect(account!.state).toBe('unverified')
      await expect(panel.getByLabel(`Account ${name}`)).toContainText(account!.native_home)
      await writeFile(
        join(account!.native_home, 'auth.json'),
        JSON.stringify({
          fixture: `synthetic-secret-${index}`,
          fixture_credential_marker: credentialMarkers[index],
        }),
        { mode: 0o600 },
      )
      await writeFile(
        join(account!.native_home, 'identity.json'),
        JSON.stringify({
          email: `${index === 0 ? 'personal' : 'work'}@example.invalid`,
          accountId: `packaged-${index === 0 ? 'personal' : 'work'}`,
        }),
      )
      await panel.getByRole('button', { name: 'Inspect' }).click()
      await expect(panel.getByRole('status')).toContainText('ready')
      await panel.getByRole('button', { name: 'Verify' }).click()
      await expect(panel.getByLabel(`Account ${name}`)).toContainText(`${name} · verified`)
      await window.getByLabel('New conversation provider').selectOption('codex')
      await window.getByLabel('New conversation account').selectOption(account!.id)
      await window.getByRole('button', { name: 'New conversation', exact: true }).click()
      const conversation = window.getByRole('region', { name: 'Conversation' })
      await expect(conversation).toContainText(`Account: ${name}`)
      await conversation.getByRole('textbox', { name: 'Prompt' }).fill(prompts[index])
      await conversation.getByRole('button', { name: 'Send' }).click()
      await expect
        .poll(
          async () =>
            (
              (await rpc(socket, { op: 'catalog.get' })).catalog as {
                conversations: Conversation[]
              }
            ).conversations.find((item) => item.account_id === account!.id)?.id,
        )
        .toBeTruthy()
      const catalog = (await rpc(socket, { op: 'catalog.get' })).catalog as { conversations: Conversation[] }
      const created = catalog.conversations.find((item) => item.account_id === account!.id)
      expect(created).toMatchObject({ account_id: account!.id, account_context: 'managed' })
      conversations.push(created!)
      await expect
        .poll(
          async () => (await rpc(socket, { op: 'conversation.get', conversation_id: created!.id })).conversation.status,
        )
        .toBe('ready')
      const settled = (await rpc(socket, { op: 'conversation.get', conversation_id: created!.id }))
        .conversation as Conversation
      expect(settled.provider_thread_id).toBeTruthy()
      conversations[index] = settled
    }
    expect(accounts[0].native_home).not.toBe(accounts[1].native_home)
    const verified = (await rpc(socket, { op: 'account.list' })).accounts as Account[]
    expect(verified.map((item) => item.codex_identity?.chatgpt_account_id).sort()).toEqual([
      'packaged-personal',
      'packaged-work',
    ])
    for (const [index, account] of accounts.entries()) {
      expect(JSON.parse(await readFile(join(account.native_home, 'environment.json'), 'utf8'))).toMatchObject({
        codex_home: account.native_home,
        openai_key: false,
        codex_key: false,
        wif: false,
      })
      const calls = await readFile(join(account.native_home, 'calls.jsonl'), 'utf8')
      expect(calls).toContain(prompts[index])
      expect(calls).not.toContain(prompts[1 - index])
      expect(calls).not.toContain('ambient-must-not-leak')
      expect(await turnMarkers(account)).toEqual([credentialMarkers[index]])
    }

    await application.close()
    expect((await rpc(socket, { op: 'hello' })).boot_id).toBe(bootId)
    for (const [index, conversation] of conversations.entries()) {
      await rpc(socket, {
        op: 'agent.send',
        conversation_id: conversation.id,
        request_id: `packaged-closed-${index}`,
        text: closedPrompts[index],
      })
      await expect
        .poll(
          async () =>
            (await rpc(socket, { op: 'conversation.get', conversation_id: conversation.id })).conversation.status,
        )
        .toBe('ready')
    }
    application = await electron.launch({ executablePath: executable, cwd: directory, env })
    window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect(window.getByText('Active profile: Managed accounts')).toBeVisible()
    expect((await rpc(socket, { op: 'hello' })).boot_id).toBe(bootId)
    for (const [index, conversation] of conversations.entries()) {
      const item = window.locator('.conversation-list button').filter({ hasText: `Account: ${names[index]}` })
      await expect(item).toBeVisible()
      await item.click()
      const view = window.getByRole('region', { name: 'Conversation' })
      await expect(view).toContainText(`Account: ${names[index]}`)
      await expect(view.locator('.message-user').filter({ hasText: prompts[index] })).toHaveCount(1)
      await expect(view.locator('.message-user').filter({ hasText: closedPrompts[index] })).toHaveCount(1)
      await expect(view).not.toContainText(prompts[1 - index])
      await expect(view).not.toContainText(closedPrompts[1 - index])
      const snapshot = await rpc(socket, { op: 'conversation.get', conversation_id: conversation.id })
      expect(snapshot.conversation).toMatchObject({
        account_id: accounts[index].id,
        provider_thread_id: conversation.provider_thread_id,
      })
      const calls = await readFile(join(accounts[index].native_home, 'calls.jsonl'), 'utf8')
      expect(calls).toContain(closedPrompts[index])
      expect(calls).not.toContain(closedPrompts[1 - index])
      expect(calls).not.toContain('ambient-must-not-leak')
      expect(await turnMarkers(accounts[index])).toEqual([credentialMarkers[index], credentialMarkers[index]])
    }
    expect(await window.locator('body').innerText()).not.toContain('synthetic-secret')
  } catch (error) {
    if (profileHome) {
      const log = await readFile(join(profileHome, 'daemon.log')).catch(() => Buffer.from('No daemon log was written'))
      await testInfo.attach('packaged-accounts-daemon.log', {
        body: log.subarray(-64 * 1024),
        contentType: 'text/plain',
      })
    }
    throw error
  } finally {
    await application.close().catch(() => undefined)
    if (owned) await stopManagedProfile(owned)
    await rm(directory, { recursive: true, force: true })
  }
})

test('packaged provider entry points run deterministic turns through bundled Node and Bun', async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-package-providers-e2e-'))
  const folder = join(directory, 'project')
  await mkdir(folder)
  const codexMock = join(directory, 'codex-mock.py')
  const ompMock = join(directory, 'omp-mock-cli.mjs')
  // The Claude worker's SDK double; packaging leaves it out of the bundle, so it is staged here.
  const claudeSdkMock = join(directory, 'worker-test-sdk.mjs')
  await Promise.all([
    copyFile(resolve('scripts/fixtures/codex_mock.py'), codexMock),
    copyFile(resolve('providers/omp/mock-cli.mjs'), ompMock),
    ...['worker-test-sdk.mjs', 'worker-test-store.mjs', 'worker-test-scenarios.mjs'].map((name) =>
      copyFile(resolve('providers/claude', name), join(directory, name)),
    ),
  ])
  const codexServer = join(directory, 'codex-unix-server.mjs')
  await writeFile(
    codexServer,
    `
import { spawn } from 'node:child_process';
const endpoint = process.argv[process.argv.indexOf('--listen') + 1];
if (!endpoint?.startsWith('unix://')) throw new Error('Expected Codex Unix endpoint');
const child = spawn('/usr/bin/python3', [process.env.ADE_MOCK_CODEX_SCRIPT], { stdio: ['pipe', 'pipe', 'inherit'] });
let peer, pending = '';
child.stdout.on('data', bytes => {
  pending += bytes.toString();
  let boundary;
  while ((boundary = pending.indexOf('\\n')) >= 0) {
    const line = pending.slice(0, boundary); pending = pending.slice(boundary + 1);
    if (line) peer?.send(line);
  }
});
const server = Bun.serve({ unix: endpoint.slice('unix://'.length),
  fetch(request, server) { return server.upgrade(request) ? undefined : new Response('Upgrade failed', { status: 400 }); },
  websocket: {
    open(socket) { peer = socket; },
    message(_socket, data) { child.stdin.write(String(data) + '\\n'); },
    close() { child.kill('SIGTERM'); },
  },
});
process.on('SIGTERM', () => { child.kill('SIGTERM'); server.stop(); process.exit(0); });
`,
  )
  const codexWrapper = join(directory, 'codex-app-server')
  const ompWrapper = join(directory, 'omp-cli')
  await Promise.all([
    executableWrapper(codexWrapper, bundledBun, codexServer),
    executableWrapper(ompWrapper, bundledBun, ompMock),
  ])

  const env = {
    ...(await isolatedEnvironment(directory)),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    ADE_PROFILES_HOME: join(directory, 'profiles'),
    ADE_E2E_USER_DATA_DIR: join(directory, 'electron'),
    ADE_CODEX_BIN: codexWrapper,
    ADE_MOCK_CODEX_SCRIPT: codexMock,
    ADE_MOCK_DIR: join(directory, 'codex-calls'),
    ADE_E2E_CLAUDE_SDK: claudeSdkMock,
    ADE_CLAUDE_WORKER_TEST_DIR: join(directory, 'claude-calls'),
    ADE_OMP_BIN: ompWrapper,
  }
  const application = await electron.launch({ executablePath: executable, cwd: directory, env })
  let owned: ManagedProfileOwner | null = null
  let runtimeHome: string | null = null
  try {
    const window = await application.firstWindow()
    await window.getByRole('textbox', { name: 'New profile' }).fill('Bundled providers')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const profile = (await window.evaluate(() => window.adeHost.getProfileState())).profiles[0]
    runtimeHome = profile.home
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const located = await promisify(execFile)(nativeControl, ['locate', '--home', profile.home])
    const socket = (JSON.parse(located.stdout) as { socket: string }).socket
    await rpc(socket, { op: 'hello' })
    owned = await managedProfileOwner(socket)
    await window.getByRole('textbox', { name: 'Open folder' }).fill(folder)
    await window.getByRole('button', { name: 'Open folder' }).click()
    const canonicalFolder = await realpath(folder)
    await expect(window.getByText(canonicalFolder, { exact: true })).toBeVisible()

    const catalog = await rpc(socket, { op: 'catalog.get' })
    const workspace = (catalog.catalog as { workspaces: Array<{ id: string; root: string }> }).workspaces.find(
      (item) => item.root === canonicalFolder,
    )
    expect(workspace).toBeDefined()
    for (const [provider, answer] of [
      ['codex', 'Hello world'],
      ['claude', 'Hello Claude'],
      ['omp', 'Hello Oh My Pi'],
    ] as const) {
      const created = await rpc(socket, {
        op: 'conversation.create',
        workspace_id: workspace!.id,
        provider,
        title: `Packaged ${provider}`,
      })
      const conversationId = (created.conversation as { id: string }).id
      await rpc(socket, {
        op: 'agent.send',
        conversation_id: conversationId,
        request_id: `packaged-${provider}-turn`,
        text: `packaged-${provider}`,
      })
      await expect
        .poll(
          async () => {
            const snapshot = await rpc(socket, { op: 'conversation.get', conversation_id: conversationId })
            return (snapshot.messages as Array<{ role: string; text: string }>)
              .filter((item) => item.role === 'assistant')
              .map((item) => item.text)
              .join('\n')
          },
          { timeout: 20_000 },
        )
        .toContain(answer)
    }
    const codexCalls = (await readFile(join(directory, 'codex-calls/calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(codexCalls.filter((line) => JSON.parse(line).method === 'turn/start')).toHaveLength(1)
    const claudeCalls = (await readFile(join(directory, 'claude-calls/calls.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
    expect(claudeCalls.filter((line) => JSON.parse(line).method === 'send')).toHaveLength(1)

    const beforeCount = await window.locator('.conversation-list button').count()
    await window.getByRole('combobox', { name: 'New conversation provider' }).selectOption('claude')
    await window.getByRole('button', { name: 'New conversation' }).click()
    const conversation = window.getByRole('region', { name: 'Conversation' })
    const text = 'draft stays in the new conversation'
    await conversation.getByRole('textbox', { name: 'Prompt' }).fill(text)
    await expect(window.locator('.conversation-list button')).toHaveCount(beforeCount + 1)
    await expect(conversation.getByRole('textbox', { name: 'Prompt' })).toHaveValue(text)
    await expect(conversation.getByRole('button', { name: 'Send' })).toBeEnabled()
  } catch (error) {
    if (runtimeHome) {
      const log = await readFile(join(runtimeHome, 'daemon.log')).catch(() => Buffer.from('No daemon log was written'))
      await testInfo.attach('packaged-providers-daemon.log', {
        body: log.subarray(-64 * 1024),
        contentType: 'text/plain',
      })
    }
    throw error
  } finally {
    await application.close().catch(() => undefined)
    if (owned) await stopManagedProfile(owned)
    await rm(directory, { recursive: true, force: true })
  }
})

test('packaged launcher preserves an incompatible live owner and explains recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-package-incompatible-e2e-'))
  const profilesHome = join(directory, 'profiles')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const created = await execFileAsync(nativeControl, ['profiles', '--home', profilesHome, 'create', 'Future'])
  const profile = (JSON.parse(created.stdout) as { profile: { home: string } }).profile
  const located = await execFileAsync(nativeControl, ['locate', '--home', profile.home])
  const socket = (JSON.parse(located.stdout) as { socket: string }).socket
  const registryBefore = await readFile(join(profilesHome, 'registry.json'), 'utf8')
  let requests = 0
  const server = createServer((peer) => {
    peer.once('data', () => {
      requests++
      peer.end('{"type":"hello","application_protocol":"future-v2","runtime_protocol":"future-v2"}\n')
    })
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(socket, resolveListen)
  })
  let application: Awaited<ReturnType<typeof electron.launch>> | null = null
  try {
    application = await electron.launch({
      executablePath: executable,
      cwd: directory,
      env: {
        ...(await isolatedEnvironment(directory)),
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        ADE_PROFILES_HOME: profilesHome,
        ADE_E2E_USER_DATA_DIR: join(directory, 'electron'),
        ADE_E2E_HIDE_WINDOW: '1',
      },
    })
    const window = await application.firstWindow()
    await expect(window.getByRole('alert')).toContainText('Existing daemon cannot hand off this runtime')
    expect(server.listening).toBe(true)
    expect(requests).toBeGreaterThan(0)
    expect(await readFile(join(profilesHome, 'registry.json'), 'utf8')).toBe(registryBefore)
    const owner = await rpc(socket, { op: 'hello' })
    expect(owner.application_protocol).toBe('future-v2')
  } finally {
    if (application) {
      // This refusal fixture has no connected daemon or admitted work. Stop only its
      // owned Electron child; the incompatible owner must remain alive throughout.
      const child = application.process()
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
    }
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    await rm(directory, { recursive: true, force: true })
  }
})

test('packaged macOS daemon inspects a managed Oh My Pi account with bundled resources', async () => {
  test.setTimeout(90_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-package-omp-account-'))
  const fixture = join(directory, 'omp-fixture.mjs')
  const wrapper = join(directory, 'omp')
  await copyFile(resolve('e2e/fixtures/omp_account_cli.mjs'), fixture)
  await executableWrapper(wrapper, bundledBun, fixture)
  const application = await electron.launch({
    executablePath: executable,
    cwd: directory,
    env: {
      ...(await isolatedEnvironment(directory)),
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      ADE_OMP_BIN: wrapper,
      ADE_PROFILES_HOME: join(directory, 'profiles'),
      ADE_E2E_USER_DATA_DIR: join(directory, 'electron'),
      ADE_E2E_HIDE_WINDOW: '1',
    },
  })
  let owned: ManagedProfileOwner | null = null
  try {
    const window = await application.firstWindow()
    await window.getByRole('textbox', { name: 'New profile' }).fill('OMP')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const profile = (await window.evaluate(() => window.adeHost.getProfileState())).profiles[0]
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const located = await promisify(execFile)(nativeControl, ['locate', '--home', profile.home])
    const socket = (JSON.parse(located.stdout) as { socket: string }).socket
    owned = await managedProfileOwner(socket)
    const account = (await rpc(socket, { op: 'account.create', provider: 'omp', name: 'Packaged OMP' })).account as {
      id: string
      native_home: string
    }
    const database = join(account.native_home, 'agent.db')
    const seed = `import { Database } from 'bun:sqlite';
const db = new Database(process.argv[1], { create: true });
db.run('CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT, identity_key TEXT)');
db.query('INSERT INTO auth_credentials(id,provider,credential_type,data,disabled_cause,identity_key) VALUES(7,?,?,?,?,?)').run(
  'anthropic', 'oauth', JSON.stringify({ email: 'packaged@example.invalid', accountId: 'packaged-account', access: 'secret' }),
  null, 'email:packaged@example.invalid');
db.close();`
    await promisify(execFile)(bundledBun, ['-e', seed, database])
    await chmod(database, 0o600)
    const inspection = (await rpc(socket, { op: 'account.inspect', account_id: account.id })).inspection as {
      state: string
      identity: Record<string, unknown>
    }
    expect(inspection.state).toBe('ready')
    expect(inspection.identity).toMatchObject({
      provider: 'anthropic',
      credential_id: 7,
      email: 'packaged@example.invalid',
    })
    const verified = (
      await rpc(socket, {
        op: 'account.verify',
        account_id: account.id,
        expected_generation: 0,
        expected_identity: inspection.identity,
      })
    ).account as { state: string }
    expect(verified.state).toBe('verified')
    expect(JSON.stringify(verified)).not.toContain('secret')
  } finally {
    await application.close().catch(() => undefined)
    if (owned) await stopManagedProfile(owned)
    await rm(directory, { recursive: true, force: true })
  }
})
