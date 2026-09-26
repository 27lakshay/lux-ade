import { expect, test, _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { rpc, startDaemon } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string

test('an unfamiliar native item remains readable and ordered after profile and desktop restart', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-unknown-item-e2e-'))
  const dataDirectory = join(userData, 'data')
  const daemonEnvironment = {
    ADE_DATA_DIR: dataDirectory,
    ADE_ROOT: userData,
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio',
    ADE_MOCK_DIR: join(userData, 'codex'),
  }
  let daemon = await startDaemon(daemonEnvironment)
  let application: Awaited<ReturnType<typeof electron.launch>> | null = null
  try {
    const environment = { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData }
    application = await electron.launch({ executablePath: electronExecutable,
      args: [desktopDirectory], env: environment })
    let window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('button', { name: 'New conversation' }).click()
    let conversation = window.getByRole('region', { name: 'Conversation' })
    await conversation.getByRole('textbox', { name: 'Prompt' }).fill('typed-unknown')
    await conversation.getByRole('button', { name: 'Send' }).click()
    const catalog = await rpc(daemon.socket, { op: 'catalog.get' })
    const id = (catalog.catalog as { conversations: Array<{ id: string }> }).conversations[0].id
    await expect.poll(async () => (await rpc(daemon.socket, { op: 'conversation.get',
      conversation_id: id })).conversation.status).toBe('ready')
    const before = await rpc(daemon.socket, { op: 'conversation.get', conversation_id: id })
    const messages = before.messages as Array<{ id: string; kind: string; text: string; sequence: number }>
    const command = messages.find((item) => item.kind === 'commandExecution')
    const unfamiliar = messages.find((item) => item.kind === 'futurePreview')
    expect(command).toBeDefined()
    expect(unfamiliar?.text).toContain('Unrecognized Codex item (futurePreview)')
    expect(unfamiliar?.text).not.toContain('PRIVATE_NATIVE_PAYLOAD')
    expect(JSON.stringify(messages)).not.toContain('PRIVATE_NATIVE_PAYLOAD')
    expect(JSON.stringify(messages)).not.toContain('PRIVATE_REASONING')
    expect(unfamiliar!.sequence).toBeGreaterThan(command!.sequence)
    await expect(conversation.locator('.message-tool').filter({ hasText: 'Unrecognized Codex item' })).toHaveCount(1)
    await expect(conversation).not.toContainText('PRIVATE_NATIVE_PAYLOAD')

    await application.close()
    application = null
    const oldBoot = daemon.hello.boot_id
    await daemon.stop()
    daemon = await startDaemon(daemonEnvironment)
    expect(daemon.hello.boot_id).not.toBe(oldBoot)
    environment.ADE_SOCKET = daemon.socket
    application = await electron.launch({ executablePath: electronExecutable,
      args: [desktopDirectory], env: environment })
    window = await application.firstWindow()
    conversation = window.getByRole('region', { name: 'Conversation' })
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect(conversation.locator('.message-tool').filter({ hasText: 'Unrecognized Codex item' })).toHaveCount(1)
    await expect(conversation).not.toContainText('PRIVATE_NATIVE_PAYLOAD')
    const after = await rpc(daemon.socket, { op: 'conversation.get', conversation_id: id })
    expect((after.messages as Array<{ id: string; kind: string; text: string; sequence: number }>))
      .toEqual(messages)
  } finally {
    await application?.close().catch(() => undefined)
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})
