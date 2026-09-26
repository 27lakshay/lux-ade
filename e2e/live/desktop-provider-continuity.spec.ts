import { expect, test, _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { rpc, startDaemon } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const electronExecutable = createRequire(join(desktopDirectory, 'package.json'))('electron') as string

for (const provider of ['codex', 'claude'] as const) {
  test(`a real ${provider} turn survives closing and reopening the desktop`, async () => {
    test.skip(process.env.ADE_RUN_LIVE_PROVIDERS !== '1', 'Opt in to real provider usage')
    const userData = await mkdtemp(join(tmpdir(), `ade-live-desktop-${provider}-`))
    let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null
    let application: Awaited<ReturnType<typeof electron.launch>> | null = null
    try {
      const running = await startDaemon({ ADE_CODEX_TRANSPORT: 'stdio' })
      daemon = running
      const environment = { ...process.env, ADE_SOCKET: running.socket, ADE_E2E_USER_DATA_DIR: userData }
      application = await electron.launch({ executablePath: electronExecutable,
        args: [desktopDirectory], env: environment })
      let window = await application.firstWindow()
      await expect(window.locator('header').getByRole('status')).toHaveText('connected')
      await window.getByLabel('New conversation provider').selectOption(provider)
      await window.getByRole('button', { name: 'New conversation' }).click()
      const conversation = window.getByRole('region', { name: 'Conversation' })
      const marker = `ADE_LIVE_DESKTOP_${provider.toUpperCase()}`
      await conversation.getByRole('textbox', { name: 'Prompt' }).fill(
        `Do not use tools, read files, or change anything. Output exactly 200 numbered lines. Each line must contain ${marker}. Do not shorten the list or add commentary.`,
      )
      await conversation.getByRole('button', { name: 'Send' }).click()
      const catalog = await rpc(running.socket, { op: 'catalog.get' })
      const id = (catalog.catalog as { conversations: Array<{ id: string }> }).conversations[0].id
      await expect.poll(async () => (await rpc(running.socket, { op: 'conversation.get',
        conversation_id: id })).conversation.status, { timeout: 30_000 }).toBe('running')
      const before = await rpc(running.socket, { op: 'hello' })
      const nativeThread = (await rpc(running.socket, { op: 'conversation.get',
        conversation_id: id })).conversation.provider_thread_id
      expect(nativeThread).toBeTruthy()

      await application.close()
      application = null
      const closed = await rpc(running.socket, { op: 'hello' })
      expect(closed.boot_id).toBe(before.boot_id)
      expect(closed.runtime_instance).toBe(before.runtime_instance)
      const whileClosed = await rpc(running.socket, { op: 'conversation.get', conversation_id: id })
      expect(['running', 'ready']).toContain(whileClosed.conversation.status)

      application = await electron.launch({ executablePath: electronExecutable,
        args: [desktopDirectory], env: environment })
      window = await application.firstWindow()
      await expect(window.locator('header').getByRole('status')).toHaveText('connected')
      await expect.poll(async () => (await rpc(running.socket, { op: 'conversation.get',
        conversation_id: id })).conversation.status, { timeout: 120_000 }).toBe('ready')
      const after = await rpc(running.socket, { op: 'conversation.get', conversation_id: id })
      expect(after.conversation.provider_thread_id).toBe(nativeThread)
      expect((after.messages as Array<{ role: string }>).filter((item) => item.role === 'user')).toHaveLength(1)
      expect((after.messages as Array<{ role: string; text: string }>).some((item) =>
        item.role === 'assistant' && item.text.includes(marker))).toBe(true)
      await expect(window.getByRole('region', { name: 'Conversation' })).toContainText(marker)
    } finally {
      let closeFailure: unknown
      try { await application?.close() } catch (error) { closeFailure = error }
      await daemon?.stop()
      if (closeFailure) throw new Error(`Electron close is unconfirmed; retained ${userData}: ${String(closeFailure)}`)
      await rm(userData, { recursive: true, force: true })
    }
  })
}
