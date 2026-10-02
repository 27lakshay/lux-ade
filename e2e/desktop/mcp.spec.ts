// Ticket 22: Settings records a server in the profile MCP catalog, shows what each provider would
// receive (direct delivery; ADE runs no gateway), and the next Codex launch receives it as its
// native configuration. The Codex mock records what it was given; it runs no MCP server.
import { prompts, send, waitForIdle } from '../protocol/fixtures'
import { expect, test } from './fixtures'

test('an MCP server added in Settings reaches the next provider launch in its native form', async ({
  profile,
  desktop,
}, testInfo) => {
  const { window: page } = await desktop.launch(profile)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'MCP servers' })).toBeVisible()
  const section = page.locator('section', { has: page.getByRole('heading', { name: 'MCP servers' }) })
  await expect(section.getByText('No MCP servers are recorded.')).toBeVisible()
  await section.getByRole('textbox', { name: 'Name', exact: true }).fill('files')
  await section.getByRole('textbox', { name: 'Command', exact: true }).fill('files-mcp')
  await section.getByRole('textbox', { name: 'Arguments', exact: true }).fill('--root .')
  await section.getByRole('button', { name: 'Add server' }).click()
  await expect(section.getByRole('list', { name: 'MCP servers' })).toContainText('files · stdio files-mcp · revision 1')
  await section.getByRole('button', { name: 'What codex receives' }).click()
  await expect(section.getByLabel('MCP resolution')).toContainText(
    'codex: delivered direct as codex_config_toml · receives files',
  )
  await testInfo.attach('mcp-settings.png', { body: await page.screenshot(), contentType: 'image/png' })

  // The SDK reads the same catalog, and a Codex launch receives the server as a config override.
  expect((await profile.call('mcp.server.list', {})).servers.map((server) => server.name)).toEqual(['files'])
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'codex',
  })
  await send(profile, conversation.id, prompts.turn)
  await waitForIdle(profile, conversation.id)
  const start = (await profile.mockCalls('codex')).find((call) => call.method === 'thread/start')
  expect(JSON.stringify(start?.params)).toContain('files-mcp')

  await section.getByRole('button', { name: 'Remove files' }).click()
  await expect(section.getByText('No MCP servers are recorded.')).toBeVisible()
})
