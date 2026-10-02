// PC34: two accounts each hold a native Codex thread with the same native session ID. ADE keeps the
// two conversations' transcripts and native history apart: nothing read for one account's thread
// reaches the other's conversation.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, send, test, waitForIdle } from '../fixtures'
import { conversationOn, profileWithClis, verifiedAccount } from './steps'

test('histories that share a native session ID across two accounts stay isolated', async ({ ade }) => {
  const { profile, clis } = await profileWithClis(ade)
  await writeFile(join(clis.mockDirectory, 'per-home'), '')
  await writeFile(join(clis.mockDirectory, 'fixed-thread-id'), '')
  const work = await verifiedAccount(profile, clis, 'codex', 'Work', {
    email: 'work@example.invalid',
    account_id: 'org-work',
  })
  const personal = await verifiedAccount(profile, clis, 'codex', 'Personal', {
    email: 'me@example.invalid',
    account_id: 'org-me',
  })
  const a = await conversationOn(profile, 'codex', work.id)
  const b = await conversationOn(profile, 'codex', personal.id)
  await send(profile, a.conversationId, 'work account prompt')
  await waitForIdle(profile, a.conversationId)
  await send(profile, b.conversationId, 'personal account prompt')
  await waitForIdle(profile, b.conversationId)

  const get = (id: string) => profile.call('conversation.get', { conversation_id: id })
  const [first, second] = [await get(a.conversationId), await get(b.conversationId)]
  // The same native ID under two accounts.
  expect(first.conversation.provider_thread_id).toBe('mock-thread-shared')
  expect(second.conversation.provider_thread_id).toBe('mock-thread-shared')
  expect(first.conversation.account_id).toBe(work.id)
  expect(second.conversation.account_id).toBe(personal.id)
  const users = (snapshot: typeof first) =>
    snapshot.messages.filter((message) => message.role === 'user').map((message) => message.text)
  expect(users(first)).toEqual(['work account prompt'])
  expect(users(second)).toEqual(['personal account prompt'])

  // Native history is read from each conversation's own account, never the other's thread.
  const history = async (id: string) => {
    const page = await profile.call('conversation.history', { conversation_id: id })
    expect(page.error).toBeNull()
    return page.messages.map((message) => message.text)
  }
  expect(await history(a.conversationId)).toContain('work account prompt')
  expect(await history(a.conversationId)).not.toContain('personal account prompt')
  expect(await history(b.conversationId)).toContain('personal account prompt')
  expect(await history(b.conversationId)).not.toContain('work account prompt')

  // Reading one again after the other changed does not mix them either.
  await send(profile, b.conversationId, 'second personal prompt')
  await waitForIdle(profile, b.conversationId)
  expect(await history(a.conversationId)).not.toContain('second personal prompt')
  expect(users(await get(a.conversationId))).toEqual(['work account prompt'])
})
