// F131: the profile MCP catalog. Entries are recorded once per profile,
// guarded by revision, resolved per workspace and provider into each
// provider's native configuration, and kept across daemon crashes.
import { expect, test, type ScratchProfile } from '../fixtures'

type Definition = Record<string, unknown>

function stdio(
  overrides: Partial<Record<'env' | 'args', unknown>> & {
    scope?: unknown
    providers?: unknown
    enabled?: boolean
  } = {},
): Definition {
  return {
    enabled: overrides.enabled ?? true,
    installation: { source: 'package', registry: 'npm', identifier: '@fixture/files-mcp', version: '1.2.3' },
    transport: {
      type: 'stdio',
      command: 'files-mcp',
      args: overrides.args ?? ['--root', '.'],
      env: overrides.env ?? { FIXTURE_TOKEN: { env: 'FIXTURE_TOKEN' }, LOG_LEVEL: { literal: 'info' } },
    },
    scope: overrides.scope ?? { kind: 'profile' },
    providers: overrides.providers ?? { kind: 'all' },
  }
}

function http(url: string, scope: unknown = { kind: 'profile' }): Definition {
  return {
    enabled: true,
    installation: { source: 'remote' },
    transport: { type: 'streamable_http', url, headers: { Authorization: { env: 'FIXTURE_REMOTE_AUTH' } } },
    scope,
    providers: { kind: 'all' },
  }
}

// The SDK types these requests from the contract; the definitions here are
// built as plain objects, so the calls go through a loosely typed helper.
async function call(profile: ScratchProfile, op: string, request: Record<string, unknown>): Promise<any> {
  return profile.call(op as never, request as never)
}

test('adds, updates and removes an entry under its revision guard, and keeps it across a daemon kill', async ({
  profile,
}) => {
  const added = await call(profile, 'mcp.server.add', { name: 'files', definition: stdio() })
  expect(added.server).toMatchObject({ name: 'files', revision: 1 })
  expect(added.server.definition.transport).toMatchObject({ type: 'stdio', command: 'files-mcp', cwd: null })

  // A duplicate add (a lost reply retried) converges on the stored entry.
  const repeated = await call(profile, 'mcp.server.add', { name: 'files', definition: stdio() })
  expect(repeated.server.revision).toBe(1)
  // A different definition under the same name is a conflict, not an overwrite.
  await expect(
    call(profile, 'mcp.server.add', { name: 'files', definition: stdio({ args: ['--other'] }) }),
  ).rejects.toThrow(/already exists at revision 1/)

  const updatedDefinition = stdio({ args: ['--root', '/srv'] })
  const updated = await call(profile, 'mcp.server.update', {
    name: 'files',
    expected_revision: 1,
    definition: updatedDefinition,
  })
  expect(updated.server.revision).toBe(2)
  // The same update repeated after a lost reply converges instead of applying twice.
  const retried = await call(profile, 'mcp.server.update', {
    name: 'files',
    expected_revision: 1,
    definition: updatedDefinition,
  })
  expect(retried.server.revision).toBe(2)
  // A stale writer with another definition is refused.
  await expect(
    call(profile, 'mcp.server.update', {
      name: 'files',
      expected_revision: 1,
      definition: stdio({ args: ['--stale'] }),
    }),
  ).rejects.toThrow(/changed since revision 1; it is at revision 2/)

  await profile.restartDaemon('kill')
  const listed = await call(profile, 'mcp.server.list', {})
  expect(listed.servers).toHaveLength(1)
  expect(listed.servers[0]).toMatchObject({ name: 'files', revision: 2 })
  expect(listed.servers[0].definition.transport.args).toEqual(['--root', '/srv'])

  await expect(call(profile, 'mcp.server.remove', { name: 'files', expected_revision: 1 })).rejects.toThrow(
    /changed since revision 1/,
  )
  const removed = await call(profile, 'mcp.server.remove', { name: 'files', expected_revision: 2 })
  expect(removed).toMatchObject({ name: 'files', removed: true })
  // Removing again converges and says nothing was there.
  const again = await call(profile, 'mcp.server.remove', { name: 'files', expected_revision: 2 })
  expect(again).toMatchObject({ name: 'files', removed: false })
  expect((await call(profile, 'mcp.server.list', {})).servers).toEqual([])
})

test('concurrent writers: duplicate adds converge and only one of two racing updates applies', async ({ profile }) => {
  const adds = await Promise.all(
    Array.from({ length: 6 }, () => call(profile, 'mcp.server.add', { name: 'race', definition: stdio() })),
  )
  expect(new Set(adds.map((reply) => reply.server.revision))).toEqual(new Set([1]))

  const outcomes = await Promise.allSettled([
    call(profile, 'mcp.server.update', { name: 'race', expected_revision: 1, definition: stdio({ args: ['--left'] }) }),
    call(profile, 'mcp.server.update', {
      name: 'race',
      expected_revision: 1,
      definition: stdio({ args: ['--right'] }),
    }),
  ])
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
  const winner = (outcomes.find((outcome) => outcome.status === 'fulfilled') as PromiseFulfilledResult<any>).value
  const stored = (await call(profile, 'mcp.server.inspect', { name: 'race' })).server
  expect(stored).toEqual(winner.server)
  expect(stored.revision).toBe(2)
})

