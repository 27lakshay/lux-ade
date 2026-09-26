import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { createConnection, createServer, type Socket } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string

test('Electron sends multiple anchored review notes including a selected range', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-review-batch-e2e-'))
  const mockDirectory = join(userData, 'codex')
  const daemon = await startDaemon({
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'), ADE_CODEX_TRANSPORT: 'stdio',
    ADE_MOCK_DIR: mockDirectory,
  })
  const folder = join(daemon.rootDirectory, 'project')
  await mkdir(folder)
  await execFileAsync('git', ['init', '-q', folder])
  await writeFile(join(folder, 'sample.txt'), 'first\nsecond\nthird\nfourth\n')
  await execFileAsync('git', ['-C', folder, 'add', 'sample.txt'])
  await execFileAsync('git', ['-C', folder, '-c', 'user.name=ADE Test', '-c', 'user.email=ade@example.test', 'commit', '-qm', 'initial'])
  await writeFile(join(folder, 'sample.txt'), 'first\nchanged second\nchanged third\nchanged fourth\n')
  const application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData,
      ADE_E2E_HIDE_WINDOW: '1' } })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('textbox', { name: 'Open folder' }).fill(folder)
    await window.getByRole('button', { name: 'Open folder' }).click()
    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    const changes = window.getByRole('region', { name: 'Changes' })
    await expect(changes.getByText('sample.txt', { exact: true })).toBeVisible()
    await changes.getByRole('button', { name: 'Unstaged diff' }).click()
    await changes.getByRole('button', { name: 'Select line 2' }).click()
    await changes.getByRole('button', { name: 'Select line 3' }).click({ modifiers: ['Shift'] })
    await expect(changes.locator('.review-feedback p').first()).toContainText('line 2–3')
    await changes.getByRole('textbox', { name: 'Feedback note' }).fill('x'.repeat(4097))
    await changes.getByRole('button', { name: 'Add note' }).click()
    await expect(changes.getByRole('alert')).toContainText('4096 bytes or less')
    await expect(changes.getByRole('textbox', { name: 'Feedback note' })).toHaveValue('x'.repeat(4097))
    await expect(changes.getByLabel('Feedback notes')).toHaveCount(0)
    await changes.getByRole('textbox', { name: 'Feedback note' }).fill('Revise these two lines together')
    await changes.getByRole('button', { name: 'Add note' }).click()
    await expect(changes.getByLabel('Feedback notes')).toContainText('Revise these two lines together')
    await changes.getByRole('textbox', { name: 'Feedback note' }).fill('Check the final line too')
    await changes.getByRole('button', { name: 'Send feedback' }).click()
    await expect(changes.getByRole('alert')).toContainText('Select a changed line')
    await expect(changes.getByRole('textbox', { name: 'Feedback note' })).toHaveValue('Check the final line too')
    await changes.getByRole('button', { name: 'Select line 4' }).click()
    await changes.getByRole('button', { name: 'Send feedback' }).click()
    const conversation = window.getByRole('region', { name: 'Conversation' })
    await expect(conversation.locator('.message-user')).toContainText('Revise these two lines together')
    await expect(conversation.locator('.message-user')).toContainText('Check the final line too')
    await expect(conversation.locator('.message-assistant')).toContainText('Hello world')
    await expect.poll(async () => {
      const calls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
      return calls.filter((line) => JSON.parse(line).method === 'turn/start').length
    }).toBe(1)
    const feedback = await window.evaluate(async () => {
      const state = await window.adeHost.getClientState()
      const workspaceId = (document.getElementById('workspace') as HTMLSelectElement).value
      const conversationId = state.catalog?.conversations.find((item) => item.workspace_id === workspaceId)?.id
      if (!conversationId) throw new Error('Conversation is absent')
      const snapshot = await window.adeHost.requestConversation('conversation.get', { conversation_id: conversationId })
      return snapshot.messages?.find((item: { role: string; review_feedback?: unknown }) => item.role === 'user')?.review_feedback
    })
    expect(feedback).toMatchObject({ format: 'ade-review-feedback-v1', notes: [
      { anchor: { path: 'sample.txt', line: 2, end_line: 3 }, note: 'Revise these two lines together' },
      { anchor: { path: 'sample.txt', line: 4 }, note: 'Check the final line too' },
    ] })
    await window.reload()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const savedSearch = window.getByRole('form', { name: 'Saved feedback search' })
    await savedSearch.getByRole('textbox', { name: 'Search feedback path' }).fill('sample.txt')
    await savedSearch.getByRole('textbox', { name: 'Search saved notes' }).fill('Revise')
    await savedSearch.getByRole('button', { name: 'Search feedback' }).click()
    await expect(savedSearch.getByLabel('Saved feedback results')).toContainText('Revise these two lines together')
    await expect(savedSearch.getByLabel('Saved feedback results')).toContainText('line 2–3')
    await expect(savedSearch.getByLabel('Saved feedback results')).toContainText('Conversation ')
    await savedSearch.getByRole('textbox', { name: 'Search saved notes' }).fill('Check the final line')
    await expect(savedSearch.getByLabel('Saved feedback results')).toHaveCount(0)
    await expect(savedSearch.getByRole('button', { name: 'More saved feedback' })).toHaveCount(0)
    await savedSearch.getByRole('button', { name: 'Search feedback' }).click()
    await expect(savedSearch.getByLabel('Saved feedback results')).toContainText('Check the final line too')
    await expect(savedSearch.getByLabel('Saved feedback results')).not.toContainText('Revise these two lines together')
  } finally {
    await application.close()
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})

