import { expect, test } from './fixtures'

test('theme editor drafts edit supported section roles locally, cancel cleanly and save built-in copies', async ({
  profile,
  desktop,
}) => {
  const beforeAppearance = await profile.call('settings.appearance', {})
  const builtInBefore = await profile.call('themes.inspect', { id: 'ade:graphite' })
  const { app, window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Theme library', exact: true }).click()
  const library = window.getByRole('dialog')
  await library.getByLabel('Installed theme', { exact: true }).selectOption('ade:graphite')

  await library.getByLabel('Custom copy ID', { exact: true }).fill('user:discarded-copy')
  await library.getByRole('button', { name: 'Create custom draft', exact: true }).click()
  const editor = window.getByRole('dialog').filter({ hasText: 'Edit theme draft' })
  await expect(editor.getByLabel('Definition ID', { exact: true })).toHaveValue('user:discarded-copy')
  await editor.getByLabel('Theme definition', { exact: true }).fill('{')
  await expect(
    editor.getByText('This draft is not valid JSON. Correct the source or reset the draft.', { exact: true }),
  ).toBeVisible()
  await editor.getByRole('button', { name: 'Reset draft', exact: true }).click()
  await editor.locator('#theme-role-app-primary').fill('#123456')
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await profile.call('themes.list', {})).themes.some((theme) => theme.id === 'user:discarded-copy')).toBe(false)
  expect(await profile.call('settings.appearance', {})).toEqual(beforeAppearance)
  expect(await profile.call('themes.inspect', { id: 'ade:graphite' })).toEqual(builtInBefore)

  await library.getByLabel('Custom copy ID', { exact: true }).fill('user:editor-copy')
  await library.getByRole('button', { name: 'Create custom draft', exact: true }).click()
  const copyEditor = window.getByRole('dialog').filter({ hasText: 'Edit theme draft' })
  const originalPrimary = builtInBefore.theme.definition.app?.tokens.primary
  await copyEditor.locator('#theme-role-app-primary').fill('#123456')
  await copyEditor.locator('#theme-role-terminal-terminal-ansi-2').fill('#234567')
  await copyEditor.locator('#theme-role-syntax-syntax-keyword').fill('#345678')
  await copyEditor.getByRole('button', { name: 'Reset draft', exact: true }).click()
  await expect(copyEditor.locator('#theme-role-app-primary')).toHaveValue(originalPrimary!)
  await copyEditor.locator('#theme-role-app-primary').fill('#123456')
  const appearanceSample = copyEditor.locator('[data-appearance-preview="dark"]')
  await expect(appearanceSample).toHaveCSS('--primary', '#123456')
  const lightSample = copyEditor.locator('[data-appearance-preview="light"]')
  await expect(lightSample).toContainText('Light — Chalk')
  await expect(lightSample).not.toHaveCSS('--primary', '#123456')
  await expect(appearanceSample.locator('canvas')).toBeVisible()
  await copyEditor.locator('#theme-role-terminal-terminal-ansi-2').fill('#234567')
  await copyEditor.locator('#theme-role-syntax-syntax-keyword').fill('#345678')
  await expect(copyEditor.getByText('#123456', { exact: false }).first()).toBeVisible()
  await copyEditor.getByRole('button', { name: 'Save draft', exact: true }).click()

  await window.getByRole('button', { name: 'Validate theme', exact: true }).click()
  await expect(window.getByText('Theme definition is valid.', { exact: true })).toBeVisible()
  await window.getByRole('button', { name: 'Install theme', exact: true }).click()
  await expect(window.getByText(/Theme installed at library revision/)).toBeVisible()
  const saved = await profile.call('themes.inspect', { id: 'user:editor-copy' })
  expect(saved.theme.definition).toMatchObject({
    id: 'user:editor-copy',
    mode: 'dark',
    app: { tokens: { primary: '#123456' } },
    terminal: { tokens: { 'terminal-ansi-2': '#234567' } },
    syntax: { tokens: { 'syntax-keyword': '#345678' } },
  })
  expect(await profile.call('settings.appearance', {})).toEqual(beforeAppearance)
  expect(await profile.call('themes.inspect', { id: 'ade:graphite' })).toEqual(builtInBefore)
  await app.close()
  await profile.call('settings.set', {
    appearance: 'dark',
    app_dark_theme: 'user:editor-copy',
    terminal_binding: { kind: 'fixed', theme_id: 'user:editor-copy' },
    syntax_binding: { kind: 'fixed', theme_id: 'user:editor-copy' },
  })
  const selected = await profile.call('settings.appearance', {})
  expect(selected.tokens.primary).toBe('#123456')
  expect(selected.terminal.palette[2]).toEqual({ r: 35, g: 69, b: 103 })
  expect(selected.syntax.palette.tokens['syntax-keyword']).toBe('#345678')
  await profile.restartDaemon('kill')
  const reopened = await desktop.launch(profile)
  await expect(reopened.window.locator('html')).toHaveCSS('--primary', '#123456')
  const restored = await profile.call('settings.appearance', {})
  expect(restored.tokens.primary).toBe('#123456')
  expect(restored.terminal.palette[2]).toEqual({ r: 35, g: 69, b: 103 })
  expect(restored.syntax.palette.tokens['syntax-keyword']).toBe('#345678')
})

