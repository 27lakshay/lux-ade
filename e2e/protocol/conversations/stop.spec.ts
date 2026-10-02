// Ticket 05: Stop separates acknowledgement from confirmed termination, keeps
// unresolved outcomes visible and offers process termination as the declared
// escalation, through real daemon, runtime and provider processes.
import { join } from 'node:path'
import { repositoryRoot } from '../fixtures/environment'
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

async function conversation(profile: ScratchProfile, conversationId: string) {
  return (await profile.call('conversation.get', { conversation_id: conversationId })).conversation
}

async function heldTurn(profile: ScratchProfile, conversationId: string, text: string = prompts.hold) {
  await send(profile, conversationId, text)
  await expect
    .poll(async () => (await conversation(profile, conversationId)).status, { timeout: 20_000 })
    .toBe('running')
}

async function codexPid(profile: ScratchProfile): Promise<number> {
  return (await profile.mockCalls('codex')).at(-1)!.pid
}

test('Stop through the CLI waits past acknowledgement for native terminal evidence', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await heldTurn(profile, conversationId)
  const stopped = await profile.cli('conversation', 'cancel', conversationId, '--wait')
  expect(stopped.code, stopped.stderr).toBe(0)
  expect(stopped.json).toMatchObject({
    type: 'agent_cancel_outcome',
    delivery: 'acknowledged',
    evidence: { scope: 'turn', interruption_requested: true, termination: 'requested' },
    stop: { outcome: 'confirmed', confirmation: 'native_terminal', native_status: 'interrupted', escalation: null },
  })
  // The SDK reads the same authoritative record.
  expect((await conversation(profile, conversationId)).stop).toEqual(stopped.json!.stop)
})

test('an acknowledged Stop without terminal evidence becomes unresolved, and termination confirms the process exit', async ({
  ade,
}) => {
  const profile = await ade.profile({ env: { ADE_E2E_STOP_SETTLE_MS: '1500' } })
  const { conversationId } = await startConversation(profile, 'codex')
  await heldTurn(profile, conversationId)
  const provider = await codexPid(profile)
  await profile.releaseMock('codex', 'defer-interrupt')
  const waited = await profile.cli('conversation', 'cancel', conversationId, '--wait')
  expect(waited.code, waited.stderr).toBe(0)
  expect(waited.json).toMatchObject({
    delivery: 'acknowledged',
    stop: {
      delivery: 'acknowledged',
      outcome: 'unresolved',
      confirmation: null,
      escalation: 'terminate_process',
      reason: expect.stringContaining('did not report the turn ending'),
    },
  })
  // Unresolved is never shown as stopped: the provider still runs.
  expect(await isRunning(provider)).toBe(true)
  // The turn may still be running, so the conversation shows it running and Stop can be retried.
  expect((await conversation(profile, conversationId)).status).toBe('running')

  const terminated = await profile.cli('conversation', 'terminate', conversationId)
  expect(terminated.code, terminated.stderr).toBe(0)
  expect(terminated.json).toMatchObject({
    type: 'agent_terminate_outcome',
    process_exited: true,
    limits: [expect.stringContaining('Child or background processes')],
  })
  await expect.poll(() => isRunning(provider)).toBe(false)
  expect((await conversation(profile, conversationId)).stop).toMatchObject({
    operation_id: waited.json!.operation_id,
    outcome: 'confirmed',
    confirmation: 'process_exit',
    escalation: null,
  })

  expect((await conversation(profile, conversationId)).status).toBe('error')
  // The next attempt is unaffected by the settled Stop.
  await profile.call('agent.resume', { operation_id: 'resume-after-terminate', conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
  await profile.call('queue.pause', { conversation_id: conversationId, paused: false })
  await send(profile, conversationId, prompts.turn, 'after-terminate')
  await waitForMessage(profile, conversationId, turnReply.codex)
  await waitForIdle(profile, conversationId)
})

test('a refused cancellation keeps the turn running and the provider alive, and offers termination', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await heldTurn(profile, conversationId)
  const provider = await codexPid(profile)
  await profile.releaseMock('codex', 'refuse-interrupt')
  await expect(cancelActiveSubmission(profile, conversationId)).rejects.toThrow('refused the cancellation')
  const current = await conversation(profile, conversationId)
  expect(current.status).toBe('running')
  expect(current.stop).toMatchObject({
    delivery: 'refused',
    outcome: 'unresolved',
    escalation: 'terminate_process',
    reason: expect.stringContaining('The provider refused the cancellation'),
  })
  expect(await isRunning(provider)).toBe(true)
})

test('a Claude interrupt that leaves input queued is reported unresolved, never as a stop', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'claude')
  await heldTurn(profile, conversationId, 'interrupt-queued')
  const outcome = await cancelActiveSubmission(profile, conversationId)
  expect(outcome).toMatchObject({
    delivery: 'acknowledged',
    evidence: { interruption_requested: true, termination: 'requested', queued_work_count: 1 },
  })
  expect((await conversation(profile, conversationId)).stop).toMatchObject({
    outcome: 'unresolved',
    escalation: 'terminate_process',
    reason: '1 queued input can still run after this stop',
  })
})

test('an OMP abort that goes idle without a run-end event still settles the Stop from the native state', async ({
  ade,
}) => {
  // The deterministic OMP CLI fixture reproduces what installed OMP 18.4 did in the live probe.
  const profile = await ade.profile({ env: { ADE_OMP_BIN: join(repositoryRoot, 'providers/omp/mock-cli.mjs') } })
  const { conversationId } = await startConversation(profile, 'omp')
  await heldTurn(profile, conversationId, 'hold-silent-abort')
  const outcome = await cancelActiveSubmission(profile, conversationId)
  expect(outcome).toMatchObject({
    delivery: 'acknowledged',
    evidence: { active_work_remaining: false, queued_work_count: 0 },
  })
  await expect
    .poll(async () => (await conversation(profile, conversationId)).stop)
    .toMatchObject({ outcome: 'confirmed', confirmation: 'native_terminal' })
  expect((await conversation(profile, conversationId)).status).toMatch(/^(idle|ready|interrupted)$/)
})
