// Ticket 21, installed and live tiers: the packaged OpenCode plugin drives a real
// OpenCode v2 executable through the real daemon and runtime. Both cases are opt-in and
// skipped without their variables, so ordinary suites never start OpenCode or use an account.
//
// Installed: ADE_OPENCODE_LOOPBACK_BIN=<opencode>. OpenCode runs with scratch config, data and
// credentials; its only model is a local deterministic endpoint in this process.
// Live: ADE_RUN_LIVE_PROVIDERS=1 ADE_OPENCODE_LIVE_BIN=<opencode> ADE_OPENCODE_LIVE_MODEL=<provider/model>.
// OpenCode uses the machine's own configuration and sign-in for exactly one minimal prompt; the
// test fails if the stored credentials file changes.
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, send, test, waitForIdle, waitForMessage, type ScratchProfile } from '../fixtures'
import { openCodePluginArtifact } from '../fixtures/plugins'

async function install(profile: ScratchProfile, root: string) {
  const installed = await profile.call('plugin.install', {
    operation_id: 'install-opencode',
    source: { kind: 'local', path: await openCodePluginArtifact(root) },
  })
  await profile.call('plugin.enable', { plugin_id: installed.plugin.id })
  const provider = `plugin:${installed.plugin.id}`
  const inspected = await profile.call('provider.inspect', { provider })
  return { provider, plugin: installed.plugin, inspected }
}

async function conversationOn(profile: ScratchProfile, provider: string, model: string) {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: workspace.id,
    provider,
    provider_config: { model, permission_mode: 'default', setting_sources: [] },
  })
  return conversation.id
}

/** A deterministic Anthropic Messages endpoint: it streams one text answer per call and calls no tool. */
async function loopbackModel(): Promise<{ server: Server; port: number; calls: Array<Record<string, unknown>> }> {
  const calls: Array<Record<string, unknown>> = []
  const isTitle = (payload: Record<string, unknown>) =>
    JSON.stringify(payload.system ?? '').includes('You are a title generator.')
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/v1/messages') {
      response.writeHead(404).end()
      return
    }
    const payload = JSON.parse(body) as Record<string, unknown>
    calls.push(payload)
    const answers = calls.filter((call) => !isTitle(call)).length
    const text = isTitle(payload) ? 'Loopback title' : `Loopback answer ${answers}`
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = (value: Record<string, unknown>) =>
      response.write(`event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`)
    event({
      type: 'message_start',
      message: {
        id: `msg_loopback_${calls.length}`,
        type: 'message',
        role: 'assistant',
        model: 'ade-loopback',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    })
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 9) } })
    event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(9) } })
    event({ type: 'content_block_stop', index: 0 })
    event({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    })
    event({ type: 'message_stop' })
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port, calls }
}

const evidence = (inspected: Awaited<ReturnType<typeof install>>['inspected'], digest: string, extra: object) =>
  JSON.stringify(
    {
      provider: inspected.provider,
      native: inspected.descriptor?.name,
      artifact_digest: digest,
      capabilities: inspected.descriptor?.capabilities.map(({ name, support, available }) => ({
        name,
        support,
        available,
      })),
      operations: inspected.descriptor?.operations.map(({ method, availability, reason }) => ({
        method,
        availability,
        reason,
      })),
      ...extra,
    },
    null,
    2,
  )

