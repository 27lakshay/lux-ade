// F023: a provider installed as a plugin runs Conversations through the same
// registry as the bundled providers. The fixture worker is
// e2e/protocol/fixtures/plugins/provider/worker.mjs.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { conversationStatus, expect, send, test, waitForIdle, waitForMessage, type ScratchProfile } from '../fixtures'
import { installAndEnable, stagePlugin } from '../fixtures/plugins'

async function create(profile: ScratchProfile, provider: string) {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  return (await profile.call('conversation.create', { workspace_id: workspace.id, provider })).conversation.id
}

async function texts(profile: ScratchProfile, conversationId: string) {
  return (await profile.call('conversation.get', { conversation_id: conversationId })).messages.map(
    (message) => message.text,
  )
}

async function generations(profile: ScratchProfile, pluginId: string) {
  return (await profile.call('plugin.generation.list', { plugin_id: pluginId })).generations
    .map((generation) => `${generation.generation}:${generation.state}`)
    .sort()
}

/** A staged copy of the provider fixture whose worker answers `reply` instead of "Hello plugin". */
async function stageReplying(root: string, reply: string, manifest: Record<string, unknown> = {}) {
  const source = await stagePlugin(root, 'provider', manifest)
  const worker = join(source, 'worker.mjs')
  await writeFile(
    worker,
    (await readFile(worker, 'utf8')).replace("text: 'Hello plugin'", `text: ${JSON.stringify(reply)}`),
  )
  return source
}

test('F023: a provider plugin runs a turn, the catalogue shows its handshake capabilities, and its history stays readable after it is disabled', async ({
  ade,
  profile,
}) => {
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'provider'))
  const provider = `plugin:${pluginId}`
  // Capabilities come from the worker's own initialize handshake.
  expect((await profile.call('catalog.get', {})).providers.find((descriptor) => descriptor.id === provider)).toEqual({
    id: provider,
    name: 'E2E agent',
    capabilities: ['streaming', 'resume', 'cancel'],
    permission_modes: ['default'],
    setting_sources: [],
  })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  await expect(
    profile.call('conversation.create', { workspace_id: workspace.id, provider: 'plugin:not.installed' }),
  ).rejects.toThrow(/No enabled plugin registers provider/)

  const conversationId = await create(profile, provider)
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, 'Hello plugin')
  await waitForIdle(profile, conversationId)

  // Uninstall is refused while a run uses the provider, even once the plugin is disabled.
  await profile.call('plugin.disable', { plugin_id: pluginId })
  expect(await texts(profile, conversationId)).toEqual(['hello', 'Hello plugin'])
  expect((await profile.call('catalog.get', {})).providers.some((descriptor) => descriptor.id === provider)).toBe(false)
  await expect(
    profile.call('plugin.uninstall', { operation_id: 'uninstall-busy', plugin_id: pluginId }),
  ).rejects.toMatchObject({ code: 'conflict' })

  // With the run stopped, it uninstalls; the history is still readable, and the Conversation cannot run.
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  await profile.call('plugin.uninstall', { operation_id: 'uninstall-idle', plugin_id: pluginId })
  expect(await texts(profile, conversationId)).toEqual(['hello', 'Hello plugin'])
  // Ticket 28: the export reads the retained history and says nothing can continue it natively.
  const exported = await profile.call('conversation.export', { conversation_id: conversationId })
  expect(exported.messages.map((entry) => entry.message.text)).toEqual(['hello', 'Hello plugin'])
  expect(exported.continuity).toMatchObject({
    provider_available: false,
    native_resume_possible: false,
    reason: expect.stringContaining('is not installed in this profile'),
  })
  const file = join(ade.root, 'removed-provider.json')
  const cli = await profile.cli('conversation', 'export', conversationId, file)
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(await readFile(file, 'utf8')).continuity.provider_available).toBe(false)
  await profile.call('agent.resume', { conversation_id: conversationId })
  await expect
    .poll(
      async () =>
        (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.error ?? '',
    )
    .toMatch(/not enabled|not installed/)
  expect(await texts(profile, conversationId)).toEqual(['hello', 'Hello plugin'])
})

