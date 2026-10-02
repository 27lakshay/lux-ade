// R003: cancelling one run never affects its successor. Each case races a
// cancellation, its cleanup or a late provider callback against a newly
// admitted turn, and checks that only the turn the caller meant is touched
// (architecture section 4: "An old cancellation or worker callback must not
// affect a successor").
import { access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  cancelActiveSubmission,
  expect,
  isRunning,
  prompts,
  send,
  startConversation,
  test,
  turnReply,
  waitForIdle,
  waitForMessage,
  type ScratchProfile,
} from '../fixtures'
import { mockDirectory } from '../fixtures/providers'

let cancelOperationNumber = 0

function nextCancelOperation() {
  return `cancel-fencing-${++cancelOperationNumber}`
}

async function cancellationRequest(profile: ScratchProfile, conversationId: string, turnId?: string) {
  const current = await conversation(profile, conversationId)
  const source_attempt_id = current.runtime_run
  const submission_id = current.runtime_submission
  if (!source_attempt_id || !submission_id) throw new Error('Running turn has no exact ADE cancellation identity')
  const target_turn_id = turnId ?? current.active_turn_id ?? undefined
  return {
    operation_id: nextCancelOperation(),
    conversation_id: conversationId,
    source_attempt_id,
    submission_id,
    ...(target_turn_id === undefined ? {} : { turn_id: target_turn_id }),
  }
}

function retryCancellation<T extends { operation_id: string }>(request: T) {
  return { ...request, operation_id: nextCancelOperation() }
}

async function conversation(profile: ScratchProfile, conversationId: string) {
  return (await profile.call('conversation.get', { conversation_id: conversationId })).conversation
}

/** Send `text` and wait until its turn runs; returns the provider turn ID. */
async function runningTurn(
  profile: ScratchProfile,
  conversationId: string,
  text: string = prompts.hold,
  requestId?: string,
): Promise<string> {
  await send(profile, conversationId, text, requestId)
  let turn: string | null = null
  await expect
    .poll(
      async () => {
        const current = await conversation(profile, conversationId)
        turn = current.status === 'running' ? (current.active_turn_id ?? null) : null
        return turn
      },
      { timeout: 20_000 },
    )
    .not.toBeNull()
  return turn!
}

async function interruptedTurns(profile: ScratchProfile): Promise<Array<string | undefined>> {
  return (await profile.mockCalls('codex'))
    .filter((call) => call.method === 'turn/interrupt')
    .map((call) => (call.params as { turnId?: string }).turnId)
}

async function waitForStatus(profile: ScratchProfile, conversationId: string, status: string) {
  await expect.poll(async () => (await conversation(profile, conversationId)).status, { timeout: 20_000 }).toBe(status)
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

test('a cancel that names the previous turn is refused and never stops its successor, also after a daemon crash', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const first = await runningTurn(profile, conversationId)
  const firstCancel = await cancellationRequest(profile, conversationId, first)
  await profile.call('agent.cancel', firstCancel)
  await waitForStatus(profile, conversationId, 'interrupted')
  expect(await interruptedTurns(profile)).toEqual([first])

  const second = await runningTurn(profile, conversationId)
  expect(second).not.toBe(first)
  // A retried or late cancel for the first turn, through the SDK and the CLI.
  await expect(profile.call('agent.cancel', retryCancellation(firstCancel))).rejects.toThrow(
    `Turn ${first} is no longer active; nothing was cancelled`,
  )
  const cli = await profile.cli('conversation', 'cancel', conversationId, '--turn', first)
  expect(cli.code).not.toBe(0)
  expect(cli.stderr).toContain('no longer active')
  expect(await conversation(profile, conversationId)).toMatchObject({ status: 'running', active_turn_id: second })
  expect(await interruptedTurns(profile)).toEqual([first])

  // The fence holds across a daemon crash: the running turn is reattached and still protected.
  await profile.restartDaemon('kill')
  await expect(profile.call('agent.cancel', retryCancellation(firstCancel))).rejects.toThrow('no longer active')
  expect(await conversation(profile, conversationId)).toMatchObject({ status: 'running', active_turn_id: second })
  expect(await interruptedTurns(profile)).toEqual([first])

  // A cancel that names the running turn stops it, through the CLI.
  const stop = await profile.cli('conversation', 'cancel', conversationId, '--turn', second)
  expect(stop.code, stop.stderr).toBe(0)
  await waitForStatus(profile, conversationId, 'interrupted')
  expect(await interruptedTurns(profile)).toEqual([first, second])
})

