// F131 for Oh My Pi: a server registered once in the profile MCP catalog
// reaches Oh My Pi through its adapter. Oh My Pi reads MCP servers only from
// files: its native `mcp.json` (user-owned), other tools' configs, and the
// sibling `.mcp.json` of an extension package named with `--extension`
// (docs/extension-loading.md, docs/mcp-config.md "OMP extension packages").
// ADE writes the resolved catalog as the `.mcp.json` of its own package
// directory and names it with `--extension` at every launch and resume, so the
// user's files are never written. Delivery is `direct`: Oh My Pi negotiates
// protocol version, capabilities and authorization with each server itself.
//
// The Oh My Pi CLI here is the fixture `providers/omp/mock-cli.mjs`, driven by
// the real bridge. It records its arguments and each named package's
// `.mcp.json` in calls.jsonl, as written; it never calls a model.
import { access, mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, send, test, waitForIdle, waitForMessage, type ScratchProfile } from '../fixtures'
import { repositoryRoot } from '../fixtures/environment'

type Definition = Record<string, unknown>
type Launch = { pid: number; method: 'launch'; args: string[]; cwd: string;
  extensions: Array<{ path: string; mcp: Record<string, any> | null }> }

function stdio(options: { scope?: unknown; providers?: unknown; enabled?: boolean; command?: string; args?: string[];
  env?: Record<string, unknown> } = {}): Definition {
  return {
    enabled: options.enabled ?? true,
    installation: { source: 'manual' },
    transport: { type: 'stdio', command: options.command ?? 'files-mcp', args: options.args ?? ['--root', '.'],
      env: options.env ?? { FIXTURE_TOKEN: { env: 'FIXTURE_TOKEN' }, LOG_FORMAT: { literal: 'json,compact' } } },
    scope: options.scope ?? { kind: 'profile' },
    providers: options.providers ?? { kind: 'all' },
  }
}

async function call(profile: ScratchProfile, op: string, request: Record<string, unknown>): Promise<any> {
  return profile.call(op as never, request as never)
}

