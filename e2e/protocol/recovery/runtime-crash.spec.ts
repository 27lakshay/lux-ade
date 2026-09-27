// R005, R006: a runtime killed during a provider turn. The new daemon
// classifies every attempt the old runtime owned from recorded process
// identity and fresh observation, keeps unsettled leases reserved, and never
// replays a prompt (architecture section 4, "Runtime restart reconciliation").
import {
  expect,
  isRunning,
  prompts,
  send,
  startConversation,
  test,
  turnReply,
  waitForIdle,
  waitForMessage,
  codexPrompts,
  type ScratchProfile,
} from '../fixtures'
import { attemptRecords, waitForAttemptRecord } from '../fixtures/recovery'

async function turnStarts(profile: ScratchProfile): Promise<string[]> {
  return (await profile.mockCalls('codex'))
    .filter((call) => call.method === 'turn/start')
    .map((call) => (call.params as { input: Array<{ text: string }> }).input[0].text)
}

async function recoveryAttempt(profile: ScratchProfile, key: string) {
  const recovery = await profile.call('runtime.recovery', {})
  for (const report of recovery.reports) {
    const attempt = report.attempts.find((candidate) => candidate.key === key)
    if (attempt) return { report, attempt }
  }
  return undefined
}

// Two orderings reach the same classification. The daemon may outlive its
// runtime, notice the loss and mark the turn interrupted before it restarts
// (`daemon-survives`), or die first so the next start sees the turn busy
// (`daemon-first`, as after a host crash).
for (const ordering of ['daemon-survives', 'daemon-first'] as const) {
  test(`a runtime killed mid-turn (${ordering}) settles from evidence, marks the turn outcome unknown and never replays it`, async ({
    profile,
  }) => {
    const { conversationId } = await startConversation(profile, 'codex')
    await send(profile, conversationId, prompts.hold)
    await expect
      .poll(
        async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status,
      )
      .toBe('running')
    const record = await waitForAttemptRecord(profile, `agent:${conversationId}`)
    expect(record.leader).toBe(true)
    const before = profile.hello

    if (ordering === 'daemon-first') await profile.killDaemon()
    await profile.killRuntime()
    // The provider loses its stdin with the runtime and exits on its own.
    await expect.poll(() => isRunning(record.pid)).toBe(false)
    if (ordering === 'daemon-survives') {
      await expect
        .poll(
          async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status,
        )
        .toBe('interrupted')
    }
    const after = await profile.restartDaemon()
    expect(after.runtime_instance).not.toBe(before.runtime_instance)

    const found = await recoveryAttempt(profile, `agent:${conversationId}`)
    expect(found?.report.previous_instances).toContain(before.runtime_instance)
    expect(found?.report.current_instance).toBe(after.runtime_instance)
    expect(found?.attempt).toMatchObject({
      kind: 'provider_turn',
      classification: 'settled',
      outcome_unknown: true,
      runtime_instance: before.runtime_instance,
      pids: [],
    })
    expect(found?.attempt.reason).toMatch(/not replayed/)

    const snapshot = await profile.call('conversation.get', { conversation_id: conversationId })
    expect(snapshot.conversation).toMatchObject({ status: 'interrupted', active_turn_id: null, queue_paused: true })
    expect(await turnStarts(profile)).toEqual([prompts.hold])

    // The Conversation continues on the new runtime; the held prompt is not sent again.
    await profile.call('agent.resume', { conversation_id: conversationId })
    await waitForIdle(profile, conversationId)
    await send(profile, conversationId, prompts.turn)
    await waitForMessage(profile, conversationId, turnReply.codex)
    expect(await turnStarts(profile)).toEqual([prompts.hold, prompts.turn])
  })
}

