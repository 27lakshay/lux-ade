// F038, R001 and R002: native approvals and questions are answered once. A
// retry after an uncertain delivery is reconciled by the runtime's answer
// receipt, and a late or conflicting answer after settlement is refused.
import { codexPrompts, conversationStatus, expect, fixtureAnswers, prompts, send, startConversation, test,
  waitForIdle, waitForPendingRequest, type MockProvider, type ScratchProfile } from '../fixtures'

async function nativeReplies(profile: ScratchProfile, provider: MockProvider): Promise<number> {
  const method = provider === 'codex' ? 'approval/reply' : 'answer'
  return (await profile.mockCalls(provider)).filter((call) => call.method === method).length
}

async function requests(profile: ScratchProfile, conversationId: string) {
  return (await profile.call('conversation.get', { conversation_id: conversationId })).requests
}

for (const provider of ['codex', 'claude'] as MockProvider[]) {
  test(`F038: a ${provider} approval takes one answer; a repeat converges and a late or conflicting one is refused`, async ({ profile }) => {
    const { conversationId } = await startConversation(profile, provider)
    await send(profile, conversationId, prompts.approval)
    const approval = await waitForPendingRequest(profile, conversationId)
    expect(await conversationStatus(profile, conversationId)).toBe('waiting')
    const answer = { conversation_id: conversationId, request_id: approval.id, decision: 'accept' }
    await profile.call('agent.answer', answer)
    await waitForIdle(profile, conversationId)
    // The same answer again converges without a second native reply.
    await profile.call('agent.answer', answer)
    expect(await nativeReplies(profile, provider)).toBe(1)
    // After settlement, a different answer is refused and changes nothing.
    await expect(profile.call('agent.answer', { ...answer, decision: 'decline' })).rejects.toThrow(/conflicts with the recorded decision|stale or already answered/)
    await profile.restartDaemon()
    await expect(profile.call('agent.answer', { ...answer, decision: 'decline' })).rejects.toThrow(/conflicts with the recorded decision|stale or already answered/)
    expect(await requests(profile, conversationId)).toEqual([])
    expect(await nativeReplies(profile, provider)).toBe(1)
  })

  test(`F038: ${provider} questions take free-text answers once`, async ({ profile }) => {
    const { conversationId } = await startConversation(profile, provider)
    await send(profile, conversationId, prompts.questions)
    const questions = await waitForPendingRequest(profile, conversationId)
    const texts = (questions.params.questions as Array<{ question: string }>).map((question) => question.question)
    expect(texts).toEqual(['First?', 'Second?'])
    const answers = fixtureAnswers(questions)
    await profile.call('agent.answer', { conversation_id: conversationId, request_id: questions.id, decision: 'answer', answers })
    await waitForIdle(profile, conversationId)
    await expect(profile.call('agent.answer', { conversation_id: conversationId, request_id: questions.id,
      decision: 'answer', answers: fixtureAnswers(questions, 'a late, different answer') })).rejects.toThrow()
    expect(await nativeReplies(profile, provider)).toBe(1)
  })
}

test('F038: Codex native choices are offered as sent, and an answer outside them is refused before dispatch', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, codexPrompts.approval)
  const approval = await waitForPendingRequest(profile, conversationId)
  expect(approval.params.availableDecisions).toEqual(['accept', 'decline'])
  // "cancel" is not one of this request's native choices.
  await expect(profile.call('agent.answer', { conversation_id: conversationId, request_id: approval.id, decision: 'cancel' }))
    .rejects.toThrow()
  expect(await nativeReplies(profile, 'codex')).toBe(0)
  expect((await requests(profile, conversationId)).map((request) => request.status)).toEqual(['pending'])
  await profile.call('agent.answer', { conversation_id: conversationId, request_id: approval.id, decision: 'decline' })
  await waitForIdle(profile, conversationId)
  expect(await nativeReplies(profile, 'codex')).toBe(1)

  await send(profile, conversationId, codexPrompts.richQuestions)
  const rich = await waitForPendingRequest(profile, conversationId)
  const questions = rich.params.questions as Array<{ id: string; options?: Array<{ label: string }>; multiSelect?: boolean; isSecret?: boolean }>
  expect(questions.map((question) => question.id)).toEqual(['choice', 'multiple', 'secret'])
  expect(questions[0].options?.map((option) => option.label)).toEqual(['Fast', 'Thorough'])
  expect(questions[1].multiSelect).toBe(true)
  expect(questions[2].isSecret).toBe(true)
  await profile.call('agent.answer', { conversation_id: conversationId, request_id: rich.id, decision: 'answer',
    answers: { choice: 'Fast', multiple: ['Read, write', 'Review'], secret: 'fixture secret' } })
  await waitForIdle(profile, conversationId)
  expect(await nativeReplies(profile, 'codex')).toBe(2)
})

