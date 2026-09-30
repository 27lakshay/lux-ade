import { rm } from 'node:fs/promises'
import { expect, primaryShell, test } from '../fixtures'
import { fixturePluginIds, installAndEnable, stagePlugin } from '../fixtures/plugins'

const themeId = 'plugin.e2e.backend:night-sky'
const darkTheme = {
  format: 'ade-theme',
  version: 1,
  id: themeId,
  name: 'Night Sky',
  mode: 'dark',
  provenance: { kind: 'plugin', source: 'fixture', source_version: '1.0.0' },
  app: { defaults: 'ade:graphite', tokens: { primary: '#315b9a' } },
}

function backendContributions(themes: object[], providerId = fixturePluginIds.backend) {
  return {
    commands: [
      { id: `${providerId}.echo`, title: 'Echo' },
      { id: `${providerId}.fail`, title: 'Fail' },
      { id: `${providerId}.crash`, title: 'Crash' },
      { id: `${providerId}.hold`, title: 'Hold' },
    ],
    settings: [
      { key: 'out_dir', title: 'Where the fixture writes what it saw', kind: 'string', default: '' },
      { key: 'token', title: 'A credential the plugin names by reference', kind: 'credential_ref' },
    ],
    hooks: ['workspace.created', 'turn.settled'],
    themes,
  }
}

test('installed plugin themes validate, resolve, and fall back across the provider lifecycle', async ({
  ade,
  profile,
}) => {
  const source = await stagePlugin(ade.root, 'backend', { contributes: backendContributions([darkTheme]) })
  const { pluginId } = await installAndEnable(profile, source)
  expect(pluginId).toBe(fixturePluginIds.backend)

  const retainedTheme = JSON.stringify({
    ...darkTheme,
    id: 'user:retained-theme',
    provenance: { kind: 'user', source: null, source_version: null, source_digest: null, author: null, license: null },
  })
  await profile.call('themes.install', { items: [{ source: retainedTheme, expected_revision: 0 }] })

  const library = await profile.call('themes.list', {})
  expect(library.themes).toContainEqual(
    expect.objectContaining({
      id: themeId,
      name: 'Night Sky',
      provenance: expect.objectContaining({
        kind: 'plugin',
        source: pluginId,
        source_version: '1.0.0',
        source_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }),
    }),
  )
  const cliLibrary = await profile.cli('themes', 'list')
  expect(cliLibrary.code, cliLibrary.stderr).toBe(0)
  expect(cliLibrary.json?.themes).toContainEqual(expect.objectContaining({ id: themeId }))
  await profile.call('settings.set', { appearance: 'dark', app_dark_theme: themeId })
  expect(await profile.call('settings.appearance', {})).toMatchObject({
    theme_id: themeId,
    tokens: { primary: '#315b9a' },
    diagnostics: [],
  })

  await profile.call('plugin.disable', { plugin_id: pluginId })
  expect(await profile.call('settings.appearance', {})).toMatchObject({
    theme_id: 'ade:graphite',
    diagnostics: [
      expect.objectContaining({ code: 'missing_theme', selected_id: themeId, fallback_id: 'ade:graphite' }),
    ],
  })
  expect((await profile.call('settings.get', {})).settings.app_dark_theme).toBe(themeId)

  await profile.call('plugin.enable', { plugin_id: pluginId })
  expect((await profile.call('settings.appearance', {})).theme_id).toBe(themeId)
  await profile.call('settings.set', { app_dark_theme: 'ade:carbon' })
  await profile.call('plugin.disable', { plugin_id: pluginId })
  await profile.call('plugin.enable', { plugin_id: pluginId })
  expect((await profile.call('settings.appearance', {})).theme_id).toBe('ade:carbon')

  await profile.call('plugin.disable', { plugin_id: pluginId })
  await profile.call('plugin.uninstall', { operation_id: 'remove-theme-plugin', plugin_id: pluginId })
  expect((await profile.call('themes.list', {})).themes).not.toContainEqual(expect.objectContaining({ id: themeId }))
  expect((await profile.call('themes.list', {})).themes).toContainEqual(
    expect.objectContaining({ id: 'user:retained-theme' }),
  )
  expect((await profile.call('settings.appearance', {})).theme_id).toBe('ade:carbon')
})

