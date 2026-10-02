// R004, R005: a live run keeps a receipt for every command it admitted, up to
// a bound. Saturating ordinary receipts refuses new ordinary commands, but
// cancellation draws on reserved capacity, so the user can always stop the
// running turn (architecture section 4: "Saturated normal command receipts
// must not disable stopping existing work").
import { cancelActiveSubmission, conversationStatus, expect, prompts, send, startConversation, test } from '../fixtures'

// The runtime's ordinary receipt bound per run (crates/ade-runtime/src/agent_budget.rs).
const RECEIPT_COUNT = 4096

test('cancel is admitted and reaches the provider while ordinary command receipts are saturated', async ({
  profile,
}) => {
  test.setTimeout(300_000)
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.hold)
  let turnId = ''
  await expect
    .poll(async () => {
      const snapshot = await profile.call('conversation.get', { conversation_id: conversationId })
      turnId = snapshot.conversation.active_turn_id ?? ''
      return snapshot.conversation.status === 'running' && turnId !== ''
    })
    .toBe(true)

  // Every steer is an ordinary command with its own receipt. The mock refuses
  // steering, so each one is answered without changing the turn.
  await profile.releaseMock('codex', 'refuse-steer')
  let next = 0
  let saturatedBy: string | null = null
  const steer = async () => {
    while (saturatedBy === null && next < RECEIPT_COUNT + 64) {
      const operationId = `saturate-${next++}`
      try {
        await profile.call('conversation.steer', {
          operation_id: operationId,
          conversation_id: conversationId,
          turn_id: turnId,
          text: 'steer',
        })
      } catch (error) {
        if (/receipt limit reached/.test(String(error))) saturatedBy ??= operationId
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, steer))
  expect(saturatedBy).not.toBeNull()
  // The open and send receipts count toward the same bound.
  expect(next).toBeGreaterThan(RECEIPT_COUNT - 64)
  // Still saturated: another ordinary command is refused.
  await expect(
    profile.call('conversation.steer', {
      operation_id: 'saturate-after',
      conversation_id: conversationId,
      turn_id: turnId,
      text: 'steer',
    }),
  ).rejects.toThrow(/receipt limit reached/)
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status).toBe(
    'running',
  )

  await cancelActiveSubmission(profile, conversationId)
  await expect
    .poll(async () => (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/interrupt').length)
    .toBe(1)
  // The provider interrupted the turn; the Conversation records it as such.
  await expect.poll(() => conversationStatus(profile, conversationId)).toBe('interrupted')
})
