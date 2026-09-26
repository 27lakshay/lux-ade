import { expect, test, _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { rpc, startDaemon } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string

test('an admitted provider tool continues after the last window closes and appears once on reopen', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-provider-background-e2e-'))
  const mockDirectory = join(userData, 'codex')
  const daemon = await startDaemon({
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio',
    ADE_MOCK_DIR: mockDirectory,
  })
  const environment = { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData }
  let application: Awaited<ReturnType<typeof electron.launch>> | null = null
  try {
    application = await electron.launch({ executablePath: electronExecutable,
      args: [desktopDirectory], env: environment })
    let window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('button', { name: 'New conversation' }).click()
    const conversation = window.getByRole('region', { name: 'Conversation' })
    await conversation.getByRole('textbox', { name: 'Prompt' }).fill('handoff-tool')
    await conversation.getByRole('button', { name: 'Send' }).click()
    const catalog = (await rpc(daemon.socket, { op: 'catalog.get' })).catalog as {
      conversations: Array<{ id: string }> }
    const id = catalog.conversations[0].id
    await expect.poll(async () => {
      const calls = await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8').catch(() => '')
      return calls.includes('"method": "fixture/tool"')
    }).toBe(true)
    const toolStart = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as { method: string; tool_pid?: number })
      .find((call) => call.method === 'fixture/tool')
    expect(toolStart?.tool_pid).toBeGreaterThan(0)
    await expect.poll(async () => (await rpc(daemon.socket, { op: 'conversation.get',
      conversation_id: id })).conversation.status).toBe('running')
    const bootId = (await rpc(daemon.socket, { op: 'hello' })).boot_id

    await application.close()
    expect((await rpc(daemon.socket, { op: 'hello' })).boot_id).toBe(bootId)
    expect((await rpc(daemon.socket, { op: 'conversation.get', conversation_id: id })).conversation.status)
      .toBe('running')
    expect(() => process.kill(toolStart!.tool_pid!, 0)).not.toThrow()
    await writeFile(join(mockDirectory, 'release-tool'), '')
    await expect.poll(async () => (await rpc(daemon.socket, { op: 'conversation.get',
      conversation_id: id })).conversation.status).toBe('ready')

    application = await electron.launch({ executablePath: electronExecutable,
      args: [desktopDirectory], env: environment })
    window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect(window.getByRole('region', { name: 'Conversation' }).locator('.message-tool')
      .filter({ hasText: 'tool completed once' })).toHaveCount(1)
    const calls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as { method: string })
    expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
  } finally {
    await application?.close().catch(() => undefined)
    await writeFile(join(mockDirectory, 'release-tool'), '').catch(() => undefined)
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})