test('unavailable installed providers lose their themes on daemon recovery', async ({ ade, profile }) => {
  const source = await stagePlugin(ade.root, 'backend', { contributes: backendContributions([darkTheme]) })
  const { pluginId } = await installAndEnable(profile, source, 'unavailable-theme-plugin')
  await profile.call('settings.set', { appearance: 'dark', app_dark_theme: themeId })
  const detail = await profile.call('plugin.inspect', { plugin_id: pluginId })
  await rm(detail.plugin.artifact_path, { recursive: true })

  await profile.restartDaemon('kill')
  expect((await profile.call('plugin.inspect', { plugin_id: pluginId })).plugin).toMatchObject({
    status: 'enabled',
    activation: null,
    activation_error: expect.any(String),
  })
  expect(await profile.call('settings.appearance', {})).toMatchObject({
    theme_id: 'ade:graphite',
    diagnostics: [expect.objectContaining({ code: 'missing_theme', selected_id: themeId })],
  })
})

test('core appearance restore defaults remains usable with a plugin disabled and terminals intact', async ({
  ade,
  profile,
}) => {
  const source = await stagePlugin(ade.root, 'backend', { contributes: backendContributions([darkTheme]) })
  const { pluginId } = await installAndEnable(profile, source, 'safe-mode-theme-plugin')
  await profile.call('settings.set', { appearance: 'dark', app_dark_theme: themeId })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const shellId = await primaryShell(profile, workspace.id)

  await profile.call('plugin.disable', { plugin_id: pluginId })
  const appearance = await profile.call('settings.appearance', {})
  expect(appearance.diagnostics).toContainEqual(expect.objectContaining({ selected_id: themeId }))
  await profile.call('settings.appearance.reset', { expected_appearance_revision: appearance.revision })
  expect((await profile.call('settings.get', {})).settings).toMatchObject({
    app_light_theme: 'ade:chalk',
    app_dark_theme: 'ade:graphite',
  })
  expect((await profile.call('settings.appearance', {})).theme_id).toBe('ade:graphite')
  expect((await profile.call('catalog.get', {})).catalog.terminals).toContainEqual(
    expect.objectContaining({ id: shellId }),
  )
})

test('invalid plugin themes fail before install and cannot claim another provider namespace', async ({
  ade,
  profile,
}) => {
  const invalid = { ...darkTheme, app: { defaults: 'ade:graphite', tokens: { primary: 'url(javascript:alert(1))' } } }
  const source = await stagePlugin(ade.root, 'backend', { contributes: backendContributions([invalid]) })
  await expect(
    profile.call('plugin.install', {
      operation_id: 'invalid-theme-plugin',
      source: { kind: 'local', path: source },
    }),
  ).rejects.toMatchObject({ code: 'invalid_request' })
  expect((await profile.call('plugin.list', {})).plugins).toEqual([])

  const owner = await stagePlugin(ade.root, 'backend', { contributes: backendContributions([darkTheme]) })
  await installAndEnable(profile, owner, 'valid-theme-plugin')
  const collision = await stagePlugin(ade.root, 'backend', {
    id: 'e2e.other',
    contributes: backendContributions([darkTheme], 'e2e.other'),
  })
  await expect(
    profile.call('plugin.install', {
      operation_id: 'colliding-theme-plugin',
      source: { kind: 'local', path: collision },
    }),
  ).rejects.toMatchObject({ code: 'invalid_request' })
  expect((await profile.call('themes.inspect', { id: themeId })).theme.definition.provenance.source).toBe('e2e.backend')
})

test('failed plugin fallback propagation is reported and reconciled after runtime recovery', async ({
  ade,
  profile,
}) => {
  const source = await stagePlugin(ade.root, 'backend', { contributes: backendContributions([darkTheme]) })
  const { pluginId } = await installAndEnable(profile, source, 'failed-theme-projection')
  await profile.call('settings.set', { appearance: 'dark', app_dark_theme: themeId })
  await profile.killRuntime()

  await expect(profile.call('plugin.disable', { plugin_id: pluginId })).rejects.toThrow(
    /terminal update could not be confirmed/i,
  )
  expect((await profile.call('plugin.inspect', { plugin_id: pluginId })).plugin.status).toBe('disabled')

  await profile.restartDaemon('kill')
  expect(await profile.call('settings.appearance', {})).toMatchObject({
    theme_id: 'ade:graphite',
    diagnostics: [expect.objectContaining({ code: 'missing_theme', selected_id: themeId })],
  })
})
