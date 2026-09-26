import { expect, test, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { managedProfileOwner, stopManagedProfile, stopManagedProfiles, type ManagedProfileOwner, rpc } from '../fixtures/daemon'

const app = resolve(process.env.ADE_E2E_PACKAGE_APP ?? 'dist/electron/mac-arm64/Lux ADE.app')
const executable = join(app, 'Contents/MacOS/Lux ADE')
const resources = join(app, 'Contents/Resources')
const bundledBun = join(resources, 'bin/bun')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

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
  const { ADE_SOCKET: _socket, ADE_ROOT: _root, ADE_RESOURCE_DIR: _resources,
    ADE_DAEMON_BIN: _daemonBinary, ADE_NODE_BIN: _nodeBinary, ADE_BUN_BIN: _bunBinary,
    ADE_PYTHON_BIN: _pythonBinary, ADE_OMP_BRIDGE: _ompBridge,
    ADE_CLAUDE_BRIDGE: _claudeBridge, ...parentEnvironment } = process.env
  const env = {
    ...parentEnvironment,
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
    const result = await promisify(locate.execFile)('/usr/bin/python3', [join(app, 'Contents/Resources/runtime.py'), 'locate', '--home', profile.home])
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
    await expect(window.getByRole('region', { name: 'Conversation' }).locator('.message-assistant')).toContainText('Hello world')
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
  await writeFile(join(folder, 'package.json'), JSON.stringify({
    name: 'ade-packaged-script', private: true,
    packageManager: `npm@${execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()}`,
    scripts: { check: 'node -e "console.log(\'PACKAGED_SCRIPT_READY\')"' },
  }))
  await writeFile(join(folder, '.node-version'), `${process.version.slice(1)}\n`)
  await mkdir(join(folder, '.ade'))
  await writeFile(join(folder, '.ade', 'scripts.json'), JSON.stringify({
    schema_version: 1,
    scripts: { recipe_check: {
      program: 'node', args: ['-e', "console.log('PACKAGED_RECIPE_READY')"], cwd: '.',
    } },
  }))
  const { ADE_SOCKET: _socket, ADE_ROOT: _root, ADE_DAEMON_BIN: _daemonBinary,
    ...parentEnvironment } = process.env
  const env = { ...parentEnvironment,
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
    const located = await promisify(execFile)('/usr/bin/python3', [join(resources, 'runtime.py'), 'locate', '--home', profile.home])
    const socket = (JSON.parse(located.stdout) as { socket: string }).socket
    owned = { ...await managedProfileOwner(socket), home: profile.home }
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
    const restored = window.getByRole('region', { name: 'Workspace scripts' })
      .getByRole('article', { name: 'Script run check' })
    await expect(restored).toContainText('succeeded')
    await restored.getByRole('button', { name: 'Inspect output' }).click()
    await expect(restored).toContainText('PACKAGED_SCRIPT_READY')
    const restoredRecipe = window.getByRole('region', { name: 'Workspace scripts' })
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
  const { ADE_SOCKET: _socket, ADE_ROOT: _root, ADE_RESOURCE_DIR: _resources,
    ADE_DAEMON_BIN: _daemonBinary, ADE_NODE_BIN: _nodeBinary, ADE_BUN_BIN: _bunBinary,
    ADE_PYTHON_BIN: _pythonBinary, ADE_OMP_BRIDGE: _ompBridge,
    ADE_CLAUDE_BRIDGE: _claudeBridge, ...parentEnvironment } = process.env
  const env = {
    ...parentEnvironment,
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
      const located = await execFileAsync('/usr/bin/python3', [join(resources, 'runtime.py'), 'locate', '--home', profile!.home])
      const socket = (JSON.parse(located.stdout) as { socket: string }).socket
      const hello = await rpc(socket, { op: 'hello' })
      owned.push({ ...await managedProfileOwner(socket), id: profile!.id, home: profile!.home })

      await window.getByRole('textbox', { name: 'Open folder' }).fill(folders[index])
      await window.getByRole('button', { name: 'Open folder' }).click()
      const workspace = await realpath(folders[index])
      await expect(window.getByText(workspace, { exact: true })).toBeVisible()
      const terminal = window.locator('.terminal-surface')
      await expect(terminal.locator('.xterm-rows')).toBeVisible()
      await terminal.click()
      await window.keyboard.type(`export ADE_PROFILE_VALUE=${name.toUpperCase()}; printf 'PROFILE_%s_SHELL\\n' "$ADE_PROFILE_VALUE"`)
      await window.keyboard.press('Enter')
      await expect(terminal.locator('.xterm-rows')).toContainText(`PROFILE_${name.toUpperCase()}_SHELL`)

      await window.getByRole('button', { name: 'New conversation' }).click()
      const conversation = window.getByRole('region', { name: 'Conversation' })
      await conversation.getByRole('textbox', { name: 'Prompt' }).fill(`profile-${name.toLowerCase()}-turn`)
      await conversation.getByRole('button', { name: 'Send' }).click()
      await expect(conversation.locator('.message-assistant')).toContainText('Hello world')
      const catalog = await rpc(socket, { op: 'catalog.get' })
      const records = catalog.catalog as { workspaces: Array<{ id: string; root: string }>;
        conversations: Array<{ id: string; workspace_id: string }> }
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
    await expect(window.evaluate(() => window.adeHost.selectProfile('00000000-0000-4000-8000-000000000000'))).rejects.toThrow('Unknown profile')
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
      await expect(window.getByRole('region', { name: 'Conversation' }).locator('.message-assistant')).toContainText('Hello world')
      await expect(window.getByText(profiles[profile.name === 'Alpha' ? 1 : 0].workspace, { exact: true })).toHaveCount(0)
      const owner = owned.find((item) => item.id === profile.id)
      expect(owner).toBeDefined()
      expect((await rpc(owner!.socket, { op: 'hello' })).boot_id).toBe(owner!.bootId)
      const runtime = await rpc(owner!.socket, { op: 'runtime.status' })
      expect((runtime.terminals as Array<{ metrics: { shell_pid: number } }>)[0].metrics.shell_pid).toBe(profile.shellPid)
      const terminal = window.locator('.terminal-surface')
      await expect(terminal.locator('.xterm-rows')).toBeVisible()
      await terminal.hover()
      await window.mouse.wheel(0, 10_000)
      await expect(terminal.locator('.xterm-rows')).toContainText(`PROFILE_${profile.name.toUpperCase()}_SHELL`, { timeout: 30_000 })
      await expect(terminal.locator('.xterm-rows')).toContainText('❯')
      await terminal.click()
      await window.keyboard.type('printf "RESTORED_%s\\n" "$ADE_PROFILE_VALUE"')
      await window.keyboard.press('Enter')
      await window.mouse.wheel(0, 10_000)
      await expect(terminal.locator('.xterm-rows')).toContainText(`RESTORED_${profile.name.toUpperCase()}`)
      const snapshot = await rpc(owner!.socket, { op: 'conversation.get', conversation_id: profile.conversationId })
      expect((snapshot.messages as Array<{ role: string; text: string }>).some((message) =>
        message.role === 'user' && message.text === `profile-${profile.name.toLowerCase()}-turn`)).toBe(true)
    }
  } catch (error) {
    for (const owner of owned) {
      const log = await readFile(join(owner.home, 'daemon.log')).catch(() => Buffer.from('No daemon log was written'))
      await testInfo.attach(`packaged-${owner.home.split('/').at(-1)}-daemon.log`,
        { body: log.subarray(-64 * 1024), contentType: 'text/plain' })
    }
    throw error
  } finally {
    await application.close().catch(() => undefined)
    await stopManagedProfiles(owned)
    await rm(directory, { recursive: true, force: true })
  }
})

