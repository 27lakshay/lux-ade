// F038, R001 and R002: typed native answers preserve provenance and settle once.
import {
  answerFor,
  answerIntent,
  codexPrompts,
  conversationStatus,
  expect,
  fixtureAnswers,
  prompts,
  send,
  startConversation,
  subscribeFeed,
  test,
  waitForIdle,
  waitForPendingRequest,
  type MockProvider,
  type ScratchProfile,
} from '../fixtures'

async function nativeReplies(profile: ScratchProfile, provider: MockProvider): Promise<number> {
  const method = provider === 'codex' ? 'approval/reply' : 'answer'
  return (await profile.mockCalls(provider)).filter((call) => call.method === method).length
}

async function requests(profile: ScratchProfile, conversationId: string) {
  return (await profile.call('conversation.get', { conversation_id: conversationId })).requests
}
test('conversation_changed decodes the public native request through the built client feed', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const feed = await subscribeFeed(profile)
  try {
    await feed.connected()
    await send(profile, conversationId, codexPrompts.approvalAll)
    const approval = await waitForPendingRequest(profile, conversationId)
    const changed = await feed.waitFor(
      (frame) =>
        frame.type === 'conversation_changed' &&
        frame.conversation.id === conversationId &&
        frame.requests.some((request) => request.id === approval.id),
    )
    if (changed.type !== 'conversation_changed') throw new Error('Expected a conversation_changed frame')
    const request = changed.requests.find((candidate) => candidate.id === approval.id)
    if (!request) throw new Error('Expected the native request in the decoded feed')

    expect(request.metadata.schema.kind).toBe('choices')
    if (request.metadata.schema.kind !== 'choices') throw new Error('Expected native choice schema')
    expect(request.metadata.schema.choices.map((choice) => choice.value)).toEqual(['accept', 'decline', 'cancel'])

    expect(request.metadata.native_request_id === approval.metadata.native_request_id).toBe(true)
    expect(request.source_attempt_id === approval.source_attempt_id).toBe(true)
    expect(request.revision === approval.revision).toBe(true)
    const fields = Object.keys(request)
    for (const field of ['run_id', 'rpc_id', 'method', 'params', 'answer_fingerprint']) {
      expect(fields.includes(field)).toBe(false)
    }

    const answerReply = await profile.cli('conversation', 'answer', conversationId, approval.id, 'cancel')
    expect(answerReply.code === 0).toBe(true)
    const outcomeOperationId = (answerReply.json as { operation_id?: unknown } | null)?.operation_id
    if (typeof outcomeOperationId !== 'string') throw new Error('CLI answer did not return its operation ID')

    await waitForIdle(profile, conversationId)
    const statusReply = await profile.cli('conversation', 'inspect', conversationId)
    expect(statusReply.code === 0).toBe(true)
    const snapshot = statusReply.json as { conversation?: { status?: string }; requests?: unknown[] } | null
    expect(snapshot?.conversation?.status === 'idle' || snapshot?.conversation?.status === 'ready').toBe(true)
    expect(Array.isArray(snapshot?.requests) && snapshot.requests.length === 0).toBe(true)

    const replay = await profile.cli(
      'request',
      'agent.answer',
      JSON.stringify(answerIntent(approval, { kind: 'choice', value: 'cancel' }, outcomeOperationId)),
    )
    expect(replay.code === 0).toBe(true)
    const replayOperationId = (replay.json as { operation_id?: unknown } | null)?.operation_id
    expect(replayOperationId === outcomeOperationId).toBe(true)
    expect(await nativeReplies(profile, 'codex')).toBe(1)
  } finally {
    feed.stop()
  }
})