test('a cancel racing the admission of the next turn stops only the turn it was issued for', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const first = await runningTurn(profile, conversationId)
  // Cancel, and at once try to admit the next turn under one request ID until
  // the daemon accepts it; the cancelled turn's cleanup runs meanwhile.
  const firstCancellation = await cancellationRequest(profile, conversationId, first)
  const cancelled = profile.call('agent.cancel', firstCancellation)
  const successor = `successor-${test.info().testId}`
  await expect
    .poll(
      async () => {
        try {
          await send(profile, conversationId, prompts.turn, successor)
          return 'admitted'
        } catch (error) {
          return String(error)
        }
      },
      { timeout: 20_000, intervals: [10] },
    )
    .toBe('admitted')
  await cancelled
  // The successor completes normally; the earlier cancellation did not reach it.
  await waitForMessage(profile, conversationId, turnReply.codex)
  await waitForIdle(profile, conversationId)
  const calls = await profile.mockCalls('codex')
  expect(await interruptedTurns(profile)).toEqual([first])
  expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(2)
  expect((await conversation(profile, conversationId)).error ?? null).toBeNull()
})

test('a cancellation whose provider reply fails after the turn ended does not fail the successor turn', async ({
  ade,
}) => {
  const profile = await ade.profile({ env: { ADE_CODEX_BIN: join(__dirname, '../fixtures/codex_cancel_faults.py') } })
  const directory = mockDirectory(profile.root, 'codex')
  const { conversationId } = await startConversation(profile, 'codex')
  await runningTurn(profile, conversationId)
  await profile.releaseMock('codex', 'hold-interrupt-reply')
  await cancelActiveSubmission(profile, conversationId)
  // The provider interrupted the turn, but its reply to the cancel is held.
  await expect.poll(() => exists(join(directory, 'interrupt-held'))).toBe(true)
  await waitForStatus(profile, conversationId, 'interrupted')

  const second = await runningTurn(profile, conversationId)
  const provider = (await profile.mockCalls('codex')).at(-1)!.pid
  // The late failure of the first turn's cancellation arrives now.
  await profile.releaseMock('codex', 'release-interrupt')
  await expect.poll(() => exists(join(directory, 'interrupt-failed'))).toBe(true)
  // A steer is answered on the same provider pipe after that failure, so the
  // daemon has received the failure by the time the steer is acknowledged.
  expect(
    await profile.call('conversation.steer', {
      operation_id: 'after-late-failure',
      conversation_id: conversationId,
      turn_id: second,
      text: 'still running',
    }),
  ).toMatchObject({ outcome: 'acknowledged', turn_id: second })
  expect(await conversation(profile, conversationId)).toMatchObject({ status: 'running', active_turn_id: second })
  expect(await isRunning(provider)).toBe(true)

  // Only the second turn's own cancel stops it, and it stops cleanly.
  await rm(join(directory, 'hold-interrupt-reply'))
  await cancelActiveSubmission(profile, conversationId)
  await waitForStatus(profile, conversationId, 'interrupted')
  expect((await conversation(profile, conversationId)).error ?? null).toBeNull()
  expect(await interruptedTurns(profile)).toHaveLength(2)
})

test('a late provider reply to a finished turn neither fails nor replaces its successor', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  for (const [index, late] of ['late-error', 'late-response'].entries()) {
    // The mock completes this turn but withholds its turn/start reply until the next turn starts.
    await send(profile, conversationId, late)
    await waitForIdle(profile, conversationId)
    const successor = await runningTurn(profile, conversationId, 'hold-late')
    await expect
      .poll(
        async () =>
          (await profile.mockCalls('codex')).filter((call) => call.method === 'fixture/late-delivered').length,
      )
      .toBe(index + 1)
    // A steer on the same pipe is answered after the late reply, so the daemon has handled it.
    expect(
      await profile.call('conversation.steer', {
        operation_id: `after-${late}`,
        conversation_id: conversationId,
        turn_id: successor,
        text: 'still running',
      }),
    ).toMatchObject({ outcome: 'acknowledged', turn_id: successor })
    expect(await conversation(profile, conversationId)).toMatchObject({ status: 'running', active_turn_id: successor })
    await cancelActiveSubmission(profile, conversationId)
    await waitForStatus(profile, conversationId, 'interrupted')
    expect((await conversation(profile, conversationId)).error ?? null).toBeNull()
    await profile.call('queue.pause', { conversation_id: conversationId, paused: false })
  }
})