test('packaged provider entry points run deterministic turns through bundled Node and Bun', async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-package-providers-e2e-'))
  const folder = join(directory, 'project')
  await mkdir(folder)
  const codexMock = join(directory, 'codex-mock.py')
  const ompMock = join(directory, 'omp-mock-cli.mjs')
  const claudeSdkMock = join(directory, 'claude-fake-sdk.mjs')
  await Promise.all([
    copyFile(resolve('scripts/fixtures/codex_mock.py'), codexMock),
    copyFile(resolve('providers/omp/mock-cli.mjs'), ompMock),
    copyFile(resolve('providers/claude/fake-sdk.mjs'), claudeSdkMock),
  ])
  const codexServer = join(directory, 'codex-unix-server.mjs')
  await writeFile(codexServer, `
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
`)
  const claudeRunner = join(directory, 'claude-runner.mjs')
  await writeFile(claudeRunner, `
import { serve } from ${JSON.stringify(pathToFileURL(join(resources, 'providers/claude/bridge.mjs')).href)};
import { fakeSdk } from ${JSON.stringify(pathToFileURL(claudeSdkMock).href)};
process.env.ADE_CLAUDE_BIN = process.execPath;
serve(fakeSdk(process.env.ADE_MOCK_CLAUDE_DIR));
`)
  const codexWrapper = join(directory, 'codex-app-server')
  const claudeWrapper = join(directory, 'claude-bridge')
  const ompWrapper = join(directory, 'omp-cli')
  await Promise.all([
    executableWrapper(codexWrapper, bundledBun, codexServer),
    executableWrapper(claudeWrapper, executable, claudeRunner),
    executableWrapper(ompWrapper, bundledBun, ompMock),
  ])

  const { ADE_SOCKET: _socket, ADE_ROOT: _root, ADE_RESOURCE_DIR: _resources,
    ADE_DAEMON_BIN: _daemonBinary, ADE_NODE_BIN: _nodeBinary, ADE_BUN_BIN: _bunBinary,
    ADE_PYTHON_BIN: _pythonBinary, ADE_CODEX_TRANSPORT: _codexTransport,
    ADE_OMP_BRIDGE: _ompBridge, ADE_CLAUDE_BRIDGE: _claudeBridge, ...parentEnvironment } = process.env
  const env = {
    ...parentEnvironment,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    ADE_PROFILES_HOME: join(directory, 'profiles'),
    ADE_E2E_USER_DATA_DIR: join(directory, 'electron'),
    ADE_CODEX_BIN: codexWrapper,
    ADE_MOCK_CODEX_SCRIPT: codexMock,
    ADE_MOCK_DIR: join(directory, 'codex-calls'),
    ADE_CLAUDE_BRIDGE_BIN: claudeWrapper,
    ADE_MOCK_CLAUDE_DIR: join(directory, 'claude-calls'),
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
    const located = await promisify(execFile)('/usr/bin/python3', [join(resources, 'runtime.py'), 'locate', '--home', profile.home])
    const socket = (JSON.parse(located.stdout) as { socket: string }).socket
    const hello = await rpc(socket, { op: 'hello' })
    owned = await managedProfileOwner(socket)
    await window.getByRole('textbox', { name: 'Open folder' }).fill(folder)
    await window.getByRole('button', { name: 'Open folder' }).click()
    const canonicalFolder = await realpath(folder)
    await expect(window.getByText(canonicalFolder, { exact: true })).toBeVisible()

    const catalog = await rpc(socket, { op: 'catalog.get' })
    const workspace = (catalog.catalog as { workspaces: Array<{ id: string; root: string }> }).workspaces
      .find((item) => item.root === canonicalFolder)
    expect(workspace).toBeDefined()
    for (const [provider, answer] of [
      ['codex', 'Hello world'], ['claude', 'Hello Claude'], ['omp', 'Hello Oh My Pi'],
    ] as const) {
      const created = await rpc(socket, { op: 'conversation.create', workspace_id: workspace!.id,
        provider, title: `Packaged ${provider}` })
      const conversationId = (created.conversation as { id: string }).id
      await rpc(socket, { op: 'agent.send', conversation_id: conversationId,
        request_id: `packaged-${provider}-turn`, text: `packaged-${provider}` })
      await expect.poll(async () => {
        const snapshot = await rpc(socket, { op: 'conversation.get', conversation_id: conversationId })
        return (snapshot.messages as Array<{ role: string; text: string }>).filter((item) => item.role === 'assistant')
          .map((item) => item.text).join('\n')
      }, { timeout: 20_000 }).toContain(answer)
    }
    const codexCalls = (await readFile(join(directory, 'codex-calls/calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(codexCalls.filter((line) => JSON.parse(line).method === 'turn/start')).toHaveLength(1)
    const claudeCalls = (await readFile(join(directory, 'claude-calls/calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
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
      await testInfo.attach('packaged-providers-daemon.log', { body: log.subarray(-64 * 1024), contentType: 'text/plain' })
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
  const created = await execFileAsync('/usr/bin/python3', [join(resources, 'profiles.py'), '--home', profilesHome, 'create', 'Future'])
  const profile = (JSON.parse(created.stdout) as { profile: { home: string } }).profile
  const located = await execFileAsync('/usr/bin/python3', [join(resources, 'runtime.py'), 'locate', '--home', profile.home])
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
  const { ADE_SOCKET: _socket, ADE_ROOT: _root, ADE_RESOURCE_DIR: _resources,
    ADE_DAEMON_BIN: _daemonBinary, ADE_NODE_BIN: _nodeBinary, ADE_BUN_BIN: _bunBinary,
    ADE_PYTHON_BIN: _pythonBinary, ...parentEnvironment } = process.env
  const application = await electron.launch({ executablePath: executable, cwd: directory,
    env: { ...parentEnvironment, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ADE_PROFILES_HOME: profilesHome,
      ADE_E2E_USER_DATA_DIR: join(directory, 'electron') } })
  try {
    const window = await application.firstWindow()
    await expect(window.getByRole('alert')).toContainText('Existing daemon cannot hand off this runtime')
    expect(server.listening).toBe(true)
    expect(requests).toBeGreaterThan(0)
    expect(await readFile(join(profilesHome, 'registry.json'), 'utf8')).toBe(registryBefore)
    const owner = await rpc(socket, { op: 'hello' })
    expect(owner.application_protocol).toBe('future-v2')
  } finally {
    await application.close()
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
  const { ADE_SOCKET: _socket, ADE_ROOT: _root, ADE_RESOURCE_DIR: _resourceRoot,
    ADE_DAEMON_BIN: _daemonBinary, ADE_BUN_BIN: _bunBinary,
    ADE_OMP_BRIDGE: _ompBridge, ...parentEnvironment } = process.env
  const application = await electron.launch({ executablePath: executable, cwd: directory,
    env: { ...parentEnvironment, PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      ADE_OMP_BIN: wrapper, ADE_PROFILES_HOME: join(directory, 'profiles'),
      ADE_E2E_USER_DATA_DIR: join(directory, 'electron'), ADE_E2E_HIDE_WINDOW: '1' } })
  let owned: ManagedProfileOwner | null = null
  try {
    const window = await application.firstWindow()
    await window.getByRole('textbox', { name: 'New profile' }).fill('OMP')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const profile = (await window.evaluate(() => window.adeHost.getProfileState())).profiles[0]
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const located = await promisify(execFile)('/usr/bin/python3', [join(resources, 'runtime.py'), 'locate', '--home', profile.home])
    const socket = (JSON.parse(located.stdout) as { socket: string }).socket
    owned = await managedProfileOwner(socket)
    const account = (await rpc(socket, { op: 'account.create', provider: 'omp', name: 'Packaged OMP' })).account as
      { id: string; native_home: string }
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
    const inspection = (await rpc(socket, { op: 'account.inspect', account_id: account.id })).inspection as
      { state: string; identity: Record<string, unknown> }
    expect(inspection.state).toBe('ready')
    expect(inspection.identity).toMatchObject({ provider: 'anthropic', credential_id: 7,
      email: 'packaged@example.invalid' })
    const verified = (await rpc(socket, { op: 'account.verify', account_id: account.id,
      expected_generation: 0, expected_identity: inspection.identity })).account as { state: string }
    expect(verified.state).toBe('verified')
    expect(JSON.stringify(verified)).not.toContain('secret')
  } finally {
    await application.close().catch(() => undefined)
    if (owned) await stopManagedProfile(owned)
    await rm(directory, { recursive: true, force: true })
  }
})
