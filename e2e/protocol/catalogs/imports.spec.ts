// F042 (and F041's imported provenance): native Claude Code and Codex
// sessions imported from fixture files in the scratch HOME as read-only
// conversations, keyed by provider and native session ID.
import { appendFile, readFile } from 'node:fs/promises'
import { expect, test, type ScratchProfile } from '../fixtures'
import { claudeRecords, claudeTranscript, codexMessage, codexRollout } from '../fixtures/native-sessions'
import { treeSnapshot } from '../fixtures/tree'

const claudeId = 'effc8dc5-4adb-433e-9f12-25c6a7dd1c5b'
const codexId = '01a076ee-e1bb-71a1-9a20-d12ac6dc30ea'

async function call(profile: ScratchProfile, op: string, request: Record<string, unknown>): Promise<any> {
  return profile.call(op as never, request as never)
}

test('imports a Claude Code session twice without duplicates and keeps it read-only with its provenance', async ({ profile, repo }) => {
  const workspace = (await profile.call('workspace.open', { path: repo.path })).workspace
  const records = claudeRecords(claudeId, repo.path, [
    { uuid: 'u1', parent: null, role: 'user', text: 'Explain the quokkaflux cache' },
    { uuid: 'a1', parent: 'u1', role: 'assistant', text: 'The quokkaflux cache keeps parsed trees.' },
  ])
  const native = await claudeTranscript(profile.home, claudeId, repo.path,
    [{ type: 'mode', mode: 'default', sessionId: claudeId }, ...records, { type: 'ai-title', aiTitle: 'Quokkaflux cache', sessionId: claudeId }])
  const nativeBefore = await treeSnapshot(native.path)

  const scan = await call(profile, 'history.import.scan', { provider: 'claude', workspace_id: workspace.id })
  expect(scan.store).toMatchObject({ provider: 'claude', available: true, unavailable_reason: null })
  expect(scan.sessions).toEqual([expect.objectContaining({ native_session_id: claudeId, cwd: repo.path,
    title: 'Quokkaflux cache', source_path: native.path, imported_conversation_id: null })])

  const first = await call(profile, 'history.import.session', { provider: 'claude', native_session_id: claudeId, workspace_id: workspace.id })
  expect(first).toMatchObject({ outcome: 'imported', added_messages: 2, skipped_records: 0, incomplete_tail: false })
  const conversationId: string = first.conversation.provenance.conversation_id
  expect(first.conversation).toMatchObject({ status: 'imported', message_count: 2,
    provenance: { provider: 'claude', workspace_id: workspace.id, native_session_id: claudeId,
      import: { source_path: native.path, native_cwd: repo.path, account_id: null, resumable: false } } })
  expect(first.conversation.provenance.import.resume_unavailable_reason).toBeTruthy()

  // The second import, and one after a daemon crash, converge on the same conversation.
  const second = await call(profile, 'history.import.session', { provider: 'claude', native_session_id: claudeId, workspace_id: workspace.id })
  expect(second).toMatchObject({ outcome: 'unchanged', added_messages: 0, updated_messages: 0 })
  expect(second.conversation.provenance.conversation_id).toBe(conversationId)
  await profile.restartDaemon('kill')
  const third = await call(profile, 'history.import.session', { provider: 'claude', native_session_id: claudeId, workspace_id: workspace.id })
  expect(third).toMatchObject({ outcome: 'unchanged' })
  expect(third.conversation.provenance.conversation_id).toBe(conversationId)

  const snapshot = await profile.call('conversation.get', { conversation_id: conversationId })
  expect(snapshot.conversation.status).toBe('imported')
  expect(snapshot.messages.map((message) => (message as { text?: string }).text))
    .toEqual(['Explain the quokkaflux cache', 'The quokkaflux cache keeps parsed trees.'])
  const listed = await call(profile, 'history.list', { provider: 'claude' })
  expect(listed.conversations.filter((entry: any) => entry.provenance.conversation_id === conversationId)).toHaveLength(1)
  const rescanned = await call(profile, 'history.import.scan', { provider: 'claude' })
  expect(rescanned.sessions[0].imported_conversation_id).toBe(conversationId)

  // Imported history is searchable with its native provenance.
  await expect.poll(async () => (await call(profile, 'history.search', { query: 'quokkaflux' })).results.length).toBe(2)
  const search = await call(profile, 'history.search', { query: 'quokkaflux', provider: 'claude' })
  for (const hit of search.results) {
    expect(hit.provenance).toMatchObject({ conversation_id: conversationId, native_session_id: claudeId,
      import: { resumable: false } })
  }

  // Sending to it would start a new native session that looks like a continuation, so it is refused.
  await expect(profile.call('agent.send', { conversation_id: conversationId, request_id: `e2e-imported-${process.pid}`, text: 'continue' }))
    .rejects.toThrow()
  expect(await profile.mockCalls('claude')).toEqual([])
  // ADE only read the native file.
  expect(await treeSnapshot(native.path)).toEqual(nativeBefore)
})

