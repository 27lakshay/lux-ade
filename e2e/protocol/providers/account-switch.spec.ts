// F026 and D04: an explicit account switch inside a conversation. It follows
// the adapter's declared capability, is refused while a turn is active, keeps
// its provenance, discloses what does not carry over, and is an effect command
// with a receipt: a retry converges and a conflicting reuse is refused.
import { expect, prompts, send, test, waitForIdle, waitForPendingRequest, type ScratchProfile } from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'
import type { FakeProviderClis } from '../fixtures/provider-cli'
import { conversationOn, profileWithClis, verifiedAccount, type Account } from './steps'

let operations = 0
function operationId(): string {
  return `e2e-switch-${process.pid}-${++operations}`
}

async function twoAccounts(profile: ScratchProfile, clis: FakeProviderClis): Promise<[Account, Account]> {
  return [
    await verifiedAccount(profile, clis, 'codex', 'Work', { email: 'work@example.invalid', account_id: 'org-work' }),
    await verifiedAccount(profile, clis, 'codex', 'Personal', { email: 'me@example.invalid', account_id: 'org-me' }),
  ]
}

async function conversation(profile: ScratchProfile, id: string) {
  return (await profile.call('conversation.get', { conversation_id: id })).conversation
}

function switchRequest(
  conversationId: string,
  from: Account | null,
  to: Account,
  continuity: 'new_native_session' | 'native_continuation' = 'new_native_session',
  id = operationId(),
) {
  return {
    operation_id: id,
    conversation_id: conversationId,
    account_id: to.id,
    expected_account_id: from?.id ?? null,
    expected_generation: to.generation,
    continuity,
  }
}

test('F026: a Codex conversation moves to another account for future turns with a new native session, the transcript as context and its provenance', async ({
  ade,
}) => {
  const { profile, clis } = await profileWithClis(ade)
  const [work, personal] = await twoAccounts(profile, clis)
  const { conversationId } = await conversationOn(profile, 'codex', work.id)
  await send(profile, conversationId, 'hello')
  await waitForIdle(profile, conversationId)
  const before = await conversation(profile, conversationId)
  const oldThread = before.provider_thread_id
  expect(oldThread).toBeTruthy()
  expect((await clis.codexLaunches()).at(-1)!.codex_home).toBe(work.native_home)

  // Codex does not declare native continuation, so the preview offers a new native session and says what is lost.
  const preview = await profile.call('account.switch.preview', {
    conversation_id: conversationId,
    account_id: personal.id,
  })
  expect(preview).toMatchObject({
    from_account_id: work.id,
    to_account_id: personal.id,
    to_generation: personal.generation,
    continuity: 'new_native_session',
    refusal: null,
    capability: { support: 'unknown' },
  })
  expect(preview.disclosure).toMatch(/new native session under the new account/)
  expect(preview.disclosure).toMatch(/tool state, hidden context and native history do not carry over/)
  expect(preview.disclosure).toMatch(/last 2 transcript messages/)

  // Asking for native continuation is refused and names the alternative; nothing changes.
  await expect(
    profile.call('account.switch', switchRequest(conversationId, work, personal, 'native_continuation')),
  ).rejects.toThrow(/cannot continue its native session under another account.*new_native_session/)
  expect(await conversation(profile, conversationId)).toMatchObject({
    account_id: work.id,
    provider_thread_id: oldThread,
  })

  const id = operationId()
  const { switch: switched } = await profile.call(
    'account.switch',
    switchRequest(conversationId, work, personal, 'new_native_session', id),
  )
  expect(switched).toMatchObject({
    id,
    provider: 'codex',
    from_account_id: work.id,
    from_generation: work.generation,
    to_account_id: personal.id,
    to_generation: personal.generation,
    continuity: 'new_native_session',
    previous_native_session: oldThread,
    context_transfer: 'pending',
    context_messages: 2,
    context_truncated: false,
    agent_stopped: true,
  })
  expect(switched.disclosure).toBe(preview.disclosure)
  expect(await conversation(profile, conversationId)).toMatchObject({
    account_id: personal.id,
    provider_thread_id: null,
  })

  // The next turn opens a new native session in the new account's home and carries the excerpt.
  await send(profile, conversationId, 'hello')
  await waitForIdle(profile, conversationId)
  expect((await clis.codexLaunches()).at(-1)!.codex_home).toBe(personal.native_home)
  const calls = await clis.codexCalls()
  expect(calls.filter((call) => call.method === 'thread/start')).toHaveLength(2)
  expect(calls.filter((call) => call.method === 'thread/resume')).toEqual([])
  const prompt = (calls.filter((call) => call.method === 'turn/start').at(-1)!.params as any).input[0].text as string
  expect(prompt).toMatch(/^\[ADE account switch\]/)
  expect(prompt).toContain('User: hello\nAssistant: Hello world\n</ade-transcript>')
  expect(prompt.endsWith('\n\nhello')).toBe(true)
  const after = await conversation(profile, conversationId)
  expect(after.provider_thread_id).toBeTruthy()
  expect(after.provider_thread_id).not.toBe(oldThread)
  // The stored user message is what the user wrote, not the framed prompt.
  const messages = (await profile.call('conversation.get', { conversation_id: conversationId })).messages
  expect(messages.filter((message) => message.role === 'user').map((message) => message.text)).toEqual([
    'hello',
    'hello',
  ])

  // The excerpt is marked delivered once Codex acknowledges the turn, which
  // may come just after the turn's own events; a further turn sends only the user's text.
  await expect
    .poll(async () =>
      (await profile.call('account.switch.list', { conversation_id: conversationId })).switches.map((entry) => [
        entry.id,
        entry.context_transfer,
      ]),
    )
    .toEqual([[id, 'delivered']])
  await send(profile, conversationId, 'hello')
  await waitForIdle(profile, conversationId)
  expect(
    ((await clis.codexCalls()).filter((call) => call.method === 'turn/start').at(-1)!.params as any).input[0].text,
  ).toBe('hello')

  // The CLI lists the same provenance.
  const cli = await profile.cli('account', 'switch', 'list', conversationId)
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({
    type: 'account_switches',
    switches: [{ id, from_account_id: work.id, to_account_id: personal.id }],
  })
})

