import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')
const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string

async function runCli(socket: string, ...args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(process.execPath, [cli, '--socket', socket, ...args], { timeout: 12_000 })
  return JSON.parse(stdout) as Record<string, unknown>
}

async function runCliFailure(socket: string, ...args: string[]): Promise<Record<string, unknown>> {
  try {
    await runCli(socket, ...args)
    throw new Error('CLI unexpectedly accepted an invalid service')
  } catch (error) {
    const failure = error as Error & { code?: number; stderr?: string }
    if (typeof failure.code !== 'number' || !failure.stderr) throw failure
    return JSON.parse(failure.stderr) as Record<string, unknown>
  }
}

test('CLI and Electron share a managed workspace service across app closure', async () => {
  const daemon = await startDaemon()
  const userData = await mkdtemp(join(tmpdir(), 'ade-service-electron-e2e-'))
  const launch = () => electron.launch({
    executablePath: electronExecutable,
    args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData },
  })
  let application = await launch()
  try {
    let window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const catalogue = await rpc(daemon.socket, { op: 'catalog.get' })
    const workspace = (catalogue.catalog as { workspaces: Array<{ id: string }> }).workspaces[0]
    const invalid = await runCliFailure(daemon.socket, 'service', 'configure', workspace.id, 'invalid-recipe', JSON.stringify({
      program: '', args: [], cwd: '.', env: {}, ports: [],
    }))
    expect(invalid).toMatchObject({ type: 'error', code: 'daemon' })
    expect(String(invalid.message)).toContain('Invalid service executable')
    const config = {
      program: process.execPath,
      args: ['-e', 'require("http").createServer((_,res)=>res.end("ade-service-ready")).listen(Number(process.env.PORT),"127.0.0.1")'],
      cwd: '.', env: {}, ports: ['PORT'],
    }
    const configured = await runCli(daemon.socket, 'service', 'configure', workspace.id, 'web', JSON.stringify(config))
    expect(configured.type).toBe('service')
    const service = configured.service as { ports: { PORT: number } }
    const port = service.ports.PORT
    expect(port).toBeGreaterThan(1023)
    const row = window.getByRole('article', { name: 'Service web' })
    await expect(row).toContainText(`PORT=${port}`)
    await expect(row).toContainText('stopped')

    const started = await runCli(daemon.socket, 'service', 'start', workspace.id, 'web')
    expect(started.type).toBe('service')
    await expect(row).toContainText('running')
    await expect.poll(async () => {
      try { return await (await fetch(`http://127.0.0.1:${port}`)).text() }
      catch { return '' }
    }).toBe('ade-service-ready')

    await application.close()
    const afterClose = await runCli(daemon.socket, 'service', 'list', workspace.id)
    expect((afterClose.states as Record<string, { state: string }>).web.state).toBe('running')
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('ade-service-ready')
    application = await launch()
    window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect(window.getByRole('article', { name: 'Service web' })).toContainText('running')
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('ade-service-ready')

    await window.getByRole('article', { name: 'Service web' }).getByRole('button', { name: 'Stop' }).click()
    await expect(window.getByRole('article', { name: 'Service web' })).toContainText('stopped')
    const stopped = await runCli(daemon.socket, 'service', 'list', workspace.id)
    expect((stopped.states as Record<string, { state: string }>).web.state).toBe('stopped')
    await expect.poll(async () => {
      try { await fetch(`http://127.0.0.1:${port}`); return false }
      catch { return true }
    }).toBe(true)

    await window.getByRole('article', { name: 'Service web' }).getByRole('button', { name: 'Start' }).click()
    await expect(window.getByRole('article', { name: 'Service web' })).toContainText('running')
    const final = await runCli(daemon.socket, 'service', 'stop', workspace.id, 'web')
    expect(final.type).toBe('service')
  } finally {
    await application.close()
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})
