import { expect, test, _electron as electron } from '@playwright/test'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rpc } from '../fixtures/daemon'

const app = resolve(process.env.ADE_E2E_PACKAGE_APP ?? 'dist/electron/mac-arm64/Lux ADE.app')
const executable = join(app, 'Contents/MacOS/Lux ADE')
const resources = join(app, 'Contents/Resources')
const bundledBun = join(resources, 'bin/bun')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

async function executableWrapper(filename: string, binary: string, script: string): Promise<void> {
  await writeFile(filename, `#!/bin/sh\nexec ${shellQuote(binary)} ${shellQuote(script)} "$@"\n`, { mode: 0o755 })
}

async function stopOwned(socket: string, bootId: unknown): Promise<void> {
  const hello = await rpc(socket, { op: 'hello' }).catch(() => null)
  if (!hello || hello.boot_id !== bootId) return
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await rpc(socket, { op: 'runtime.prepare_restart', boot_id: bootId }); break }
    catch (error) {
      if (attempt === 49 || !String(error).includes('A command is still being admitted')) throw error
      await new Promise((done) => setTimeout(done, 100))
    }
  }
  if (typeof hello.runtime_socket !== 'string') return
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await rpc(hello.runtime_socket, { op: 'runtime.stop', instance_id: hello.runtime_instance, stop_active: true })
      return
    } catch (error) {
      if (attempt === 49) throw error
      await new Promise((done) => setTimeout(done, 50))
    }
  }
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
  let owned: { socket: string; bootId: unknown } | null = null
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
    owned = { socket, bootId: hello.boot_id }
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
    if (owned) await stopOwned(owned.socket, owned.bootId)
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
  let owned: { socket: string; bootId: unknown } | null = null
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
    owned = { socket, bootId: hello.boot_id }
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
    if (owned) await stopOwned(owned.socket, owned.bootId)
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
