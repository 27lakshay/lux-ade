import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { createConnection, createServer, type Socket } from 'node:net'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string

test('Electron sends current line feedback once, blocks stale feedback and preserves an ordinary draft', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-review-e2e-'))
  const mockDirectory = join(userData, 'codex')
  const daemon = await startDaemon({
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio',
    ADE_MOCK_DIR: mockDirectory,
  })
  const folder = join(daemon.rootDirectory, 'project')
  await mkdir(folder)
  await execFileAsync('git', ['init', '-q', folder])
  await writeFile(join(folder, 'sample.txt'), 'first\nsecond\n')
  await execFileAsync('git', ['-C', folder, 'add', 'sample.txt'])
  await execFileAsync('git', ['-C', folder, '-c', 'user.name=ADE Test', '-c', 'user.email=ade@example.test', 'commit', '-qm', 'initial'])
  await writeFile(join(folder, 'sample.txt'), 'first\nchanged line\n')
  const application = await electron.launch({
    executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData },
  })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect(window.getByRole('region', { name: 'Changes' }).getByRole('alert')).toBeVisible()
    await window.getByRole('textbox', { name: 'Open folder' }).fill(folder)
    await window.getByRole('button', { name: 'Open folder' }).click()
    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    const changes = window.getByRole('region', { name: 'Changes' })
    await expect(changes.getByText('sample.txt', { exact: true })).toBeVisible()
    await changes.getByRole('button', { name: 'Unstaged diff' }).click()
    await expect(changes.getByRole('button', { name: 'Select line 2' })).toBeVisible()
    await changes.getByRole('button', { name: 'Select line 2' }).click()
    await changes.getByRole('textbox', { name: 'Feedback note' }).fill('Please handle this line carefully')

    await rename(join(folder, '.git'), join(folder, '.git-paused'))
    await changes.getByRole('button', { name: 'Send feedback' }).click()
    await expect(changes.getByRole('alert')).toBeVisible()
    await expect(changes.getByRole('button', { name: 'Retry feedback delivery' })).toHaveCount(0)
    await expect(changes.getByRole('textbox', { name: 'Feedback note' })).toHaveValue('Please handle this line carefully')
    expect(await window.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('ade.reviewPending.')))).toEqual([])
    await rename(join(folder, '.git-paused'), join(folder, '.git'))

    await writeFile(join(folder, 'sample.txt'), 'first\nchanged again\n')
    await changes.getByRole('button', { name: 'Send feedback' }).click()
    await expect(changes.getByRole('alert')).toContainText('Stale diff')
    await expect(changes.getByRole('textbox', { name: 'Feedback note' })).toHaveValue('Please handle this line carefully')
    expect(await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8').catch(() => '')).not.toContain('"method": "turn/start"')

    await changes.getByRole('button', { name: 'Refresh changes' }).click()
    await expect(changes.getByText('sample.txt', { exact: true })).toBeVisible()
    await changes.getByRole('button', { name: 'Unstaged diff' }).click()
    await changes.getByRole('button', { name: 'Select line 2' }).click()
    const selectedAnchor = await changes.locator('.review-feedback p').first().textContent()
    const token = selectedAnchor?.match(/[0-9a-f]{16}$/)?.[0]
    expect(token).toBeDefined()
    await changes.getByRole('button', { name: 'Send feedback' }).click()
    const conversation = window.getByRole('region', { name: 'Conversation' })
    await expect(conversation.locator('.message-user')).toContainText('Please handle this line carefully')
    await expect(conversation.locator('.message-user')).toContainText('File: sample.txt')
    await expect(conversation.locator('.message-user')).toContainText('Side: unstaged')
    await expect(conversation.locator('.message-user')).toContainText(`Diff token: ${token}`)
    await expect(conversation.locator('.message-user')).toContainText('Line: +2')
    await expect.poll(async () => {
      const calls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
      return calls.filter((line) => JSON.parse(line).method === 'turn/start').length
    }).toBe(1)
    await expect(window.getByRole('region', { name: 'Conversation' }).locator('.message-assistant')).toContainText('Hello world')
    const calls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    const turn = calls.map((line) => JSON.parse(line)).find((call) => call.method === 'turn/start')
    expect(JSON.stringify(turn)).toContain('Please handle this line carefully')
    expect(JSON.stringify(turn)).toContain(`Diff token: ${token}`)
    const savedSearch = changes.getByRole('form', { name: 'Saved feedback search' })
    await savedSearch.getByRole('textbox', { name: 'Search feedback path' }).fill('sample.txt')
    await savedSearch.getByRole('textbox', { name: 'Search saved notes' }).fill('handle this line')
    await savedSearch.getByRole('button', { name: 'Search feedback' }).click()
    await expect(savedSearch.getByLabel('Saved feedback results')).toContainText('Please handle this line carefully')

    const completedKey = await window.evaluate(async (requestId: string) => {
      const state = await window.adeHost.getClientState()
      const workspaceId = (document.getElementById('workspace') as HTMLSelectElement).value
      const conversationId = state.catalog?.conversations.find((item) => item.workspace_id === workspaceId)?.id
      if (!conversationId) throw new Error('Conversation did not appear in the catalog')
      const key = `ade.reviewPending.fixed.${workspaceId}.${conversationId}`
      sessionStorage.setItem(key, JSON.stringify({ requestId, note: 'Already delivered', anchor: { workspace_id: workspaceId } }))
      return key
    }, turn.params.clientUserMessageId as string)
    await window.reload()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect(changes.getByRole('textbox', { name: 'Feedback note' })).toHaveValue('')
    await expect(changes.getByRole('button', { name: 'Retry feedback delivery' })).toHaveCount(0)
    expect(await window.evaluate((key) => sessionStorage.getItem(key), completedKey)).toBeNull()
    await changes.getByRole('button', { name: 'Unstaged diff' }).click()
    await changes.getByRole('button', { name: 'Select line 2' }).click()

    const prompt = conversation.getByRole('textbox', { name: 'Prompt' })
    await expect(prompt).toBeEnabled()
    await prompt.fill('ordinary unsent draft')
    await changes.getByRole('textbox', { name: 'Feedback note' }).fill('Another review note')
    await changes.getByRole('button', { name: 'Send feedback' }).click()
    await expect(changes.getByRole('alert')).toContainText('ordinary conversation draft')
    await expect(prompt).toHaveValue('ordinary unsent draft')
    await expect(changes.getByRole('textbox', { name: 'Feedback note' })).toHaveValue('Another review note')
    const finalCalls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(finalCalls.filter((line) => JSON.parse(line).method === 'turn/start')).toHaveLength(1)

    await prompt.fill('   ')
    await changes.getByRole('button', { name: 'Send feedback' }).click()
    await expect(changes.getByRole('alert')).toContainText('ordinary conversation draft')
    await expect(prompt).toHaveValue('   ')
    await expect(changes.getByRole('textbox', { name: 'Feedback note' })).toHaveValue('Another review note')

    await writeFile(join(folder, 'sample.txt'), `first\n${'large change\n'.repeat(400_000)}`)
    await changes.getByRole('button', { name: 'Refresh changes' }).click()
    await expect(changes.getByText('sample.txt', { exact: true })).toBeVisible()
    await changes.getByRole('button', { name: 'Unstaged diff' }).click()
    await expect(changes.getByRole('button', { name: 'Next diff page' })).toBeVisible()
    await changes.getByRole('button', { name: 'Next diff page' }).click()
    await expect(changes.getByRole('button', { name: 'Select line 1002' })).toBeVisible()
    await expect(prompt).toHaveValue('   ')
  } finally {
    await application.close()
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})

