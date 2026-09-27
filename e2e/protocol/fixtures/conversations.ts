// Conversation helpers over the SDK. Every wait polls conversation.get; none sleeps.
import { expect } from '@playwright/test'
import type { MockProvider } from './providers'
import type { ScratchProfile } from './profile'

export type PendingRequest = { id: string; method: string; params: Record<string, unknown> }

let sendNumber = 0

/** Open `workspacePath` (the profile's default workspace when omitted) and create a conversation on `provider`. */
export async function startConversation(
  profile: ScratchProfile,
  provider: MockProvider,
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

/** Wait until the conversation can take a new turn. */
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
  await expect
    .poll(
      async () => {
        const snapshot = await profile.call('conversation.get', { conversation_id: conversationId })
        pending = snapshot.requests[0] as PendingRequest | undefined
        return snapshot.requests.length
      },
      { timeout },
    )
    .toBe(1)
  if (!pending) throw new Error('The pending request disappeared')
  return pending
}

/** Text answers for every question in a questions request, keyed the way the provider asked them. */
export function fixtureAnswers(request: PendingRequest, answer = 'fixture answer'): Record<string, string> {
  const questions = (request.params.questions ?? []) as Array<{ id?: string; question?: string }>
  return Object.fromEntries(
    questions.map((question, index) => [question.id ?? question.question ?? String(index), answer]),
  )
}
