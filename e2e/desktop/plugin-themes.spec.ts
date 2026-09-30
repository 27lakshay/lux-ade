import { expect, primaryShell, test } from './fixtures'
import { fixturePluginIds, installAndEnable, stagePlugin } from '../protocol/fixtures/plugins'

const pluginThemeId = 'plugin.' + fixturePluginIds.backend + ':night-sky'

const theme = {
  format: 'ade-theme',
  version: 1,
  id: pluginThemeId,
  name: 'Night Sky',
  mode: 'dark',
  provenance: { kind: 'plugin', source: 'fixture', source_version: '1.0.0' },
  app: { defaults: 'ade:graphite', tokens: { primary: '#315b9a' } },
}

test('plugin theme selection is visible in the desktop and safe-mode appearance recovery preserves active work', async ({
  ade,
  profile,
  desktop,
}) => {
  const source = await stagePlugin(ade.root, 'backend', {
    contributes: {
      commands: [
        { id: fixturePluginIds.backend + '.echo', title: 'Echo' },
        { id: fixturePluginIds.backend + '.fail', title: 'Fail' },
        { id: fixturePluginIds.backend + '.crash', title: 'Crash' },
        { id: fixturePluginIds.backend + '.hold', title: 'Hold' },
      ],
      settings: [
        { key: 'out_dir', title: 'Where the fixture writes what it saw', kind: 'string', default: '' },
        { key: 'token', title: 'A credential the plugin names by reference', kind: 'credential_ref' },
      ],
      hooks: ['workspace.created', 'turn.settled'],
      themes: [theme],
    },
  })
  const { pluginId } = await installAndEnable(profile, source, 'desktop-plugin-theme')
  expect(pluginId).toBe(fixturePluginIds.backend)
  const initial = await profile.call('settings.appearance', {})
  await profile.call('settings.set', { appearance: 'dark', app_dark_theme: 'ade:graphite' })
  expect(await profile.call('settings.appearance', {})).toMatchObject({ theme_id: 'ade:graphite' })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const shellId = await primaryShell(profile, workspace.id)
  const { window } = await desktop.launch(profile)

  await expect(window.locator('html')).toHaveCSS('--primary', '#8AB4F8')
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Theme library', exact: true }).click()
  const library = window.getByRole('dialog', { name: 'Theme library', exact: true })
  await library.getByLabel('Installed theme', { exact: true }).selectOption(pluginThemeId)
  await expect(library.getByText(/Origin: plugin; source: e2e\.backend/)).toBeVisible()
  await expect(library.getByText(/version: 1\.0\.0/)).toBeVisible()
  await library.getByRole('button', { name: 'Preview and select theme', exact: true }).click()
  const preview = window.getByRole('dialog', { name: 'Preview appearance', exact: true })
  await expect(preview.locator('[data-appearance-preview="dark"]')).toHaveCSS('--primary', '#315b9a')
  await preview.getByRole('button', { name: 'Apply preview', exact: true }).click()
  await expect(preview).not.toBeVisible()
  await library.getByRole('button', { name: 'Close library', exact: true }).click()
  await expect(window.locator('html')).toHaveCSS('--primary', '#315b9a')
  expect(await profile.call('settings.appearance', {})).toMatchObject({ theme_id: pluginThemeId })

  const runtimeBefore = await profile.call('runtime.status', {})
  const terminalsBefore = runtimeBefore.terminals as Array<{
    workspace: { terminal_id: string }
    metrics: { run_id: string; shell_pid: number; shell_running: boolean }
  }>
  const activeWork = terminalsBefore.map((item) => [
    item.workspace.terminal_id,
    item.metrics.run_id,
    item.metrics.shell_pid,
  ])
  expect(activeWork).toContainEqual(expect.arrayContaining([shellId, expect.any(String), expect.any(Number)]))
  expect(terminalsBefore.find((item) => item.workspace.terminal_id === shellId)?.metrics.shell_running).toBe(true)

  const safeUrl = new URL(window.url())
  safeUrl.searchParams.set('safeMode', '1')
  await window.goto(safeUrl.toString(), { waitUntil: 'domcontentloaded' })
  await window.reload({ waitUntil: 'domcontentloaded' })
  await expect(window.getByRole('heading', { name: 'Safe mode recovery', exact: true })).toBeVisible()
  await expect(window.getByText('Safe mode is active', { exact: true })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Restore core appearance defaults', exact: true })).toBeEnabled()
  await window.getByRole('button', { name: 'Restore core appearance defaults', exact: true }).click()
  await expect(
    window.getByRole('status').getByText('Core appearance defaults restored.', { exact: true }),
  ).toBeVisible()
  expect(await profile.call('settings.appearance', {})).toMatchObject({ theme_id: 'ade:graphite' })
  expect((await profile.call('settings.get', {})).settings.app_dark_theme).toBe('ade:graphite')
  expect((await profile.call('settings.get', {})).settings.app_light_theme).toBe('ade:chalk')
  expect((await profile.call('catalog.get', {})).catalog.terminals).toContainEqual(
    expect.objectContaining({ id: shellId }),
  )
  expect((await profile.call('settings.appearance', {})).revision).toBeGreaterThan(initial.revision)
  const runtimeAfterRecovery = await profile.call('runtime.status', {})
  const terminalsAfterRecovery = runtimeAfterRecovery.terminals as typeof terminalsBefore
  expect(
    terminalsAfterRecovery.map((item) => [item.workspace.terminal_id, item.metrics.run_id, item.metrics.shell_pid]),
  ).toEqual(activeWork)
  expect(terminalsAfterRecovery.find((item) => item.workspace.terminal_id === shellId)?.metrics.shell_running).toBe(
    true,
  )

  await window.getByRole('link', { name: 'Back to workspace', exact: true }).click()
  await expect(window.getByTestId('workspace')).toBeVisible()
  expect(new URL(window.url()).searchParams.has('safeMode')).toBe(false)
  const runtimeAfterExit = await profile.call('runtime.status', {})
  const terminalsAfterExit = runtimeAfterExit.terminals as typeof terminalsBefore
  expect(
    terminalsAfterExit.map((item) => [item.workspace.terminal_id, item.metrics.run_id, item.metrics.shell_pid]),
  ).toEqual(activeWork)
  expect(terminalsAfterExit.find((item) => item.workspace.terminal_id === shellId)?.metrics.shell_running).toBe(true)
})
