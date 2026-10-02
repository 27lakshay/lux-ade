// R005: independent work survives frontend closes and daemon restarts. A
// headless view (the SDK client plus the `@ade/client/sync` projection the
// renderer uses) closes mid-turn. The daemon is then killed and later
// restarted gracefully. The provider run, its tool, a terminal program in a
// shared checkout and that checkout's HostResources claim all keep their
// identity; a new view restores the same state, and nothing is replayed.
import {
  codexPrompts,
  expect,
  isRunning,
  prompts,
  send,
  test,
  turnReply,
  waitForIdle,
  waitForMessage,
  type ScratchProfile,
} from '../fixtures'
import { startHostProfiles } from '../fixtures/host-profiles'
import { openConversationView, viewDigest } from '../fixtures/sync-view'
import { terminalMetrics } from '../fixtures/terminals'
import { adopt, claimsOn, externalTree, launchShell, removeTree } from '../resources/steps'

async function turnStarts(profile: ScratchProfile): Promise<string[]> {
  return (await profile.mockCalls('codex'))
    .filter((call) => call.method === 'turn/start')
    .map((call) => (call.params as { input: Array<{ text: string }> }).input[0].text)
}

async function toolPid(profile: ScratchProfile): Promise<number> {
  let pid = 0
  await expect
    .poll(async () => {
      pid = Number((await profile.mockCalls('codex')).find((call) => call.method === 'fixture/tool')?.tool_pid ?? 0)
      return pid
    })
    .toBeGreaterThan(0)
  return pid
}

test('a closed view, a daemon kill and a graceful restart leave the run, its tool, a terminal and its claim running', async ({
  ade,
  repo,
}) => {
  test.setTimeout(150_000)
  const {
    profiles: [worker, observer],
  } = await startHostProfiles(ade, 2)
  // The observer may remove the checkout; the worker works in it.
  const tree = await externalTree(ade, repo, 'kept')
  const projectId = await adopt(observer, repo.path, tree)
  const launch = await launchShell(worker, tree)
  expect(launch.launched).toBe(true)
  const { workspace, shellId } = launch
  const shell = [workspace.id, shellId] as const
  const [claim] = await claimsOn(worker, tree)
  expect(claim).toMatchObject({ mode: 'shared', purpose: 'use', state: 'active', owner_live: true, mine: true })

  // A provider turn in the same workspace, blocked in a tool call.
  const { conversation } = await worker.call('conversation.create', { workspace_id: workspace.id, provider: 'codex' })
  const conversationId = conversation.id
  const view = await openConversationView(worker, conversationId)
  const requestId = await send(worker, conversationId, codexPrompts.heldTool)
  const tool = await toolPid(worker)
  const providerPid = (await worker.mockCalls('codex'))[0].pid
  // The mock records its child PID before the tool event reaches the daemon.
  // Capture the baseline after that event so restart equality compares the same history.
  await view.settle(
    (snapshot) =>
      snapshot.conversation.status === 'running' &&
      snapshot.messages.some((message) => message.id === `${conversationId}:tool-${requestId}`),
  )
  const before = await worker.call('conversation.get', { conversation_id: conversationId })
  const shellBefore = (await terminalMetrics(worker, ...shell))!
  expect(shellBefore.shell_running).toBe(true)
  const first = worker.hello

  // The view closes mid-turn, as a closed or reloaded window does.
  view.dispose()
  const statesAtClose = view.states.length

  for (const mode of ['kill', 'graceful'] as const) {
    const previous = worker.hello
    if (mode === 'kill') {
      await worker.killDaemon()
      // While no daemon runs, the claim is quarantined, never dropped: the other profile still may not remove the checkout.
      expect(await claimsOn(observer, tree)).toEqual([
        expect.objectContaining({
          id: claim.id,
          state: 'quarantined',
          reason: 'owner_lost_during_use',
          owner_live: false,
        }),
      ])
      expect(await removeTree(observer, projectId, 'remove-while-down', tree)).toMatchObject({
        type: 'error',
        code: 'host_resource_conflict',
      })
    }
    const after = await worker.restartDaemon(mode)
    expect(after.boot_id, mode).not.toBe(previous.boot_id)
    // The same runtime incarnation owns the work; nothing was reconciled.
    expect(after).toMatchObject({ runtime_instance: first.runtime_instance, runtime_pid: first.runtime_pid })
    expect((await worker.call('runtime.recovery', {})).reports, mode).toEqual([])
    for (const pid of [providerPid, tool, shellBefore.shell_pid!])
      expect(await isRunning(pid), `${mode}: ${pid}`).toBe(true)
    expect(await terminalMetrics(worker, ...shell), mode).toMatchObject({
      run_id: shellBefore.run_id,
      shell_pid: shellBefore.shell_pid,
      shell_running: true,
    })
    // The new daemon incarnation supersedes the claim with its own live one: the checkout stays protected throughout.
    const claims = await claimsOn(observer, tree)
    expect(claims, mode).toEqual([
      expect.objectContaining({
        state: 'active',
        owner_live: true,
        purpose: 'use',
        owner_profile: claim.owner_profile,
        owner_pid: after.pid,
      }),
    ])
    expect(await removeTree(observer, projectId, `remove-${mode}`, tree), mode).toMatchObject({
      type: 'error',
      code: 'host_resource_conflict',
    })
    const attached = await worker.call('conversation.get', { conversation_id: conversationId })
    expect(attached.conversation, mode).toMatchObject({
      status: 'running',
      runtime_run: before.conversation.runtime_run,
      provider_thread_id: before.conversation.provider_thread_id,
    })
  }
  // The closed view heard nothing after it closed.
  expect(view.states).toHaveLength(statesAtClose)

  // A new view restores the running turn from the new daemon, then follows it to the end.
  const restored = await openConversationView(worker, conversationId)
  try {
    const running = await restored.settle((snapshot) => snapshot.conversation.status === 'running')
    expect(running.boot_id).toBe(worker.hello.boot_id)
    expect(viewDigest(running).messages).toEqual(viewDigest(before).messages)
    // A retried send is deduplicated; the turn is not started again.
    await send(worker, conversationId, codexPrompts.heldTool, requestId)
    await worker.releaseMock('codex', 'release-tool')
    const done = await restored.settle(
      (snapshot) =>
        /^(idle|ready)$/.test(snapshot.conversation.status) &&
        JSON.stringify(snapshot.messages).includes('tool completed once'),
    )
    const fresh = await worker.call('conversation.get', { conversation_id: conversationId, limit: 32 })
    expect(viewDigest(done)).toEqual(viewDigest(fresh))
    expect(fresh.messages.filter((message) => JSON.stringify(message).includes('tool completed once'))).toHaveLength(1)
    expect(await turnStarts(worker)).toEqual([codexPrompts.heldTool])

    // The same provider process takes the next turn.
    await send(worker, conversationId, prompts.turn)
    await waitForMessage(worker, conversationId, turnReply.codex)
    await waitForIdle(worker, conversationId)
    expect(new Set((await worker.mockCalls('codex')).map((call) => call.pid))).toEqual(new Set([providerPid]))
  } finally {
    restored.dispose()
  }
  expect(await terminalMetrics(worker, ...shell)).toMatchObject({
    shell_pid: shellBefore.shell_pid,
    shell_running: true,
  })
  // The claim goes only when the work that holds it stops: the shell and the provider run.
  await worker.call('terminal.stop', { workspace_id: workspace.id, terminal_id: shellId })
  await worker.call('agent.disconnect', { conversation_id: conversationId })
  await expect.poll(async () => (await claimsOn(observer, tree)).length).toBe(0)
})
