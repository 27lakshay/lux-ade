import { expect, test } from '../fixtures'
import { installAndEnable, stagePlugin } from '../fixtures/plugins'

const themeId = 'plugin.e2e.backend:preview-reset'
const original = {
  format: 'ade-theme',
  version: 1,
  id: themeId,
  name: 'Preview Reset',
  mode: 'dark',
  provenance: { kind: 'plugin', source: 'old-provider', source_version: '1.0.0' },
  app: { defaults: 'ade:graphite', tokens: { primary: '#315b9a' } },
}
const replacement = {
  ...original,
  provenance: { kind: 'plugin', source: 'replacement-provider', source_version: '2.0.0' },
  app: { defaults: 'ade:graphite', tokens: { primary: '#a83257' } },
}

function contributions(theme: object) {
  return {
    commands: [],
    settings: [{ key: 'out_dir', title: 'Fixture output directory', kind: 'string', default: '' }],
    hooks: [],
    themes: [theme],
  }
}

function previewRequest() {
  return {
    app_light_theme: 'ade:chalk',
    app_dark_theme: themeId,
    terminal_binding: { kind: 'follow_app' as const },
    syntax_binding: { kind: 'follow_app' as const },
  }
}

test('remove and re-add advances plugin theme revisions so stale previews conflict', async ({ ade, profile }) => {
  const first = await stagePlugin(ade.root, 'backend', { contributes: contributions(original) })
  const { pluginId } = await installAndEnable(profile, first, 'theme-preview-first')
  const originalTheme = await profile.call('themes.inspect', { id: themeId })
  const originalDigest = originalTheme.theme.definition.provenance.source_digest

  const preview = await profile.call('themes.preview', previewRequest())
  expect(preview.expected_theme_revisions[themeId]).toBeGreaterThan(0)

  await profile.call('plugin.disable', { plugin_id: pluginId })
  await profile.call('plugin.uninstall', { operation_id: 'remove-preview-plugin', plugin_id: pluginId })
  const second = await stagePlugin(ade.root, 'backend', { contributes: contributions(replacement) })
  await installAndEnable(profile, second, 'theme-preview-second')
  await profile.restartDaemon()

  await expect(
    profile.call('settings.set', {
      app_dark_theme: themeId,
      expected_appearance_revision: preview.appearance_revision,
      expected_theme_revisions: preview.expected_theme_revisions,
    }),
  ).rejects.toThrow(/theme.*changed|conflict/i)

  expect((await profile.call('settings.get', {})).settings.app_dark_theme).toBe('ade:graphite')
  const current = await profile.call('themes.inspect', { id: themeId })
  expect(current.theme).toMatchObject({
    definition: {
      provenance: { source: 'e2e.backend' },
      app: { tokens: { primary: '#a83257' } },
    },
  })
  expect(current.theme.definition.provenance.source_digest).not.toBe(originalDigest)

  const fresh = await profile.call('themes.preview', previewRequest())
  await profile.call('settings.set', {
    app_dark_theme: themeId,
    expected_appearance_revision: fresh.appearance_revision,
    expected_theme_revisions: fresh.expected_theme_revisions,
  })
  expect((await profile.call('settings.appearance', {})).theme_id).toBe(themeId)
})
