// F026: explicit in-conversation account switching through an operation the
// adapter declares. Claude declares `conversation.account_switch: supported`:
// a native session is a transcript in the account's CLAUDE_CONFIG_DIR, and
// the Agent SDK documents moving that file to resume a session elsewhere.
// ADE copies the transcript into the new account's home, keeps the earlier
// copy, and the next turn resumes the same native session there. Codex
// declares no such operation, so it only offers a new native session
// (providers/account-switch.spec.ts). Each managed Claude launch runs the
// provider mock with the account's CLAUDE_CONFIG_DIR, so sessions and call
// logs live in each account's home and nothing crosses between them unseen.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, send, test, waitForIdle, type ScratchProfile } from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'
import type { MockCall } from '../fixtures/providers'
import { conversationOn, profileWithClis, record, verifiedAccount, type Account } from '../providers/steps'

async function conversation(profile: ScratchProfile, id: string) {
  return (await profile.call('conversation.get', { conversation_id: id })).conversation
}

async function texts(profile: ScratchProfile, id: string): Promise<string[]> {
  return (await profile.call('conversation.get', { conversation_id: id, limit: 200 })).messages.map((m) => m.text)
}

/** The prompts a Claude session transcript in `home` holds, or null when the home has no such session. */
async function transcript(home: string, session: string): Promise<{ path: string; prompts: string[] } | null> {
  const projects = join(home, 'projects')
  for (const project of await readdir(projects).catch(() => [] as string[])) {
    const path = join(projects, project, `${session}.jsonl`)
    const text = await readFile(path, 'utf8').catch(() => null)
    if (text === null) continue
    const entries = text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as
      { type: string; message?: { content?: unknown } })
    return { path, prompts: entries.filter((entry) => entry.type === 'user' && typeof entry.message?.content === 'string')
      .map((entry) => entry.message!.content as string) }
  }
  return null
}

/** What the Claude mock recorded while it ran under `home`. */
async function sends(home: string): Promise<string[]> {
  const text = await readFile(join(home, 'ade-mock', 'calls.jsonl'), 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as MockCall)
    .filter((call) => call.method === 'send').map((call) => call.text as string)
}

function switchRequest(conversationId: string, from: Account, to: Account, operationId: string,
  continuity: 'new_native_session' | 'native_continuation' = 'native_continuation') {
  return { operation_id: operationId, conversation_id: conversationId, account_id: to.id, expected_account_id: from.id,
    expected_generation: to.generation, continuity }
}

async function claudeAccounts(profile: ScratchProfile, clis: Parameters<typeof verifiedAccount>[1]) {
  return [
    await verifiedAccount(profile, clis, 'claude', 'Work', { email: 'work@example.invalid', account_id: 'org-work' }),
    await verifiedAccount(profile, clis, 'claude', 'Personal', { email: 'me@example.invalid', account_id: 'org-me' }),
  ] as const
}

async function turn(profile: ScratchProfile, id: string, text: string) {
  await send(profile, id, text)
  await waitForIdle(profile, id)
}

/** The switch stopped the Agent that ran under the earlier account; resuming opens the native session again. */
async function resume(profile: ScratchProfile, id: string) {
  expect((await conversation(profile, id)).status).toBe('disconnected')
  await profile.call('agent.resume', { conversation_id: id })
  await waitForIdle(profile, id)
}