test('F038: concurrent conflicting answers admit exactly one decision', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.approval)
  const approval = await waitForPendingRequest(profile, conversationId)
  const base = { conversation_id: conversationId, request_id: approval.id }
  const attempts = await Promise.allSettled([
    profile.call('agent.answer', { ...base, decision: 'accept' }),
    profile.call('agent.answer', { ...base, decision: 'decline' }),
  ])
  expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
  const rejected = attempts.find((attempt) => attempt.status === 'rejected') as PromiseRejectedResult
  expect(String(rejected.reason)).toContain('Answer conflicts with the recorded decision')
  await waitForIdle(profile, conversationId)
  expect(await nativeReplies(profile, 'codex')).toBe(1)
  const calls = await profile.mockCalls('codex')
  const winner = attempts[0].status === 'fulfilled' ? 'accept' : 'decline'
  expect(calls.find((call) => call.method === 'approval/reply')?.result).toMatchObject({ decision: winner })
})

for (const failpoint of ['before_delivery', 'after_delivery'] as const) {
  test(`R001: an answer left uncertain by a daemon crash ${failpoint.replace('_', ' ')} is retried once, never twice`, async ({ ade }) => {
    const profile = await ade.profile({ env: { ADE_E2E_ANSWER_FAILPOINT: failpoint } })
    const { conversationId } = await startConversation(profile, 'codex')
    await send(profile, conversationId, prompts.approval)
    const approval = await waitForPendingRequest(profile, conversationId)
    const answer = { conversation_id: conversationId, request_id: approval.id, decision: 'decline' }
    // The daemon exits while the answer is in flight; the caller cannot know whether it landed.
    await expect(profile.call('agent.answer', answer)).rejects.toThrow()
    await expect.poll(() => profile.daemonRunning).toBe(false)
    delete profile.env.ADE_E2E_ANSWER_FAILPOINT
    await profile.restartDaemon()

    // The recorded intent survives: another decision conflicts, the same one is delivered once.
    await expect(profile.call('agent.answer', { ...answer, decision: 'accept' }))
      .rejects.toThrow('Answer conflicts with the recorded decision')
    await profile.call('agent.answer', answer)
    await profile.call('agent.answer', answer)
    await expect.poll(() => nativeReplies(profile, 'codex')).toBe(1)
    await waitForIdle(profile, conversationId)
    const calls = await profile.mockCalls('codex')
    expect(calls.filter((call) => call.method === 'approval/reply').map((call) => call.result))
      .toEqual([expect.objectContaining({ decision: 'decline' })])
  })
}

test('R001: an answer the runtime proves was never sent keeps its intent and one safe retry delivers it', async ({ ade }) => {
  const profile = await ade.profile({ env: { ADE_E2E_ANSWER_FAULT: 'before_native' } })
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.approval)
  const approval = await waitForPendingRequest(profile, conversationId)
  const answer = { conversation_id: conversationId, request_id: approval.id, decision: 'decline' }
  await expect(profile.call('agent.answer', answer)).rejects.toThrow('Answer was not sent to the provider')
  // The retry form stays visible with its recorded decision.
  const pending = await requests(profile, conversationId)
  expect(pending).toEqual([expect.objectContaining({ id: approval.id, status: 'pending', answer_attempt: 1 })])
  await expect(profile.call('agent.answer', { ...answer, decision: 'accept' }))
    .rejects.toThrow('Answer conflicts with the recorded decision')
  await profile.call('agent.answer', answer)
  await profile.call('agent.answer', answer)
  await waitForIdle(profile, conversationId)
  expect(await nativeReplies(profile, 'codex')).toBe(1)
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).conversation.error).toBeNull()
})

test('F038: a request the provider withdrew refuses a late answer', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, codexPrompts.approvalExpire)
  const approval = await waitForPendingRequest(profile, conversationId)
  await profile.releaseMock('codex', 'expire-approval')
  await expect.poll(async () => (await requests(profile, conversationId)).length).toBe(0)
  await waitForIdle(profile, conversationId)
  await expect(profile.call('agent.answer', { conversation_id: conversationId, request_id: approval.id, decision: 'accept' }))
    .rejects.toThrow()
  expect(await nativeReplies(profile, 'codex')).toBe(0)
})
