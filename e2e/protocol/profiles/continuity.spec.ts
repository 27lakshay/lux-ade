// F010 and the F005 clause "close clients without stopping admitted work":
// background continuity on a managed profile. Work admitted through the CLI
// keeps running after every client has gone: the CLI exited, terminal
// attachments and feed subscribers closed. It settles with nobody attached,
// and a client that comes back later observes the settled result without
// the command or the prompt running again. A daemon crash while nobody is
// attached does not change that.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { codexPrompts, isRunning, prompts, turnReply } from '../fixtures'
import { subscribeFeed } from '../fixtures/feed'
import { expect, test, type ManagedProfile } from '../fixtures/managed-profiles'
import { replayText, TerminalStream } from '../fixtures/terminals'

const modes = ['all clients closed', 'daemon crash while detached'] as const

function field(result: { json: Record<string, unknown> | null }, pattern: RegExp): string {
  const match = JSON.stringify(result.json).match(pattern)
  if (!match) throw new Error(`No ${pattern} in ${JSON.stringify(result.json)}`)
  return match[1]
}

async function turnStarts(profile: ManagedProfile): Promise<string[]> {
  return (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start')
    .map((call) => ((call.params as { input: Array<{ text: string }> }).input[0]).text)
}

for (const mode of modes) {
  test(`a terminal command keeps running with no client and is observed once on reattach (${mode})`, async ({ host, ade }) => {
    const work = await host.create('Work')
    const opened = await work.cli('workspace', 'open', work.defaultWorkspaceRoot)
    expect(opened.code, opened.stderr).toBe(0)
    const workspaceId = field(opened, /"id":"(workspace[^"]*)"/)
    const terminalId = field(opened, /"terminal_id":"([^"]+)"/)

    // A command that records each start and end, and waits for a release file.
    const log = join(ade.root, 'command.log')
    const release = join(ade.root, 'release-command')
    const command = `echo begin >> '${log}'; while [ ! -f '${release}' ]; do sleep 0.05; done; ` +
      `echo end >> '${log}'; echo "CONTINUITY-$((6 * 7))-DONE"`

    // One viewer attaches, and the CLI sends the command and exits.
    const viewer = TerminalStream.open(work.asScratch(), workspaceId, terminalId)
    const runId = (await viewer.snapshot()).run_id as string
    const sent = await work.cli('terminal', 'send', workspaceId, terminalId, command)
    expect(sent.code, sent.stderr).toBe(0)
    await expect.poll(() => readFile(log, 'utf8').catch(() => '')).toBe('begin\n')
    const feed = await subscribeFeed(work.asScratch())
    await feed.connected()

    // Every client goes away.
    viewer.close()
    feed.stop()
    await viewer.waitForClose()
    const before = (await work.hello())!
    if (mode === 'daemon crash while detached') await work.killDaemon()

    // With nobody attached, the command finishes.
    await writeFile(release, '')
    await expect.poll(() => readFile(log, 'utf8').catch(() => '')).toBe('begin\nend\n')

    // A client returns: the CLI (cold-starting a replacement daemon after a crash) and a new attachment.
    const inspected = await work.cli('terminal', 'inspect', workspaceId, terminalId)
    expect(inspected.code, inspected.stderr).toBe(0)
    expect(inspected.json).toMatchObject({ type: 'snapshot', run_id: runId })
    const after = (await work.hello())!
    expect(after.runtime_instance).toBe(before.runtime_instance)
    if (mode === 'daemon crash while detached') expect(after.boot_id).not.toBe(before.boot_id)
    else expect(after.boot_id).toBe(before.boot_id)

    const returning = TerminalStream.open(work.asScratch(), workspaceId, terminalId)
    const snapshot = await returning.snapshot()
    expect(snapshot.run_id).toBe(runId)
    const replay = replayText(snapshot)
    expect(replay.match(/CONTINUITY-42-DONE/g)).toHaveLength(1)
    expect(replayText(inspected.json as never).match(/CONTINUITY-42-DONE/g)).toHaveLength(1)
    returning.close()
    // Reattaching never ran the command again.
    expect(await readFile(log, 'utf8')).toBe('begin\nend\n')
  })

  test(`a provider turn keeps running with no client and settles once on reattach (${mode})`, async ({ host }) => {
    const work = await host.create('Work')
    const opened = await work.cli('workspace', 'open', work.defaultWorkspaceRoot)
    expect(opened.code, opened.stderr).toBe(0)
    const workspaceId = field(opened, /"id":"(workspace[^"]*)"/)
    const created = await work.cli('conversation', 'create', workspaceId, 'codex')
    expect(created.code, created.stderr).toBe(0)
    const conversationId = field(created, /"id":"(conversation[^"]*)"/)

    // The CLI sends a turn whose tool runs until released, and exits.
    const requestId = `continuity-${mode.replace(/\W+/g, '-')}`
    const sent = await work.cli('conversation', 'send', conversationId, codexPrompts.heldTool, '--request-id', requestId)
    expect(sent.code, sent.stderr).toBe(0)
    let toolPid = 0
    await expect.poll(async () => {
      toolPid = Number((await work.mockCalls('codex')).find((call) => call.method === 'fixture/tool')?.tool_pid ?? 0)
      return toolPid
    }).toBeGreaterThan(0)
    const running = await work.call('conversation.get', { conversation_id: conversationId })
    expect(running.conversation.status).toBe('running')
    const thread = running.conversation.provider_thread_id!
    expect(thread).toBeTruthy()
    const providerPid = (await work.mockCalls('codex'))[0].pid

    // A feed subscriber watches the turn run, then every client goes away.
    const feed = await subscribeFeed(work.asScratch())
    await feed.connected()
    feed.stop()
    const before = (await work.hello())!
    if (mode === 'daemon crash while detached') {
      await work.killDaemon()
      expect(await isRunning(providerPid)).toBe(true)
    }

    // With nobody attached, the tool finishes and the provider completes the turn.
    await work.releaseMock('codex', 'release-tool')
    await expect.poll(async () => {
      const saved = await readFile(join(work.root, 'providers/codex', `${thread}.json`), 'utf8').catch(() => '{}')
      return (JSON.parse(saved) as { turns?: Array<{ status?: string }> }).turns?.at(-1)?.status ?? ''
    }, { timeout: 20_000 }).toBe('completed')
    expect(await isRunning(toolPid)).toBe(false)

    // A client returns and sees the settled turn exactly once.
    await expect.poll(async () => {
      const inspected = await work.cli('conversation', 'inspect', conversationId)
      return JSON.stringify(inspected.json).match(/"status":"(idle|ready|running)"/)?.[1]
    }, { timeout: 20_000 }).toMatch(/^(idle|ready)$/)
    const after = (await work.hello())!
    expect(after.runtime_instance).toBe(before.runtime_instance)
    const settled = await work.call('conversation.get', { conversation_id: conversationId })
    expect(settled.messages.filter((message) => JSON.stringify(message).includes('tool completed once'))).toHaveLength(1)
    expect(await turnStarts(work)).toEqual([codexPrompts.heldTool])

    // Retrying the send with its request ID after reattaching does not run the prompt again.
    const retried = await work.cli('conversation', 'send', conversationId, codexPrompts.heldTool, '--request-id', requestId)
    expect(retried.code, retried.stderr).toBe(0)
    expect(await turnStarts(work)).toEqual([codexPrompts.heldTool])

    // The same provider process takes the next turn.
    const next = await work.cli('conversation', 'send', conversationId, prompts.turn)
    expect(next.code, next.stderr).toBe(0)
    await expect.poll(async () => JSON.stringify((await work.call('conversation.get', { conversation_id: conversationId })).messages))
      .toContain(turnReply.codex)
    expect(new Set((await work.mockCalls('codex')).map((call) => call.pid))).toEqual(new Set([providerPid]))
  })
}
