import { expect, test, _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { rpc, startDaemon } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const electronExecutable = createRequire(join(desktopDirectory, 'package.json'))('electron') as string

test('Electron runs and stops a workspace package script across window closure', async () => {
  test.setTimeout(60_000)
  const daemon = await startDaemon()
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    await writeFile(join(daemon.rootDirectory, 'package.json'), JSON.stringify({
      name: 'ade-script-desktop-e2e', private: true,
      scripts: { serve: 'node -e "console.log(\'DESKTOP_SCRIPT_READY\'); setInterval(()=>{},1000)"' },
    }))
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    const launch = async (): Promise<Awaited<ReturnType<typeof electron.launch>>> => electron.launch({
      executablePath: electronExecutable,
      args: [desktopDirectory],
      env: { ...process.env, ADE_SOCKET: daemon.socket,
        ADE_E2E_USER_DATA_DIR: join(daemon.rootDirectory, 'electron') },
    })
    application = await launch()
    let window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const scripts = window.getByRole('region', { name: 'Workspace scripts' })
    const script = scripts.getByRole('article', { name: 'Script serve' })
    await expect(script).toBeVisible()
    await script.getByRole('button', { name: 'Run' }).click()
    const run = scripts.getByRole('article', { name: 'Script run serve' })
    await expect(run).toContainText('running')
    await expect(run).toContainText('DESKTOP_SCRIPT_READY')
    const id = (await rpc(daemon.socket, { op: 'script.runs', workspace_id: workspace.id })).runs as
      Array<{ run_id: string; metrics: { shell_pid: number } }>
    expect(id).toHaveLength(1)
    const pid = id[0].metrics.shell_pid

    await application.close()
    application = await launch()
    window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const reopened = window.getByRole('region', { name: 'Workspace scripts' })
      .getByRole('article', { name: 'Script run serve' })
    await expect(reopened).toContainText('running')
    const same = (await rpc(daemon.socket, { op: 'script.inspect', workspace_id: workspace.id,
      run_id: id[0].run_id })).metrics as { shell_pid: number }
    expect(same.shell_pid).toBe(pid)
    await reopened.getByRole('button', { name: 'Stop' }).click()
    await expect(reopened).toContainText('exited')
    await reopened.getByRole('button', { name: 'Retire' }).click()
    await expect(reopened).toHaveCount(0)
  } finally {
    await application?.close()
    await daemon.stop()
  }
})