test('installed OpenCode streams two turns, pages its native history and resumes without resubmitting', async ({
  ade,
}, testInfo) => {
  const binary = process.env.ADE_OPENCODE_LOOPBACK_BIN
  test.skip(!binary, 'Set ADE_OPENCODE_LOOPBACK_BIN to an installed OpenCode v2 executable')
  const model = await loopbackModel()
  try {
    const scratch = join(ade.root, 'opencode-home')
    const config = {
      providers: {
        'ade-loopback': {
          package: 'aisdk:@ai-sdk/anthropic',
          settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: 'ade-local-placeholder' },
          models: { 'ade-loopback': { name: 'ADE loopback', limit: { context: 32000, output: 1024 } } },
        },
      },
    }
    const profile = await ade.profile({
      env: {
        ADE_OPENCODE_BIN: binary!,
        XDG_CONFIG_HOME: join(scratch, 'config'),
        XDG_DATA_HOME: join(scratch, 'data'),
        XDG_CACHE_HOME: join(scratch, 'cache'),
        XDG_STATE_HOME: join(scratch, 'state'),
        OPENCODE_CONFIG_DIR: join(scratch, 'config/opencode'),
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
    })
    const { provider, plugin, inspected } = await install(profile, ade.root)
    expect(inspected.state).toBe('installed_unchecked')
    expect(inspected.descriptor?.name).toMatch(/^OpenCode 2\./)
    const conversationId = await conversationOn(profile, provider, 'ade-loopback/ade-loopback')
    for (const turn of [1, 2]) {
      await send(profile, conversationId, `Local prompt ${turn}`, `installed-${turn}`)
      await waitForMessage(profile, conversationId, `Loopback answer ${turn}`, 60_000)
      await waitForIdle(profile, conversationId, 60_000)
    }
    const answers = () => model.calls.filter((call) => !JSON.stringify(call.system ?? '').includes('title generator'))
    expect(answers()).toHaveLength(2)
    // The second model call carried the first turn: one native session.
    expect(JSON.stringify(answers()[1]!.messages)).toContain('Loopback answer 1')
    const before = (await profile.call('conversation.get', { conversation_id: conversationId })).messages
    expect(before.filter((message) => message.role === 'assistant').map((message) => message.text)).toEqual([
      'Loopback answer 1',
      'Loopback answer 2',
    ])
    expect(before.filter((message) => message.role === 'user').map((message) => message.text)).toEqual([
      'Local prompt 1',
      'Local prompt 2',
    ])

    const first = await profile.call('conversation.history', { conversation_id: conversationId, max_items: 2 })
    expect(first.error).toBeNull()
    const rest = await profile.call('conversation.history', {
      conversation_id: conversationId,
      snapshot: first.snapshot,
      native_cursor: first.next_native_cursor,
      history_epoch: first.history_epoch,
      max_items: 32,
    })
    expect(rest.error).toBeNull()
    expect([...first.messages, ...rest.messages].map((message) => message.text)).toEqual(
      expect.arrayContaining(['Local prompt 1', 'Loopback answer 1', 'Local prompt 2', 'Loopback answer 2']),
    )

    // A new worker reopens the same native session and sends nothing.
    await profile.call('agent.disconnect', { conversation_id: conversationId })
    await profile.call('agent.resume', { operation_id: 'installed-resume', conversation_id: conversationId })
    await waitForIdle(profile, conversationId, 60_000)
    expect(answers()).toHaveLength(2)
    const after = await profile.call('conversation.get', { conversation_id: conversationId })
    expect(after.messages.map((message) => message.id)).toEqual(before.map((message) => message.id))
    await testInfo.attach('opencode-installed-evidence.json', {
      contentType: 'application/json',
      body: evidence(inspected, plugin.artifact_digest, {
        tier: 'installed',
        executable: binary,
        account_context: 'none: scratch OpenCode data with a placeholder key for a local model endpoint',
        model_calls: model.calls.length,
      }),
    })
  } finally {
    await new Promise((resolve) => model.server.close(resolve))
  }
})

test('live OpenCode answers one minimal prompt with the machine sign-in and leaves stored credentials unchanged', async ({
  ade,
}, testInfo) => {
  const binary = process.env.ADE_OPENCODE_LIVE_BIN
  const modelId = process.env.ADE_OPENCODE_LIVE_MODEL
  test.skip(
    process.env.ADE_RUN_LIVE_PROVIDERS !== '1' || !binary || !modelId,
    'Live OpenCode needs ADE_RUN_LIVE_PROVIDERS=1, ADE_OPENCODE_LIVE_BIN and ADE_OPENCODE_LIVE_MODEL; it uses the real account',
  )
  const home = homedir()
  const credentials = join(home, '.local/share/opencode/auth.json')
  const fingerprint = async () => ({
    sha256: createHash('sha256')
      .update(await readFile(credentials))
      .digest('hex'),
    modified: (await stat(credentials)).mtimeMs,
  })
  const before = await fingerprint()
  // The machine's own OpenCode configuration and sign-in; ADE's own state stays in the scratch profile.
  const profile = await ade.profile({
    env: {
      ADE_OPENCODE_BIN: binary!,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_STATE_HOME: join(home, '.local/state'),
    },
  })
  const { provider, plugin, inspected } = await install(profile, ade.root)
  expect(inspected.descriptor?.name).toMatch(/^OpenCode 2\./)
  const conversationId = await conversationOn(profile, provider, modelId!)
  await send(profile, conversationId, 'Reply with the single word ok', 'live-1')
  await expect
    .poll(
      async () =>
        (await profile.call('conversation.get', { conversation_id: conversationId })).messages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.text)
          .join(' '),
      { timeout: 120_000 },
    )
    .toMatch(/\bok\b/i)
  await waitForIdle(profile, conversationId, 120_000)
  const conversation = await profile.call('conversation.get', { conversation_id: conversationId })
  const prompt = conversation.messages.find((message) => message.delivery?.request_id === 'live-1')
  expect(prompt?.delivery?.native_outcome).toBe('accepted')
  // One reply item: the streamed text and its stored message merge.
  expect(conversation.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  expect(await fingerprint()).toEqual(before)
  await testInfo.attach('opencode-live-evidence.json', {
    contentType: 'application/json',
    body: evidence(inspected, plugin.artifact_digest, {
      tier: 'live',
      executable: binary,
      model: modelId,
      account_context: 'ambient OpenCode sign-in of this machine (not managed by ADE)',
      workspace: profile.defaultWorkspaceRoot,
      native_session: conversation.conversation.provider_thread_id,
      credentials_unchanged: true,
      answer: conversation.messages.filter((message) => message.role === 'assistant').map((message) => message.text),
    }),
  })
})
