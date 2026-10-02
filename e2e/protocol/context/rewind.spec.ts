// F039: conversation and file rewind. Codex conversation rewind forks the
// thread before the rewound turn (below); Claude's is proved in
// e2e/protocol/accounts-rewind/rewind.spec.ts. File rewind restores an ADE
// checkpoint for any provider: it is previewed first, refuses a stale preview
// and unconfirmed overwrites, and reads a lost outcome back after a crash.
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  cancelActiveSubmission,
  expect,
  prompts,
  send,
  startConversation,
  test,
  waitForIdle,
  type AdeHarness,
  type ScratchProfile,
  type ScratchRepo,
} from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'
import { mockDirectory } from '../fixtures/providers'
import { snapshot } from './helpers'

async function checkpointed(profile: ScratchProfile, repo: ScratchRepo, provider: 'codex' | 'claude') {
  await repo.commit('Add source', { 'src/app.ts': 'export const answer = 42\n' })
  const { workspaceId, conversationId } = await startConversation(profile, provider, repo.path)
  const { checkpoint } = await profile.call('checkpoint.create', {
    operation_id: `cp-${provider}`,
    workspace_id: workspaceId,
    label: 'before the agent',
  })
  // The agent's work: an edit and a new file.
  await repo.dirty('src/app.ts', 'export const answer = 41\n')
  await repo.write('src/extra.ts', 'export {}\n')
  return { workspaceId, conversationId, checkpointId: checkpoint.checkpoint_id }
}

async function control(profile: ScratchProfile, conversationId: string, name: string) {
  return (await profile.call('conversation.controls', { conversation_id: conversationId })).controls.find(
    (entry) => entry.control === name,
  )
}

for (const provider of ['codex', 'claude'] as const) {
  test(`F039: ${provider} rewinds files through a checkpoint after a preview`, async ({ profile, repo }) => {
    const { conversationId, checkpointId } = await checkpointed(profile, repo, provider)
    expect(await control(profile, conversationId, 'rewind_files')).toMatchObject({
      available: true,
      mechanism: 'ade.checkpoints',
      reason: null,
    })
    await send(profile, conversationId, prompts.turn)
    await waitForIdle(profile, conversationId)
    const before = (await snapshot(profile, conversationId)).messages

    // File rewind: the preview lists what changes and asks for confirmation over uncommitted work.
    const preview = await profile.call('conversation.rewind.preview', {
      conversation_id: conversationId,
      scope: 'files',
      checkpoint_id: checkpointId,
    })
    expect(preview.availability).toMatchObject({ available: true, mechanism: 'ade.checkpoints' })
    expect(preview.files).toMatchObject({
      verdict: 'needs_confirmation',
      uncommitted_overwritten: expect.arrayContaining(['src/app.ts']),
    })
    expect(preview.files!.changes.map((change) => change.path).sort()).toEqual(['src/app.ts', 'src/extra.ts'])
    const rewind = {
      operation_id: 'rewind-op',
      conversation_id: conversationId,
      scope: 'files' as const,
      checkpoint_id: checkpointId,
      expected_state: preview.files!.state_token,
      confirm_overwrite: true,
    }
    const reply = await profile.call('conversation.rewind', rewind)
    expect(reply).toMatchObject({
      outcome: 'restored',
      control: 'rewind_files',
      reason: null,
      files: { outcome: 'restored', verified: true, problems: [] },
    })
    expect(reply.files!.safety_checkpoint).not.toBeNull()
    expect(await repo.read('src/app.ts')).toBe('export const answer = 42\n')
    await expect(repo.read('src/extra.ts')).rejects.toThrow()
    // The conversation history is not touched by a file rewind.
    expect((await snapshot(profile, conversationId)).messages).toEqual(before)

    // R002: the same operation replays its outcome, also after a daemon crash; a different payload conflicts.
    expect(await profile.call('conversation.rewind', rewind)).toEqual(reply)
    await profile.restartDaemon('kill')
    expect(await profile.call('conversation.rewind', rewind)).toEqual(reply)
    await expect(profile.call('conversation.rewind', { ...rewind, confirm_overwrite: false })).rejects.toThrow(
      'already used for a different request',
    )
    // Rewinding again to where the files already are changes nothing.
    const again = await profile.call('conversation.rewind.preview', {
      conversation_id: conversationId,
      scope: 'files',
      checkpoint_id: checkpointId,
    })
    expect(again.files).toMatchObject({ verdict: 'unchanged', changes: [] })
  })
}