test('F026: a switch is refused during an active turn and with an open approval, and allowed once the turn ends', async ({
  ade,
}) => {
  const { profile, clis } = await profileWithClis(ade)
  const [work, personal] = await twoAccounts(profile, clis)
  const { conversationId } = await conversationOn(profile, 'codex', work.id)

  await send(profile, conversationId, prompts.hold)
  await expect.poll(async () => (await conversation(profile, conversationId)).active_turn_id).toBeTruthy()
  const busy = await profile.call('account.switch.preview', {
    conversation_id: conversationId,
    account_id: personal.id,
  })
  expect(busy).toMatchObject({ continuity: null, disclosure: null })
  expect(busy.refusal).toMatch(/A turn is active/)
  await expect(profile.call('account.switch', switchRequest(conversationId, work, personal))).rejects.toThrow(
    /A turn is active/,
  )
  await profile.call('agent.cancel', { conversation_id: conversationId })
  await expect.poll(async () => (await conversation(profile, conversationId)).status).toBe('interrupted')

  await send(profile, conversationId, prompts.approval)
  const approval = await waitForPendingRequest(profile, conversationId)
  await expect(profile.call('account.switch', switchRequest(conversationId, work, personal))).rejects.toThrow(
    /A turn is active|open questions and approvals/,
  )
  await profile.call('agent.answer', { conversation_id: conversationId, request_id: approval.id, decision: 'decline' })
  await waitForIdle(profile, conversationId)

  // Nothing was recorded by the refusals; the idle conversation now switches.
  expect((await profile.call('account.switch.list', { conversation_id: conversationId })).switches).toEqual([])
  expect((await conversation(profile, conversationId)).account_id).toBe(work.id)
  await profile.call('account.switch', switchRequest(conversationId, work, personal))
  expect((await conversation(profile, conversationId)).account_id).toBe(personal.id)
})

test('F026: stale fences, unverified, disabled and foreign targets are refused without changing the conversation', async ({
  ade,
}) => {
  const { profile, clis } = await profileWithClis(ade)
  const [work, personal] = await twoAccounts(profile, clis)
  const { conversationId } = await conversationOn(profile, 'codex', work.id)
  const refuse = async (request: Record<string, unknown>, reason: RegExp) => {
    await expect(profile.call('account.switch', request as never)).rejects.toThrow(reason)
  }

  await refuse(switchRequest(conversationId, work, work), /already uses this account/)
  await refuse(
    { ...switchRequest(conversationId, work, personal), expected_generation: personal.generation + 1 },
    /changed since the preview/,
  )
  await refuse(
    { ...switchRequest(conversationId, work, personal), expected_account_id: personal.id },
    /account changed; preview the switch again/,
  )
  await refuse(
    { ...switchRequest(conversationId, work, personal), expected_account_id: null },
    /account changed; preview the switch again/,
  )

  const { account: unverified } = await profile.call('account.create', { provider: 'codex', name: 'Fresh' })
  await refuse(switchRequest(conversationId, work, unverified), /not verified/)
  const claude = await verifiedAccount(profile, clis, 'claude', 'Claude', {
    email: 'c@example.invalid',
    account_id: 'org-c',
  })
  await refuse(switchRequest(conversationId, work, claude), /another provider/)
  await expect(
    profile.call('account.switch.preview', { conversation_id: conversationId, account_id: claude.id }),
  ).resolves.toMatchObject({ continuity: null, refusal: expect.stringMatching(/another provider/) })

  // Disabling the target after the preview moves its generation, so the preview's fence fails too.
  const preview = await profile.call('account.switch.preview', {
    conversation_id: conversationId,
    account_id: personal.id,
  })
  const { account: disabled } = await profile.call('account.disable', { account_id: personal.id })
  expect(disabled.generation).toBeGreaterThan(preview.to_generation)
  await refuse(switchRequest(conversationId, work, { ...personal, generation: preview.to_generation }), /not verified/)
  await refuse(switchRequest(conversationId, work, disabled), /not verified/)

  expect(await conversation(profile, conversationId)).toMatchObject({ account_id: work.id })
  expect((await profile.call('account.switch.list', { conversation_id: conversationId })).switches).toEqual([])
})