test('a quarantined provider tree keeps its lease and refuses admission until its processes exit', async ({
  profile,
}) => {
  test.setTimeout(90_000)
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, codexPrompts.heldTool)
  let toolPid = 0
  await expect
    .poll(async () => {
      toolPid = Number((await profile.mockCalls('codex')).find((call) => call.method === 'fixture/tool')?.tool_pid ?? 0)
      return toolPid
    })
    .toBeGreaterThan(0)
  const record = await waitForAttemptRecord(profile, `agent:${conversationId}`)

  await profile.killRuntime()
  // The provider is blocked in its tool and keeps running without an owner.
  expect(await isRunning(record.pid)).toBe(true)
  expect(await isRunning(toolPid)).toBe(true)
  await profile.restartDaemon()

  const key = `agent:${conversationId}`
  const found = await recoveryAttempt(profile, key)
  expect(found?.attempt).toMatchObject({ kind: 'provider_turn', classification: 'quarantined', resolved_at: null })
  expect(found?.attempt.pids).toEqual(expect.arrayContaining([record.pid, toolPid]))
  expect(found?.report.open).toBeGreaterThan(0)
  const activity = await profile.call('activity.list', { limit: 200 })
  expect(
    activity.activities.filter((entry) => entry.kind === 'operation_unknown' && entry.detail?.includes('quarantined')),
  ).toHaveLength(1)
  const open = await profile.call('runtime.recovery', { open_only: true })
  expect(open.reports.map((report) => report.id)).toContain(found!.report.id)

  // Ownership is reconciled before new admission: nothing new may start on it.
  await expect(profile.call('agent.resume', { conversation_id: conversationId })).rejects.toThrow()
  await expect(send(profile, conversationId, prompts.turn)).rejects.toThrow()
  await expect(
    profile.call('runtime.recovery.release', { report_id: found!.report.id, attempt_key: key }),
  ).rejects.toThrow(/still running/)

  // The orphaned tree finishes; a later observation settles the attempt.
  await profile.releaseMock('codex', 'release-tool')
  await expect.poll(() => isRunning(record.pid), { timeout: 15_000 }).toBe(false)
  await expect
    .poll(async () => (await recoveryAttempt(profile, key))?.attempt.resolved_at ?? null, { timeout: 30_000 })
    .not.toBeNull()
  const settled = await recoveryAttempt(profile, key)
  expect(settled?.attempt.resolution).toMatch(/settled/)
  expect(
    (await profile.call('runtime.recovery', { open_only: true })).reports.map((report) => report.id),
  ).not.toContain(found!.report.id)
  // A release after the evidence settled it changes nothing and answers the same report.
  const repeated = await profile.call('runtime.recovery.release', { report_id: found!.report.id, attempt_key: key })
  expect(repeated.report.attempts.find((attempt) => attempt.key === key)).toEqual(settled?.attempt)

  // Released on evidence, never replayed.
  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
  await send(profile, conversationId, prompts.turn)
  await waitForMessage(profile, conversationId, turnReply.codex)
  expect(await turnStarts(profile)).toEqual([codexPrompts.heldTool, prompts.turn])
})

test('a turn lost before its process was recorded stays unknown until the user releases it, and is never replayed', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.hold)
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .toBe('running')
  const before = profile.hello
  const key = `agent:${conversationId}`
  // The daemon records process identities every 2 seconds. Kill it before the
  // first record of this provider, then confirm none was written.
  await profile.killDaemon()
  const recorded = (await attemptRecords(profile, before.runtime_instance)).some((record) => record.key === key)
  test.skip(recorded, 'The daemon recorded the provider just before it was killed; the unrecorded path was not reached')
  await profile.killRuntime()
  await profile.restartDaemon()

  const found = await recoveryAttempt(profile, key)
  expect(found?.attempt).toMatchObject({
    kind: 'provider_turn',
    classification: 'unknown',
    resolved_at: null,
    pids: [],
  })
  expect(found?.attempt.reason).toMatch(/no process identity was recorded/)

  // Unknown is not settled: nothing new starts on this Conversation.
  await expect(profile.call('agent.resume', { conversation_id: conversationId })).rejects.toThrow()
  await expect(send(profile, conversationId, prompts.turn)).rejects.toThrow()

  // The user accepts it without proof; a repeated release answers the same report.
  const released = await profile.call('runtime.recovery.release', { report_id: found!.report.id, attempt_key: key })
  const attempt = released.report.attempts.find((candidate) => candidate.key === key)
  expect(attempt?.resolved_at).not.toBeNull()
  expect(attempt?.resolution).toMatch(/released by the user without proof of exit/)
  const again = await profile.call('runtime.recovery.release', { report_id: found!.report.id, attempt_key: key })
  expect(again.report.attempts.find((candidate) => candidate.key === key)).toEqual(attempt)
  expect(
    (await profile.call('runtime.recovery', { open_only: true })).reports.map((report) => report.id),
  ).not.toContain(found!.report.id)

  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
  await send(profile, conversationId, prompts.turn)
  await waitForMessage(profile, conversationId, turnReply.codex)
  expect(await turnStarts(profile)).toEqual([prompts.hold, prompts.turn])
})