test('batch review feedback restores the same notes and request ID after an uncertain send', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-review-batch-recovery-e2e-'))
  const mockDirectory = join(userData, 'codex')
  const daemon = await startDaemon({
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'), ADE_CODEX_TRANSPORT: 'stdio',
    ADE_MOCK_DIR: mockDirectory,
  })
  const folder = join(daemon.rootDirectory, 'project')
  await mkdir(folder)
  await execFileAsync('git', ['init', '-q', folder])
  await writeFile(join(folder, 'sample.txt'), 'first\nsecond\nthird\n')
  await execFileAsync('git', ['-C', folder, 'add', 'sample.txt'])
  await execFileAsync('git', ['-C', folder, '-c', 'user.name=ADE Test', '-c', 'user.email=ade@example.test', 'commit', '-qm', 'initial'])
  await writeFile(join(folder, 'sample.txt'), 'first\nchanged second\nchanged third\n')

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
    env: { ...process.env, ADE_SOCKET: proxySocket, ADE_E2E_USER_DATA_DIR: userData,
      ADE_E2E_HIDE_WINDOW: '1' } })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('textbox', { name: 'Open folder' }).fill(folder)
    await window.getByRole('button', { name: 'Open folder' }).click()
    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    const changes = window.getByRole('region', { name: 'Changes' })
    await expect(changes.getByText('sample.txt', { exact: true })).toBeVisible()
    await changes.getByRole('button', { name: 'Unstaged diff' }).click()
    await changes.getByRole('button', { name: 'Select line 2' }).click()
    await changes.getByRole('textbox', { name: 'Feedback note' }).fill('Keep first note')
    await changes.getByRole('button', { name: 'Add note' }).click()
    await changes.getByRole('button', { name: 'Select line 3' }).click()
    await changes.getByRole('textbox', { name: 'Feedback note' }).fill('Keep second note')
    await changes.getByRole('button', { name: 'Send feedback' }).click()
    await expect(changes.getByRole('button', { name: 'Retry feedback delivery' })).toBeVisible()
    const stored = await window.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith('ade.reviewPending.'))?.[1] ?? '')
    const pending = JSON.parse(stored) as { requestId: string; reviewFeedback: { notes: unknown[] } }
    expect(pending.reviewFeedback.notes).toHaveLength(2)
    blockReconciliation = false
    await window.reload()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect(changes.getByLabel('Feedback notes')).toContainText('Keep first note')
    await expect(changes.getByLabel('Feedback notes')).toContainText('Keep second note')
    await expect(changes.getByRole('button', { name: 'Retry feedback delivery' })).toBeVisible()
    const restored = await window.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith('ade.reviewPending.'))?.[1] ?? '')
    expect((JSON.parse(restored) as { requestId: string }).requestId).toBe(pending.requestId)
    await changes.getByRole('button', { name: 'Retry feedback delivery' }).click()
    await expect(changes.getByText('Feedback sent to this conversation.')).toBeVisible()
    await expect.poll(async () => {
      const calls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
      return calls.filter((line) => JSON.parse(line).method === 'turn/start').length
    }).toBe(1)
    const calls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    const turn = calls.map((line) => JSON.parse(line)).find((call) => call.method === 'turn/start')
    expect(turn.params.clientUserMessageId).toBe(pending.requestId)
  } finally {
    blockReconciliation = false
    for (const peer of peers) peer.destroy()
    await application.close()
    await new Promise<void>((done) => proxy.close(() => done()))
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})

