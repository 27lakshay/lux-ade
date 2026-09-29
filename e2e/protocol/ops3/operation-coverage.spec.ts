// Operations no other protocol E2E named (daemon authority ticket 08):
// agent.child_transcript, plugin.record.delete and service.proxy.target through
// the SDK and the CLI; agent.list and agent.account_inspect, which only the
// daemon sends on the runtime socket it owns, through the public operations
// that reach them. placement.release is in remote2/placement-release.spec.ts:
// it needs a paired remote host to record anything.
import { join } from 'node:path'
import { rpc } from '../../fixtures/daemon'
import { expect, send, startConversation, test, waitForIdle, type ScratchProfile } from '../fixtures'
import { writeEnvEchoPrograms } from '../fixtures/env-echo'
import { installAndEnable, stagePlugin } from '../fixtures/plugins'
import { waitForReadiness } from '../fixtures/services'

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  return promise.then(
    () => {
      throw new Error('The call was expected to be refused')
    },
    (failure: unknown) => failure as { code: string; message: string },
  )
}

/** The ID of the message that records the Conversation's child agents. */
async function subagentMessage(profile: ScratchProfile, conversationId: string): Promise<string> {
  let id: string | undefined
  await expect
    .poll(async () => {
      const { messages } = await profile.call('conversation.get', { conversation_id: conversationId })
      id = (messages as Array<{ id: string; content?: { type?: string; agents?: Array<{ id: string }> } | null }>).find(
        (message) =>
          message.content?.type === 'subagents' &&
          message.content.agents?.some((agent) => agent.id === 'fixture-child'),
      )?.id
      return id
    })
    .toBeTruthy()
  return id!
}

test('agent.child_transcript pages a child agent transcript through the SDK and the CLI', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'claude')
  await send(profile, conversationId, 'typed-subagents')
  const messageId = await subagentMessage(profile, conversationId)
  await waitForIdle(profile, conversationId)

  const page = await profile.call('agent.child_transcript', {
    conversation_id: conversationId,
    message_id: messageId,
    child_id: 'fixture-child',
  })
  expect(page).toMatchObject({ type: 'child_transcript', child_id: 'fixture-child' })
  expect(JSON.stringify(page.items)).toContain('Private child transcript')

  const cli = await profile.cli('conversation', 'child-transcript', conversationId, messageId, 'fixture-child')
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toMatchObject({ type: 'child_transcript', child_id: 'fixture-child' })

  // A child the record does not name is refused.
  const unknown = await refusal(
    profile.call('agent.child_transcript', {
      conversation_id: conversationId,
      message_id: messageId,
      child_id: 'another-child',
    }),
  )
  expect(unknown.message).toMatch(/Child is not in this record/)
})

test('plugin.record.delete removes a record once, only at the revision given, through the SDK and the CLI', async ({
  ade,
  profile,
}) => {
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'backend'))
  const put = (key: string) =>
    profile.call('plugin.record.put', { plugin_id: pluginId, namespace: 'notes', key, value: { key } })
  const record = (key: string) => ({ plugin_id: pluginId, namespace: 'notes', key })
  await put('a')
  await put('b')

  // A stale revision deletes nothing.
  await expect(profile.call('plugin.record.delete', { ...record('a'), expected_revision: 7 })).rejects.toMatchObject({
    code: 'conflict',
  })
  expect((await profile.call('plugin.record.get', record('a'))).record?.value).toEqual({ key: 'a' })
  expect(await profile.call('plugin.record.delete', { ...record('a'), expected_revision: 1 })).toMatchObject({
    type: 'plugin_record_deleted',
    deleted: true,
  })
  // Deleting it again succeeds and deletes nothing.
  expect(await profile.call('plugin.record.delete', record('a'))).toMatchObject({ deleted: false })
  expect((await profile.call('plugin.record.get', record('a'))).record).toBeNull()

  const cli = await profile.cli('plugin', 'record', 'delete', pluginId, 'notes', 'b')
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toMatchObject({ deleted: true, key: 'b' })
  expect((await profile.call('plugin.record.list', { plugin_id: pluginId, namespace: 'notes' })).records).toEqual([])
})

test('service.proxy.target names the running service a proxy connection may reach, and refuses a moved one', async ({
  profile,
  repo,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeEnvEchoPrograms(repo.path)
  const configured = await profile.call('service.configure', {
    workspace_id: workspace.id,
    name: 'web',
    revision: 0,
    config: { program: process.execPath, args: [files.server], ports: ['PORT'] },
  })
  await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
  await profile.call('service.proxy.ensure', { workspace_id: workspace.id, name: 'web', port_variable: 'PORT' })
  const port = configured.service.ports.PORT!
  const target = {
    workspace_id: workspace.id,
    name: 'web',
    port_variable: 'PORT',
    expected_port: port,
    service_identity: configured.service.identity,
    connected_host: '127.0.0.1',
  }

  const reply = await profile.call('service.proxy.target', target)
  expect(JSON.stringify(reply)).toContain(String(port))

  expect((await refusal(profile.call('service.proxy.target', { ...target, expected_port: port + 1 }))).message).toMatch(
    /target changed/,
  )
  expect(
    (await refusal(profile.call('service.proxy.target', { ...target, connected_host: '10.0.0.1' }))).message,
  ).toMatch(/Invalid connected proxy host/)
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
  expect((await refusal(profile.call('service.proxy.target', target))).message).toMatch(/unavailable/)
})

test('agent.list and agent.account_inspect reach the runtime only from its owning daemon', async ({ ade }) => {
  const profile = await ade.profile({ env: { ADE_CLAUDE_BIN: join(ade.root, 'ade-missing-claude-cli') } })
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, 'Hello')
  await waitForIdle(profile, conversationId)

  // runtime.status relays the runtime's agent.list, without the command logs.
  const status = await profile.call('runtime.status', {})
  const runs = status.agents as Array<{ spec: { conversation: string }; commands?: unknown }>
  const run = runs.find((item) => item.spec.conversation === conversationId)
  expect(run).toBeDefined()
  expect(run).not.toHaveProperty('commands')

  // account.inspect runs the provider probe through the runtime's agent.account_inspect.
  const { account } = await profile.call('account.create', { provider: 'claude', name: 'Probe' })
  expect((await profile.call('account.inspect', { account_id: account.id })).inspection).toMatchObject({
    state: 'missing_executable',
  })

  // Another client cannot send either one: only the owner's claimed connection carries them.
  for (const request of [
    { op: 'agent.list', token: '00000000-0000-0000-0000-000000000000' },
    { op: 'agent.account_inspect', token: '00000000-0000-0000-0000-000000000000', account: { provider: 'codex' } },
  ]) {
    const reply = await rpc(profile.runtimeSocket, request, 2_000).catch((error: unknown) => ({
      type: 'error',
      message: String(error),
    }))
    expect(reply, request.op).toMatchObject({ type: 'error' })
  }
})