test('extends a Codex import with appended records, waits for an incomplete tail, and refuses rewritten history', async ({ profile, repo }) => {
  const workspace = (await profile.call('workspace.open', { path: repo.path })).workspace
  const native = await codexRollout(profile.home, codexId, repo.path, [
    codexMessage('user', 'why is the wombatron build red?', 3),
    { timestamp: '2026-09-06T13:36:05.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command',
      arguments: '{"cmd":"gh run list"}', call_id: 'call_1' } },
    { timestamp: '2026-09-06T13:36:04.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'PRIVATE' } },
  ])
  const request = { provider: 'codex', native_session_id: codexId, workspace_id: workspace.id }

  const first = await call(profile, 'history.import.session', request)
  expect(first).toMatchObject({ outcome: 'imported', added_messages: 2 })
  const conversationId: string = first.conversation.provenance.conversation_id
  expect(first.conversation.provenance).toMatchObject({ provider: 'codex', native_session_id: codexId,
    import: { resumable: false, source_path: native.path } })

  // A tool result written after its call updates the imported call; a new answer is appended.
  await native.append([
    { timestamp: '2026-09-06T13:36:06.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'failed: lint' } },
    codexMessage('assistant', 'Lint fails in the wombatron package.', 7),
  ])
  const appended = await call(profile, 'history.import.session', request)
  expect(appended).toMatchObject({ outcome: 'appended', added_messages: 1, updated_messages: 1 })
  expect(appended.conversation.provenance.conversation_id).toBe(conversationId)

  // A record the provider is still writing is not read until it is complete.
  await native.append([codexMessage('user', 'fix it please', 8)], { partial: true })
  const tail = await call(profile, 'history.import.session', request)
  expect(tail).toMatchObject({ outcome: 'unchanged', incomplete_tail: true })
  // The provider finishes the record, then writes another.
  await appendFile(native.path, '\n')
  await native.append([codexMessage('assistant', 'Fixed.', 9)])
  expect((await readFile(native.path, 'utf8')).split('\n').filter(Boolean).every((line) => JSON.parse(line))).toBe(true)
  const completed = await call(profile, 'history.import.session', request)
  expect(completed).toMatchObject({ outcome: 'appended', added_messages: 2, incomplete_tail: false })

  const messages = (await profile.call('conversation.get', { conversation_id: conversationId })).messages
  expect(messages).toHaveLength(5)
  expect(JSON.stringify(messages)).not.toContain('PRIVATE')

  // Rewritten native history no longer extends the import: refused, and the import stays as it was.
  await native.rewrite([
    { timestamp: '2026-09-06T13:36:02.049Z', type: 'session_meta', payload: { id: codexId, cwd: repo.path } },
    codexMessage('user', 'a different first prompt', 3),
  ])
  await expect(call(profile, 'history.import.session', request)).rejects.toThrow()
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).messages).toHaveLength(5)

  // A repeat must name the workspace the first import used.
  const other = (await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })).workspace
  await expect(call(profile, 'history.import.session', { ...request, workspace_id: other.id })).rejects.toThrow()
})

test('concurrent duplicate imports of one session create one conversation', async ({ profile, repo }) => {
  const workspace = (await profile.call('workspace.open', { path: repo.path })).workspace
  await claudeTranscript(profile.home, claudeId, repo.path, claudeRecords(claudeId, repo.path, [
    { uuid: 'u1', parent: null, role: 'user', text: 'parallel import' },
    { uuid: 'a1', parent: 'u1', role: 'assistant', text: 'done' },
  ]))
  const request = { provider: 'claude', native_session_id: claudeId, workspace_id: workspace.id }
  const replies = await Promise.all(Array.from({ length: 6 }, () => call(profile, 'history.import.session', request)))
  const conversations = new Set(replies.map((reply) => reply.conversation.provenance.conversation_id))
  expect(conversations.size).toBe(1)
  expect(replies.filter((reply) => reply.outcome === 'imported')).toHaveLength(1)
  const listed = await call(profile, 'history.list', { provider: 'claude' })
  expect(listed.conversations).toHaveLength(1)
  expect(listed.conversations[0].message_count).toBe(2)
})

test('reports a missing native store as unavailable and refuses unknown sessions', async ({ profile }) => {
  const workspace = (await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })).workspace
  for (const provider of ['claude', 'codex']) {
    const scan = await call(profile, 'history.import.scan', { provider })
    expect(scan.store.available).toBe(false)
    expect(scan.store.unavailable_reason).toBeTruthy()
    expect(scan.sessions).toEqual([])
  }
  await expect(call(profile, 'history.import.session', { provider: 'claude', native_session_id: claudeId, workspace_id: workspace.id }))
    .rejects.toThrow()
  await expect(call(profile, 'history.import.session', { provider: 'codex', native_session_id: 'not-a-uuid', workspace_id: workspace.id }))
    .rejects.toThrow()

  const cli = await profile.cli('import', 'scan', 'codex')
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({ type: 'history_import_scan', store: { available: false } })
})