test('batch review feedback survives a pre-dispatch Electron crash', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-review-batch-crash-e2e-'))
  const mockDirectory = join(userData, 'codex')
  const signal = join(userData, 'send-paused')
  const release = join(userData, 'send-release')
  const daemon = await startDaemon({ ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio', ADE_MOCK_DIR: mockDirectory })
  const folder = join(daemon.rootDirectory, 'project')
  await mkdir(folder)
  await execFileAsync('git', ['init', '-q', folder])
  await writeFile(join(folder, 'sample.txt'), 'first\nsecond\nthird\n')
  await execFileAsync('git', ['-C', folder, 'add', 'sample.txt'])
  await execFileAsync('git', ['-C', folder, '-c', 'user.name=ADE Test', '-c', 'user.email=ade@example.test', 'commit', '-qm', 'initial'])
  await writeFile(join(folder, 'sample.txt'), 'first\nchanged second\nchanged third\n')
  const launch = (pause: boolean) => electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData, ADE_E2E_HIDE_WINDOW: '1',
      ...(pause ? { ADE_E2E_SEND_JOURNAL_PAUSE: '1', ADE_E2E_SEND_JOURNAL_SIGNAL: signal,
        ADE_E2E_SEND_JOURNAL_RELEASE: release } : {}) } })
  let application = await launch(true)
  try {
    let window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('textbox', { name: 'Open folder' }).fill(folder)
    await window.getByRole('button', { name: 'Open folder' }).click()
    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    let changes = window.getByRole('region', { name: 'Changes' })
    await expect(changes.getByText('sample.txt', { exact: true })).toBeVisible()
    await changes.getByRole('button', { name: 'Unstaged diff' }).click()
    await changes.getByRole('button', { name: 'Select line 2' }).click()
    await changes.getByRole('textbox', { name: 'Feedback note' }).fill('First crash note')
    await changes.getByRole('button', { name: 'Add note' }).click()
    await changes.getByRole('button', { name: 'Select line 3' }).click()
    await changes.getByRole('textbox', { name: 'Feedback note' }).fill('Second crash note')
    await changes.getByRole('button', { name: 'Send feedback' }).click()
    await expect.poll(async () => readFile(signal, 'utf8').catch(() => '')).toBe('paused')
    const initial = JSON.parse(await readFile(join(userData, 'pending-sends-v1.json'), 'utf8')) as {
      records: Array<{ requestId: string; reviewFeedback?: { notes: unknown[] } }> }
    const requestId = initial.records[0].requestId
    expect(initial.records[0].reviewFeedback?.notes).toHaveLength(2)
    const process = application.process()
    process.kill('SIGKILL')
    await expect.poll(() => process.signalCode).toBe('SIGKILL')
    application = await launch(false)
    window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('combobox', { name: 'Workspace' }).selectOption({ label: 'project' })
    const originalConversation = window.getByRole('navigation', { name: 'Conversations' })
      .getByRole('button', { name: /New Conversation/ })
    await expect(originalConversation).toBeVisible()
    await originalConversation.click()
    changes = window.getByRole('region', { name: 'Changes' })
    await expect(changes.getByLabel('Feedback notes')).toContainText('First crash note')
    await expect(changes.getByLabel('Feedback notes')).toContainText('Second crash note')
    await changes.getByRole('button', { name: 'Retry feedback delivery' }).click()
    await expect(window.getByRole('region', { name: 'Conversation' }).locator('.message-user'))
      .toContainText('First crash note')
    const calls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    const turns = calls.map((line) => JSON.parse(line) as { method: string; params?: { clientUserMessageId?: string } })
      .filter((call) => call.method === 'turn/start')
    expect(turns).toHaveLength(1)
    expect(turns[0].params?.clientUserMessageId).toBe(requestId)
  } finally {
    await application.close().catch(() => undefined)
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})
