// R006: process exit is evidence about the observed process, not proof that
// its descendants stopped. Provider runs and script runs whose descendants
// ignore SIGTERM, leave the process group or are reparented must not report an
// exit, or release their lease, until the whole observed tree is gone.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, isRunning, prompts, send, startConversation, test, turnReply, waitForIdle, waitForMessage,
  type AdeHarness, type ScratchProfile } from '../fixtures'
import { mockDirectory } from '../fixtures/providers'
import { recoveryFixtures, waitForAttemptRecord, waitForPidFile } from '../fixtures/recovery'

/** Workspace recipes: a shell that ignores TERM and HUP and starts an escaping descendant. */
async function writeRecipes(root: string): Promise<void> {
  await mkdir(join(root, '.ade'), { recursive: true })
  const stubborn = (linger: number) => ({ program: '/bin/sh', args: ['-c', [
    "trap '' TERM HUP",
    `python3 '${recoveryFixtures.escapee}' "$PWD" ${linger} &`,
    'echo $$ > shell.pid',
    'while :; do sleep 1; done',
  ].join('\n')] })
  await writeFile(join(root, '.ade', 'scripts.json'), JSON.stringify({ schema_version: 1, scripts: {
    stubborn: stubborn(0), orphaning: stubborn(3), quick: { program: '/bin/sh', args: ['-c', 'echo ADE_QUICK'] },
  } }))
}

async function startStubborn(ade: AdeHarness, profile: ScratchProfile, name: 'stubborn' | 'orphaning') {
  const root = profile.defaultWorkspaceRoot
  await writeRecipes(root)
  const { workspace } = await profile.call('workspace.open', { path: root })
  const started = await profile.call('script.start', { workspace_id: workspace.id, name })
  const shellPid = await waitForPidFile(join(root, 'shell.pid'))
  const escapedPid = await waitForPidFile(join(root, 'escaped.pid'))
  // The escapee left the group; the harness must still account for it.
  await ade.ledger.own(escapedPid, 'escaped descendant')
  return { workspaceId: workspace.id, runId: started.run_id, shellPid, escapedPid }
}

/** An exit status that claims the process tree exited. */
function claimsExit(status: unknown): boolean {
  const kind = (status as { kind?: string } | undefined)?.kind
  return kind === 'success' || kind === 'failure' || kind === 'signaled'
}

test('disconnecting a provider that ignores TERM escalates and confirms only once its escaped descendant is gone', async ({ ade }) => {
  const profile = await ade.profile({ env: { ADE_CODEX_BIN: recoveryFixtures.stubbornCodex } })
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.turn)
  await waitForMessage(profile, conversationId, turnReply.codex)
  await waitForIdle(profile, conversationId)
  const providerPid = (await profile.mockCalls('codex'))[0].pid
  const escapedPid = await waitForPidFile(join(mockDirectory(profile.root, 'codex'), 'escaped.pid'))
  await ade.ledger.own(escapedPid, 'escaped provider descendant')

  // A confirmed stop is the only acknowledgement, so the reply itself is the evidence.
  const started = Date.now()
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  expect(await isRunning(providerPid)).toBe(false)
  expect(await isRunning(escapedPid)).toBe(false)
  // SIGTERM was ignored; only the SIGKILL escalation after the grace period stopped the tree.
  expect(Date.now() - started).toBeGreaterThanOrEqual(1_500)
  const snapshot = await profile.call('conversation.get', { conversation_id: conversationId })
  expect(snapshot.conversation.status).not.toMatch(/^(running|starting|waiting)$/)
})

for (const name of ['stubborn', 'orphaning'] as const) {
  test(`script.stop reports an exit only after the ${name} tree, which ignores TERM, is gone`, async ({ ade, profile }) => {
    const { workspaceId, runId, shellPid, escapedPid } = await startStubborn(ade, profile, name)
    expect(await isRunning(escapedPid)).toBe(true)

    const stopped = await profile.call('script.stop', { workspace_id: workspaceId, run_id: runId })
    // Whatever the stop answers, it never claims an exit while a descendant runs.
    if (claimsExit(stopped.exit_status)) {
      expect(await isRunning(escapedPid)).toBe(false)
      expect(await isRunning(shellPid)).toBe(false)
    }
    await expect.poll(async () => {
      const inspected = await profile.call('script.inspect', { workspace_id: workspaceId, run_id: runId })
      // Checked against the same observation that reports the exit.
      if (claimsExit(inspected.exit_status)) expect(await isRunning(escapedPid)).toBe(false)
      return inspected.state === 'exited' && claimsExit(inspected.exit_status)
    }, { timeout: 15_000 }).toBe(true)
    expect(await isRunning(shellPid)).toBe(false)
    expect(await isRunning(escapedPid)).toBe(false)
    const inspected = await profile.call('script.inspect', { workspace_id: workspaceId, run_id: runId })
    expect(inspected.exit_status).toMatchObject({ kind: 'signaled', descendants: { verdict: 'exited' } })

    // The lease is released only now: the workspace admits a new run.
    await profile.call('script.retire', { workspace_id: workspaceId, run_id: runId })
    await profile.call('script.start', { workspace_id: workspaceId, name: 'quick' })
  })
}