for (const provider of ['codex', 'claude'] as MockProvider[]) {
  test(`F038: a ` + provider + ` approval is a typed, provenance-fenced native transaction`, async ({ profile }) => {
    const { conversationId } = await startConversation(profile, provider)
    await send(profile, conversationId, prompts.approval)
    const approval = await waitForPendingRequest(profile, conversationId)
    expect(await conversationStatus(profile, conversationId)).toBe('waiting')

    expect(approval.metadata.schema.kind).toBe('choices')
    expect(approval).not.toHaveProperty('params')

    const intent = answerIntent(approval, answerFor(approval, 'accept'))
    const receipt = await profile.call('agent.answer', intent)
    expect(receipt).toMatchObject({ operation_id: intent.operation_id, response_delivery: 'acknowledged' })
    expect(receipt.resolution).toBe('outstanding')
    await waitForIdle(profile, conversationId)

    // Codex emits native request-closed evidence. The Claude SDK provides no success-close event,
    // so the terminal turn must not promote its acknowledged response to resolved.
    const expectedResolution = provider === 'codex' ? 'resolved' : 'outstanding'
    expect(await requests(profile, conversationId)).toEqual([])
    const replay = await profile.call('agent.answer', intent)
    expect(replay).toMatchObject({
      operation_id: intent.operation_id,
      response_delivery: 'acknowledged',
      resolution: expectedResolution,
    })
    const sameIdDifferentPayload = answerIntent(approval, answerFor(approval, 'decline'), intent.operation_id)
    await expect(profile.call('agent.answer', sameIdDifferentPayload)).rejects.toThrow()
    const differentOperation = answerIntent(approval, answerFor(approval, 'accept'), intent.operation_id + '-second')
    await expect(profile.call('agent.answer', differentOperation)).rejects.toThrow()
    expect(await nativeReplies(profile, provider)).toBe(1)
    await profile.restartDaemon()
    const afterRestart = await profile.call('agent.answer', intent)
    expect(afterRestart).toEqual(replay)
    expect(await nativeReplies(profile, provider)).toBe(1)
  })

  test(`F038: ` + provider + ` question answers preserve each native question and option`, async ({ profile }) => {
    const { conversationId } = await startConversation(profile, provider)
    await send(profile, conversationId, prompts.questions)
    const questions = await waitForPendingRequest(profile, conversationId)
    expect(questions.metadata.schema.kind).toBe('questions')
    expect(
      questions.metadata.schema.kind === 'questions' && questions.metadata.schema.questions.map((q) => q.prompt),
    ).toEqual(['First?', 'Second?'])
    const intent = answerIntent(questions, fixtureAnswers(questions))
    await profile.call('agent.answer', intent)
    await waitForIdle(profile, conversationId)
    await expect(
      profile.call('agent.answer', { ...intent, answer: { kind: 'choice', value: 'different' } }),
    ).rejects.toThrow()
    expect(await nativeReplies(profile, provider)).toBe(1)
  })
}
test('F038: same-session callbacks without proven attempt attribution stay answerable and unowned', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'claude')
  await send(profile, conversationId, 'callback-before-echo')
  const pending = await waitForPendingRequest(profile, conversationId)
  expect(pending.source_attempt_id).toBeUndefined()
  expect(pending.metadata.native_session_id).toBeTruthy()
  expect(pending.metadata.native_turn_id).toBeUndefined()
  const intent = answerIntent(pending, answerFor(pending, 'accept'))
  const unrelatedAttempt = { ...intent, source_attempt_id: 'unrelated-attempt' }
  await expect(profile.call('agent.answer', unrelatedAttempt)).rejects.toThrow()
  expect(await nativeReplies(profile, 'claude')).toBe(0)
  const receipt = await profile.call('agent.answer', intent)
  expect(receipt).toMatchObject({ response_delivery: 'acknowledged', resolution: 'outstanding' })
  expect(receipt.source_attempt_id).toBeUndefined()
  await waitForIdle(profile, conversationId)
  const transcript = (await profile.call('conversation.get', { conversation_id: conversationId })).messages
    .map((message) => (message as { text?: string }).text ?? '')
    .join('\n')
  expect(transcript).toContain('"behavior":"allow"')
})
test('F038: answer provenance fences reject cross-conversation, native-ID, attempt, and revision mismatches', async ({
  profile,
}) => {
  const first = await startConversation(profile, 'codex')
  const second = await startConversation(profile, 'codex')
  await send(profile, first.conversationId, prompts.approval)
  await send(profile, second.conversationId, prompts.approval)
  const firstRequest = await waitForPendingRequest(profile, first.conversationId)
  const secondRequest = await waitForPendingRequest(profile, second.conversationId)
  const answer = answerFor(firstRequest, 'accept')
  const base = answerIntent(firstRequest, answer)
  const mismatches: Array<typeof base> = [
    { ...base, conversation_id: second.conversationId },
    { ...answerIntent(firstRequest, answer), request_id: String(firstRequest.metadata.native_request_id) },
    { ...answerIntent(firstRequest, answer), source_attempt_id: firstRequest.source_attempt_id + '-foreign' },
    { ...answerIntent(firstRequest, answer), request_revision: firstRequest.revision + 1 },
  ]
  for (const mismatch of mismatches) {
    await expect(profile.call('agent.answer', mismatch)).rejects.toThrow()
  }
  expect(await nativeReplies(profile, 'codex')).toBe(0)
  expect(await requests(profile, first.conversationId)).toEqual([expect.objectContaining({ id: firstRequest.id })])
  expect(await requests(profile, second.conversationId)).toEqual([expect.objectContaining({ id: secondRequest.id })])

  await profile.call('agent.answer', base)
  await profile.call('agent.answer', answerIntent(secondRequest, answerFor(secondRequest, 'decline')))
  await waitForIdle(profile, first.conversationId)
  await waitForIdle(profile, second.conversationId)
  expect(
    (await profile.mockCalls('codex')).filter((call) => call.method === 'approval/reply').map((call) => call.result),
  ).toEqual([{ decision: 'accept' }, { decision: 'decline' }])
})