test('a delayed review read cannot send after workspace or conversation selection changes', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-review-selection-e2e-'))
  const mockDirectory = join(userData, 'codex')
  const daemon = await startDaemon({
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'), ADE_CODEX_TRANSPORT: 'stdio',
    ADE_MOCK_DIR: mockDirectory,
  })
  const folder = join(daemon.rootDirectory, 'project')
  await mkdir(folder)
  await execFileAsync('git', ['init', '-q', folder])
  await writeFile(join(folder, 'sample.txt'), 'first\n')
  await execFileAsync('git', ['-C', folder, 'add', 'sample.txt'])
  await execFileAsync('git', ['-C', folder, '-c', 'user.name=ADE Test', '-c', 'user.email=ade@example.test', 'commit', '-qm', 'initial'])
  await writeFile(join(folder, 'sample.txt'), 'changed\n')

  const proxySocket = join(userData, 'proxy.sock')
  const peers = new Set<Socket>()
  let delayReview = false
  let releaseHeld: (() => void) | null = null
  const proxy = createServer((downstream) => {
    const upstream = createConnection(daemon.socket)
    peers.add(downstream)
    peers.add(upstream)
    let requestText = ''
    let replyText = ''
    let operation = ''
    let held = false
    downstream.on('data', (chunk: Buffer) => {
      requestText += chunk.toString('utf8')
      const end = requestText.indexOf('\n')
      if (end < 0) return
      const line = requestText.slice(0, end + 1)
      operation = (JSON.parse(line) as { op: string }).op
      upstream.write(line)
      requestText = requestText.slice(end + 1)
    })
    upstream.on('data', (chunk: Buffer) => {
      replyText += chunk.toString('utf8')
      const end = replyText.indexOf('\n')
      if (end < 0) return
      const line = replyText.slice(0, end + 1)
      if (operation === 'review.status' && delayReview) {
        delayReview = false
        held = true
        releaseHeld = () => { downstream.write(line); downstream.end(); held = false; releaseHeld = null }
      } else downstream.write(line)
      replyText = replyText.slice(end + 1)
    })
    downstream.on('error', () => undefined)
    upstream.on('error', () => undefined)
    upstream.on('close', () => { peers.delete(upstream); if (!held) downstream.end() })
    downstream.on('close', () => { peers.delete(downstream); upstream.destroy() })
  })
  await new Promise<void>((done) => proxy.listen(proxySocket, done))
  const application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: proxySocket, ADE_E2E_USER_DATA_DIR: userData } })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('textbox', { name: 'Open folder' }).fill(folder)
    await window.getByRole('button', { name: 'Open folder' }).click()
    const workspacePicker = window.getByRole('combobox', { name: 'Workspace' })
    const projectOption = workspacePicker.getByRole('option', { name: 'project' })
    await expect(projectOption).toHaveCount(1)
    await expect(workspacePicker).toHaveValue((await projectOption.getAttribute('value'))!)
    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    const navigation = window.getByRole('navigation', { name: 'Conversations' })
    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    await expect(navigation.locator('button').filter({ hasText: 'starting' })).toHaveCount(0)
    await navigation.locator('button').first().click()
    await expect(navigation.locator('button').first()).toHaveClass(/selected/)
    const changes = window.getByRole('region', { name: 'Changes' })
    await expect(changes.getByText('sample.txt', { exact: true })).toBeVisible()
    await changes.getByRole('button', { name: 'Unstaged diff' }).click()
    await changes.getByRole('button', { name: 'Select line 1' }).click()
    await changes.getByRole('textbox', { name: 'Feedback note' }).fill('Should not reach the old conversation')

    delayReview = true
    await changes.getByRole('button', { name: 'Send feedback' }).click()
    await expect.poll(() => Boolean(releaseHeld)).toBe(true)
    const projectId = await workspacePicker.inputValue()
    await workspacePicker.selectOption({ index: 0 })
    await expect(workspacePicker).not.toHaveValue(projectId)
    releaseHeld?.()
    await expect(window.getByRole('region', { name: 'Changes' }).getByRole('alert')).toBeVisible()
    expect(await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8').catch(() => '')).not.toContain('"method": "turn/start"')

    await workspacePicker.selectOption({ index: 1 })
    await expect(changes.getByText('sample.txt', { exact: true })).toBeVisible()
    await navigation.locator('button').first().click()
    await expect(changes.getByText('sample.txt', { exact: true })).toBeVisible()
    await changes.getByRole('button', { name: 'Unstaged diff' }).click()
    await changes.getByRole('button', { name: 'Select line 1' }).click()
    await changes.getByRole('textbox', { name: 'Feedback note' }).fill('Still should not dispatch')
    delayReview = true
    await changes.getByRole('button', { name: 'Send feedback' }).click()
    await expect.poll(() => Boolean(releaseHeld)).toBe(true)
    await navigation.locator('button').last().click()
    await expect(navigation.locator('button').last()).toHaveClass(/selected/)
    releaseHeld?.()
    expect(await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8').catch(() => '')).not.toContain('"method": "turn/start"')
    await expect(navigation.locator('button').filter({ hasText: 'starting' })).toHaveCount(0)
  } finally {
    releaseHeld?.()
    await application.close()
    for (const peer of peers) peer.destroy()
    await new Promise<void>((done) => proxy.close(() => done()))
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})

