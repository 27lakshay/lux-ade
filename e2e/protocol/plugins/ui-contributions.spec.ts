// Tickets 24–25: a plugin declares timeline renderers and composer contributions in its manifest.
// The daemon validates them before install, records them as activation registrations, and runs the
// provider headlessly: its namespaced items are stored with canonical text and a bounded payload.
import { expect, send, test, waitForIdle, waitForMessage } from '../fixtures'
import { installAndEnable, stagePlugin } from '../fixtures/plugins'

test('declared UI contributions are inspectable registrations, and the provider runs headlessly', async ({
  ade,
  profile,
}) => {
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'ui'))
  const { plugin } = await profile.call('plugin.inspect', { plugin_id: pluginId })
  expect(plugin.manifest.entry_points).toEqual({ provider: 'worker.mjs', ui: 'ui.mjs', backend: 'backend.mjs' })
  expect(plugin.manifest.contributes.composer).toEqual([
    { id: 'e2e.ui.snippet', version: 1, node_kind: 'e2e.ui.snippet', title: 'Snippets' },
  ])
  const listed = (await profile.call('plugin.list', {})).plugins.find((item) => item.id === pluginId)!
  expect(listed.activation?.registrations).toEqual(
    expect.arrayContaining([
      { kind: 'timeline', id: 'e2e.ui.card' },
      { kind: 'composer', id: 'e2e.ui.snippet' },
    ]),
  )

  // No renderer is involved: the item keeps its kind, canonical text and payload.
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: `plugin:${pluginId}`,
    title: 'Headless contributions',
  })
  await send(profile, conversation.id, 'hello')
  await waitForMessage(profile, conversation.id, 'Check summary: 3 checks passed.')
  await waitForIdle(profile, conversation.id)
  const card = (await profile.call('conversation.get', { conversation_id: conversation.id })).messages.at(-1)
  expect(card).toMatchObject({
    kind: 'e2e.ui.card',
    text: 'Check summary: 3 checks passed.',
    content: { type: 'extension', data: { title: 'Checks', passed: 3 } },
  })
})

test('contributions outside the plugin namespace or without a UI entry are refused before install', async ({
  ade,
  profile,
}) => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [
      {
        contributes: {
          timeline: [{ id: 'e2e.ui.card', version: 1, item_kind: 'message', title: 'Card' }],
        },
      },
      'item_kind must be e2e.ui.<name>',
    ],
    [
      {
        contributes: {
          composer: [{ id: 'other.plugin.snippet', version: 1, node_kind: 'e2e.ui.snippet', title: 'Snippets' }],
        },
      },
      'composer contribution other.plugin.snippet must be e2e.ui.<name>',
    ],
    [{ entry_points: { provider: 'worker.mjs' } }, 'timeline renderers need a ui entry point'],
  ]
  for (const [index, [manifest, message]] of cases.entries()) {
    const source = await stagePlugin(ade.root, 'ui', manifest)
    await expect(
      profile.call('plugin.install', { operation_id: `refused-${index}`, source: { kind: 'local', path: source } }),
    ).rejects.toThrow(message)
  }
  expect((await profile.call('plugin.list', {})).plugins).toEqual([])
})
