// F050, readable history export: `ade conversation export ID FILE` writes a
// Conversation's complete history as JSON through the public paginated read.
// It pages past the 100-message page size, never overwrites a file, leaves no
// partial file behind, and refuses a history that changes while it reads.
// The managed backup half of F050 is proved in e2e/protocol/backup.
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, prompts, send, startConversation, test, waitForIdle, type ScratchProfile } from '../fixtures'
import { claudeRecords, claudeTranscript } from '../fixtures/native-sessions'

const sessionId = '5f0a4c61-8d0e-4c2b-9b7e-1f3a2d9c7e10'

type Exported = {
  format: string
  scope: string
  message_order: string
  boot_id: string
  revision: number
  conversation: { id: string }
  messages: Array<{ id: string; sequence: number; role: string; text: string; conversation_id: string }>
}

/** Import a Claude Code transcript of `pairs` user and assistant turns; returns its Conversation ID. */
async function importedConversation(profile: ScratchProfile, root: string, pairs: number): Promise<string> {
  const workspace = (await profile.call('workspace.open', { path: root })).workspace
  const turns = Array.from({ length: pairs * 2 }, (_, index) => ({
    uuid: `m${index}`, parent: index ? `m${index - 1}` : null, role: (index % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
    text: `${index % 2 ? 'Answer' : 'Question'} ${index}`,
  }))
  await claudeTranscript(profile.home, sessionId, root, claudeRecords(sessionId, root, turns))
  const imported = await profile.call('history.import.session' as never, { provider: 'claude', native_session_id: sessionId,
    workspace_id: workspace.id } as never) as { conversation: { provenance: { conversation_id: string } } }
  return imported.conversation.provenance.conversation_id
}

test('F050: an export writes the complete readable history across pages into a new private file', async ({ ade, profile, repo }) => {
  const conversationId = await importedConversation(profile, repo.path, 130)
  const directory = join(ade.root, 'exports')
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'history.json')

  const result = await profile.cli('conversation', 'export', conversationId, file)
  expect(result.code, result.stderr).toBe(0)
  expect(result.json).toMatchObject({ type: 'conversation_export', conversation_id: conversationId, file,
    format: 'ade-conversation-history-v1', message_count: 260 })
  expect((await stat(file)).mode & 0o777).toBe(0o600)

  const exported = JSON.parse(await readFile(file, 'utf8')) as Exported
  expect(exported).toMatchObject({ format: 'ade-conversation-history-v1', scope: 'conversation-history',
    message_order: 'newest_first', conversation: { id: conversationId } })
  expect(exported.messages).toHaveLength(260)
  // Every message once, newest first, and readable as the transcript said it.
  const sequences = exported.messages.map((message) => message.sequence)
  expect(new Set(sequences).size).toBe(260)
  expect([...sequences].sort((a, b) => b - a)).toEqual(sequences)
  expect(exported.messages.at(-1)).toMatchObject({ role: 'user', text: 'Question 0', conversation_id: conversationId })
  expect(exported.messages[0]).toMatchObject({ role: 'assistant', text: 'Answer 259' })
  // The export equals what the public read returns page by page.
  const newest = await profile.call('conversation.get', { conversation_id: conversationId, limit: 100 })
  expect(exported.messages.slice(0, 100).map((message) => message.id))
    .toEqual([...newest.messages].reverse().map((message) => (message as { id: string }).id))

  // A second export never replaces the first, and leaves no temporary file.
  const before = await readFile(file, 'utf8')
  const again = await profile.cli('conversation', 'export', conversationId, file)
  expect(again.code).not.toBe(0)
  expect(again.json).toMatchObject({ type: 'error', message: expect.stringContaining('already exists') })
  expect(await readFile(file, 'utf8')).toBe(before)
  // An unrelated file at the destination is also kept.
  const foreign = join(directory, 'notes.json')
  await writeFile(foreign, 'user notes\n')
  expect((await profile.cli('conversation', 'export', conversationId, foreign)).code).not.toBe(0)
  expect(await readFile(foreign, 'utf8')).toBe('user notes\n')
  expect((await readdir(directory)).sort()).toEqual(['history.json', 'notes.json'])

  // An unknown Conversation and a missing directory are refused without writing.
  expect((await profile.cli('conversation', 'export', 'conversation_missing', join(directory, 'missing.json'))).code).not.toBe(0)
  expect((await profile.cli('conversation', 'export', conversationId, join(directory, 'absent', 'x.json'))).code).not.toBe(0)
  expect((await readdir(directory)).sort()).toEqual(['history.json', 'notes.json'])

  // The export survives a daemon crash: the history it reads is durable.
  await profile.restartDaemon('kill')
  const afterCrash = await profile.cli('conversation', 'export', conversationId, join(directory, 'after-crash.json'))
  expect(afterCrash.code, afterCrash.stderr).toBe(0)
  const replayed = JSON.parse(await readFile(join(directory, 'after-crash.json'), 'utf8')) as Exported
  expect(replayed.messages.map((message) => message.id)).toEqual(exported.messages.map((message) => message.id))
  expect(replayed.boot_id).not.toBe(exported.boot_id)
})

test('F050: an export whose history changes while it pages is refused and leaves no file', async ({ ade, profile, repo }) => {
  const conversationId = await importedConversation(profile, repo.path, 400)
  const { conversationId: live } = await startConversation(profile, 'codex')
  const directory = join(ade.root, 'racing')
  await mkdir(directory, { recursive: true })

  // Turns in another Conversation move the profile's revision while the
  // export reads eight pages. Each export either sees one revision throughout
  // and is complete, or is refused and writes nothing.
  let refused = 0
  let completed = 0
  for (let attempt = 0; attempt < 30 && refused === 0; attempt++) {
    const file = join(directory, `attempt-${attempt}.json`)
    const turns = (async () => {
      for (let index = 0; index < 3; index++) {
        await send(profile, live, prompts.turn)
        await waitForIdle(profile, live)
      }
    })()
    const result = await profile.cli('conversation', 'export', conversationId, file)
    await turns
    if (result.code === 0) {
      completed++
      const exported = JSON.parse(await readFile(file, 'utf8')) as Exported
      expect(exported.messages).toHaveLength(800)
    } else {
      refused++
      expect(result.json).toMatchObject({ type: 'error', message: expect.stringContaining('changed') })
      await expect(stat(file)).rejects.toThrow()
    }
  }
  expect(refused, `completed ${completed} exports without a refusal`).toBeGreaterThan(0)
  // No temporary file survives a refused export.
  expect((await readdir(directory)).filter((name) => name.startsWith('.'))).toEqual([])
})
