import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { managedProfileOwner, rpc, stopManagedProfiles, type ManagedProfileOwner } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const electronExecutable = createRequire(join(desktopDirectory, 'package.json'))('electron') as string
const run = promisify(execFile)

test('pending-send transfer validates restored intent and holds replay across profile identities', async () => {
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), 'ade-send-transfer-'))
  const profileRoot = join(root, 'profiles')
  const userData = join(root, 'electron')
  const mockDirectory = join(root, 'codex')
  const signal = join(root, 'send-paused')
  const release = join(root, 'send-release')
  const bundle = join(root, 'send-bundle.json')
  const backend = join(root, 'backend-backup')
  const { ADE_SOCKET: _fixedSocket, ADE_DAEMON_BIN: _parentDaemon, ...environment } = process.env
  const options = { executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...environment, ADE_PROFILES_HOME: profileRoot, ADE_E2E_USER_DATA_DIR: userData,
      ADE_DAEMON_BIN: resolve('target/debug/ade-daemon'), ADE_E2E_HIDE_WINDOW: '1',
      ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'), ADE_CODEX_TRANSPORT: 'stdio',
      ADE_MOCK_DIR: mockDirectory, ADE_E2E_SEND_JOURNAL_PAUSE: '1',
      ADE_E2E_SEND_JOURNAL_SIGNAL: signal, ADE_E2E_SEND_JOURNAL_RELEASE: release } }
  let application = await electron.launch(options)
  const owned: ManagedProfileOwner[] = []
  try {
    let window = await application.firstWindow()
    await window.getByRole('textbox', { name: 'New profile' }).fill('Source')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const source = (await window.evaluate(() => window.adeHost.getProfileState())).profiles.find((item) => item.name === 'Source')!
    const sourceSocket = (JSON.parse((await run('python3', [resolve('scripts/runtime.py'), 'locate', '--home', source.home])).stdout) as { socket: string }).socket
    owned.push(await managedProfileOwner(sourceSocket))
    await window.getByRole('button', { name: 'New conversation' }).click()
    const conversation = window.getByRole('region', { name: 'Conversation' })
    await conversation.getByRole('textbox', { name: 'Prompt' }).fill('transfer pending prompt')
    await conversation.getByRole('button', { name: 'Send' }).click()
    await expect.poll(() => stat(signal).then(() => true, () => false)).toBe(true)
    const original = JSON.parse(await readFile(join(userData, 'pending-sends-v1.json'), 'utf8')) as {
      records: Array<{ profileId: string; windowId: string; conversationId: string; requestId: string;
        draftRevision: number; draftText: string; text: string; attachments: unknown[]; dispatchStarted: boolean }> }
    expect(original.records).toHaveLength(1)
    const record = original.records[0]
    expect(record).toMatchObject({ profileId: source.id, dispatchStarted: false, text: 'transfer pending prompt' })
    const exported = await window.evaluate(({ id, file }) => window.adeHost.exportSendJournalProfile(id, file),
      { id: source.id, file: bundle })
    expect(exported).toMatchObject({ type: 'pending_sends_exported', record_count: 1, source_profile_id: source.id })
    expect((await stat(bundle)).mode & 0o777).toBe(0o600)
    await expect(window.evaluate(({ id, file }) => window.adeHost.exportSendJournalProfile(id, file),
      { id: source.id, file: bundle })).rejects.toThrow()
    const target = (await window.evaluate(() => window.adeHost.createProfile('Restored')))
      .profiles.find((item) => item.name === 'Restored')!
    const process = application.process()
    process.kill('SIGKILL')
    await expect.poll(() => process.signalCode).toBe('SIGKILL')

    // The backend is a real daemon. Persist exactly the intent found in the journal,
    // then snapshot its SQLite store through the public managed backup CLI.
    await rpc(sourceSocket, { op: 'draft.save', conversation_id: record.conversationId,
      window_id: record.windowId, revision: record.draftRevision,
      text: record.draftText, attachments: record.attachments })
    await rpc(sourceSocket, { op: 'draft.send.prepare', conversation_id: record.conversationId,
      window_id: record.windowId, request_id: record.requestId, revision: record.draftRevision,
      draft_text: record.draftText, text: record.text, attachments: record.attachments })
    await rpc(sourceSocket, { op: 'agent.send', conversation_id: record.conversationId,
      request_id: record.requestId, text: record.text, attachments: record.attachments })
    await expect.poll(async () => {
      const snapshot = await rpc(sourceSocket, { op: 'conversation.get', conversation_id: record.conversationId })
      return (snapshot.messages as Array<{ id: string; role: string }>).some((message) =>
        message.id === record.requestId && message.role === 'user')
    }).toBe(true)
    const binding = JSON.parse(await readFile(join(source.home, 'runtime.json'), 'utf8')) as { data_directory: string }
    await run('python3', [resolve('scripts/managed_backup.py'), 'create', '--data-dir', binding.data_directory, '--out', backend])
    const targetData = join(target.home, 'data')
    await mkdir(target.home, { recursive: true })
    await run('python3', [resolve('scripts/managed_backup.py'), 'restore', '--backup', backend, '--data-dir', targetData])
    await run('python3', [resolve('scripts/runtime.py'), 'adopt', '--home', target.home, '--data-dir', targetData])

    await writeFile(release, 'release')
    await run('python3', [resolve('scripts/profiles.py'), '--home', profileRoot, 'select', target.id])
    application = await electron.launch({ ...options,
      env: { ...options.env, ADE_E2E_TEST_CLOSE_GUARD: '1' } })
    window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const targetSocket = (JSON.parse((await run('python3', [resolve('scripts/runtime.py'), 'locate', '--home', target.home])).stdout) as { socket: string }).socket
    owned.push(await managedProfileOwner(targetSocket))
    const proof = await rpc(targetSocket, { op: 'draft.send.get', conversation_id: record.conversationId,
      window_id: record.windowId })
    expect(proof).toMatchObject({ restored_from_backup: true, intent: { request_id: record.requestId } })
    await window.evaluate((conversationId) => window.adeHost.requestConversation('draft.get', {
      conversation_id: conversationId }), record.conversationId)
    const autoHeld = (JSON.parse(await readFile(join(userData, 'pending-sends-v1.json'), 'utf8')) as {
      records: Array<{ profileId: string; requestId: string; dispatchStarted: boolean; restoreHold?: boolean }> }).records
      .find((item) => item.profileId === target.id)
    expect(autoHeld).toMatchObject({ requestId: record.requestId, dispatchStarted: true, restoreHold: true })
    const earlyRetry = await window.evaluate(({ conversationId, requestId }) => window.adeHost.requestConversation('agent.retry_send', {
      conversation_id: conversationId, request_id: requestId,
    }), { conversationId: record.conversationId, requestId: record.requestId })
    expect(String(earlyRetry.message)).toContain('held')
    await application.close()
    const afterClose = (JSON.parse(await readFile(join(userData, 'pending-sends-v1.json'), 'utf8')) as {
      records: Array<{ profileId: string; requestId: string; restoreHold?: boolean }> }).records
      .find((item) => item.profileId === target.id)
    expect(afterClose).toMatchObject({ requestId: record.requestId, restoreHold: true })
    expect((await rpc(targetSocket, { op: 'draft.send.get', conversation_id: record.conversationId,
      window_id: record.windowId })).intent).toMatchObject({ request_id: record.requestId, state: 'pending' })
    await run('python3', [resolve('scripts/profiles.py'), '--home', profileRoot, 'select', source.id])
    application = await electron.launch(options)
    window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const artifact = JSON.parse(await readFile(bundle, 'utf8')) as {
      format: string; records: { value: Array<{ text: string; dispatchStarted: boolean }>; bytes: number; sha256: string } }
    const mismatched = join(root, 'mismatched.json')
    artifact.records.value[0].text = 'wrong payload'
    const altered = JSON.stringify(artifact.records.value)
    artifact.records.bytes = Buffer.byteLength(altered)
    artifact.records.sha256 = createHash('sha256').update(altered).digest('hex')
    await writeFile(mismatched, JSON.stringify(artifact))
    await expect(window.evaluate(({ file, from, to }) => window.adeHost.importSendJournalProfile(file, from, to),
      { file: mismatched, from: source.id, to: target.id })).rejects.toThrow(/different or unheld/)
    const laterMismatch = join(root, 'later-mismatch.json')
    artifact.records.value[0].text = record.text
    artifact.records.value.push({ ...artifact.records.value[0], conversationId: randomUUID(), requestId: randomUUID() } as typeof artifact.records.value[0])
    const twoRecords = JSON.stringify(artifact.records.value)
    artifact.records.bytes = Buffer.byteLength(twoRecords)
    artifact.records.sha256 = createHash('sha256').update(twoRecords).digest('hex')
    await writeFile(laterMismatch, JSON.stringify(artifact))
    await expect(window.evaluate(({ file, from, to }) => window.adeHost.importSendJournalProfile(file, from, to),
      { file: laterMismatch, from: source.id, to: target.id })).rejects.toThrow(/unavailable/)
    const dispatched = join(root, 'dispatched.json')
    artifact.records.value.pop()
    artifact.records.value[0].dispatchStarted = true
    const dispatchedRecords = JSON.stringify(artifact.records.value)
    artifact.records.bytes = Buffer.byteLength(dispatchedRecords)
    artifact.records.sha256 = createHash('sha256').update(dispatchedRecords).digest('hex')
    await writeFile(dispatched, JSON.stringify(artifact))
    await expect(window.evaluate(({ file, from, to }) => window.adeHost.importSendJournalProfile(file, from, to),
      { file: dispatched, from: source.id, to: target.id })).rejects.toThrow(/unknown external outcome/)
    expect((JSON.parse(await readFile(join(userData, 'pending-sends-v1.json'), 'utf8')) as { records: unknown[] }).records)
      .toHaveLength(2)
    const imported = await window.evaluate(({ file, from, to }) => window.adeHost.importSendJournalProfile(file, from, to),
      { file: bundle, from: source.id, to: target.id })
    expect(imported).toMatchObject({ type: 'pending_sends_imported_held', profile_id: target.id,
      record_count: 1, reconciled_count: 1 })
    const transferred = (JSON.parse(await readFile(join(userData, 'pending-sends-v1.json'), 'utf8')) as {
      records: Array<{ profileId: string; requestId: string; endpoint: string; restoreHold?: boolean }> }).records
    expect(transferred).toHaveLength(2)
    expect(transferred.find((item) => item.profileId === target.id)).toMatchObject({
      requestId: record.requestId, restoreHold: true, endpoint: expect.not.stringContaining(sourceSocket) })
    await application.close()
    application = await electron.launch(options)
    let restartStderr = ''
    application.process().stderr?.on('data', (chunk: Buffer) => { restartStderr += chunk.toString() })
    try { window = await application.firstWindow() }
    catch (error) { throw new Error(`Restart failed: ${restartStderr}`, { cause: error }) }
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.evaluate((id) => window.adeHost.selectProfile(id), target.id)
    const retry = await window.evaluate(({ conversationId, requestId }) => window.adeHost.requestConversation('agent.retry_send', {
      conversation_id: conversationId, request_id: requestId,
    }), { conversationId: record.conversationId, requestId: record.requestId })
    expect(retry).toMatchObject({ type: 'send_pending', request_id: record.requestId })
    expect(String(retry.message)).toContain('held')
    const calls = await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8').catch(() => '')
    expect(calls.split('\n').filter(Boolean).filter((line) => JSON.parse(line).method === 'turn/start')).toHaveLength(1)
    const sourceIntent = await rpc(sourceSocket, { op: 'draft.send.get', conversation_id: record.conversationId,
      window_id: record.windowId })
    expect((sourceIntent.intent as { request_id: string }).request_id).toBe(record.requestId)
  } finally {
    await application.close().catch(() => undefined)
    await stopManagedProfiles(owned)
    await rm(root, { recursive: true, force: true })
  }
})
