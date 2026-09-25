import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')
const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string

async function runCli(socket: string, ...args: string[]): Promise<{ code: number; output: Record<string, unknown> }> {
  try {
    const result = await execFileAsync(process.execPath, [cli, '--socket', socket, ...args], { timeout: 12_000 })
    return { code: 0, output: JSON.parse(result.stdout) as Record<string, unknown> }
  } catch (error) {
    const failure = error as Error & { code?: number; stderr?: string }
    if (typeof failure.code !== 'number' || !failure.stderr) throw failure
    return { code: failure.code, output: JSON.parse(failure.stderr) as Record<string, unknown> }
  }
}

test('CLI and Electron control one runtime-owned workspace terminal', async () => {
  const daemon = await startDaemon()
  const userData = await mkdtemp(join(tmpdir(), 'ade-cli-electron-e2e-'))
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData },
  })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect(window.locator('.terminal-surface .xterm-rows')).toBeVisible()
    const catalogue = await rpc(daemon.socket, { op: 'catalog.get' })
    const workspace = (catalogue.catalog as {
      workspaces: Array<{ id: string; terminal_id: string }>
    }).workspaces[0]
    const listed = await runCli(daemon.socket, 'workspace', 'list')
    expect(listed.code).toBe(0)
    expect(listed.output.workspaces).toEqual(expect.arrayContaining([expect.objectContaining({ id: workspace.id })]))

    const inspected = await runCli(daemon.socket, 'terminal', 'inspect', workspace.id, workspace.terminal_id)
    expect(inspected.code).toBe(0)
    expect(inspected.output.type).toBe('snapshot')
    expect((inspected.output.metrics as { terminal_id: string }).terminal_id).toBe(workspace.terminal_id)
    const shellPid = (inspected.output.metrics as { shell_pid: number }).shell_pid

    const sent = await runCli(daemon.socket, 'terminal', 'send', workspace.id, workspace.terminal_id, 'echo __ADE_CLI_SHARED_TERMINAL__')
    expect(sent.code).toBe(0)
    expect(sent.output.type).toBe('terminal_input_submitted')
    expect((sent.output.metrics as { shell_pid: number }).shell_pid).toBe(shellPid)
    await expect.poll(async () => {
      const snapshot = await runCli(daemon.socket, 'terminal', 'inspect', workspace.id, workspace.terminal_id)
      const events = (snapshot.output.terminal_recovery as { events: Array<{ type: string; bytes_base64?: string }> }).events
      return events.filter((event) => event.type === 'output' && event.bytes_base64)
        .map((event) => Buffer.from(event.bytes_base64!, 'base64').toString('utf8')).join('')
    }).toContain('__ADE_CLI_SHARED_TERMINAL__')
    await window.locator('.terminal-surface').scrollIntoViewIfNeeded()
    await expect(window.locator('.terminal-surface .xterm-rows')).toContainText('__ADE_CLI_SHARED_TERMINAL__')

    const resized = await runCli(daemon.socket, 'terminal', 'resize', workspace.id, workspace.terminal_id, '90', '31')
    expect(resized.code).toBe(0)
    expect(resized.output).toMatchObject({ type: 'terminal_resize_submitted', cols: 90, rows: 31 })
    const after = await runCli(daemon.socket, 'terminal', 'inspect', workspace.id, workspace.terminal_id)
    expect(after.code).toBe(0)
    const recovery = after.output.terminal_recovery as { events: Array<Record<string, unknown>> }
    expect(recovery.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'resize', cols: 90, rows: 31 })]))
    const runtime = await rpc(daemon.socket, { op: 'runtime.status' })
    const terminals = runtime.terminals as Array<{ metrics: { shell_pid: number; terminal_id: string } }>
    expect(terminals.find((item) => item.metrics.terminal_id === workspace.terminal_id)?.metrics.shell_pid).toBe(shellPid)
  } finally {
    await application.close()
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})

test('CLI distinguishes an unavailable socket from an incompatible daemon protocol', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-cli-endpoint-e2e-'))
  const missing = join(directory, 'missing.sock')
  const incompatible = join(directory, 'incompatible.sock')
  const unavailable = await runCli(missing, 'status')
  expect(unavailable).toMatchObject({ code: 3, output: { type: 'error', code: 'unavailable' } })

  const server = createServer((peer) => {
    peer.once('data', () => peer.write('{"type":"hello","application_protocol":"future-v2","session_protocol":"ade-sessions-v1"}\n'))
  })
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(incompatible, resolveListen)
    })
    const mismatch = await runCli(incompatible, 'status')
    expect(mismatch).toMatchObject({ code: 4, output: { type: 'error', code: 'incompatible' } })
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    await rm(directory, { recursive: true, force: true })
  }
})