test('F026: a retried switch converges on its receipt across a lost reply and a daemon crash; a conflicting reuse is refused', async ({
  ade,
}) => {
  const { profile, clis } = await profileWithClis(ade)
  const [work, personal] = await twoAccounts(profile, clis)
  const spare = await verifiedAccount(profile, clis, 'codex', 'Spare', {
    email: 'spare@example.invalid',
    account_id: 'org-spare',
  })
  const { conversationId } = await conversationOn(profile, 'codex', work.id)
  const request = switchRequest(conversationId, work, personal)

  // The reply is lost; the outcome is learned by retrying the same operation.
  await sendAndLoseReply(profile, { op: 'account.switch', ...request })
  const retried = await profile.call('account.switch', request)
  const again = await profile.call('account.switch', request)
  expect(again).toEqual(retried)
  expect(retried.switch).toMatchObject({
    id: request.operation_id,
    from_account_id: work.id,
    to_account_id: personal.id,
  })

  // The same operation ID with another target is a conflict, not a second switch.
  await expect(
    profile.call('account.switch', { ...request, account_id: spare.id, expected_generation: spare.generation }),
  ).rejects.toThrow(/conflict|different|reused/i)

  await profile.restartDaemon('kill')
  expect(await profile.call('account.switch', request)).toEqual(retried)
  const { switches } = await profile.call('account.switch.list', { conversation_id: conversationId })
  expect(switches).toHaveLength(1)
  expect(switches[0]).toEqual(retried.switch)
  expect((await conversation(profile, conversationId)).account_id).toBe(personal.id)

  // A second, new switch moves on from the new account and keeps both records in order.
  await profile.call('account.switch', switchRequest(conversationId, personal, spare))
  expect(
    (await profile.call('account.switch.list', { conversation_id: conversationId })).switches.map((entry) => [
      entry.from_account_id,
      entry.to_account_id,
    ]),
  ).toEqual([
    [work.id, personal.id],
    [personal.id, spare.id],
  ])
})

test('F026: a legacy conversation on the provider login can move to a managed account, and Claude switching follows its declared capability', async ({
  ade,
}) => {
  const { profile, clis } = await profileWithClis(ade)
  const [work] = await twoAccounts(profile, clis)

  // A conversation on Codex's own login has no managed account yet.
  const legacy = await conversationOn(profile, 'codex')
  await send(profile, legacy.conversationId, 'hello')
  await waitForIdle(profile, legacy.conversationId)
  const moved = await profile.call('account.switch', switchRequest(legacy.conversationId, null, work))
  expect(moved.switch).toMatchObject({
    from_account_id: null,
    from_generation: null,
    to_account_id: work.id,
    continuity: 'new_native_session',
  })
  expect(await conversation(profile, legacy.conversationId)).toMatchObject({
    account_id: work.id,
    account_context: 'managed',
  })

  // Claude declares native continuation, but a conversation with no native session yet has nothing to
  // continue: the preview offers a new native session and the switch refuses native continuation.
  const {
    providers: [claudeRecord],
  } = await profile.call('provider.capabilities', { provider: 'claude' })
  const first = await verifiedAccount(profile, clis, 'claude', 'One', {
    email: 'one@example.invalid',
    account_id: 'org-1',
  })
  const second = await verifiedAccount(profile, clis, 'claude', 'Two', {
    email: 'two@example.invalid',
    account_id: 'org-2',
  })
  const claude = await conversationOn(profile, 'claude', first.id)
  const preview = await profile.call('account.switch.preview', {
    conversation_id: claude.conversationId,
    account_id: second.id,
  })
  expect(preview).toMatchObject({
    continuity: 'new_native_session',
    capability: claudeRecord.conversation.account_switch,
  })
  expect(preview.disclosure).toMatch(/No native session or transcript exists yet/)
  await expect(
    profile.call('account.switch', switchRequest(claude.conversationId, first, second, 'native_continuation')),
  ).rejects.toThrow(/new_native_session/)
  expect(
    (await profile.call('account.switch', switchRequest(claude.conversationId, first, second))).switch,
  ).toMatchObject({ continuity: 'new_native_session', context_transfer: 'none', agent_stopped: false })
})

// Native continuation, where Claude keeps its native session across a switch,
// is proved in e2e/protocol/accounts-rewind/account-switch.spec.ts.