test('a script tree that survives a runtime kill is quarantined and blocks the workspace until it exits', async ({ ade, profile }) => {
  test.setTimeout(90_000)
  const { workspaceId, runId, shellPid, escapedPid } = await startStubborn(ade, profile, 'stubborn')
  const key = `script:${workspaceId}:${runId}`
  const record = await waitForAttemptRecord(profile, `terminal:${workspaceId}:${runId}`)
  expect(record.pid).toBe(shellPid)
  const before = profile.hello

  // The shell and its escapee ignore the hangup the lost terminal delivers.
  await profile.killRuntime()
  expect(await isRunning(shellPid)).toBe(true)
  expect(await isRunning(escapedPid)).toBe(true)
  const after = await profile.restartDaemon()
  expect(after.runtime_instance).not.toBe(before.runtime_instance)

  const recovery = await profile.call('runtime.recovery', {})
  const report = recovery.reports.find((candidate) => candidate.attempts.some((attempt) => attempt.key === key))
  const attempt = report?.attempts.find((candidate) => candidate.key === key)
  expect(attempt).toMatchObject({ kind: 'script', classification: 'quarantined', subject: runId, resolved_at: null })
  expect(attempt?.pids).toContain(shellPid)

  // Reconciled before admission: no new run, no retire, no user release.
  await expect(profile.call('script.start', { workspace_id: workspaceId, name: 'quick' })).rejects.toThrow()
  await expect(profile.call('script.retire', { workspace_id: workspaceId, run_id: runId })).rejects.toThrow()
  await expect(profile.call('runtime.recovery.release', { report_id: report!.id, attempt_key: key }))
    .rejects.toThrow(/still running/)

  // The whole tree exits; a later observation settles the attempt and the
  // workspace admits new work again.
  process.kill(escapedPid, 'SIGKILL')
  process.kill(shellPid, 'SIGKILL')
  await expect.poll(() => isRunning(shellPid)).toBe(false)
  await expect.poll(async () => {
    const reports = (await profile.call('runtime.recovery', {})).reports
    return reports.flatMap((candidate) => candidate.attempts).find((candidate) => candidate.key === key)?.resolved_at ?? null
  }, { timeout: 30_000 }).not.toBeNull()
  await profile.call('script.start', { workspace_id: workspaceId, name: 'quick' })
})

// Gap (R006; architecture section 4, "Limits"): restart reconciliation knows
// only the recorded process and its group. A descendant that left the group
// before the runtime crashed is not recorded, so the attempt settles and the
// workspace is released while that descendant still runs. Closing it needs the
// runtime to report the descendants it tracks per attempt, and the daemon to
// record them with the attempt identity.
test.fixme('an escaped descendant that survives a runtime kill keeps its script attempt quarantined', async ({ ade, profile }) => {
  const { workspaceId, runId, shellPid, escapedPid } = await startStubborn(ade, profile, 'stubborn')
  const key = `script:${workspaceId}:${runId}`
  await waitForAttemptRecord(profile, `terminal:${workspaceId}:${runId}`)
  await profile.killRuntime()
  await profile.restartDaemon()
  process.kill(shellPid, 'SIGKILL')
  await expect.poll(() => isRunning(shellPid)).toBe(false)
  const attempt = async () => (await profile.call('runtime.recovery', {})).reports
    .flatMap((report) => report.attempts).find((candidate) => candidate.key === key)
  expect((await attempt())?.pids).toContain(escapedPid)
  await expect(profile.call('script.start', { workspace_id: workspaceId, name: 'quick' })).rejects.toThrow()
  process.kill(escapedPid, 'SIGKILL')
})