test('F039: file rewind refuses a stale preview, unconfirmed overwrites and a running turn, and keeps the files', async ({
  profile,
  repo,
}) => {
  const { workspaceId, conversationId, checkpointId } = await checkpointed(profile, repo, 'codex')
  const preview = await profile.call('conversation.rewind.preview', {
    conversation_id: conversationId,
    scope: 'files',
    checkpoint_id: checkpointId,
  })
  const base = {
    conversation_id: conversationId,
    scope: 'files' as const,
    checkpoint_id: checkpointId,
    expected_state: preview.files!.state_token,
  }
  await expect(profile.call('conversation.rewind', { ...base, operation_id: 'rewind-unconfirmed' })).rejects.toThrow(
    /confirm/i,
  )
  // The files moved after the preview: its state token no longer matches.
  await repo.dirty('src/app.ts', 'export const answer = 40\n')
  await expect(
    profile.call('conversation.rewind', { ...base, operation_id: 'rewind-stale', confirm_overwrite: true }),
  ).rejects.toThrow(/changed|preview/i)
  expect(await repo.read('src/app.ts')).toBe('export const answer = 40\n')

  // While a turn runs, file rewind is unavailable and records nothing.
  await send(profile, conversationId, prompts.hold)
  await expect.poll(async () => (await snapshot(profile, conversationId)).conversation.status).toBe('running')
  const fresh = await profile.call('checkpoint.restore.preview', {
    workspace_id: workspaceId,
    checkpoint_id: checkpointId,
  })
  const running = await profile.call('conversation.rewind.preview', {
    conversation_id: conversationId,
    scope: 'files',
    checkpoint_id: checkpointId,
  })
  expect(running).toMatchObject({
    files: null,
    availability: { available: false, reason: 'A turn is running; stop it before rewinding files' },
  })
  const busy = { ...base, operation_id: 'rewind-busy', expected_state: fresh.state_token, confirm_overwrite: true }
  expect(await profile.call('conversation.rewind', busy)).toMatchObject({
    outcome: 'unavailable',
    reason: 'A turn is running; stop it before rewinding files',
    files: null,
  })
  expect(await repo.read('src/app.ts')).toBe('export const answer = 40\n')
  await cancelActiveSubmission(profile, conversationId)
  await expect.poll(async () => (await snapshot(profile, conversationId)).conversation.status).toBe('interrupted')
  // No receipt was kept: the same operation ID runs once the turn has stopped.
  expect(await profile.call('conversation.rewind', busy)).toMatchObject({ outcome: 'restored' })
  expect(await repo.read('src/app.ts')).toBe('export const answer = 42\n')
})

// R001 for file rewind. The reply is lost and the daemon is SIGKILLed at a
// fixed point, where the daemon's debug-only receipt pause
// (`receipts::e2e_pause`, gated on ADE_E2E_RECEIPT_PAUSE_DIR) holds it:
// - conversation.rewind.files.settled: the restore's receipt has settled, so
//   a retry reads the restore back once;
// - checkpoint.restore.writing and checkpoint.restore.written, either side of
//   the file writes: the receipt says the workspace may be changing, so a
//   retry reports the outcome unknown, never runs the restore again, and the
//   files stay as the crash left them.
type PausePoint = 'conversation.rewind.files.settled' | 'checkpoint.restore.writing' | 'checkpoint.restore.written'
const UNKNOWN =
  /rewind-lost:files was interrupted while it was changing the workspace; its outcome is unknown and it will not run again/

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