test('F023/04-S11: a Conversation stays on the plugin version it started on after a newer version is enabled', async ({
  ade,
  profile,
}) => {
  const { pluginId } = await installAndEnable(profile, await stageReplying(ade.root, 'Hello from v1'))
  const provider = `plugin:${pluginId}`
  const old = await create(profile, provider)
  await send(profile, old, 'first')
  await waitForMessage(profile, old, 'Hello from v1')
  await waitForIdle(profile, old)
  await profile.call('agent.disconnect', { conversation_id: old })

  await profile.call('plugin.disable', { plugin_id: pluginId })
  await profile.call('plugin.install', {
    operation_id: 'agent-v2',
    source: { kind: 'local', path: await stageReplying(ade.root, 'Hello from v2', { version: '2.0.0' }) },
  })
  await profile.call('plugin.enable', { plugin_id: pluginId })
  // The old generation is kept because the old Conversation leases it.
  await expect.poll(() => generations(profile, pluginId)).toContain('1:leased')

  // A new Conversation starts on version 2; the old one resumes on version 1, across a daemon crash.
  const fresh = await create(profile, provider)
  await send(profile, fresh, 'new')
  await waitForMessage(profile, fresh, 'Hello from v2')
  await waitForIdle(profile, fresh)
  await profile.restartDaemon('kill')
  await profile.call('agent.resume', { conversation_id: old })
  await waitForIdle(profile, old)
  await send(profile, old, 'second')
  await expect.poll(() => texts(profile, old)).toEqual(['first', 'Hello from v1', 'second', 'Hello from v1'])
  await waitForIdle(profile, old)
})

test('04-S11: a dev-mode reload keeps a leased provider Conversation on its old generation', async ({
  ade,
  profile,
}) => {
  const source = await stagePlugin(ade.root, 'provider')
  const { pluginId } = await installAndEnable(profile, source)
  await profile.call('plugin.dev.enter', { plugin_id: pluginId, debounce_ms: 100 })
  const before = (await profile.call('plugin.inspect', { plugin_id: pluginId })).plugin.activation_generation
  await create(profile, `plugin:${pluginId}`)
  await writeFile(join(source, 'worker.mjs'), `${await readFile(join(source, 'worker.mjs'), 'utf8')}\n// edited\n`)
  await expect
    .poll(() => generations(profile, pluginId), { timeout: 20_000 })
    .toEqual([`${before}:leased`, `${before + 1}:current`])
})

test('F023: a provider worker that crashes mid-turn ends the run without redispatching the turn', async ({
  ade,
  profile,
}) => {
  const source = await stagePlugin(ade.root, 'provider')
  const worker = join(source, 'worker.mjs')
  // The worker records each send beside itself, then dies before answering it.
  await writeFile(
    worker,
    (await readFile(worker, 'utf8')).replace(
      '  send: (params) => {',
      "  send: (params) => {\n    appendFileSync(new URL('./sends.log', import.meta.url), `${params.text}\\n`)\n    process.exit(9)",
    ),
  )
  const { pluginId } = await installAndEnable(profile, source)
  const artifact = (await profile.call('plugin.inspect', { plugin_id: pluginId })).plugin.artifact_path
  const conversationId = await create(profile, `plugin:${pluginId}`)
  await send(profile, conversationId, 'hello')
  await expect
    .poll(() => conversationStatus(profile, conversationId), { timeout: 20_000 })
    .not.toMatch(/^(starting|ready|running|waiting)$/)
  const sends = async () => (await readFile(join(artifact, 'sends.log'), 'utf8')).split('\n').filter(Boolean)
  expect(await sends()).toEqual(['hello'])
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).conversation.error).toBeTruthy()
  expect(await sends()).toEqual(['hello'])
})

test('ticket 31: a provider plugin gets the controls its worker declares, through the same daemon path as a bundled worker', async ({
  ade,
  profile,
}) => {
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'provider'))
  const conversationId = await create(profile, `plugin:${pluginId}`)
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, 'Hello plugin')
  await waitForIdle(profile, conversationId)

  const { controls } = await profile.call('conversation.controls', { conversation_id: conversationId })
  const control = (name: string) => controls.find((entry) => entry.control === name)
  // Declared available: offered, performed by the worker's own method.
  expect(control('compact')).toMatchObject({ available: true, mechanism: 'worker.compact', reason: null })
  // Declared unsupported: the worker's own reason, not a blanket plugin refusal.
  expect(control('steer')).toMatchObject({ available: false, reason: 'Fixture does not support steering' })
  // Not declared at all: said so.
  expect(control('rewind_conversation')?.reason).toContain('does not declare worker.rewind')

  const reply = await profile.call('conversation.compact', {
    operation_id: 'plugin-compact',
    conversation_id: conversationId,
  })
  expect(reply).toMatchObject({ outcome: 'acknowledged', control: 'compact' })
  await waitForMessage(profile, conversationId, 'Plugin compacted the context.')
  // A retry under the same operation ID replays the receipt instead of compacting again.
  expect(
    await profile.call('conversation.compact', { operation_id: 'plugin-compact', conversation_id: conversationId }),
  ).toEqual(reply)
  const records = (await profile.call('conversation.get', { conversation_id: conversationId })).messages.filter(
    (message) => message.kind === 'contextCompaction',
  )
  expect(records).toHaveLength(1)
})