/** A profile whose Oh My Pi CLI is the recording fixture. */
async function ompProfile(ade: { root: string; profile: (options: { env: Record<string, string> }) => Promise<ScratchProfile> }):
  Promise<{ profile: ScratchProfile; launches: () => Promise<Launch[]> }> {
  const calls = join(ade.root, 'omp-mock')
  await mkdir(calls, { recursive: true })
  const profile = await ade.profile({ env: {
    ADE_OMP_BIN: join(repositoryRoot, 'providers/omp/mock-cli.mjs'),
    ADE_MOCK_OMP_DIR: calls,
  } })
  const launches = async () => (await readFile(join(calls, 'calls.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Launch)
  return { profile, launches }
}

async function turn(profile: ScratchProfile, conversationId: string): Promise<void> {
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, 'Hello Oh My Pi')
  await waitForIdle(profile, conversationId)
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

/** The package directories named with `--extension`, in order. */
function extensionArgs(launch: Launch): string[] {
  return launch.args.flatMap((arg, index) => arg === '--extension' ? [launch.args[index + 1]] : [])
}

test('F131: an Oh My Pi launch receives the resolved servers as an extension package, and a resume receives the current catalog', async ({ ade }) => {
  const { profile, launches } = await ompProfile(ade)
  const alphaRepo = await ade.repo({ name: 'alpha' })
  const betaRepo = await ade.repo({ name: 'beta' })
  const alpha = (await profile.call('workspace.open', { path: alphaRepo.path })).workspace
  const beta = (await profile.call('workspace.open', { path: betaRepo.path })).workspace
  await call(profile, 'mcp.server.add', { name: 'files', definition: stdio() })
  await call(profile, 'mcp.server.add', { name: 'local', definition: stdio({ command: './tools/local-mcp', args: [] }) })
  await call(profile, 'mcp.server.add', { name: 'docs', definition: { enabled: true, installation: { source: 'remote' },
    transport: { type: 'streamable_http', url: 'https://mcp.example.invalid/docs',
      headers: { Authorization: { env: 'FIXTURE_REMOTE_AUTH' } } }, scope: { kind: 'profile' }, providers: { kind: 'all' } } })
  await call(profile, 'mcp.server.add', { name: 'beta-only', definition: stdio({ scope: { kind: 'workspaces', workspace_ids: [beta.id] } }) })
  await call(profile, 'mcp.server.add', { name: 'codex-only', definition: stdio({ providers: { kind: 'only', provider_ids: ['codex'] } }) })
  await call(profile, 'mcp.server.add', { name: 'switched-off', definition: stdio({ enabled: false }) })
  // Oh My Pi would read a literal shaped like a variable name as that variable.
  await call(profile, 'mcp.server.add', { name: 'ambiguous', definition: stdio({ env: { LOG_LEVEL: { literal: 'info' } } }) })

  const resolved = await call(profile, 'mcp.resolve', { workspace_id: alpha.id, provider: 'omp' })
  expect(resolved).toMatchObject({ delivery: 'direct', wired: true, format: 'omp_mcp_json' })
  expect(Object.keys(resolved.document.mcpServers)).toEqual(['docs', 'files', 'local'])
  expect(Object.fromEntries(resolved.excluded.map((entry: any) => [entry.name, entry.reason]))).toEqual({
    ambiguous: 'unsupported', 'beta-only': 'outside_scope', 'codex-only': 'provider_not_selected',
    'switched-off': 'disabled' })

  const { conversation } = await profile.call('conversation.create', { workspace_id: alpha.id, provider: 'omp' })
  await turn(profile, conversation.id)
  const [launched] = await launches()
  const [pkg] = extensionArgs(launched)
  expect(launched.extensions).toHaveLength(1)
  // Exactly the resolution, except that a path-like command is rooted at the
  // workspace, where a native mcp.json would run it.
  expect(launched.extensions[0]).toEqual({ path: pkg, mcp: { mcpServers: {
    ...resolved.document.mcpServers,
    local: { ...resolved.document.mcpServers.local, command: join(launched.cwd, 'tools/local-mcp') },
  } } })
  // Credentials travel as references Oh My Pi expands from its own environment.
  expect(launched.extensions[0].mcp!.mcpServers.files).toMatchObject({ type: 'stdio', command: 'files-mcp',
    env: { FIXTURE_TOKEN: '${FIXTURE_TOKEN}', LOG_FORMAT: 'json,compact' } })
  expect(launched.extensions[0].mcp!.mcpServers.docs).toEqual({ type: 'http', url: 'https://mcp.example.invalid/docs',
    headers: { Authorization: '${FIXTURE_REMOTE_AUTH}' } })
  // The package is ADE's, under its data directory; the user's own Oh My Pi
  // configuration and the repository are left alone.
  expect(pkg.startsWith(join(await realpath(profile.dataDirectory), 'omp', 'mcp') + '/')).toBe(true)
  expect(await exists(join(alphaRepo.path, '.omp'))).toBe(false)
  // (Oh My Pi's session library keeps its own session markers under ~/.omp/agent.)
  for (const name of ['mcp.json', '.mcp.json']) expect(await exists(join(profile.home, '.omp/agent', name))).toBe(false)
  expect(await alphaRepo.status()).toEqual([])

  // Another workspace launches with its own resolution, in its own package.
  const other = (await profile.call('conversation.create', { workspace_id: beta.id, provider: 'omp' })).conversation
  await turn(profile, other.id)
  const betaLaunch = (await launches())[1]
  expect(extensionArgs(betaLaunch)).toHaveLength(1)
  expect(extensionArgs(betaLaunch)[0]).not.toBe(pkg)
  expect(Object.keys(betaLaunch.extensions[0].mcp!.mcpServers).sort()).toEqual(['beta-only', 'docs', 'files', 'local'])

  // The catalog changes while the Agent runs; a resume after a daemon crash
  // launches with the current catalog, not the one the first launch saw.
  const files = (await call(profile, 'mcp.server.inspect', { name: 'files' })).server
  await call(profile, 'mcp.server.update', { name: 'files', expected_revision: files.revision,
    definition: stdio({ args: ['--root', '/srv'] }) })
  const before = (await launches()).length
  await profile.restartDaemon('kill')
  await profile.call('agent.disconnect', { conversation_id: conversation.id })
  await profile.call('agent.resume', { conversation_id: conversation.id })
  await waitForIdle(profile, conversation.id)
  await expect.poll(async () => (await launches()).length).toBeGreaterThan(before)
  const resumed = (await launches()).at(-1)!
  // The same native session, the same package, the current catalog.
  expect(resumed.args[resumed.args.indexOf('--session') + 1]).toBe(launched.args[launched.args.indexOf('--session') + 1])
  expect(extensionArgs(resumed)).toEqual([pkg])
  expect(resumed.extensions[0].mcp!.mcpServers.files.args).toEqual(['--root', '/srv'])
  await turn(profile, conversation.id)
})

test('F131: an Oh My Pi launch with no applicable server names no package, and a resume after the catalog empties removes it', async ({ ade }) => {
  const { profile, launches } = await ompProfile(ade)
  const repo = await ade.repo({ name: 'plain' })
  const workspace = (await profile.call('workspace.open', { path: repo.path })).workspace
  // Only a disabled entry exists.
  await call(profile, 'mcp.server.add', { name: 'switched-off', definition: stdio({ enabled: false }) })
  const first = (await profile.call('conversation.create', { workspace_id: workspace.id, provider: 'omp' })).conversation
  await turn(profile, first.id)
  const [plain] = await launches()
  expect(plain.args).not.toContain('--extension')

  // A server applies to the next Conversation; then the catalog empties again
  // and its resume names no package, and the stale file is gone.
  await call(profile, 'mcp.server.add', { name: 'files', definition: stdio() })
  const second = (await profile.call('conversation.create', { workspace_id: workspace.id, provider: 'omp' })).conversation
  await turn(profile, second.id)
  const withServer = (await launches())[1]
  const [pkg] = extensionArgs(withServer)
  expect(Object.keys(withServer.extensions[0].mcp!.mcpServers)).toEqual(['files'])
  const files = (await call(profile, 'mcp.server.inspect', { name: 'files' })).server
  await call(profile, 'mcp.server.update', { name: 'files', expected_revision: files.revision,
    definition: stdio({ enabled: false }) })
  await profile.call('agent.disconnect', { conversation_id: second.id })
  await profile.call('agent.resume', { conversation_id: second.id })
  await waitForIdle(profile, second.id)
  await expect.poll(async () => (await launches()).length).toBe(3)
  expect((await launches())[2].args).not.toContain('--extension')
  expect(await exists(join(pkg, '.mcp.json'))).toBe(false)

  // Inspect reports Oh My Pi as wired beside Claude and Codex.
  const inspected = await profile.cli('mcp', 'inspect', 'files')
  expect(inspected.code, inspected.stderr).toBe(0)
  const wired = Object.fromEntries((inspected.json?.providers as Array<any>).map((entry) => [entry.provider, entry.wired]))
  expect(wired).toEqual({ claude: true, codex: true, omp: true })
})