test('F026: a Claude conversation continues its native session under another account, with the transcript copied and provenance kept', async ({ ade }) => {
  const { profile, clis } = await profileWithClis(ade)
  const [work, personal] = await claudeAccounts(profile, clis)
  const declared = (await record(profile, 'claude')).conversation.account_switch
  expect(declared.support).toBe('supported')

  const { conversationId } = await conversationOn(profile, 'claude', work.id)
  await turn(profile, conversationId, 'first zebracorn')
  const session = (await conversation(profile, conversationId)).provider_thread_id!
  expect(session).toBeTruthy()
  // The native session lives in the work account's home only.
  expect((await transcript(work.native_home, session))!.prompts).toEqual(['first zebracorn'])
  expect(await transcript(personal.native_home, session)).toBeNull()
  expect(await sends(work.native_home)).toEqual(['first zebracorn'])

  // The preview offers the declared operation and says what carries over.
  const preview = await profile.call('account.switch.preview', { conversation_id: conversationId, account_id: personal.id })
  expect(preview).toMatchObject({ from_account_id: work.id, to_account_id: personal.id, continuity: 'native_continuation',
    refusal: null, capability: declared })
  expect(preview.disclosure).toMatch(/continue the same native session under the new account/)
  expect(preview.disclosure).toMatch(/the earlier account keeps its copy/)
  expect(preview.disclosure).toMatch(/file checkpoints .* do not carry over/)

  // Asking for a new session instead is refused: ADE never picks another continuity silently.
  await expect(profile.call('account.switch', switchRequest(conversationId, work, personal, 'e2e-other', 'new_native_session')))
    .rejects.toThrow(/continues the native session; retry with continuity native_continuation/)
  expect(await conversation(profile, conversationId)).toMatchObject({ account_id: work.id, provider_thread_id: session })
  expect(await transcript(personal.native_home, session)).toBeNull()

  const { switch: switched } = await profile.call('account.switch',
    switchRequest(conversationId, work, personal, 'e2e-continue'))
  expect(switched).toMatchObject({ id: 'e2e-continue', provider: 'claude', from_account_id: work.id,
    from_generation: work.generation, to_account_id: personal.id, to_generation: personal.generation,
    continuity: 'native_continuation', previous_native_session: session, context_transfer: 'none', context_messages: 0,
    agent_stopped: true })
  expect(switched.disclosure).toBe(preview.disclosure)
  // Same native session, new account; both homes now hold the transcript, byte for byte.
  expect(await conversation(profile, conversationId)).toMatchObject({ account_id: personal.id, provider_thread_id: session })
  const earlier = (await transcript(work.native_home, session))!
  const carried = (await transcript(personal.native_home, session))!
  expect(await readFile(carried.path, 'utf8')).toBe(await readFile(earlier.path, 'utf8'))

  // The next turn resumes that session under the new account, with the user's text only.
  await resume(profile, conversationId)
  await turn(profile, conversationId, 'second quokkaflux')
  expect(await sends(personal.native_home)).toEqual(['second quokkaflux'])
  expect(await sends(work.native_home)).toEqual(['first zebracorn'])
  expect((await transcript(personal.native_home, session))!.prompts).toEqual(['first zebracorn', 'second quokkaflux'])
  expect((await transcript(work.native_home, session))!.prompts).toEqual(['first zebracorn'])
  expect((await conversation(profile, conversationId)).provider_thread_id).toBe(session)
  // The resume read the carried history back without duplicating ADE's messages.
  expect(await texts(profile, conversationId))
    .toEqual(['first zebracorn', 'Hello Claude', 'second quokkaflux', 'Hello Claude'])

  // Provenance through the list and the CLI.
  const { switches } = await profile.call('account.switch.list', { conversation_id: conversationId })
  expect(switches).toEqual([switched])
  const cli = await profile.cli('account', 'switch', 'list', conversationId)
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toMatchObject({ switches: [{ id: 'e2e-continue', continuity: 'native_continuation',
    previous_native_session: session }] })
})

test('F026: a different transcript already in the new account is never overwritten, and nothing switches', async ({ ade }) => {
  const { profile, clis } = await profileWithClis(ade)
  const [work, personal] = await claudeAccounts(profile, clis)
  const { conversationId } = await conversationOn(profile, 'claude', work.id)
  await turn(profile, conversationId, 'first zebracorn')
  const session = (await conversation(profile, conversationId)).provider_thread_id!
  const earlier = (await transcript(work.native_home, session))!
  const project = earlier.path.split('/').at(-2)!
  const foreign = join(personal.native_home, 'projects', project, `${session}.jsonl`)
  await mkdir(join(personal.native_home, 'projects', project), { recursive: true })
  await writeFile(foreign, '{"type":"user","message":{"content":"someone else"}}\n')

  await expect(profile.call('account.switch', switchRequest(conversationId, work, personal, 'e2e-blocked')))
    .rejects.toThrow(/different copy .* already exists in the new account's home; nothing was overwritten/)
  expect(await readFile(foreign, 'utf8')).toBe('{"type":"user","message":{"content":"someone else"}}\n')
  expect(await conversation(profile, conversationId)).toMatchObject({ account_id: work.id, provider_thread_id: session })
  expect((await profile.call('account.switch.list', { conversation_id: conversationId })).switches).toEqual([])
  // The stopped Agent is reported honestly under the unchanged account, and the next turn resumes there.
  await resume(profile, conversationId)
  await turn(profile, conversationId, 'second quokkaflux')
  expect(await sends(work.native_home)).toEqual(['first zebracorn', 'second quokkaflux'])
  expect(await sends(personal.native_home)).toEqual([])
})

test('F026: a native-continuation switch whose reply was lost converges on retry across a daemon crash', async ({ ade }) => {
  const { profile, clis } = await profileWithClis(ade)
  const [work, personal] = await claudeAccounts(profile, clis)
  const { conversationId } = await conversationOn(profile, 'claude', work.id)
  await turn(profile, conversationId, 'first zebracorn')
  const session = (await conversation(profile, conversationId)).provider_thread_id!
  const request = switchRequest(conversationId, work, personal, 'e2e-lost')

  await sendAndLoseReply(profile, { op: 'account.switch', ...request })
  await profile.restartDaemon('kill')
  const retried = await profile.call('account.switch', request)
  expect(retried.switch).toMatchObject({ id: 'e2e-lost', continuity: 'native_continuation', previous_native_session: session })
  expect(await profile.call('account.switch', request)).toEqual(retried)
  expect((await profile.call('account.switch.list', { conversation_id: conversationId })).switches).toHaveLength(1)
  expect(await conversation(profile, conversationId)).toMatchObject({ account_id: personal.id, provider_thread_id: session })
  await resume(profile, conversationId)
  await turn(profile, conversationId, 'second quokkaflux')
  expect((await transcript(personal.native_home, session))!.prompts).toEqual(['first zebracorn', 'second quokkaflux'])
})