test('F038: Codex preserves exact available choices and refuses schema-mismatched answers before dispatch', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, codexPrompts.approvalAll)
  const approval = await waitForPendingRequest(profile, conversationId)
  expect(approval.metadata.schema.kind).toBe('choices')
  if (approval.metadata.schema.kind !== 'choices') throw new Error('Expected native choice schema')
  expect(approval.metadata.schema.choices.map((choice) => choice.value)).toEqual(['accept', 'decline', 'cancel'])
  const intent = answerIntent(approval, { kind: 'choice', value: 'cancel' })
  await profile.call('agent.answer', intent)
  await waitForIdle(profile, conversationId)
  expect((await profile.mockCalls('codex')).find((call) => call.method === 'approval/reply')?.result).toMatchObject({
    decision: 'cancel',
  })

  await send(profile, conversationId, codexPrompts.richQuestions)
  const rich = await waitForPendingRequest(profile, conversationId)
  expect(rich.metadata.schema.kind).toBe('questions')
  if (rich.metadata.schema.kind !== 'questions') throw new Error('Expected native questions schema')
  expect(rich.metadata.schema.questions.map((question) => question.id)).toEqual(['choice', 'multiple', 'secret'])
  expect(rich.metadata.schema.questions[0].options?.map((option) => option.value)).toEqual(['Fast', 'Thorough'])
  expect(rich.metadata.schema.questions[1]).toMatchObject({ multiple: true })
  expect(rich.metadata.schema.questions[2]).toMatchObject({ secret: true })
  const exact = answerIntent(rich, {
    kind: 'questions',
    answers: { choice: ['Thorough'], multiple: ['Read, write', 'Review'], secret: ['fixture secret'] },
  })
  await profile.call('agent.answer', exact)
  await waitForIdle(profile, conversationId)
  expect(await nativeReplies(profile, 'codex')).toBe(2)
})

test('R002: conflicting clients admit only one operation and never dispatch the losing payload', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.approval)
  const approval = await waitForPendingRequest(profile, conversationId)
  const intents = [
    answerIntent(approval, answerFor(approval, 'accept'), 'client-one'),
    answerIntent(approval, answerFor(approval, 'decline'), 'client-two'),
  ]
  const attempts = await Promise.allSettled(intents.map((intent) => profile.call('agent.answer', intent)))
  const winnerIndex = attempts.findIndex((attempt) => attempt.status === 'fulfilled')
  if (winnerIndex < 0) throw new Error('No answer operation was admitted')
  const loserIndex = 1 - winnerIndex
  expect(attempts[loserIndex]?.status).toBe('rejected')
  const winner = intents[winnerIndex]!
  if (winner.answer.kind !== 'choice') throw new Error('Expected an approval choice')
  await waitForIdle(profile, conversationId)
  expect(await nativeReplies(profile, 'codex')).toBe(1)
  expect((await profile.mockCalls('codex')).find((call) => call.method === 'approval/reply')?.result).toEqual({
    decision: winner.answer.value,
  })
})

