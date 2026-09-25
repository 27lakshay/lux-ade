import { expect, test, _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { rpc, startDaemon } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string

test('conversation restores transcript and answers native approvals and questions', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-conversation-e2e-'))
  const mockDirectory = join(userData, 'codex')
  const daemon = await startDaemon({
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio',
    ADE_MOCK_DIR: mockDirectory,
  })
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData },
  })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('button', { name: 'New conversation' }).click()
    const conversation = window.getByRole('region', { name: 'Conversation' })
    await expect(conversation.getByText('Send a prompt to start this conversation.')).toBeVisible()
    await conversation.getByRole('textbox', { name: 'Prompt' }).fill('typed-tool')
    await conversation.getByRole('button', { name: 'Send' }).click()
    await expect(conversation.locator('.message-user')).toContainText('typed-tool')
    await expect(conversation.locator('.message-assistant')).toContainText('Hello world')
    await expect(conversation.locator('.message-tool')).toContainText('fixture failure')
    const firstIds = await conversation.locator('.message').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-message-id')))
    const catalog = await rpc(daemon.socket, { op: 'catalog.get' })
    const conversationId = (catalog.catalog as { conversations: Array<{ id: string }> }).conversations[0].id

    await window.reload()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect(conversation.locator('.message-assistant')).toContainText('Hello world')
    expect(await conversation.locator('.message').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-message-id')))).toEqual(firstIds)
    const callsAfterReload = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(callsAfterReload.filter((line) => JSON.parse(line).method === 'turn/start')).toHaveLength(1)

    await conversation.getByRole('textbox', { name: 'Prompt' }).fill('approval')
    await conversation.getByRole('button', { name: 'Send' }).click()
    const approval = conversation.getByRole('region', { name: 'Pending approval' })
    await expect(approval).toContainText('echo fixture')
    await approval.getByRole('button', { name: 'Decline' }).click()
    await expect(approval).toHaveCount(0)
    const snapshot = await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversationId })
    expect(snapshot.requests).toEqual([])
    await expect.poll(async () => {
      const calls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
      return calls.filter((line) => JSON.parse(line).method === 'approval/reply').length
    }).toBe(1)

    await conversation.getByRole('textbox', { name: 'Prompt' }).fill('rich-questions')
    await conversation.getByRole('button', { name: 'Send' }).click()
    const questions = conversation.getByRole('region', { name: 'Pending approval' })
    await expect(questions).toContainText('Choose a mode')
    await questions.getByLabel('Choose a mode').fill('Thorough')
    await questions.getByRole('checkbox', { name: 'Read, write' }).check()
    await questions.getByLabel('Fixture secret').fill('fixture answer')
    await questions.getByRole('button', { name: 'Submit answer' }).click()
    await expect(questions).toHaveCount(0)
    await expect.poll(async () => {
      const lines = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
      const replies = lines.map((line) => JSON.parse(line)).filter((call) => call.method === 'approval/reply')
      return replies[1]?.result?.answers
    }).toEqual({ choice: { answers: ['Thorough'] }, multiple: { answers: ['Read, write'] }, secret: { answers: ['fixture answer'] } })
  } finally {
    await application.close()
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})
