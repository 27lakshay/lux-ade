import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string
const execFileAsync = promisify(execFile)

test('typing in a newly created conversation survives draft loading', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-conversation-switch-e2e-'))
  const { ADE_SOCKET: _socket, ...environment } = process.env
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [desktopDirectory],
    env: { ...environment, ADE_PROFILES_HOME: join(userData, 'profiles'),
      ADE_E2E_USER_DATA_DIR: join(userData, 'electron'), ADE_DAEMON_BIN: resolve('target/debug/ade-daemon') },
  })
  let socket: string | undefined
  let bootId: unknown
  try {
    const window = await application.firstWindow()
    await window.getByRole('textbox', { name: 'New profile' }).fill('Draft switch')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const profile = (await window.evaluate(() => window.adeHost.getProfileState())).profiles[0]
    const result = await execFileAsync('python3', [resolve('scripts/runtime.py'), 'locate', '--home', profile.home])
    socket = (JSON.parse(result.stdout) as { socket: string }).socket
    bootId = (await rpc(socket, { op: 'hello' })).boot_id
    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    const conversation = window.getByRole('region', { name: 'Conversation' })
    await window.getByRole('combobox', { name: 'New conversation provider' }).selectOption('claude')
    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    const prompt = conversation.getByRole('textbox', { name: 'Prompt' })
    await prompt.fill('second-conversation-draft')
    await expect(conversation.locator('.conversation-heading')).toContainText('claude · idle')
    await expect(prompt).toHaveValue('second-conversation-draft')
    await expect(conversation.getByRole('button', { name: 'Send' })).toBeEnabled()
    await window.waitForTimeout(800)
    await expect(prompt).toHaveValue('second-conversation-draft')
    await expect(conversation.getByRole('button', { name: 'Send' })).toBeEnabled()
  } finally {
    await application.close()
    if (socket) {
      const hello = await rpc(socket, { op: 'hello' }).catch(() => null)
      if (hello?.boot_id === bootId) {
        await rpc(socket, { op: 'runtime.prepare_restart', boot_id: bootId })
        for (let attempt = 0; attempt < 50; attempt++) {
          try {
            await rpc(String(hello.runtime_socket), { op: 'runtime.stop', instance_id: hello.runtime_instance, stop_active: true })
            break
          } catch (error) {
            if (attempt === 49) throw error
            await new Promise((done) => setTimeout(done, 50))
          }
        }
      }
    }
    await rm(userData, { recursive: true, force: true })
  }
})