/** Loses a file rewind's reply, SIGKILLs the daemon while it is held at `point`, then starts a new daemon. */
async function rewindLostAt(ade: AdeHarness, repo: ScratchRepo, point: PausePoint) {
  const pause = join(ade.root, 'pause-receipt')
  await mkdir(pause, { recursive: true })
  const profile = await ade.profile({ env: { ADE_E2E_RECEIPT_PAUSE_DIR: pause } })
  const { workspaceId, conversationId, checkpointId } = await checkpointed(profile, repo, 'codex')
  const preview = await profile.call('conversation.rewind.preview', {
    conversation_id: conversationId,
    scope: 'files',
    checkpoint_id: checkpointId,
  })
  const rewind = {
    operation_id: 'rewind-lost',
    conversation_id: conversationId,
    scope: 'files' as const,
    checkpoint_id: checkpointId,
    expected_state: preview.files!.state_token,
    confirm_overwrite: true,
  }
  await writeFile(join(pause, `${point}.armed`), '')
  await sendAndLoseReply(profile, { op: 'conversation.rewind', ...rewind })
  await expect.poll(() => exists(join(pause, `${point}.paused`)), { timeout: 30_000 }).toBe(true)
  await profile.killDaemon()
  // Nothing is armed for the daemons that follow.
  await rm(join(pause, `${point}.armed`))
  await profile.restartDaemon()
  const safety = async () =>
    (await profile.call('checkpoint.list', { workspace_id: workspaceId })).checkpoints.filter(
      (entry) => entry.checkpoint_id !== checkpointId,
    )
  return { profile, rewind, safety }
}

test('R001: a file rewind whose reply was lost after it settled is read back after a daemon crash and restores once', async ({
  ade,
  repo,
}) => {
  const { profile, rewind, safety } = await rewindLostAt(ade, repo, 'conversation.rewind.files.settled')
  expect(await repo.read('src/app.ts')).toBe('export const answer = 42\n')
  await expect(repo.read('src/extra.ts')).rejects.toThrow()
  // The user edits again; the retry reports the earlier restore and does not write over the new edit.
  await repo.dirty('src/app.ts', 'export const answer = 43\n')
  const retried = await profile.call('conversation.rewind', rewind)
  expect(retried).toMatchObject({ outcome: 'restored', files: { outcome: 'restored', verified: true } })
  expect(await repo.read('src/app.ts')).toBe('export const answer = 43\n')
  await profile.restartDaemon('kill')
  expect(await profile.call('conversation.rewind', rewind)).toEqual(retried)
  expect(await repo.read('src/app.ts')).toBe('export const answer = 43\n')
  expect(await safety()).toHaveLength(1)
})

test('R001: a file rewind crashed before it wrote files reports its outcome unknown and never runs again', async ({
  ade,
  repo,
}) => {
  const { profile, rewind, safety } = await rewindLostAt(ade, repo, 'checkpoint.restore.writing')
  // The workspace is as the agent left it.
  expect(await repo.read('src/app.ts')).toBe('export const answer = 41\n')
  expect(await repo.read('src/extra.ts')).toBe('export {}\n')
  const [kept] = await safety()
  const unknown = profile.call('conversation.rewind', rewind)
  await expect(unknown).rejects.toThrow(UNKNOWN)
  await expect(unknown).rejects.toThrow(`safety checkpoint ${kept.checkpoint_id}`)
  await profile.restartDaemon('kill')
  await expect(profile.call('conversation.rewind', rewind)).rejects.toThrow(UNKNOWN)
  expect(await repo.read('src/app.ts')).toBe('export const answer = 41\n')
  expect(await repo.read('src/extra.ts')).toBe('export {}\n')
  expect(await safety()).toHaveLength(1)
})

