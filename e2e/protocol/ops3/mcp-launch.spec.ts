// F131: a server registered once in the profile MCP catalog reaches the
// providers through their adapters. Codex receives each resolved server as a
// `mcp_servers.<name>` config override on thread/start and thread/resume; Claude
// receives it as the Agent SDK's `mcpServers` option. Delivery is `direct`:
// ADE runs no gateway, so each provider negotiates protocol version,
// capabilities and authorization with the server itself, and the resolution
// says so explicitly.
import { expect, prompts, send, startConversation, test, waitForIdle, type ScratchProfile } from '../fixtures'

type Definition = Record<string, unknown>

function stdio(options: { scope?: unknown; providers?: unknown; enabled?: boolean; args?: string[] } = {}): Definition {
  return {
    enabled: options.enabled ?? true,
    installation: { source: 'manual' },
    transport: { type: 'stdio', command: 'files-mcp', args: options.args ?? ['--root', '.'],
      env: { FIXTURE_TOKEN: { env: 'FIXTURE_TOKEN' }, LOG_LEVEL: { literal: 'info' } } },
    scope: options.scope ?? { kind: 'profile' },
    providers: options.providers ?? { kind: 'all' },
  }
}

async function call(profile: ScratchProfile, op: string, request: Record<string, unknown>): Promise<any> {
  return profile.call(op as never, request as never)
}

/** The params of every native call `method` the Codex mock received. */
async function codexCalls(profile: ScratchProfile, method: string): Promise<Array<Record<string, any>>> {
  return (await profile.mockCalls('codex')).filter((entry) => entry.method === method)
    .map((entry) => entry.params as Record<string, any>)
}

async function claudeQueries(profile: ScratchProfile): Promise<Array<Record<string, any>>> {
  return (await profile.mockCalls('claude')).filter((entry) => entry.method === 'query')
}

async function turn(profile: ScratchProfile, conversationId: string): Promise<void> {
  await send(profile, conversationId, prompts.turn)
  await waitForIdle(profile, conversationId)
}

test('F131: a Codex launch receives the resolved servers, and a resume receives the current catalog', async ({ ade, profile }) => {
  const alphaRepo = await ade.repo({ name: 'alpha' })
  const betaRepo = await ade.repo({ name: 'beta' })
  const alpha = (await profile.call('workspace.open', { path: alphaRepo.path })).workspace
  const beta = (await profile.call('workspace.open', { path: betaRepo.path })).workspace
  await call(profile, 'mcp.server.add', { name: 'files', definition: stdio() })
  await call(profile, 'mcp.server.add', { name: 'beta-only', definition: stdio({ scope: { kind: 'workspaces', workspace_ids: [beta.id] } }) })
  await call(profile, 'mcp.server.add', { name: 'claude-only', definition: stdio({ providers: { kind: 'only', provider_ids: ['claude'] } }) })
  await call(profile, 'mcp.server.add', { name: 'switched-off', definition: stdio({ enabled: false }) })
  await call(profile, 'mcp.server.add', { name: 'legacy-sse', definition: { enabled: true, installation: { source: 'remote' },
    transport: { type: 'sse', url: 'https://mcp.example.invalid/sse', headers: {} }, scope: { kind: 'profile' },
    providers: { kind: 'all' } } })

  const resolved = await call(profile, 'mcp.resolve', { workspace_id: alpha.id, provider: 'codex' })
  // The fallback is explicit: the provider connects to each server itself.
  expect(resolved).toMatchObject({ delivery: 'direct', wired: true, format: 'codex_config_toml' })
  expect(Object.keys(resolved.document.mcp_servers)).toEqual(['files'])
  expect(Object.fromEntries(resolved.excluded.map((entry: any) => [entry.name, entry.reason]))).toEqual({
    'beta-only': 'outside_scope', 'claude-only': 'provider_not_selected', 'switched-off': 'disabled',
    'legacy-sse': 'unsupported' })

  const { conversationId } = await startConversation(profile, 'codex', alphaRepo.path)
  await turn(profile, conversationId)
  const [started] = await codexCalls(profile, 'thread/start')
  // Exactly the resolution, one `mcp_servers.<name>` key per server so the
  // user's own config.toml servers stay, with the secret passed by name only.
  expect(started.config).toEqual(Object.fromEntries(Object.entries(resolved.document.mcp_servers)
    .map(([name, server]) => [`mcp_servers.${name}`, server])))
  expect(started.config['mcp_servers.files']).toMatchObject({ command: 'files-mcp', env: { LOG_LEVEL: 'info' },
    env_vars: ['FIXTURE_TOKEN'] })

  // Another workspace launches with its own resolution.
  const other = await startConversation(profile, 'codex', betaRepo.path)
  await turn(profile, other.conversationId)
  const betaStart = (await codexCalls(profile, 'thread/start'))[1]
  expect(Object.keys(betaStart.config).sort()).toEqual(['mcp_servers.beta-only', 'mcp_servers.files'])

  // The catalog changes while the Agent runs; a resume after a daemon crash
  // launches with the current catalog, not the one the first launch saw.
  const files = (await call(profile, 'mcp.server.inspect', { name: 'files' })).server
  await call(profile, 'mcp.server.update', { name: 'files', expected_revision: files.revision,
    definition: stdio({ args: ['--root', '/srv'] }) })
  await profile.restartDaemon('kill')
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
  await turn(profile, conversationId)
  const resumed = await codexCalls(profile, 'thread/resume')
  expect(resumed.length).toBeGreaterThan(0)
  expect(resumed.at(-1)!.config['mcp_servers.files'].args).toEqual(['--root', '/srv'])
})

