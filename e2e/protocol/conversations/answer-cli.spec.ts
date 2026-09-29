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
  const acked = { code: 0, json: { type: 'ack' } }
  const requestFor = async (prompt: string, method: string) => {
    await waitForIdle(profile, conversationId)
    await send(profile, conversationId, prompt)
    const pending = await waitForPendingRequest(profile, conversationId)
    expect(pending.method).toBe(method)
    return pending
  }
  const approvalMethod = 'item/commandExecution/requestApproval'

  const approval = await requestFor(codexPrompts.approval, approvalMethod)
  expect(approval.params.command).toBe('echo fixture')
  expect(await answer(approval.id, 'decline')).toMatchObject(acked)
  await expect.poll(async () => (await replies(profile)).length).toBe(1)
  expect((await replies(profile))[0]!.result).toEqual({ decision: 'decline' })
  const conflicting = await answer(approval.id, 'accept')
  expect(conflicting.code).not.toBe(0)
  expect(conflicting.stderr).toMatch(/conflicts with the recorded decision/)
  expect(await answer(approval.id, 'decline')).toMatchObject(acked)
  expect(await replies(profile)).toHaveLength(1)

  const questions = await requestFor(codexPrompts.richQuestions, 'item/tool/requestUserInput')
  expect(questions.params.questions).toMatchObject([
    { id: 'choice', question: 'Choose a mode' },
    { id: 'multiple', question: 'Choose features', multiSelect: true },
    { id: 'secret', question: 'Fixture secret', isSecret: true },
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
  expect(await answer(questions.id, 'answer', JSON.stringify(answers))).toMatchObject(acked)
  expect(await replies(profile)).toHaveLength(2)

  const accepted = await requestFor(codexPrompts.approval, approvalMethod)
  expect(await answer(accepted.id, 'accept')).toMatchObject(acked)
  await expect.poll(async () => (await replies(profile)).length).toBe(3)
  expect((await replies(profile))[2]!.result).toEqual({ decision: 'accept' })

  // A request that offers only accept and cancel refuses decline.
  const cancelOnly = await requestFor('approval-cancel', approvalMethod)
  expect(cancelOnly.params.availableDecisions).toEqual(['accept', 'cancel'])
  const unoffered = await answer(cancelOnly.id, 'decline')
  expect(unoffered.code).not.toBe(0)
  expect(unoffered.stderr).toMatch(/Decision is not offered by Codex/)
  expect(await answer(cancelOnly.id, 'cancel')).toMatchObject(acked)
  await expect.poll(async () => (await replies(profile)).length).toBe(4)
  expect((await replies(profile))[3]!.result).toEqual({ decision: 'cancel' })
  expect(await answer(cancelOnly.id, 'cancel')).toMatchObject(acked)
  expect((await answer(cancelOnly.id, 'accept')).stderr).toMatch(/conflicts with the recorded decision/)

  // Malformed answers are refused and reach nothing.
  expect((await answer(questions.id, 'answer', '{"choice":4}')).stderr).toMatch(/values must be text/)
  expect((await answer(questions.id, 'accept', '{}')).stderr).toMatch(/required only for/)
  expect((await answer(questions.id, 'maybe')).stderr).toMatch(/must be accept, decline, cancel, or answer/)
  expect(await replies(profile)).toHaveLength(4)
})
