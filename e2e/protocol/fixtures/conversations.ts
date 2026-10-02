// Conversation helpers over the SDK. Every wait polls conversation.get; none sleeps.
import { expect } from '@playwright/test'
// provider import removed: conversation.create accepts any public provider ID.
import type {
  AgentAnswerRequest,
  AgentCancelRequest,
  PendingRequest,
  RequestAnswer,
  RequestScope,
} from '../../../packages/contracts/dist/index.js'
import type { ScratchProfile } from './profile'
export type { PendingRequest }

let sendNumber = 0

/** Open `workspacePath` (the profile's default workspace when omitted) and create a conversation on `provider`. */
export async function startConversation(
  profile: ScratchProfile,
  provider: string,
  workspacePath = profile.defaultWorkspaceRoot,
): Promise<{ workspaceId: string; conversationId: string }> {
  const { workspace } = await profile.call('workspace.open', { path: workspacePath })
  const { conversation } = await profile.call('conversation.create', { workspace_id: workspace.id, provider })
  return { workspaceId: workspace.id, conversationId: conversation.id }
}

/** Send `text` with a fresh request ID and return that ID. */
export async function send(
  profile: ScratchProfile,
  conversationId: string,
  text: string,
  requestId = `e2e-send-${process.pid}-${++sendNumber}`,
): Promise<string> {
  await profile.call('agent.send', { conversation_id: conversationId, request_id: requestId, text })
  return requestId
}

export async function conversationStatus(profile: ScratchProfile, conversationId: string): Promise<string> {
  return (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status
}

/** Cancel the exact ADE attempt/submission exposed by the latest conversation snapshot. */
export async function cancellationIntent(
  profile: ScratchProfile,
  conversationId: string,
  turnId?: string,
  snapshot?: { runtime_run: string | null; runtime_submission: string | null; active_turn_id: string | null },
): Promise<Omit<AgentCancelRequest, 'op' | 'operation_id'>> {
  const conversation =
    snapshot ?? (await profile.call('conversation.get', { conversation_id: conversationId })).conversation
  const source_attempt_id = conversation.runtime_run
  const submission_id = conversation.runtime_submission
  if (!source_attempt_id || !submission_id) throw new Error('Conversation has no active cancellation identity')
  const turn_id = turnId ?? conversation.active_turn_id
  return {
    conversation_id: conversationId,
    source_attempt_id,
    submission_id,
    ...(turn_id === null ? {} : { turn_id }),
  }
}

export async function cancelActiveSubmission(
  profile: ScratchProfile,
  conversationId: string,
  turnId?: string,
  options: { timeoutMs?: number } = {},
) {
  return profile.call('agent.cancel', await cancellationIntent(profile, conversationId, turnId), options)
}

export async function waitForIdle(profile: ScratchProfile, conversationId: string, timeout = 20_000): Promise<void> {
  await expect.poll(() => conversationStatus(profile, conversationId), { timeout }).toMatch(/^(idle|ready)$/)
}

/** Wait until an assistant message contains `text`. */
export async function waitForMessage(
  profile: ScratchProfile,
  conversationId: string,
  text: string,
  timeout = 20_000,
): Promise<void> {
  await expect
    .poll(
      async () =>
        (await profile.call('conversation.get', { conversation_id: conversationId })).messages
          .map((message) => (message as { text?: string }).text ?? '')
          .join('\n'),
      { timeout },
    )
    .toContain(text)
}

/** Wait for exactly one pending native request (approval or questions) and return it. */
export async function waitForPendingRequest(
  profile: ScratchProfile,
  conversationId: string,
  timeout = 20_000,
): Promise<PendingRequest> {
  let pending: PendingRequest | undefined
  let lastSnapshot: { conversation: { status: string; error: string | null }; requests: PendingRequest[] } | undefined
  try {
    await expect
      .poll(
        async () => {
          const snapshot = await profile.call('conversation.get', { conversation_id: conversationId })
          const actionable = snapshot.requests.filter(
            (request) => request.resolution === 'outstanding' && request.response_delivery === 'not_sent',
          )
          pending = actionable[0]
          lastSnapshot = snapshot
          return actionable.length
        },
        { timeout },
      )
      .toBe(1)
  } catch (error) {
    if (lastSnapshot?.requests.length === 0) {
      throw new Error('No native request arrived; conversation=' + JSON.stringify(lastSnapshot.conversation), {
        cause: error,
      })
    }
    throw error
  }
  if (!pending) throw new Error('The pending request disappeared')
  return pending
}

let answerNumber = 0

/** Build the exact typed answer request from the durable public request snapshot. */
export function answerIntent(
  request: PendingRequest,
  answer: RequestAnswer,
  operationId = 'e2e-answer-' + process.pid + '-' + ++answerNumber,
): Omit<AgentAnswerRequest, 'op'> {
  return {
    operation_id: operationId,
    conversation_id: request.conversation_id,
    request_id: request.id,
    source_attempt_id: request.source_attempt_id,
    request_revision: request.revision,
    answer,
  }
}

export function choiceAnswer(request: PendingRequest, name: 'accept' | 'decline'): RequestAnswer {
  const schema = request.metadata.schema
  if (schema.kind !== 'choices') throw new Error('The native request does not offer discrete choices')
  const terms = name === 'accept' ? ['accept', 'allow', 'once'] : ['decline', 'deny', 'reject']
  const choice = schema.choices.find((item) => {
    const value = JSON.stringify(item.value).toLowerCase()
    const label = item.label.toLowerCase()
    return terms.some((term) => value.includes(term) || label.includes(term))
  })
  if (!choice) throw new Error('No native ' + name + ' choice is available')
  return { kind: 'choice', value: choice.value }
}

/** Values are native option IDs; free text is used only when the schema has no options. */
export function fixtureAnswers(request: PendingRequest, answer = 'fixture answer'): RequestAnswer {
  const schema = request.metadata.schema
  if (schema.kind !== 'questions') throw new Error('The native request does not declare questions')
  const answers = Object.fromEntries(
    schema.questions.map((question) => {
      const option = question.options?.[0]
      return [question.id, [option?.value ?? answer]]
    }),
  )
  return { kind: 'questions', answers }
}

export function answerFor(request: PendingRequest, decision: 'accept' | 'decline' | 'answer'): RequestAnswer {
  const schema = request.metadata.schema
  if (schema.kind === 'choices') return choiceAnswer(request, decision === 'decline' ? 'decline' : 'accept')
  if (schema.kind === 'questions' && decision === 'answer') return fixtureAnswers(request)
  if (schema.kind === 'permissions' && decision !== 'answer') {
    const scope: RequestScope = schema.scopes.includes('once') ? 'once' : schema.scopes[0]
    return { kind: 'permissions', permissions: schema.requested, scope, strict_auto_review: null }
  }
  throw new Error('Answer ' + decision + ' does not match native request schema ' + schema.kind)
}
