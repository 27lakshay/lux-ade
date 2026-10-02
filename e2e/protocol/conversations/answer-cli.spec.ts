// F038 through the CLI: `ade conversation answer` settles a native approval or
// questions request once through the running daemon, repeats converge, a
// conflicting or unoffered decision is refused, and malformed answers are
// usage errors that reach nothing. Ported from the legacy
// e2e/specs/conversation-answer-cli spec; requests.spec.ts covers agent.answer.
import {
  codexPrompts,
  expect,
  send,
  startConversation,
  test,
  waitForIdle,
  waitForPendingRequest,
  type ScratchProfile,
} from '../fixtures'

async function replies(profile: ScratchProfile) {
  return (await profile.mockCalls('codex')).filter((call) => call.method === 'approval/reply')
}

test('CLI answers native approvals and questions once through the running daemon', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const answer = (...args: string[]) => profile.cli('conversation', 'answer', conversationId, ...args)
  const acked = { code: 0, json: { type: 'agent_answer_outcome', response_delivery: 'acknowledged' } }
  const requestFor = async (prompt: string, kind: 'choices' | 'questions') => {
    await waitForIdle(profile, conversationId)
    await send(profile, conversationId, prompt)
    const pending = await waitForPendingRequest(profile, conversationId)
    expect(pending.metadata.schema.kind).toBe(kind)
    return pending
  }
  const approvalSchema = 'choices'

  const approval = await requestFor(codexPrompts.approval, approvalSchema)
  expect(approval.metadata.summary).toBe('echo fixture')
  expect(await answer(approval.id, 'decline')).toMatchObject(acked)
  await expect.poll(async () => (await replies(profile)).length).toBe(1)
  expect((await replies(profile))[0]!.result).toEqual({ decision: 'decline' })
  // Once the answered request has closed with its turn, any further answer, the same or a
  // conflicting one, is refused and never reaches the provider again.
  const resolved = /no longer pending/
  const conflicting = await answer(approval.id, 'accept')
  expect(conflicting.code).not.toBe(0)
  expect(conflicting.stderr).toMatch(resolved)
  expect((await answer(approval.id, 'decline')).stderr).toMatch(resolved)
  expect(await replies(profile)).toHaveLength(1)

  const questions = await requestFor(codexPrompts.richQuestions, 'questions')
  if (questions.metadata.schema.kind !== 'questions') throw new Error('Expected native questions schema')
  expect(questions.metadata.schema.questions).toMatchObject([
    { id: 'choice', prompt: 'Choose a mode' },
    { id: 'multiple', prompt: 'Choose features', multiple: true },
    { id: 'secret', prompt: 'Fixture secret', secret: true },
  ])
  const answers = { choice: 'Thorough', multiple: ['Read, write'], secret: 'fixture answer' }
  expect(await answer(questions.id, 'answer', JSON.stringify(answers))).toMatchObject(acked)
  await expect.poll(async () => (await replies(profile)).length).toBe(2)
  expect((await replies(profile))[1]!.result).toEqual({
    answers: {
      choice: { answers: ['Thorough'] },
      multiple: { answers: ['Read, write'] },
      secret: { answers: ['fixture answer'] },
    },
  })
  expect((await answer(questions.id, 'answer', JSON.stringify(answers))).stderr).toMatch(resolved)
  expect(await replies(profile)).toHaveLength(2)

  const accepted = await requestFor(codexPrompts.approval, approvalSchema)
  expect(await answer(accepted.id, 'accept')).toMatchObject(acked)
  await expect.poll(async () => (await replies(profile)).length).toBe(3)
  expect((await replies(profile))[2]!.result).toEqual({ decision: 'accept' })

  // A request that offers only accept and cancel refuses decline.
  const cancelOnly = await requestFor('approval-cancel', approvalSchema)
  if (cancelOnly.metadata.schema.kind !== 'choices') throw new Error('Expected native choices schema')
  expect(cancelOnly.metadata.schema.choices.map((choice) => choice.value)).toEqual(['accept', 'cancel'])
  const unoffered = await answer(cancelOnly.id, 'decline')
  expect(unoffered.code).not.toBe(0)
  expect(unoffered.stderr).toMatch(/Choice is not offered by this request/)
  expect(await answer(cancelOnly.id, 'cancel')).toMatchObject(acked)
  await expect.poll(async () => (await replies(profile)).length).toBe(4)
  expect((await replies(profile))[3]!.result).toEqual({ decision: 'cancel' })
  expect((await answer(cancelOnly.id, 'cancel')).stderr).toMatch(resolved)
  expect((await answer(cancelOnly.id, 'accept')).stderr).toMatch(resolved)

  // Malformed answers are refused and reach nothing.
  expect((await answer(questions.id, 'answer', '{"choice":4}')).stderr).toMatch(/values must be text/)
  expect((await answer(questions.id, 'accept', '{}')).stderr).toMatch(/required only for/)
  expect((await answer(questions.id, 'maybe')).stderr).toMatch(/must be accept, decline, cancel, or answer/)
  expect(await replies(profile)).toHaveLength(4)
})