test('the CLI drives the same catalog and reports refusals as JSON errors', async ({ profile }) => {
  const added = await profile.cli('mcp', 'add', 'docs', JSON.stringify(http('https://mcp.example.invalid/docs')))
  expect(added.code).toBe(0)
  expect(added.json).toMatchObject({ type: 'mcp_server', server: { name: 'docs', revision: 1 } })

  const inspected = await profile.cli('mcp', 'inspect', 'docs')
  expect(inspected.code).toBe(0)
  const providers = (inspected.json?.providers ?? []) as Array<Record<string, unknown>>
  expect(providers.map((entry) => entry.provider)).toEqual(expect.arrayContaining(['claude', 'codex', 'omp']))
  expect(providers.find((entry) => entry.provider === 'codex')).toMatchObject({
    native: { url: 'https://mcp.example.invalid/docs', env_http_headers: { Authorization: 'FIXTURE_REMOTE_AUTH' } },
    unsupported_reason: null,
    wired: true,
  })
  expect(inspected.json?.protocol_versions).toContain('2026-07-28')

  const stale = await profile.cli('mcp', 'remove', 'docs', '7')
  expect(stale.code).not.toBe(0)
  expect(stale.json).toMatchObject({ type: 'error' })
  expect(JSON.stringify(stale.json)).toMatch(/changed since revision 7/)

  const removed = await profile.cli('mcp', 'remove', 'docs', '1')
  expect(removed.code).toBe(0)
  expect(removed.json).toMatchObject({ removed: true })
})

test('fails closed on stored secrets, placeholders, insecure URLs and unknown scope targets', async ({ profile }) => {
  const refusals: Array<[string, Definition]> = [
    ['literal credential', stdio({ env: { API_TOKEN: { literal: 'ghp_fixture' } } })],
    ['credential argument', stdio({ args: ['--api-key=fixture'] })],
    ['placeholder', stdio({ env: { HOME_DIR: { literal: '${HOME}' } } })],
    ['plain HTTP to a remote host', http('http://mcp.example.invalid/docs')],
    ['unknown workspace', stdio({ scope: { kind: 'workspaces', workspace_ids: ['workspace_missing'] } })],
    ['unknown provider', stdio({ providers: { kind: 'only', provider_ids: ['not-a-provider'] } })],
  ]
  for (const [label, definition] of refusals) {
    await expect(call(profile, 'mcp.server.add', { name: 'refused', definition }), label).rejects.toThrow()
  }
  // A raw secret field is refused by the contract before it reaches the daemon.
  const withSecret = stdio()
  ;(withSecret.transport as Record<string, unknown>).token = 'ghp_fixture'
  await expect(call(profile, 'mcp.server.add', { name: 'refused', definition: withSecret })).rejects.toThrow()
  // And by the daemon when sent raw.
  const raw = await profile
    .rpc({ op: 'mcp.server.add', name: 'refused', definition: withSecret })
    .catch((error) => error)
  expect(String(raw)).toMatch(/unknown field|token/)
  expect((await call(profile, 'mcp.server.list', {})).servers).toEqual([])
})