test('uncertain review feedback keeps its note and request ID through selection and reload', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-review-recovery-e2e-'))
  const mockDirectory = join(userData, 'codex')
  const daemon = await startDaemon({
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'), ADE_CODEX_TRANSPORT: 'stdio',
    ADE_MOCK_DIR: mockDirectory,
  })
  const folder = join(daemon.rootDirectory, 'project')
  await mkdir(folder)
  await execFileAsync('git', ['init', '-q', folder])
  await writeFile(join(folder, 'sample.txt'), 'before\n')
  await execFileAsync('git', ['-C', folder, 'add', 'sample.txt'])
  await execFileAsync('git', ['-C', folder, '-c', 'user.name=ADE Test', '-c', 'user.email=ade@example.test', 'commit', '-qm', 'initial'])
  await writeFile(join(folder, 'sample.txt'), 'after\n')

  const proxySocket = join(userData, 'proxy.sock')
  const peers = new Set<Socket>()
  let dropReply = true
  let blockReconciliation = false
  const proxy = createServer((downstream) => {
    const upstream = createConnection(daemon.socket)
    peers.add(downstream)
    peers.add(upstream)
    let requestText = ''
    let replyText = ''
    let operation = ''
    downstream.on('data', (chunk: Buffer) => {
      requestText += chunk.toString('utf8')
      const end = requestText.indexOf('\n')
      if (end < 0) return
      const line = requestText.slice(0, end + 1)
      operation = (JSON.parse(line) as { op: string }).op
      if (blockReconciliation && (operation === 'conversation.get' || operation === 'draft.send.complete')) {
        downstream.destroy()
        upstream.destroy()
      } else upstream.write(line)
      requestText = requestText.slice(end + 1)
    })
    upstream.on('data', (chunk: Buffer) => {
      replyText += chunk.toString('utf8')
      const end = replyText.indexOf('\n')
      if (end < 0) return
      const line = replyText.slice(0, end + 1)
      const response = JSON.parse(line) as { type: string }
      if (operation === 'agent.send_review' && response.type === 'ack' && dropReply) {
        dropReply = false
        blockReconciliation = true
        downstream.destroy()
        upstream.destroy()
      } else downstream.write(line)
      replyText = replyText.slice(end + 1)
    })
    downstream.on('error', () => undefined)
    upstream.on('error', () => undefined)
    downstream.on('close', () => { peers.delete(downstream); upstream.destroy() })
    upstream.on('close', () => { peers.delete(upstream); downstream.destroy() })
  })
  await new Promise<void>((done) => proxy.listen(proxySocket, done))
  const application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: proxySocket, ADE_E2E_USER_DATA_DIR: userData } })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('textbox', { name: 'Open folder' }).fill(folder)
    await window.getByRole('button', { name: 'Open folder' }).click()
    const workspacePicker = window.getByRole('combobox', { name: 'Workspace' })
    const projectOption = workspacePicker.getByRole('option', { name: 'project' })
    await expect(projectOption).toHaveCount(1)
    await expect(workspacePicker).toHaveValue((await projectOption.getAttribute('value'))!)
    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    const navigation = window.getByRole('navigation', { name: 'Conversations' })
    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    await expect(navigation.locator('button').filter({ hasText: 'starting' })).toHaveCount(0)
    await navigation.locator('button').first().click()
    await expect(navigation.locator('button').first()).toHaveClass(/selected/)
    const changes = window.getByRole('region', { name: 'Changes' })
    await expect(changes.getByText('sample.txt', { exact: true })).toBeVisible()
    await changes.getByRole('button', { name: 'Unstaged diff' }).click()
    await changes.getByRole('button', { name: 'Select line 1' }).click()
    await changes.getByRole('textbox', { name: 'Feedback note' }).fill('Keep this note across reload')
    await changes.getByRole('button', { name: 'Send feedback' }).click()
    await expect(changes.getByRole('button', { name: 'Retry feedback delivery' })).toBeVisible()
    const stored = await window.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith('ade.reviewPending.'))?.[1] ?? '')
    const requestId = (JSON.parse(stored) as { requestId: string }).requestId
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/)

    const feedbackConversation = navigation.getByRole('button', { name: /Review feedback for workspace/ })
    await expect(feedbackConversation).toBeVisible()
    await navigation.getByRole('button', { name: /New Conversation/ }).click()
    await expect(navigation.getByRole('button', { name: /New Conversation/ })).toHaveClass(/selected/)
    await feedbackConversation.click()
    await expect(feedbackConversation).toHaveClass(/selected/)
    await expect(changes.getByRole('textbox', { name: 'Feedback note' })).toHaveValue('Keep this note across reload')
    await expect(changes.getByRole('button', { name: 'Retry feedback delivery' })).toBeVisible()
    blockReconciliation = false
    await window.reload()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect(changes.getByRole('textbox', { name: 'Feedback note' })).toHaveValue('Keep this note across reload')
    await expect(changes.getByRole('button', { name: 'Retry feedback delivery' })).toBeVisible()
    const recovered = await window.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith('ade.reviewPending.'))?.[1] ?? '')
    expect((JSON.parse(recovered) as { requestId: string }).requestId).toBe(requestId)

    await changes.getByRole('button', { name: 'Retry feedback delivery' }).click()
    await expect(changes.getByText('Feedback sent to this conversation.')).toBeVisible()
    await expect(changes.getByRole('textbox', { name: 'Feedback note' })).toHaveValue('')
    await expect.poll(async () => {
      const calls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
      return calls.filter((line) => JSON.parse(line).method === 'turn/start').length
    }).toBe(1)
    const calls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    const turn = calls.map((line) => JSON.parse(line)).find((call) => call.method === 'turn/start')
    expect(turn.params.clientUserMessageId).toBe(requestId)
    expect(await window.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('ade.reviewPending.')))).toEqual([])
    await expect(window.getByRole('region', { name: 'Conversation' }).locator('.message-assistant')).toContainText('Hello world')
    await expect(window.getByRole('region', { name: 'Conversation' }).locator('.conversation-heading')).toContainText('ready')
    await expect(navigation.locator('button').filter({ hasText: 'starting' })).toHaveCount(0)

    dropReply = true
    await changes.getByRole('button', { name: 'Unstaged diff' }).click()
    await changes.getByRole('button', { name: 'Select line 1' }).click()
    await changes.getByRole('textbox', { name: 'Feedback note' }).fill('Completed while this pane stays open')
    await changes.getByRole('button', { name: 'Send feedback' }).click()
    await expect(changes.getByRole('button', { name: 'Retry feedback delivery' })).toBeVisible()
    const secondStored = await window.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith('ade.reviewPending.')) ?? [])
    const secondRequestId = (JSON.parse(secondStored[1]) as { requestId: string }).requestId
    const conversationId = secondStored[0].slice(secondStored[0].lastIndexOf('.') + 1)
    blockReconciliation = false
    await window.evaluate(({ conversationId, requestId }) => window.adeHost.requestConversation('agent.retry_send', {
      conversation_id: conversationId, request_id: requestId,
    }), { conversationId, requestId: secondRequestId })
    await writeFile(join(folder, 'sample.txt'), 'changed after completion\n')
    await changes.getByRole('button', { name: 'Retry feedback delivery' }).click()
    await expect(changes.getByRole('textbox', { name: 'Feedback note' })).toHaveValue('')
    await expect(changes.getByRole('button', { name: 'Retry feedback delivery' })).toHaveCount(0)
    await expect(changes.getByText('Feedback sent to this conversation.')).toBeVisible()
    expect(await window.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('ade.reviewPending.')))).toEqual([])
    await expect.poll(async () => {
      const lines = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
      return lines.filter((line) => JSON.parse(line).method === 'turn/start').length
    }).toBe(2)
  } finally {
    blockReconciliation = false
    for (const peer of peers) peer.destroy()
    await application.close()
    await new Promise<void>((done) => proxy.close(() => done()))
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})
