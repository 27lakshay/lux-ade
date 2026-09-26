import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')
const desktopDirectory = resolve('apps/desktop')
const electronExecutable = createRequire(join(desktopDirectory, 'package.json'))('electron') as string

test('a workspace script feeds a managed service through a stable URL and browser preview', async () => {
  test.setTimeout(90_000)
  const daemon = await startDaemon()
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    await writeFile(join(daemon.rootDirectory, 'package.json'), JSON.stringify({
      name: 'ade-daily-flow-e2e', private: true,
      scripts: { build: 'node -e "require(\'fs\').writeFileSync(\'generated.txt\',\'daily-flow-ready\')"' },
    }))
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    const runCli = async (...args: string[]): Promise<Record<string, unknown>> => {
      const { stdout } = await execFileAsync(process.execPath, [cli, '--socket', daemon.socket, ...args],
        { timeout: 12_000 })
      return JSON.parse(stdout) as Record<string, unknown>
    }
    const launch = () => electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
      env: { ...process.env, ADE_SOCKET: daemon.socket,
        ADE_E2E_USER_DATA_DIR: join(daemon.rootDirectory, 'electron') } })

    application = await launch()
    let window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('article', { name: 'Script build' }).getByRole('button', { name: 'Run' }).click()
    const run = window.getByRole('article', { name: 'Script run build' })
    await expect(run).toContainText('Execution: succeeded')
    const runs = await runCli('script', 'runs', workspace.id)
    expect((runs.runs as Array<{ name: string }>)[0].name).toBe('build')

    const configured = await runCli('service', 'configure', workspace.id, 'web', JSON.stringify({
      program: process.execPath, cwd: '.', env: {}, ports: ['PORT'],
      args: ['-e', 'require("http").createServer((_,res)=>res.end(require("fs").readFileSync("generated.txt"))).listen(Number(process.env.PORT),"127.0.0.1")'],
      health: { port_variable: 'PORT', path: '/', timeout_ms: 250, interval_ms: 1000 },
    }))
    expect(configured.type).toBe('service')
    const row = window.getByRole('article', { name: 'Service web' })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: 'Start' }).click()
    await expect(row).toContainText('running')
    await row.getByRole('button', { name: 'Inspect' }).click()
    await row.getByRole('button', { name: 'Local URL for PORT' }).click()
    const route = await runCli('service', 'url-inspect', workspace.id, 'web', 'PORT') as { url: string }
    await expect.poll(async () => (await (await fetch(route.url)).text())).toBe('daily-flow-ready')
    await row.getByRole('button', { name: 'Open preview' }).click()
    await expect.poll(async () => (await window.evaluate(() => window.adeHost.browser.list())).tabs[0]?.observedUrl)
      .toBe(route.url)
    await expect(row).toContainText('Monitored HTTP: healthy (200)')

    await application.close()
    application = await launch()
    window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect(window.getByRole('article', { name: 'Service web' })).toContainText('running')
    expect(await (await fetch(route.url)).text()).toBe('daily-flow-ready')
    expect((await window.evaluate(() => window.adeHost.browser.list())).tabs[0]?.observedUrl).toBe(route.url)
    await runCli('service', 'stop', workspace.id, 'web')
    await expect.poll(async () => (await fetch(route.url)).status).toBe(503)
  } finally {
    await application?.close()
    await daemon.stop()
  }
})
