import { test, expect, _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string

test('opens the real Electron desktop with an isolated profile', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-desktop-e2e-'))
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [desktopDirectory],
    env: {
      ...process.env,
      ADE_E2E_USER_DATA_DIR: userData,
      // Without a socket the desktop opens managed profiles; keep that registry
      // inside the test directory, never the real ~/Library profile registry.
      ADE_PROFILES_HOME: join(userData, 'profiles'),
    },
  })

  try {
    const window = await application.firstWindow()
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false)
    await expect(window.getByRole('heading', { name: 'Work across agents, in one place.' })).toBeVisible()
    await expect(window.locator('header').getByRole('status')).toHaveText('unconfigured')
    expect(await window.evaluate(() => (window as typeof window & {
      adeHost: { getAppVersion: () => Promise<string> }
    }).adeHost.getAppVersion())).toBe('0.1.0')
  } finally {
    await application.close()
    await rm(userData, { recursive: true, force: true })
  }
})
