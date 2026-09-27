// R005: independent work survives a daemon restart. The runtime keeps the
// provider run and its tool; the new daemon reconciles ownership before it
// admits anything, attaches the live run and never sends the prompt again.
import {
  codexPrompts,
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

async function turnStarts(profile: ScratchProfile): Promise<string[]> {
  return (await profile.mockCalls('codex'))
    .filter((call) => call.method === 'turn/start')
    .map((call) => (call.params as { input: Array<{ text: string }> }).input[0].text)
}

for (const mode of ['graceful', 'kill'] as const) {
  test(`a ${mode} daemon restart during a tool call keeps the run, its tool and its native session`, async ({
    profile,
  }) => {
    const { conversationId } = await startConversation(profile, 'codex')
    const requestId = await send(profile, conversationId, codexPrompts.heldTool)
    let toolPid = 0
    await expect
      .poll(async () => {
        toolPid = Number(
          (await profile.mockCalls('codex')).find((call) => call.method === 'fixture/tool')?.tool_pid ?? 0,
        )
        return toolPid
      })
      .toBeGreaterThan(0)
    const before = await profile.call('conversation.get', { conversation_id: conversationId })
    expect(before.conversation.status).toBe('running')
    const nativeThread = before.conversation.provider_thread_id
    expect(nativeThread).toBeTruthy()
    const providerPid = (await profile.mockCalls('codex'))[0].pid
    const first = profile.hello
    // A frontend subscribes to the feed and goes away mid-turn, as a closed
    // or reloaded view does. Execution does not depend on it.
    const feed = await profile.rpc({ op: 'session.subscribe' })
    expect(JSON.stringify(feed.catalog)).toContain(conversationId)

    const after = await profile.restartDaemon(mode)
    expect(after.boot_id).not.toBe(first.boot_id)
    expect(after.runtime_instance).toBe(first.runtime_instance)
    expect(after.runtime_pid).toBe(first.runtime_pid)
    expect(await isRunning(providerPid)).toBe(true)
    expect(await isRunning(toolPid)).toBe(true)

    // A new frontend restores the same state from the new daemon.
    const restored = await profile.rpc({ op: 'session.subscribe' })
    expect(restored.boot_id).toBe(after.boot_id)
    expect(JSON.stringify(restored.catalog)).toContain(conversationId)
    // The runtime never restarted, so there is nothing to classify.
    expect((await profile.call('runtime.recovery', {})).reports).toEqual([])
    // The live run was attached before admission: the turn is still running,
    // a retried send with the same request ID is deduplicated, and a new
    // prompt cannot start a second run beside it.
    const attached = await profile.call('conversation.get', { conversation_id: conversationId })
    expect(attached.conversation).toMatchObject({
      status: 'running',
      provider_thread_id: nativeThread,
      runtime_run: before.conversation.runtime_run,
    })
    await send(profile, conversationId, codexPrompts.heldTool, requestId)
    await expect(send(profile, conversationId, prompts.turn)).rejects.toThrow(/active turn/)
    const status = await profile.call('runtime.status', {})
    expect(JSON.stringify(status.agents)).toContain(before.conversation.runtime_run!)

    await profile.releaseMock('codex', 'release-tool')
    await waitForMessage(profile, conversationId, 'tool completed once')
    await waitForIdle(profile, conversationId)
    const settled = await profile.call('conversation.get', { conversation_id: conversationId })
    expect(settled.messages.filter((message) => JSON.stringify(message).includes('tool completed once'))).toHaveLength(
      1,
    )
    expect(await turnStarts(profile)).toEqual([codexPrompts.heldTool])

    // The same provider process takes the next turn on the same native session.
    await send(profile, conversationId, prompts.turn)
    await waitForMessage(profile, conversationId, turnReply.codex)
    const calls = await profile.mockCalls('codex')
    expect(new Set(calls.map((call) => call.pid))).toEqual(new Set([providerPid]))
    expect(await turnStarts(profile)).toEqual([codexPrompts.heldTool, prompts.turn])
  })
}
