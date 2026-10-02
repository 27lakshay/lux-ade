// F107: a question or approval a child raises is visible on the parent's view
// of its children, with the question itself, and the parent Agent or the user
// answers it once through that view. A different late answer is refused, a
// forged caller is refused, and the pending question survives a daemon
// restart until it is answered.
import { expect, prompts, test, type ScratchProfile } from '../fixtures'
import { childView, delegate, parentIn, waitForChild } from './steps'

type ChildRequest = { request_id: string; kind: string; method: string; params: Record<string, unknown> }

async function pendingFromParent(profile: ScratchProfile, parent: string, child: string): Promise<ChildRequest[]> {
  return (await childView(profile, parent, child)).pending_requests as ChildRequest[]
}

async function waitForQuestion(profile: ScratchProfile, parent: string, child: string): Promise<ChildRequest> {
  await expect.poll(async () => (await pendingFromParent(profile, parent, child)).length).toBe(1)
  return (await pendingFromParent(profile, parent, child))[0]
}

function answersFor(request: ChildRequest, answer = 'yes') {
  const questions = request.params.questions
  if (!Array.isArray(questions)) throw new Error('Child request does not contain structured questions')
  return Object.fromEntries(
    questions.map((question) => {
      if (typeof question !== 'object' || question === null || !('id' in question) || typeof question.id !== 'string') {
        throw new Error('Child question has no native ID')
      }
      return [question.id, [answer]]
    }),
  )
}

test('a child question shows on the parent view and the parent Agent answers it once (F107)', async ({ profile }) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const child = (await delegate(profile, parent, prompts.questions)).child_conversation_id

  const question = await waitForQuestion(profile, parent, child)
  expect(question).toMatchObject({ kind: 'question', method: 'item/tool/requestUserInput' })
  expect((question.params.questions as Array<{ question: string }>).map((item) => item.question)).toEqual([
    'First?',
    'Second?',
  ])
  expect(await childView(profile, parent, child)).toMatchObject({ status: 'waiting' })
  // The wait and the activity feed name the same request.
  expect(await waitForChild(profile, child, 'needs_input')).toMatchObject({ request_ids: [question.request_id] })
  const { activities } = await profile.call('activity.list', { limit: 200 })
  expect(activities.find((item) => item.kind === 'question_requested')).toMatchObject({
    target: { conversation_id: child, request_id: question.request_id },
  })

  // Only the parent Agent or the user may answer; a sibling is refused and nothing reaches the child.
  const sibling = (await delegate(profile, parent)).child_conversation_id
  await expect(
    profile.call('orchestration.child.answer', {
      child_conversation_id: child,
      request_id: question.request_id,
      caller: { kind: 'agent', conversation_id: sibling },
      decision: 'answer',
      answers: answersFor(question),
    }),
  ).rejects.toThrow(/Only the parent Conversation/)
  await expect(
    profile.call('orchestration.child.answer', {
      child_conversation_id: child,
      request_id: 'request_missing',
      caller: { kind: 'user' },
      decision: 'answer',
      answers: answersFor(question),
    }),
  ).rejects.toThrow()

  const answer = {
    child_conversation_id: child,
    request_id: question.request_id,
    caller: { kind: 'agent' as const, conversation_id: parent },
    decision: 'answer',
    answers: answersFor(question, 'yes'),
  }
  expect(await profile.call('orchestration.child.answer', answer)).toMatchObject({
    child_conversation_id: child,
    request_id: question.request_id,
    attribution: `agent:${parent}`,
  })
  await waitForChild(profile, child, 'settled', { outcome: 'completed' })
  expect(await pendingFromParent(profile, parent, child)).toEqual([])

  // The same answer again converges; a different late answer is refused. The child got one reply.
  await profile.call('orchestration.child.answer', answer)
  await expect(
    profile.call('orchestration.child.answer', { ...answer, answers: answersFor(question, 'no') }),
  ).rejects.toThrow()
  const replies = (await profile.mockCalls('codex')).filter((call) => call.method === 'approval/reply')
  expect(replies).toHaveLength(1)
  expect(JSON.stringify(replies[0])).toContain('yes')
})

test('a child approval shows as an approval and the CLI declines it from the parent side', async ({ profile }) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const child = (await delegate(profile, parent, prompts.approval)).child_conversation_id
  const approval = await waitForQuestion(profile, parent, child)
  expect(approval).toMatchObject({
    kind: 'approval',
    method: 'item/commandExecution/requestApproval',
    params: expect.objectContaining({ command: 'echo fixture' }),
  })

  const listed = await profile.cli('child', 'list', parent)
  expect(
    (listed.json as { children: Array<{ pending_requests: ChildRequest[] }> }).children[0].pending_requests,
  ).toEqual([expect.objectContaining({ request_id: approval.request_id, kind: 'approval' })])
  const usage = await profile.cli('child', 'answer', child, approval.request_id, 'answer')
  expect(usage.code).not.toBe(0)
  const declined = await profile.cli('child', 'answer', child, approval.request_id, 'decline', '--as-agent', parent)
  expect(declined.code).toBe(0)
  expect(declined.json).toMatchObject({
    type: 'child_answered',
    request_id: approval.request_id,
    attribution: `agent:${parent}`,
  })
  await waitForChild(profile, child, 'settled')
  const accepted = await profile.cli('child', 'answer', child, approval.request_id, 'accept', '--as-agent', parent)
  expect(accepted.code).not.toBe(0)
  const replies = (await profile.mockCalls('codex')).filter((call) => call.method === 'approval/reply')
  expect(replies).toHaveLength(1)
  expect(JSON.stringify(replies[0].result)).toContain('decline')
})

test('a pending child question survives a daemon restart and is answered once after it', async ({ profile }) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const child = (await delegate(profile, parent, prompts.questions)).child_conversation_id
  const question = await waitForQuestion(profile, parent, child)

  await profile.restartDaemon('graceful')
  expect(await pendingFromParent(profile, parent, child)).toEqual([question])
  expect(await waitForChild(profile, child, 'needs_input')).toMatchObject({ request_ids: [question.request_id] })

  await profile.call('orchestration.child.answer', {
    child_conversation_id: child,
    request_id: question.request_id,
    caller: { kind: 'user' },
    decision: 'answer',
    answers: answersFor(question),
  })
  await waitForChild(profile, child, 'settled', { outcome: 'completed' })
  expect((await profile.mockCalls('codex')).filter((call) => call.method === 'approval/reply')).toHaveLength(1)
})
