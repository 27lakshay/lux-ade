// R006: actual process uncertainty. The daemon records each provider's PID
// with its start stamp, and the descendants it has seen under it.
// - Stale identity: after a crash, a live process at a recorded PID with
//   another start stamp is someone else, so the recorded provider is gone. The
//   new daemon settles the attempt with its turn outcome unknown, and neither
//   signals the unrelated process nor lists it as the attempt's. The PID reuse
//   is staged by pointing the durable record at a test-owned process while no
//   daemon runs.
// - Escaped descendant: a process that left the provider's group before the
//   runtime crashed keeps the attempt quarantined until it exits.
import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
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
} from '../fixtures'
import { mockDirectory } from '../fixtures/providers'
import { recoveryFixtures, waitForAttemptRecord, waitForPidFile } from '../fixtures/recovery'

const execFileAsync = promisify(execFile)

test('a recorded PID now held by an unrelated process is read as gone, and that process is left alone', async ({
  ade,
  profile,
}) => {
  test.setTimeout(90_000)
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.hold)
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .toBe('running')
  const key = `agent:${conversationId}`
  const record = await waitForAttemptRecord(profile, key)
  expect(record.leader).toBe(true)
  const before = profile.hello

  // The host crashes: daemon first, then the runtime; the provider exits with its stdin.
  await profile.killDaemon()
  await profile.killRuntime()
  await expect.poll(() => isRunning(record.pid)).toBe(false)

  // An unrelated process, leading its own group, now sits at the recorded PID.
  const stranger = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' })
  stranger.unref()
  const strangerPid = stranger.pid!
  await ade.ledger.own(strangerPid, 'unrelated process at a reused PID')
  await execFileAsync('sqlite3', [
    join(profile.dataDirectory, 'sessions.sqlite'),
    `UPDATE runtime_attempt_records SET pid = ${strangerPid} WHERE instance = '${before.runtime_instance}' AND key = '${key}'`,
  ])
  const { stdout } = await execFileAsync('sqlite3', [
    '-readonly',
    join(profile.dataDirectory, 'sessions.sqlite'),
    `SELECT pid FROM runtime_attempt_records WHERE key = '${key}'`,
  ])
  expect(Number(stdout.trim())).toBe(strangerPid)

  const after = await profile.restartDaemon()
  expect(after.runtime_instance).not.toBe(before.runtime_instance)
  const recovery = await profile.call('runtime.recovery', {})
  const attempt = recovery.reports.flatMap((report) => report.attempts).find((candidate) => candidate.key === key)
  // Gone on evidence (a different start stamp), never quarantined on the stranger, and the turn's outcome is unknown.
  expect(attempt).toMatchObject({ kind: 'provider_turn', classification: 'settled', outcome_unknown: true, pids: [] })
  expect(await isRunning(strangerPid)).toBe(true)
  expect(
    (await profile.call('runtime.recovery', { open_only: true })).reports
      .flatMap((report) => report.attempts)
      .filter((candidate) => candidate.key === key),
  ).toEqual([])
  const snapshot = await profile.call('conversation.get', { conversation_id: conversationId })
  expect(snapshot.conversation).toMatchObject({ status: 'interrupted', active_turn_id: null })

  // The conversation continues without replaying the lost prompt, and the stranger still runs.
  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
  await send(profile, conversationId, prompts.turn)
  await waitForMessage(profile, conversationId, turnReply.codex)
  const starts = (await profile.mockCalls('codex'))
    .filter((call) => call.method === 'turn/start')
    .map((call) => (call.params as { input: Array<{ text: string }> }).input[0].text)
  expect(starts).toEqual([prompts.hold, prompts.turn])
  expect(await isRunning(strangerPid)).toBe(true)
  process.kill(strangerPid, 'SIGKILL')
  await expect.poll(() => isRunning(strangerPid)).toBe(false)
})

test('a provider descendant that left its group before a runtime crash keeps the attempt quarantined', async ({
  ade,
}) => {
  test.setTimeout(90_000)
  const profile = await ade.profile({ env: { ADE_CODEX_BIN: recoveryFixtures.stubbornCodex } })
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.hold)
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .toBe('running')
  const escapedPid = await waitForPidFile(join(mockDirectory(profile.root, 'codex'), 'escaped.pid'))
  await ade.ledger.own(escapedPid, 'escaped provider descendant')
  const key = `agent:${conversationId}`
  const record = await waitForAttemptRecord(profile, key)
  // The 2 s identity snapshot has seen the escaped process under the provider.
  await expect
    .poll(
      async () =>
        (
          await execFileAsync('sqlite3', [
            '-readonly',
            join(profile.dataDirectory, 'sessions.sqlite'),
            `SELECT pid FROM runtime_attempt_descendants WHERE key = '${key}'`,
          ]).catch(() => ({ stdout: '' }))
        ).stdout
          .split('\n')
          .map(Number),
      { timeout: 10_000 },
    )
    .toContain(escapedPid)

  // The runtime dies with its provider workers, so no worker shuts down in order and cleans up
  // its native tree (an orderly worker shutdown kills the escapee it tracked).
  await profile.killRuntimeAndWorkers()
  await expect.poll(() => isRunning(record.pid)).toBe(false)
  expect(await isRunning(escapedPid)).toBe(true)
  await profile.restartDaemon()

  // The provider is gone, but part of its tree still runs: that is not proof the turn ended.
  const attempt = (await profile.call('runtime.recovery', {})).reports
    .flatMap((report) => report.attempts)
    .find((candidate) => candidate.key === key)
  expect(attempt).toMatchObject({ kind: 'provider_turn', classification: 'quarantined' })
  expect(attempt?.pids).toContain(escapedPid)
  await expect(profile.call('agent.resume', { conversation_id: conversationId })).rejects.toThrow()

  // Once the escaped process exits, a later observation settles the attempt and the conversation continues.
  process.kill(escapedPid, 'SIGKILL')
  await expect.poll(() => isRunning(escapedPid)).toBe(false)
  await expect
    .poll(
      async () =>
        (await profile.call('runtime.recovery', {})).reports
          .flatMap((report) => report.attempts)
          .find((candidate) => candidate.key === key)?.resolved_at ?? null,
      { timeout: 30_000 },
    )
    .not.toBeNull()
  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
})
