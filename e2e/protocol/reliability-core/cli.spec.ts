// R002 through the CLI: `--operation-id` names an effect command's receipt,
// so a person retrying a lost reply gets the recorded outcome, and reusing the
// ID for other work is refused with the conflict exit code.
import { expect, startConversation, test } from '../fixtures'

test('R002: the CLI replays an operation ID, refuses it for other work, and names the ID it sent on an error', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const first = await profile.cli('--operation-id', 'cli-pause', 'queue', 'pause', conversationId)
  expect(first.code, first.stderr).toBe(0)
  const again = await profile.cli('--operation-id', 'cli-pause', 'queue', 'pause', conversationId)
  expect(again.code, again.stderr).toBe(0)
  expect(again.json).toEqual(first.json)

  // The same ID for the opposite command is a conflict, also after a daemon crash; nothing changed.
  await profile.restartDaemon('kill')
  const other = await profile.cli('--operation-id', 'cli-pause', 'queue', 'resume', conversationId)
  expect(other.code).toBe(8)
  expect(other.json).toMatchObject({ code: 'conflict', operation_id: 'cli-pause' })
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).conversation.queue_paused).toBe(true)

  // Without --operation-id the CLI chooses one and reports it with the error.
  const refused = await profile.cli('conversation', 'resume', 'conversation-missing')
  expect(refused.code).not.toBe(0)
  expect(refused.json).toMatchObject({ type: 'error', operation_id: expect.any(String) })
  const retried = await profile.cli('--operation-id', String(refused.json?.operation_id), 'conversation', 'resume',
    'conversation-missing')
  expect(retried.json).toEqual(refused.json)
})
