// R006: a provider's descendant that leaves the process group and loses its
// parent is still part of the Agent attempt. The runtime observes each
// provider tree every 200 ms and reports what it tracks in `agent.list`; the
// daemon adopts that report into its own tracker and records it with the
// attempt. So a descendant that escapes between two of the daemon's 2-second
// observations, just before a runtime kill, keeps the attempt quarantined
// after the provider exits: across a fresh observation, a later daemon start,
// and until it exits itself.
import { join } from 'node:path'
import {
  expect,
  isRunning,
  prompts,
  send,
  test,
  turnReply,
  waitForIdle,
  waitForMessage,
  startConversation,
  type ScratchProfile,
} from '../fixtures'
import { mockDirectory } from '../fixtures/providers'
import { waitForAttemptRecord, waitForPidFile, waitForRecordedDescendant } from '../fixtures/recovery'

/** The Codex mock with a watcher that escapes on `escape-now`; see the script. */
const escapingCodex = join(__dirname, '..', 'fixtures', 'codex_escaping.sh')

async function recoveryAttempt(profile: ScratchProfile, key: string) {
  for (const report of (await profile.call('runtime.recovery', {})).reports) {
    const attempt = report.attempts.find((candidate) => candidate.key === key)
    if (attempt) return { report, attempt }
  }
  return undefined
}

test('an escaped provider descendant that survives a runtime kill keeps its agent attempt quarantined until it exits', async ({
  ade,
}) => {
  test.setTimeout(90_000)
  const profile = await ade.profile({ env: { ADE_CODEX_BIN: escapingCodex } })
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.hold)
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .toBe('running')
  const key = `agent:${conversationId}`
  const record = await waitForAttemptRecord(profile, key)

  // The descendant escapes now: it leaves the group, and its parent exits
  // half a second later, so it is orphaned to launchd before escaped.pid exists.
  await profile.releaseMock('codex', 'escape-now')
  const escapedPid = await waitForPidFile(join(mockDirectory(profile.root, 'codex'), 'escaped.pid'))
  await ade.ledger.own(escapedPid, 'escaped provider descendant')
  // Without a parent in the tree, the daemon can know it only from the
  // runtime's report. Wait for the record, not a time, then kill the runtime.
  await waitForRecordedDescendant(profile, key, escapedPid)
  const before = profile.hello
  await profile.killRuntime()
  // The provider loses its stdin with the runtime and exits; the escapee does not.
  await expect.poll(() => isRunning(record.pid)).toBe(false)
  expect(await isRunning(escapedPid)).toBe(true)
  const after = await profile.restartDaemon()
  expect(after.runtime_instance).not.toBe(before.runtime_instance)

  const found = await recoveryAttempt(profile, key)
  expect(found?.attempt).toMatchObject({
    kind: 'provider_turn',
    classification: 'quarantined',
    resolved_at: null,
    runtime_instance: before.runtime_instance,
  })
  expect(found?.attempt.pids).toContain(escapedPid)
  expect(found?.attempt.pids).not.toContain(record.pid)

  // Each refusal observes again: the escapee alone keeps the attempt open.
  const refusesWhileEscapeeRuns = async () => {
    const reportId = (await recoveryAttempt(profile, key))!.report.id
    await expect(profile.call('runtime.recovery.release', { report_id: reportId, attempt_key: key })).rejects.toThrow(
      /still running/,
    )
    await expect(profile.call('agent.resume', { conversation_id: conversationId })).rejects.toThrow()
    await expect(send(profile, conversationId, prompts.turn)).rejects.toThrow()
  }
  await refusesWhileEscapeeRuns()
  // The record is durable: a new daemon still attributes the escapee to the attempt.
  await profile.restartDaemon('kill')
  await refusesWhileEscapeeRuns()
  expect((await recoveryAttempt(profile, key))?.attempt).toMatchObject({
    classification: 'quarantined',
    resolved_at: null,
  })

  // Once the escapee exits, a later observation settles the attempt and the
  // Conversation continues without replaying the held prompt.
  process.kill(escapedPid, 'SIGKILL')
  await expect.poll(() => isRunning(escapedPid)).toBe(false)
  await expect
    .poll(async () => (await recoveryAttempt(profile, key))?.attempt.resolved_at ?? null, { timeout: 30_000 })
    .not.toBeNull()
  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
  await send(profile, conversationId, prompts.turn)
  await waitForMessage(profile, conversationId, turnReply.codex)
  const turnStarts = (await profile.mockCalls('codex'))
    .filter((call) => call.method === 'turn/start')
    .map((call) => (call.params as { input: Array<{ text: string }> }).input[0].text)
  expect(turnStarts).toEqual([prompts.hold, prompts.turn])
})
