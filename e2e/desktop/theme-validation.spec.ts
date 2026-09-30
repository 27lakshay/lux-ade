import { expect, test } from './fixtures'

test('desktop displays source diagnostics without changing appearance and can validate a corrected definition', async ({
  profile,
  desktop,
}, testInfo) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const before = await profile.call('settings.appearance', {})
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  const input = window.getByLabel('ADE theme definition', { exact: true })
  const source = JSON.stringify(
    {
      format: 'ade-theme',
      version: 1,
      id: 'user:sample',
      name: 'Sample',
      mode: 'dark',
      provenance: { kind: 'user' },
      app: { defaults: 'ade:graphite', tokens: { primary: '#AbC' } },
    },
    null,
    2,
  )
  await input.fill(source.replace('"version": 1', '"version": 2'))
  await window.getByRole('button', { name: 'Validate theme', exact: true }).click()
  const report = window.getByRole('status').filter({ hasText: 'Theme definition' })
  await expect(report).toContainText('Theme definition has errors.')
  await expect(report).toContainText('/version, line 3')
  await input.fill(source)
  await window.getByRole('button', { name: 'Validate theme', exact: true }).click()
  await expect(report).toContainText('Theme definition is valid.')
  await expect(report).toContainText('Sample — user:sample')
  await expect(report).toContainText('Literal normalized to #aabbcc.')
  expect(await profile.call('themes.validate', { source })).toMatchObject({ valid: true })
  expect(await profile.call('settings.appearance', {})).toEqual(before)
  await expect(window.getByRole('main', { name: 'Settings', exact: true })).toHaveCSS(
    'background-color',
    'rgb(29, 31, 35)',
  )
  await window.screenshot({ path: testInfo.outputPath('theme-validation.png') })
})

test('simple authoring validates and explicitly installs an editable app-only draft', async ({
  profile,
  desktop,
}, testInfo) => {
  const before = await profile.call('settings.appearance', {})
  const running = await desktop.launch(profile)
  const { window } = running
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByLabel('Theme ID', { exact: true }).fill('user:surface-accent')
  await window.getByLabel('Theme name', { exact: true }).fill('Surface and accent')
  await window.getByLabel('Mode', { exact: true }).selectOption('light')
  await window.getByLabel('Surface color', { exact: true }).fill('rgba(10 20 30 / 50%)')
  await window.getByLabel('Accent color', { exact: true }).fill('#2456a6')
  await window.getByRole('button', { name: 'Generate app theme draft', exact: true }).click()
  await expect(window.getByText('Surface must be an opaque CSS color.', { exact: true })).toBeVisible()
  await expect(window.getByRole('alert')).toContainText('Surface must be an opaque CSS color.')
  await window.getByLabel('Surface color', { exact: true }).fill('#ffffff')
  await window.getByRole('button', { name: 'Generate app theme draft', exact: true }).click()

  const editor = window.getByLabel('ADE theme definition', { exact: true })
  const source = await editor.inputValue()
  const generated = JSON.parse(source)
  expect(generated).toMatchObject({
    id: 'user:surface-accent',
    mode: 'light',
    provenance: { kind: 'user' },
    app: { defaults: null, tokens: { background: '#ffffff', primary: '#2456a6' } },
    terminal: null,
    syntax: null,
  })
  generated.app.tokens.border = '#aabbcc'
  const editedSource = JSON.stringify(generated, null, 2)
  await editor.fill(editedSource)
  const validation = await profile.call('themes.validate', { source: editedSource })
  expect(validation).toMatchObject({ valid: true, diagnostics: [] })
  expect(validation.definition?.app?.tokens.border).toBe('#aabbcc')
  expect((await profile.call('themes.list', {})).themes.some((theme) => theme.id === 'user:surface-accent')).toBe(false)
  expect(await profile.call('settings.appearance', {})).toEqual(before)

  await window.getByRole('button', { name: 'Validate theme', exact: true }).click()
  const report = window.getByRole('status').filter({ hasText: 'Theme definition' })
  await expect(report).toContainText('Theme definition is valid.')
  await window.getByLabel('Surface color', { exact: true }).fill('currentColor')
  await window.getByRole('button', { name: 'Generate app theme draft', exact: true }).click()
  await expect(window.getByRole('alert')).toContainText('Surface must be an opaque CSS color.')
  await expect(editor).toHaveValue(editedSource)
  await expect(report).toHaveCount(0)
  await expect(window.getByRole('button', { name: 'Install theme', exact: true })).toHaveCount(0)
  expect((await profile.call('themes.list', {})).themes.some((theme) => theme.id === 'user:surface-accent')).toBe(false)
  expect(await profile.call('settings.appearance', {})).toEqual(before)

  await window.getByLabel('Surface color', { exact: true }).fill('#ffffff')
  await window.getByRole('button', { name: 'Validate theme', exact: true }).click()
  await expect(report).toContainText('Theme definition is valid.')
  await window.screenshot({ path: testInfo.outputPath('simple-theme-draft.png') })
  await window.getByRole('button', { name: 'Install theme', exact: true }).click()
  await expect(window.getByRole('status').filter({ hasText: 'Theme installed' })).toContainText(
    'Theme installed at library revision 1.',
  )
  expect((await profile.call('themes.inspect', { id: 'user:surface-accent' })).theme.definition).toMatchObject(
    generated,
  )
  expect(await profile.call('settings.appearance', {})).toEqual(before)

  const exported = await profile.call('themes.export', { id: 'user:surface-accent', expected_revision: 1 })
  expect(JSON.parse(exported.source)).toMatchObject(generated)
  await profile.call('settings.set', { appearance: 'light', app_light_theme: 'user:surface-accent' })
  await profile.restartDaemon()
  expect((await profile.call('settings.get', {})).settings).toMatchObject({
    appearance: 'light',
    app_light_theme: 'user:surface-accent',
  })
  expect((await profile.call('themes.inspect', { id: 'user:surface-accent' })).theme.definition).toMatchObject(
    generated,
  )
  await desktop.quit(running)
  const reopened = await desktop.launch(profile)
  const resolved = await profile.call('settings.appearance', {})
  expect(resolved.tokens).toMatchObject({
    background: generated.app.tokens.background,
    border: generated.app.tokens.border,
  })
  await expect
    .poll(() =>
      reopened.window.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--background').trim(),
      ),
    )
    .toBe(resolved.tokens.background)
  await expect
    .poll(() =>
      reopened.window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--border').trim()),
    )
    .toBe(resolved.tokens.border)
})
