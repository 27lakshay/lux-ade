// An unknown provider ID is a typed refusal. Wherever a request names a
// provider the daemon has neither built in nor registered, the error frame
// carries `provider_not_found` with the `list_providers` recovery, the SDK
// keeps both, and the CLI exits with 31. A refused create leaves nothing.
import { expect, test } from '../fixtures'
import { rawReply } from '../fixtures/raw-reply'
import { cliError, sdkError } from '../errors/steps'

const refusal = { type: 'error', code: 'provider_not_found', recovery: 'list_providers' }

test('conversation.create with an unknown provider is refused as provider_not_found and creates nothing', async ({
  profile,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const before = (await profile.call('catalog.get', {})).catalog.conversations.length

  const frame = await rawReply(profile, {
    op: 'conversation.create',
    operation_id: 'create-unknown-provider',
    workspace_id: workspace.id,
    provider: 'gemini',
  })
  expect(frame).toMatchObject({ ...refusal, message: expect.stringContaining('gemini') })

  const refused = await sdkError(
    profile.call('conversation.create', { workspace_id: workspace.id, provider: 'gemini' }),
  )
  expect(refused).toMatchObject({ code: 'provider_not_found', recovery: 'list_providers', message: frame.message })

  const cli = await profile.cli('conversation', 'create', workspace.id, 'gemini')
  expect(cli.code).toBe(31)
  expect(cliError(cli)).toMatchObject({ code: 'provider_not_found', recovery: 'list_providers' })

  expect((await profile.call('catalog.get', {})).catalog.conversations).toHaveLength(before)
  // The recovery names where the known providers are listed; a listed one is accepted.
  const listed = (await profile.call('provider.capabilities', {})).providers.map((record) => record.provider)
  expect(listed).not.toContain('gemini')
  const created = await profile.call('conversation.create', { workspace_id: workspace.id, provider: listed[0] })
  expect(created.conversation.provider).toBe(listed[0])
})

test('every request that names an unknown provider refuses it the same way', async ({ profile }) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  for (const request of [
    { op: 'provider.capabilities', provider: 'gemini' },
    { op: 'provider.readiness', provider: 'gemini' },
    { op: 'mcp.resolve', workspace_id: workspace.id, provider: 'gemini' },
    { op: 'preset.save', operation_id: 'preset-unknown-provider', name: 'Nowhere', provider: 'gemini' },
  ]) {
    expect(await rawReply(profile, request), request.op).toMatchObject(refusal)
  }
})