test('F131: a Claude launch receives the resolved servers as the SDK mcpServers option', async ({ profile }) => {
  await call(profile, 'mcp.server.add', { name: 'files', definition: stdio() })
  await call(profile, 'mcp.server.add', { name: 'docs', definition: { enabled: true, installation: { source: 'remote' },
    transport: { type: 'streamable_http', url: 'https://mcp.example.invalid/docs',
      headers: { Authorization: { env: 'FIXTURE_REMOTE_AUTH' } } }, scope: { kind: 'profile' }, providers: { kind: 'all' } } })
  const { workspaceId, conversationId } = await startConversation(profile, 'claude')
  const resolved = await call(profile, 'mcp.resolve', { workspace_id: workspaceId, provider: 'claude' })
  expect(resolved).toMatchObject({ delivery: 'direct', wired: true, format: 'claude_mcp_json' })
  await turn(profile, conversationId)
  const [query] = await claudeQueries(profile)
  expect(query.mcpServers).toEqual(resolved.document.mcpServers)
  // Claude reads references as ${VAR}; the credential itself never leaves the provider's environment.
  expect(query.mcpServers.files.env.FIXTURE_TOKEN).toBe('${FIXTURE_TOKEN}')
  expect(query.mcpServers.docs).toMatchObject({ type: 'http', url: 'https://mcp.example.invalid/docs',
    headers: { Authorization: '${FIXTURE_REMOTE_AUTH}' } })
})

test('F131: a launch with no applicable server passes nothing, and an unwired provider says so', async ({ ade, profile }) => {
  const repo = await ade.repo({ name: 'plain' })
  const workspace = (await profile.call('workspace.open', { path: repo.path })).workspace
  // Only a disabled entry and one for another workspace exist.
  await call(profile, 'mcp.server.add', { name: 'switched-off', definition: stdio({ enabled: false }) })
  const codex = await startConversation(profile, 'codex', repo.path)
  await turn(profile, codex.conversationId)
  const [started] = await codexCalls(profile, 'thread/start')
  expect(started).not.toHaveProperty('config')
  const claude = await startConversation(profile, 'claude', repo.path)
  await turn(profile, claude.conversationId)
  expect(await claudeQueries(profile)).toEqual([])
  // Oh My Pi has a projection, but ADE does not write its user-owned mcp.json,
  // so its resolution reports that the adapter does not deliver it.
  await call(profile, 'mcp.server.add', { name: 'files', definition: stdio() })
  expect(await call(profile, 'mcp.resolve', { workspace_id: workspace.id, provider: 'omp' }))
    .toMatchObject({ delivery: 'direct', wired: false })
  const inspected = await profile.cli('mcp', 'inspect', 'files')
  expect(inspected.code, inspected.stderr).toBe(0)
  const wired = Object.fromEntries((inspected.json?.providers as Array<any>).map((entry) => [entry.provider, entry.wired]))
  expect(wired).toEqual({ claude: true, codex: true, omp: false })
})