test('terminal-only drafts retain an independent terminal sample', async ({ profile, desktop }) => {
  const source = JSON.stringify({
    format: 'ade-theme',
    version: 1,
    id: 'user:terminal-only',
    name: 'Terminal only',
    mode: 'dark',
    provenance: { kind: 'imported', source: 'scratch fixture', source_version: '1' },
    app: null,
    syntax: null,
    terminal: { defaults: 'ade:graphite', tokens: { 'terminal-ansi-2': '#123456' } },
  })
  await profile.call('themes.install', { items: [{ source, expected_revision: 0 }] })
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Theme library', exact: true }).click()
  const library = window.getByRole('dialog')
  await library.getByLabel('Installed theme', { exact: true }).selectOption('user:terminal-only')
  await library.getByLabel('Custom copy ID', { exact: true }).fill('user:terminal-only-copy')
  await library.getByRole('button', { name: 'Create custom draft', exact: true }).click()
  const editor = window.getByRole('dialog').filter({ hasText: 'Edit theme draft' })
  await expect(editor.getByText('Resolved terminal sample', { exact: true })).toBeVisible()
  await expect(editor.getByRole('group', { name: 'Resolved terminal sample' }).locator('canvas')).toBeVisible()
  await expect(editor.getByText('App —', { exact: false })).toHaveCount(0)
  await expect(editor.getByText('Syntax —', { exact: false })).toHaveCount(0)
})

test('role edits keep a valid large source below the UTF-8 input limit', async ({ profile, desktop }) => {
  const extension = Array.from({ length: 30_000 }, () => 'x')
  const source = JSON.stringify({
    format: 'ade-theme',
    version: 1,
    id: 'user:large-editor',
    name: 'Large editor',
    mode: 'dark',
    provenance: { kind: 'imported', source: 'scratch fixture', source_version: '1' },
    app: { defaults: 'ade:graphite', tokens: { primary: '#ffffff' }, extension },
    terminal: null,
    syntax: null,
  })
  expect(Buffer.byteLength(source)).toBeLessThan(256 * 1024)
  await profile.call('themes.install', { items: [{ source, expected_revision: 0 }] })
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Theme library', exact: true }).click()
  const library = window.getByRole('dialog')
  await library.getByLabel('Installed theme', { exact: true }).selectOption('user:large-editor')
  await library.getByLabel('Custom copy ID', { exact: true }).fill('user:large-editor-copy')
  await library.getByRole('button', { name: 'Create custom draft', exact: true }).click()
  const editor = window.getByRole('dialog').filter({ hasText: 'Edit theme draft' })
  const definition = editor.getByLabel('Theme definition', { exact: true })
  await editor.locator('#theme-role-app-primary').fill('#123456')
  const updatedSource = await definition.inputValue()
  expect(Buffer.byteLength(updatedSource)).toBeLessThan(256 * 1024)
  const updated = JSON.parse(updatedSource)
  expect(updated.app.tokens.primary).toBe('#123456')
  expect(updated.app.extension).toHaveLength(30_000)
  await expect(editor.getByRole('button', { name: 'Save draft', exact: true })).toBeEnabled()
  await editor.getByRole('button', { name: 'Save draft', exact: true }).click()
  const savedDraft = JSON.parse(await window.getByLabel('ADE theme definition', { exact: true }).inputValue())
  expect(savedDraft.app.tokens.primary).toBe('#123456')
  expect(savedDraft.app.extension).toHaveLength(30_000)
})
