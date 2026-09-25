import { expect, test, _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { rpc, startDaemon } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string

test('terminal input and screen survive an Electron renderer reload', async () => {
  const daemon = await startDaemon()
  const userData = await mkdtemp(join(tmpdir(), 'ade-terminal-e2e-'))
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData },
  })

  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const surface = window.locator('.terminal-surface')
    await expect(surface.locator('.xterm-rows')).toBeVisible()
    const before = await rpc(daemon.socket, { op: 'runtime.status' })
    const shellPid = (before.terminals as Array<{ metrics: { shell_pid: number } }>)[0].metrics.shell_pid

    await surface.click()
    await window.keyboard.type('echo __ADE_ELECTRON_TERMINAL__')
    await window.keyboard.press('Enter')
    await expect(surface.locator('.xterm-rows')).toContainText('__ADE_ELECTRON_TERMINAL__')

    await writeFile(join(daemon.rootDirectory, 'query.py'), `import os, re, select, termios, tty\nfd=0\nold=termios.tcgetattr(fd)\ntry:\n tty.setraw(fd)\n os.write(1,b'\\x1b[6n')\n data=b''\n while select.select([fd],[],[],0.3)[0]: data+=os.read(fd,1024)\nfinally:\n termios.tcsetattr(fd,termios.TCSADRAIN,old)\nprint('__ADE_QUERY_REPLIES__='+str(len(re.findall(rb'\\x1b\\[[0-9;]*R',data))))\n`)
    await window.keyboard.type('python3 query.py')
    await window.keyboard.press('Enter')
    await expect(surface.locator('.xterm-rows')).toContainText('__ADE_QUERY_REPLIES__=1')

    await writeFile(join(daemon.rootDirectory, 'alternate.py'), `import os, sys\nos.write(1,b'\\x1b[?1049h\\x1b[2J\\x1b[H__ADE_ALT_SCREEN__')\nsys.stdin.readline()\nos.write(1,b'\\x1b[?1049l')\n`)
    await window.keyboard.type('python3 alternate.py')
    await window.keyboard.press('Enter')
    await expect(surface.locator('.xterm-rows')).toContainText('__ADE_ALT_SCREEN__')

    await window.reload()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect(window.locator('.terminal-surface .xterm-rows')).toContainText('__ADE_ALT_SCREEN__')
    const after = await rpc(daemon.socket, { op: 'runtime.status' })
    expect((after.terminals as Array<{ metrics: { shell_pid: number } }>)[0].metrics.shell_pid).toBe(shellPid)
    await window.locator('.terminal-surface').click()
    await window.keyboard.press('Enter')
    await expect(window.locator('.terminal-surface .xterm-rows')).toContainText('__ADE_ELECTRON_TERMINAL__')
  } finally {
    await application.close()
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})
