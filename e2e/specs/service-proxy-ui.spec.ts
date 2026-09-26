import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')
const desktopDirectory = resolve('apps/desktop')
const electronExecutable = createRequire(join(desktopDirectory, 'package.json'))('electron') as string

test('CLI and Electron expose one stable local service URL and open its preview', async () => {
  test.setTimeout(90_000)
  const daemon = await startDaemon()
  const userData = await mkdtemp(join(tmpdir(), 'ade-proxy-ui-e2e-'))
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    await rpc(daemon.socket, { op: 'service.configure', workspace_id: workspace.id,
      name: 'web', revision: 0, config: {
        program: process.execPath, cwd: '.', env: {}, ports: ['PORT'],
        args: ['-e', 'require("http").createServer((_,res)=>res.end("proxy-preview-ready")).listen(Number(process.env.PORT),"127.0.0.1")'],
      },
    })
    const { stdout } = await execFileAsync(process.execPath, [cli, '--socket', daemon.socket,
      'service', 'url', workspace.id, 'web', 'PORT'], { timeout: 12_000 })
    const url = (JSON.parse(stdout) as { url: string }).url
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect((await fetch(url)).status).toBe(503)
    await rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'web' })
    await expect.poll(async () => (await (await fetch(url)).text())).toBe('proxy-preview-ready')

    application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
      env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData } })
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const row = window.getByRole('article', { name: 'Service web' })
    await row.getByRole('button', { name: 'Inspect' }).click()
    await row.getByRole('button', { name: 'Local URL for PORT', exact: true }).click()
    await expect(row).toContainText(url)
    await row.getByRole('button', { name: 'Open preview' }).click()
    await expect.poll(async () => {
      const state = await window.evaluate(() => window.adeHost.browser.list())
      return state.tabs[0]?.observedUrl
    }).toBe(url)
    await rpc(daemon.socket, { op: 'service.stop', workspace_id: workspace.id, name: 'web' })
    await expect.poll(async () => (await fetch(url)).status).toBe(503)
    const previous = (await rpc(daemon.socket, { op: 'service.list', workspace_id: workspace.id }))
      .services as { name: string; revision: number }[]
    await rpc(daemon.socket, { op: 'service.remove', workspace_id: workspace.id,
      name: 'web', revision: previous.find((service) => service.name === 'web')!.revision })
    const replacement = (await rpc(daemon.socket, { op: 'service.configure', workspace_id: workspace.id,
      name: 'web', revision: 0, config: {
        program: process.execPath, cwd: '.', env: {}, ports: ['PORT'],
        args: ['-e', 'require("http").createServer((_,res)=>res.end("proxy-remapped-ready")).listen(Number(process.env.PORT),"127.0.0.1")'],
      },
    })).service as { identity: string; ports: Record<string, number> }
    await rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'web' })
    await expect.poll(async () => (await fetch(url)).status).toBe(503)
    const route = await execFileAsync(process.execPath, [cli, '--socket', daemon.socket,
      'service', 'url-inspect', workspace.id, 'web', 'PORT'], { timeout: 12_000 })
    const previousTarget = JSON.parse(route.stdout) as { service_identity: string; target_port: number }
    const remapped = await execFileAsync(process.execPath, [cli, '--socket', daemon.socket,
      'service', 'remap', workspace.id, 'web', 'PORT', replacement.identity, String(replacement.ports.PORT),
      previousTarget.service_identity, String(previousTarget.target_port)], { timeout: 12_000 })
    expect((JSON.parse(remapped.stdout) as { url: string }).url).toBe(url)
    await expect.poll(async () => (await (await fetch(url)).text())).toBe('proxy-remapped-ready')

    await rpc(daemon.socket, { op: 'service.stop', workspace_id: workspace.id, name: 'web' })
    const second = (await rpc(daemon.socket, { op: 'service.list', workspace_id: workspace.id }))
      .services as { name: string; revision: number }[]
    await rpc(daemon.socket, { op: 'service.remove', workspace_id: workspace.id,
      name: 'web', revision: second.find((service) => service.name === 'web')!.revision })
    await rpc(daemon.socket, { op: 'service.configure', workspace_id: workspace.id,
      name: 'web', revision: 0, config: {
        program: process.execPath, cwd: '.', env: {}, ports: ['PORT'],
        args: ['-e', 'require("http").createServer((_,res)=>res.end("proxy-ui-remapped-ready")).listen(Number(process.env.PORT),"127.0.0.1")'],
      },
    })
    await rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'web' })
    await expect.poll(async () => (await fetch(url)).status).toBe(503)
    await window.getByRole('region', { name: 'Workspace services' }).getByRole('button', { name: 'Refresh' }).click()
    const replacementRow = window.getByRole('article', { name: 'Service web' })
    await replacementRow.getByRole('button', { name: 'Local URL for PORT', exact: true }).click()
    await expect(replacementRow.getByRole('button', { name: 'Remap URL to this service' })).toBeVisible()
    await replacementRow.getByRole('button', { name: 'Remap URL to this service' }).click()
    await expect.poll(async () => (await (await fetch(url)).text())).toBe('proxy-ui-remapped-ready')
    const beforeRetire = await execFileAsync(process.execPath, [cli, '--socket', daemon.socket,
      'service', 'url-inspect', workspace.id, 'web', 'PORT'], { timeout: 12_000 })
    const pinned = JSON.parse(beforeRetire.stdout) as { route_id: string; port: number; service_identity: string; target_port: number }
    await replacementRow.getByRole('button', { name: 'Retire local URL for PORT' }).click()
    await expect(replacementRow.getByRole('button', { name: 'Retire local URL for PORT' })).toHaveCount(0)
    await expect(fetch(url)).rejects.toThrow()
    const renewed = await execFileAsync(process.execPath, [cli, '--socket', daemon.socket,
      'service', 'url', workspace.id, 'web', 'PORT'], { timeout: 12_000 })
    const next = JSON.parse(renewed.stdout) as { route_id: string; url: string; port: number; service_identity: string; target_port: number }
    expect(next.route_id).not.toBe(pinned.route_id)
    const retired = await execFileAsync(process.execPath, [cli, '--socket', daemon.socket,
      'service', 'url-retire', workspace.id, 'web', 'PORT', next.route_id, next.service_identity,
      String(next.target_port), String(next.port)], { timeout: 12_000 })
    expect((JSON.parse(retired.stdout) as { route_id: string }).route_id).toBe(next.route_id)
    await expect(fetch(next.url)).rejects.toThrow()
  } finally {
    await application?.close()
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})