test('R001: a file rewind crashed after it wrote files, before it settled, reports its outcome unknown and never runs again', async ({
  ade,
  repo,
}) => {
  const { profile, rewind, safety } = await rewindLostAt(ade, repo, 'checkpoint.restore.written')
  // The workspace is restored.
  expect(await repo.read('src/app.ts')).toBe('export const answer = 42\n')
  await expect(repo.read('src/extra.ts')).rejects.toThrow()
  // A later edit is never overwritten by a retry.
  await repo.dirty('src/app.ts', 'export const answer = 43\n')
  await expect(profile.call('conversation.rewind', rewind)).rejects.toThrow(UNKNOWN)
  await profile.restartDaemon('kill')
  await expect(profile.call('conversation.rewind', rewind)).rejects.toThrow(UNKNOWN)
  expect(await repo.read('src/app.ts')).toBe('export const answer = 43\n')
  expect(await safety()).toHaveLength(1)
})

// Codex conversation rewind forks the thread with thread/fork and lastTurnId
// (stable in the Codex 0.157.0 v2 protocol, and supported on the legacy
// threads ADE's adapter starts): the fork keeps every turn through the turn
// before the rewound one, the Conversation continues in it, and the earlier
// thread stays unchanged. thread/revert (paginated threads only) and the
// removed thread/rollback are never called. The mock (codex_mock.py) emulates
// only that documented lastTurnId behaviour.
type Message = { id: string; role: string; text: string; turn_id: string | null; sequence: number }

async function codexMessages(profile: ScratchProfile, conversationId: string): Promise<Message[]> {
  return (await profile.call('conversation.get', { conversation_id: conversationId, limit: 200 })).messages
}

async function codexThread(profile: ScratchProfile, conversationId: string): Promise<string | null> {
  return (await snapshot(profile, conversationId)).conversation.provider_thread_id
}

async function hits(profile: ScratchProfile, query: string): Promise<number> {
  return ((await profile.call('history.search' as never, { query } as never)) as { results: unknown[] }).results.length
}

/** The turn IDs a mock Codex thread holds, as its thread file stores them. */
async function mockTurns(profile: ScratchProfile, threadId: string): Promise<string[]> {
  const stored = JSON.parse(await readFile(join(mockDirectory(profile.root, 'codex'), `${threadId}.json`), 'utf8')) as {
    turns: Array<{ id: string }>
  }
  return stored.turns.map((turn) => turn.id)
}

async function codexCalls(profile: ScratchProfile, method: string) {
  return (await profile.mockCalls('codex'))
    .filter((call) => call.method === method)
    .map((call) => call.params as Record<string, unknown>)
}