test('resolves scope and provider selection per workspace into each native document', async ({ ade, profile }) => {
  const repoA = await ade.repo({ name: 'alpha' })
  const repoB = await ade.repo({ name: 'beta' })
  const alpha = (await profile.call('workspace.open', { path: repoA.path })).workspace
  const beta = (await profile.call('workspace.open', { path: repoB.path })).workspace

  await call(profile, 'mcp.server.add', { name: 'everywhere', definition: stdio() })
  await call(profile, 'mcp.server.add', {
    name: 'alpha-only',
    definition: stdio({ scope: { kind: 'workspaces', workspace_ids: [alpha.id] }, env: {} }),
  })
  await call(profile, 'mcp.server.add', {
    name: 'codex-only',
    definition: stdio({ providers: { kind: 'only', provider_ids: ['codex'] }, env: {} }),
  })
  await call(profile, 'mcp.server.add', { name: 'switched-off', definition: stdio({ enabled: false, env: {} }) })
  expect(alpha.project_id).toBeTruthy()
  await call(profile, 'mcp.server.add', {
    name: 'alpha-repo',
    definition: stdio({ scope: { kind: 'repositories', project_ids: [alpha.project_id] }, env: {} }),
  })

  const names = (resolution: any) => resolution.servers.map((server: any) => server.name).sort()
  const reasons = (resolution: any) =>
    Object.fromEntries(resolution.excluded.map((entry: any) => [entry.name, entry.reason]))

  const alphaCodex = await call(profile, 'mcp.resolve', { workspace_id: alpha.id, provider: 'codex' })
  expect(alphaCodex).toMatchObject({ delivery: 'direct', wired: true, format: 'codex_config_toml' })
  expect(names(alphaCodex)).toEqual(['alpha-only', 'codex-only', 'everywhere', 'alpha-repo'].sort())
  expect(reasons(alphaCodex)).toEqual({ 'switched-off': 'disabled' })
  // Codex forwards the reference by name and keeps the literal.
  expect(alphaCodex.document.mcp_servers.everywhere).toMatchObject({
    command: 'files-mcp',
    env: { LOG_LEVEL: 'info' },
    env_vars: ['FIXTURE_TOKEN'],
  })

  const betaClaude = await call(profile, 'mcp.resolve', { workspace_id: beta.id, provider: 'claude' })
  expect(betaClaude).toMatchObject({ delivery: 'direct', wired: true, format: 'claude_mcp_json' })
  expect(names(betaClaude)).toEqual(['everywhere'])
  expect(reasons(betaClaude)).toMatchObject({
    'alpha-only': 'outside_scope',
    'codex-only': 'provider_not_selected',
    'switched-off': 'disabled',
    'alpha-repo': 'outside_scope',
  })
  // Claude reads references as ${VAR}; the secret itself is never stored.
  expect(betaClaude.document.mcpServers.everywhere).toEqual({
    type: 'stdio',
    command: 'files-mcp',
    args: ['--root', '.'],
    env: { FIXTURE_TOKEN: '${FIXTURE_TOKEN}', LOG_LEVEL: 'info' },
  })
  expect(JSON.stringify(betaClaude)).not.toContain('ghp_')

  // Narrowing the scope moves an entry out of a workspace's resolution.
  const current = (await call(profile, 'mcp.server.inspect', { name: 'everywhere' })).server
  await call(profile, 'mcp.server.update', {
    name: 'everywhere',
    expected_revision: current.revision,
    definition: stdio({ scope: { kind: 'workspaces', workspace_ids: [beta.id] } }),
  })
  expect(names(await call(profile, 'mcp.resolve', { workspace_id: alpha.id, provider: 'claude' }))).not.toContain(
    'everywhere',
  )
  expect(names(await call(profile, 'mcp.resolve', { workspace_id: beta.id, provider: 'claude' }))).toEqual([
    'everywhere',
  ])

  // A provider that cannot express an entry names it as unsupported instead of dropping it.
  await call(profile, 'mcp.server.add', {
    name: 'legacy-sse',
    definition: {
      ...http('https://mcp.example.invalid/sse'),
      transport: { type: 'sse', url: 'https://mcp.example.invalid/sse', headers: {} },
    },
  })
  expect(reasons(await call(profile, 'mcp.resolve', { workspace_id: beta.id, provider: 'codex' }))).toMatchObject({
    'legacy-sse': 'unsupported',
  })

  await expect(call(profile, 'mcp.resolve', { workspace_id: 'workspace_missing', provider: 'codex' })).rejects.toThrow()
  await expect(call(profile, 'mcp.resolve', { workspace_id: alpha.id, provider: 'not-a-provider' })).rejects.toThrow(
    /Unknown provider/,
  )
})

test('a repository-scoped entry reaches Oh My Pi in that repository only', async ({ ade, profile }) => {
  const repo = await ade.repo({ name: 'shared' })
  const other = await ade.repo({ name: 'other' })
  const workspace = (await profile.call('workspace.open', { path: repo.path })).workspace
  const outside = (await profile.call('workspace.open', { path: other.path })).workspace
  expect(workspace.project_id).toBeTruthy()
  expect(outside.project_id).not.toBe(workspace.project_id)
  await call(profile, 'mcp.server.add', {
    name: 'repo-tools',
    definition: stdio({ scope: { kind: 'repositories', project_ids: [workspace.project_id] }, env: {} }),
  })
  const resolved = await call(profile, 'mcp.resolve', { workspace_id: workspace.id, provider: 'omp' })
  expect(resolved.format).toBe('omp_mcp_json')
  expect(resolved.servers.map((server: any) => server.name)).toEqual(['repo-tools'])
  expect(resolved.document.mcpServers['repo-tools']).toMatchObject({ command: 'files-mcp' })
  const elsewhere = await call(profile, 'mcp.resolve', { workspace_id: outside.id, provider: 'omp' })
  expect(elsewhere.servers).toEqual([])
  expect(elsewhere.excluded).toEqual([expect.objectContaining({ name: 'repo-tools', reason: 'outside_scope' })])
})

// F131: Codex and Claude adapters pass the resolution at launch. The launch
// itself is proved in e2e/protocol/ops3/mcp-launch.spec.ts.
test('a provider launched in a workspace receives the resolved MCP servers', async ({ profile }) => {
  const workspace = (await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })).workspace
  await call(profile, 'mcp.server.add', { name: 'files', definition: stdio() })
  const resolved = await call(profile, 'mcp.resolve', { workspace_id: workspace.id, provider: 'claude' })
  expect(resolved.wired).toBe(true)
})