for (const failpoint of ['before_delivery', 'after_delivery'] as const) {
  test(
    `R001: ` + failpoint.replace('_', ' ') + ` crash preserves an unknown native delivery without redispatch`,
    async ({ ade }) => {
      const profile = await ade.profile({ env: { ADE_E2E_ANSWER_FAILPOINT: failpoint } })
      const { conversationId } = await startConversation(profile, 'codex')
      await send(profile, conversationId, prompts.approval)
      const approval = await waitForPendingRequest(profile, conversationId)
      const intent = answerIntent(approval, answerFor(approval, 'decline'))
      await expect(profile.call('agent.answer', intent)).rejects.toThrow()
      await expect.poll(() => profile.daemonRunning).toBe(false)
      delete profile.env.ADE_E2E_ANSWER_FAILPOINT
      await profile.restartDaemon()
      await expect(profile.call('agent.answer', { ...intent, answer: answerFor(approval, 'accept') })).rejects.toThrow()
      const replay = await profile.call('agent.answer', intent)
      expect(replay).toMatchObject({ operation_id: intent.operation_id, response_delivery: 'unknown' })
      expect(await profile.call('agent.answer', intent)).toEqual(replay)

      if (failpoint === 'after_delivery') {
        expect(replay.resolution).toBe('resolved')
        await waitForIdle(profile, conversationId)
        expect((await profile.mockCalls('codex')).find((call) => call.method === 'approval/reply')?.result).toEqual({
          decision: 'decline',
        })
        expect(await requests(profile, conversationId)).toEqual([])
      } else {
        expect(replay.resolution).toBe('outstanding')
        expect(await requests(profile, conversationId)).toEqual([
          expect.objectContaining({
            id: approval.id,
            response_delivery: 'unknown',
            resolution: 'outstanding',
          }),
        ])
        expect(await nativeReplies(profile, 'codex')).toBe(0)
        const active = await profile.call('conversation.get', { conversation_id: conversationId })
        if (!active.conversation.runtime_run || !active.conversation.runtime_submission) {
          throw new Error('Running answer operation has no active cancellation identity')
        }
        const cancellation = await profile.call('agent.cancel', {
          operation_id: 'cancel-uncertain-answer',
          conversation_id: conversationId,
          source_attempt_id: active.conversation.runtime_run,
          submission_id: active.conversation.runtime_submission,
        })
        expect(cancellation).toMatchObject({
          type: 'agent_cancel_outcome',
          operation_id: 'cancel-uncertain-answer',
          conversation_id: conversationId,
          source_attempt_id: active.conversation.runtime_run,
          submission_id: active.conversation.runtime_submission,
          evidence: {
            active_work_remaining: null,
            queued_work_count: null,
            background_work_remaining: null,
            observed_at_ms: null,
          },
        })
        if (cancellation.evidence.scope === 'unknown') {
          expect(cancellation.evidence).toMatchObject({
            interruption_requested: false,
            termination: 'unknown',
          })
          expect(await requests(profile, conversationId)).toEqual([
            expect.objectContaining({
              id: approval.id,
              response_delivery: 'unknown',
              resolution: 'outstanding',
            }),
          ])
        } else {
          expect(cancellation.evidence).toMatchObject({
            scope: 'turn',
            interruption_requested: true,
            termination: 'requested',
          })
          await expect.poll(() => conversationStatus(profile, conversationId)).toBe('interrupted')
          expect(await requests(profile, conversationId)).toEqual([])
        }
        expect(await nativeReplies(profile, 'codex')).toBe(0)
      }
    },
  )
}

test('R001: an explicit not-sent result retains the operation for a safe retry', async ({ ade }) => {
  const profile = await ade.profile({ env: { ADE_E2E_ANSWER_FAULT: 'before_native' } })
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.approval)
  const approval = await waitForPendingRequest(profile, conversationId)
  const intent = answerIntent(approval, answerFor(approval, 'decline'))
  const notSent = await profile.call('agent.answer', intent)
  expect(notSent).toMatchObject({
    response_delivery: 'not_sent',
    resolution: 'outstanding',
    error: expect.stringContaining('Answer was not sent to the provider'),
  })
  expect(await requests(profile, conversationId)).toEqual([
    expect.objectContaining({ id: approval.id, response_delivery: 'not_sent' }),
  ])
  await profile.call('agent.answer', intent)
  await waitForIdle(profile, conversationId)
  expect(await nativeReplies(profile, 'codex')).toBe(1)
})

test('F038: a provider-withdrawn request refuses a late answer', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, codexPrompts.approvalExpire)
  const approval = await waitForPendingRequest(profile, conversationId)
  await profile.releaseMock('codex', 'expire-approval')
  await expect.poll(async () => (await requests(profile, conversationId)).length).toBe(0)
  await waitForIdle(profile, conversationId)
  await expect(profile.call('agent.answer', answerIntent(approval, answerFor(approval, 'accept')))).rejects.toThrow()
  expect(await nativeReplies(profile, 'codex')).toBe(0)
})
test('F038: unknown Codex requests stay readable and refuse guessed answers without dispatch', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, codexPrompts.unsupportedRequest)
  const pending = await waitForPendingRequest(profile, conversationId)
  expect(pending.metadata.summary).toBeTruthy()
  if (pending.metadata.schema.kind !== 'unsupported') throw new Error('Expected an unsupported native request')
  expect(pending.metadata.schema.reason).toContain('no supported answer schema')

  await expect(
    profile.call('agent.answer', answerIntent(pending, { kind: 'choice', value: 'accept' })),
  ).rejects.toThrow()
  expect(await nativeReplies(profile, 'codex')).toBe(0)

  await profile.releaseMock('codex', 'expire-approval')
  await expect.poll(async () => (await requests(profile, conversationId)).length).toBe(0)
  await waitForIdle(profile, conversationId)
  expect(await nativeReplies(profile, 'codex')).toBe(0)
})
