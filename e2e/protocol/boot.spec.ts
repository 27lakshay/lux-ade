// Proof spec for the protocol E2E fixtures: a real daemon and runtime, a
// scratch Git repository, the SDK, the CLI, the provider mocks and the fault
// helpers, with nothing left running afterwards.
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  answerFor,
  answerIntent,
  expect,
  fixtureAnswers,
  isRunning,
  prompts,
  send,
  startConversation,
  test,
  turnReply,
  waitForIdle,
  waitForMessage,
  waitForPendingRequest,
  type MockProvider,
} from './fixtures'

test('opens a workspace, reads the catalog and capabilities, and keeps the workspace across a daemon restart', async ({
  profile,
  repo,
}) => {
  const opened = await profile.call('workspace.open', { path: repo.path })
  expect(opened.workspace.root).toBe(repo.path)

  const catalog = await profile.call('catalog.get', {})
  expect(catalog.boot_id).toBe(profile.hello.boot_id)
  expect(catalog.catalog.workspaces.map((workspace) => workspace.id)).toContain(opened.workspace.id)

  const listed = await profile.cli('workspace', 'list')
  expect(listed.code).toBe(0)
  expect(JSON.stringify(listed.json)).toContain(opened.workspace.id)

  const capabilities = await profile.call('provider.capabilities', {})
  expect(capabilities.providers.map((record) => record.provider)).toEqual(expect.arrayContaining(['codex', 'claude']))
  for (const record of capabilities.providers) expect(record.fingerprint).toMatch(/^[0-9a-f]{64}$/)

  const before = profile.hello
  const after = await profile.restartDaemon()
  expect(after.boot_id).not.toBe(before.boot_id)
  expect(after.pid).not.toBe(before.pid)
  expect(after.runtime_instance).toBe(before.runtime_instance)
  expect(await isRunning(before.pid)).toBe(false)

  const restored = await profile.call('catalog.get', {})
  expect(restored.boot_id).toBe(after.boot_id)
  expect(restored.catalog.workspaces.find((workspace) => workspace.id === opened.workspace.id)).toMatchObject({
    root: repo.path,
    needs_rebind: false,
  })

  await profile.stop()
  expect(await isRunning(after.pid)).toBe(false)
  expect(await isRunning(after.runtime_pid)).toBe(false)
  await expect(profile.rpc({ op: 'hello' }, 1_000)).rejects.toThrow()
})

test('scratch repositories expose committed, dirty and staged-and-unstaged states', async ({ repo }) => {
  const initial = await repo.head()
  const next = await repo.commit('Add notes', { 'notes.txt': 'one\n' })
  expect(next).not.toBe(initial)
  expect(await repo.status()).toEqual([])

  await repo.dirty('notes.txt', 'two\n')
  await repo.dirty('untracked.txt', 'new\n')
  const mixed = await repo.stagedAndUnstaged()
  expect((await repo.status()).sort()).toEqual([' M notes.txt', 'MM mixed.txt', '?? untracked.txt'].sort())
  expect(await repo.git('show', ':mixed.txt')).toBe(mixed.staged.trimEnd())
  expect(await repo.read('mixed.txt')).toBe(mixed.unstaged)
})

for (const provider of ['codex', 'claude'] as MockProvider[]) {
  test(`the ${provider} mock scripts a turn, an approval and questions`, async ({ profile }) => {
    const { conversationId } = await startConversation(profile, provider)

    await send(profile, conversationId, prompts.turn)
    await waitForMessage(profile, conversationId, turnReply[provider])
    await waitForIdle(profile, conversationId)

    await send(profile, conversationId, prompts.approval)
    const approval = await waitForPendingRequest(profile, conversationId)
    await profile.call('agent.answer', answerIntent(approval, answerFor(approval, 'decline')))
    await waitForIdle(profile, conversationId)

    await send(profile, conversationId, prompts.questions)
    const questions = await waitForPendingRequest(profile, conversationId)
    const answers = fixtureAnswers(questions)
    if (answers.kind !== 'questions') throw new Error('Expected native question answers')
    expect(Object.keys(answers.answers)).toHaveLength(2)
    await profile.call('agent.answer', answerIntent(questions, answers))
    await waitForIdle(profile, conversationId)

    const calls = await profile.mockCalls(provider)
    const answered = calls.filter((call) => call.method === (provider === 'codex' ? 'approval/reply' : 'answer'))
    expect(answered).toHaveLength(2)
  })
}

test('fault helpers kill the runtime and the daemon, and a restart recovers on the same data', async ({ profile }) => {
  const workspace = (await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })).workspace

  const first = profile.hello
  await profile.killRuntime()
  expect(await isRunning(first.runtime_pid)).toBe(false)
  const recovered = await profile.restartDaemon()
  expect(recovered.runtime_instance).not.toBe(first.runtime_instance)
  expect(await isRunning(recovered.runtime_pid)).toBe(true)

  await profile.killDaemon()
  expect(await isRunning(recovered.pid)).toBe(false)
  expect(await isRunning(recovered.runtime_pid)).toBe(true)
  const adopted = await profile.restartDaemon()
  expect(adopted.runtime_instance).toBe(recovered.runtime_instance)

  const catalog = await profile.call('catalog.get', {})
  expect(catalog.catalog.workspaces.map((entry) => entry.id)).toContain(workspace.id)
})

test('the CLI runner returns the exit code and the parsed JSON error', async ({ profile }) => {
  const missing = await profile.cli('conversation', 'inspect', 'conversation_missing')
  expect(missing.code).not.toBe(0)
  expect(missing.json).toMatchObject({ type: 'error' })
})

test('the SDK rejects a reply-less request that fails its contract before sending it', async ({ profile }) => {
  // @ts-expect-error: the contract requires `path`.
  await expect(profile.call('workspace.open', {})).rejects.toMatchObject({
    code: 'invalid_request',
    delivery: 'not_sent',
  })
})

test('a profile database at another schema version is refused with the delete instruction', async ({ profile }) => {
  await profile.stop()
  const database = new DatabaseSync(join(profile.dataDirectory, 'sessions.sqlite'))
  const current = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  database.exec(`PRAGMA user_version=${current - 1}`)
  database.close()
  // Nothing upgrades an older database before launch (D19); the daemon stops.
  await expect(profile.restartDaemon()).rejects.toThrow(
    new RegExp(`has schema version ${current - 1}; this build reads only schema ${current}.*Delete the database`),
  )
})