type WorkerCall = {
  method: string
  params: Record<string, any>
  account: Record<string, any> | null
  home: string | null
  ambient_credential: string | null
}

/** What the fixture worker recorded receiving through the public contract (see its header). */
async function workerCalls(directory: string): Promise<WorkerCall[]> {
  return (await readFile(join(directory, 'calls.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WorkerCall)
}

const stdioServer = (command: string) => ({
  enabled: true,
  installation: { source: 'manual' },
  transport: {
    type: 'stdio',
    command,
    args: ['--root', '.'],
    env: { FIXTURE_TOKEN: { env: 'FIXTURE_TOKEN' }, LOG_FORMAT: { literal: 'json' } },
  },
  scope: { kind: 'profile' },
  providers: { kind: 'all' },
})

test('PC02: a provider plugin that declares configure_mcp receives the resolved MCP servers at launch and resume, like a bundled worker', async ({
  ade,
}) => {
  const record = join(ade.root, 'plugin-record')
  await mkdir(record, { recursive: true })
  const profile = await ade.profile({ env: { ADE_E2E_PLUGIN_RECORD: record } })
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'provider'))
  const provider = `plugin:${pluginId}`
  await profile.call('mcp.server.add' as never, { name: 'files', definition: stdioServer('files-mcp') } as never)
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })

  // The catalog previews what the plugin's worker receives: the provider-neutral projection, wired.
  const resolved = (await profile.call(
    'mcp.resolve' as never,
    { workspace_id: workspace.id, provider } as never,
  )) as Record<string, any>
  expect(resolved).toMatchObject({ wired: true, format: 'worker_mcp_json', delivery: 'direct' })
  const files = {
    type: 'stdio',
    command: 'files-mcp',
    args: ['--root', '.'],
    env: { FIXTURE_TOKEN: '${FIXTURE_TOKEN}', LOG_FORMAT: 'json' },
  }
  expect(resolved.document).toEqual({ mcpServers: { files } })
  const inspected = (await profile.call('mcp.server.inspect' as never, { name: 'files' } as never)) as Record<
    string,
    any
  >
  expect(inspected.providers.find((entry: { provider: string }) => entry.provider === provider)).toMatchObject({
    wired: true,
    native: files,
    unsupported_reason: null,
  })

  const conversationId = await create(profile, provider)
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, 'Hello plugin')
  await waitForIdle(profile, conversationId)
  // Delivered through configure_mcp before the session opened, exactly as resolved.
  const launch = await workerCalls(record)
  expect(launch.map((call) => call.method)).toEqual(['configure_mcp', 'open'])
  expect(launch[0]!.params).toEqual({ servers: { files } })

  // A resume receives the catalog as it is now.
  const { server } = (await profile.call('mcp.server.inspect' as never, { name: 'files' } as never)) as Record<
    string,
    any
  >
  await profile.call(
    'mcp.server.update' as never,
    { name: 'files', expected_revision: server.revision, definition: stdioServer('files-mcp-2') } as never,
  )
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
  const resumed = (await workerCalls(record)).slice(launch.length)
  expect(resumed.map((call) => call.method)).toEqual(['configure_mcp', 'open'])
  expect(resumed[0]!.params.servers.files.command).toBe('files-mcp-2')
  expect(resumed[1]!.params.resume).toBeTruthy()
  // Without a managed account the worker runs on the agent's own login: no account context.
  expect(resumed.every((call) => call.account === null)).toBe(true)
})