test('F039, F043: a Codex conversation rewind forks the thread before the turn, drops later messages, refuses stale history pages and drops search hits', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  for (const text of ['first zebracorn', 'second quokkaflux', 'third lemurmint']) {
    await send(profile, conversationId, text)
    await waitForIdle(profile, conversationId)
  }
  const all = await codexMessages(profile, conversationId)
  expect(all.map((message) => message.text)).toEqual([
    'first zebracorn',
    'Hello world',
    'second quokkaflux',
    'Hello world',
    'third lemurmint',
    'Hello world',
  ])
  const [first, , second] = all
  const original = (await codexThread(profile, conversationId))!
  const originalTurns = await mockTurns(profile, original)
  expect(originalTurns).toHaveLength(3)
  await expect.poll(() => hits(profile, 'quokkaflux')).toBe(1)

  expect(await control(profile, conversationId, 'rewind_conversation')).toMatchObject({
    available: true,
    mechanism: 'codex.thread_fork',
    reason: null,
  })
  // A reader holds the newest page and pages back from it.
  const page = await profile.call('conversation.get', { conversation_id: conversationId, limit: 2 })
  const cursor = {
    conversation_id: conversationId,
    before: (page.messages[0] as Message).sequence,
    limit: 2,
    history_epoch: page.history_epoch,
  }
  expect((await profile.call('conversation.get', cursor)).messages).toHaveLength(2)

  const shown = await profile.call('conversation.rewind.preview', {
    conversation_id: conversationId,
    scope: 'conversation',
    before_message_id: second.id,
  })
  expect(shown.history).toMatchObject({
    before_message_id: second.id,
    turn_id: second.turn_id,
    removed_messages: 4,
    removed_turns: 2,
    kept_messages: 2,
    history_epoch: 0,
  })
  const rewind = {
    operation_id: 'rewind-codex',
    conversation_id: conversationId,
    scope: 'conversation' as const,
    before_message_id: second.id,
    expected_state: shown.history!.state_token,
  }
  const reply = await profile.call('conversation.rewind', rewind)
  expect(reply).toMatchObject({
    outcome: 'acknowledged',
    control: 'rewind_conversation',
    reason: null,
    history: {
      removed_messages: 4,
      removed_turns: 2,
      kept_messages: 2,
      history_epoch: 1,
      previous_native_session: original,
    },
  })
  const forked = reply.history!.native_session!
  expect(forked).toBeTruthy()
  expect(forked).not.toBe(original)

  // Codex forked through the first turn; no history-rewriting method ran.
  expect(await codexCalls(profile, 'thread/fork')).toEqual([
    expect.objectContaining({ threadId: original, lastTurnId: first.turn_id }),
  ])
  expect(await codexCalls(profile, 'thread/revert')).toEqual([])
  expect(await codexCalls(profile, 'thread/rollback')).toEqual([])
  expect(await mockTurns(profile, forked)).toEqual([first.turn_id])
  expect(await mockTurns(profile, original)).toEqual(originalTurns)

  // ADE dropped the later turns and moved the Conversation to the fork.
  expect(await codexThread(profile, conversationId)).toBe(forked)
  expect((await codexMessages(profile, conversationId)).map((message) => message.text)).toEqual([
    'first zebracorn',
    'Hello world',
  ])
  await expect(profile.call('conversation.get', cursor)).rejects.toThrow(/History changed since that page was read/)
  await expect.poll(() => hits(profile, 'quokkaflux')).toBe(0)
  await expect.poll(() => hits(profile, 'lemurmint')).toBe(0)
  expect(await hits(profile, 'zebracorn')).toBe(1)

  // R002: the same operation replays, also after a daemon crash, and forks once.
  expect(await profile.call('conversation.rewind', rewind)).toEqual(reply)
  await profile.restartDaemon('kill')
  expect(await profile.call('conversation.rewind', rewind)).toEqual(reply)
  expect(await codexCalls(profile, 'thread/fork')).toHaveLength(1)

  // The next turn runs in the fork, and a resume reads the fork back unchanged.
  await send(profile, conversationId, 'fourth ocelotwave')
  await waitForIdle(profile, conversationId)
  expect((await codexCalls(profile, 'turn/start')).at(-1)).toMatchObject({ threadId: forked })
  expect(await mockTurns(profile, forked)).toHaveLength(2)
  const continued = await codexMessages(profile, conversationId)
  expect(continued.map((message) => message.text)).toEqual([
    'first zebracorn',
    'Hello world',
    'fourth ocelotwave',
    'Hello world',
  ])
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
  expect(await codexThread(profile, conversationId)).toBe(forked)
  expect((await codexMessages(profile, conversationId)).map((message) => [message.id, message.text])).toEqual(
    continued.map((message) => [message.id, message.text]),
  )
})

test('F039: a Codex rewind before the first turn is refused and keeps the thread', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.turn)
  await waitForIdle(profile, conversationId)
  const [first] = await codexMessages(profile, conversationId)
  const original = await codexThread(profile, conversationId)
  const shown = await profile.call('conversation.rewind.preview', {
    conversation_id: conversationId,
    scope: 'conversation',
    before_message_id: first.id,
  })
  const reply = await profile.call('conversation.rewind', {
    operation_id: 'rewind-first',
    conversation_id: conversationId,
    scope: 'conversation',
    before_message_id: first.id,
    expected_state: shown.history!.state_token,
  })
  expect(reply).toMatchObject({ outcome: 'refused', control: 'rewind_conversation' })
  expect(reply.history).toBeUndefined()
  expect(await codexCalls(profile, 'thread/fork')).toEqual([])
  expect(await codexThread(profile, conversationId)).toBe(original)
  expect((await codexMessages(profile, conversationId)).map((message) => message.text)).toEqual([
    first.text,
    'Hello world',
  ])
})