test('PC02: a conversation on a managed account passes a provider plugin the same account context as a bundled worker, and a changed login is refused', async ({
  ade,
}) => {
  const profile = await ade.profile({ env: { E2E_AMBIENT_TOKEN: 'ambient-credential-must-not-reach-the-worker' } })
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'provider'))
  const provider = `plugin:${pluginId}`
  // The worker declares account_inspect, so the provider supports managed accounts.
  const { providers } = await profile.call('provider.capabilities', { provider })
  expect(providers[0]!.managed_accounts.support).toBe('supported')

  const account = (await profile.call('account.create', { provider, name: 'Plugin account' })).account
  // Inspection runs the plugin's own worker in the account's launch environment.
  expect((await profile.call('account.inspect', { account_id: account.id })).inspection).toMatchObject({
    state: 'unauthenticated',
    reason: 'Not signed in to the E2E agent',
  })
  const identity = { email: 'plugin@example.invalid', org: 'org-plugin' }
  await writeFile(join(account.native_home, 'identity.json'), JSON.stringify(identity))
  const inspected = await profile.call('account.inspect', { account_id: account.id })
  expect(inspected.inspection).toMatchObject({ state: 'ready', version: '1.0.0', identity })
  const verified = (
    await profile.call('account.verify', {
      account_id: account.id,
      expected_generation: inspected.generation,
      expected_identity: inspected.inspection.identity,
    })
  ).account
  expect(verified).toMatchObject({ state: 'verified', worker_identity: identity })

  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const conversationId = (
    await profile.call('conversation.create', { workspace_id: workspace.id, provider, account_id: account.id })
  ).conversation.id
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, 'Hello plugin')
  await waitForIdle(profile, conversationId)
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).conversation).toMatchObject({
    account_id: account.id,
    execution: { account_context: 'managed', account_id: account.id, account_generation: verified.generation },
  })

  // The worker received the public account context, in a cleared environment homed in the account.
  const calls = await workerCalls(account.native_home)
  const opened = calls.filter((call) => call.method === 'open')
  expect(opened).toHaveLength(1)
  expect(opened[0]!.account).toEqual({
    account_id: account.id,
    provider,
    generation: verified.generation,
    native_home: account.native_home,
    identity,
  })
  expect(opened[0]!.home).toBe(account.native_home)
  expect(calls.every((call) => call.ambient_credential === null)).toBe(true)
  // The pinned identity is checked against the worker's own report before the session opens.
  expect(calls[calls.findIndex((call) => call.method === 'open') - 1]!.method).toBe('account_inspect')

  // A login changed underneath ADE is refused at the next launch, before anything opens.
  await writeFile(
    join(account.native_home, 'identity.json'),
    JSON.stringify({ ...identity, email: 'other@example.invalid' }),
  )
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  const before = (await workerCalls(account.native_home)).filter((call) => call.method === 'open').length
  await profile.call('agent.resume', { conversation_id: conversationId })
  await expect
    .poll(
      async () =>
        (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.error ?? '',
    )
    .toContain('identity changed')
  expect((await workerCalls(account.native_home)).filter((call) => call.method === 'open')).toHaveLength(before)
})

test('story 64: a provider plugin with managed accounts can switch a conversation to another account and delegate a child onto one', async ({
  ade,
}) => {
  const profile = await ade.profile()
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'provider'))
  const provider = `plugin:${pluginId}`
  const verifiedAs = async (name: string, email: string) => {
    const created = (await profile.call('account.create', { provider, name })).account
    const identity = { email, org: 'org-' + name.toLowerCase() }
    await writeFile(join(created.native_home, 'identity.json'), JSON.stringify(identity))
    const inspected = await profile.call('account.inspect', { account_id: created.id })
    return (
      await profile.call('account.verify', {
        account_id: created.id,
        expected_generation: inspected.generation,
        expected_identity: inspected.inspection.identity,
      })
    ).account
  }
  const work = await verifiedAs('Work', 'work@example.invalid')
  const personal = await verifiedAs('Personal', 'me@example.invalid')
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const conversationId = (
    await profile.call('conversation.create', { workspace_id: workspace.id, provider, account_id: work.id })
  ).conversation.id
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, 'Hello plugin')
  await waitForIdle(profile, conversationId)

  // Switching follows the same preview and effect command as a bundled provider.
  const preview = await profile.call('account.switch.preview', {
    conversation_id: conversationId,
    account_id: personal.id,
  })
  expect(preview).toMatchObject({ refusal: null, continuity: 'new_native_session' })
  await profile.call('account.switch', {
    operation_id: 'plugin-switch',
    conversation_id: conversationId,
    account_id: personal.id,
    expected_account_id: work.id,
    expected_generation: personal.generation,
    continuity: 'new_native_session',
  })
  await send(profile, conversationId, 'hello again')
  await waitForIdle(profile, conversationId)
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).conversation).toMatchObject({
    account_id: personal.id,
    execution: { account_context: 'managed', account_id: personal.id },
  })
  expect((await workerCalls(personal.native_home)).some((call) => call.method === 'open')).toBe(true)

  // A delegated child may run on a managed account of the plugin, as on a bundled provider's.
  const { child } = await profile.call('orchestration.delegate', {
    operation_id: 'plugin-delegate',
    parent_conversation_id: conversationId,
    caller: { kind: 'user' },
    provider,
    account: { mode: 'managed', account_id: work.id },
    workspace: { mode: 'same' },
    task: 'hello',
  })
  await waitForMessage(profile, child.child_conversation_id, 'Hello plugin')
  expect(
    (await profile.call('conversation.get', { conversation_id: child.child_conversation_id })).conversation,
  ).toMatchObject({ account_id: work.id, execution: { account_context: 'managed', account_id: work.id } })
})
