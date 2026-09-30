import { expect, test } from './fixtures'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function source(color = '#123456') {
  return JSON.stringify({
    format: 'ade-theme',
    version: 1,
    id: 'user:complete',
    name: 'Complete custom',
    mode: 'dark',
    provenance: { kind: 'user' },
    app: { defaults: 'ade:graphite', tokens: { primary: color } },
    syntax: { defaults: 'ade:graphite', tokens: { 'syntax-keyword': color } },
    terminal: {
      defaults: 'ade:graphite',
      tokens: {
        'terminal-foreground': color,
        'terminal-ansi-255': '#abcdef',
        'terminal-selection': '#11223380',
        'terminal-cursor-text': 'cell-background',
      },
    },
  })
}

test('custom selection previews stay local, reject edited definitions and persist after explicit rebase', async ({
  profile,
  desktop,
}, testInfo) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const file = join(profile.root, 'custom-theme.json')
  await writeFile(file, source())
  await profile.call('themes.install', { items: [{ source: await readFile(file, 'utf8'), expected_revision: 0 }] })
  await rm(file)
  const before = await profile.call('settings.appearance', {})
  const { app, window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Theme library', exact: true }).click()
  const library = window.getByRole('dialog', { name: 'Theme library', exact: true })
  await library.getByLabel('Installed theme', { exact: true }).selectOption('user:complete')
  await library.getByRole('button', { name: 'Preview and select theme', exact: true }).click()
  const preview = window.getByRole('dialog', { name: 'Preview appearance', exact: true })
  await expect(preview.locator('[data-appearance-preview="dark"] canvas')).toBeVisible()
  await expect(preview.locator('[data-appearance-preview="dark"]')).toHaveCSS('--primary', '#123456')
  expect(await profile.call('settings.appearance', {})).toEqual(before)
  await preview.getByRole('button', { name: 'Cancel preview', exact: true }).click()
  expect(await profile.call('settings.appearance', {})).toEqual(before)
  await library.getByRole('button', { name: 'Preview and select theme', exact: true }).click()
  await expect(preview.locator('[data-appearance-preview="dark"] canvas')).toBeVisible()
  await profile.call('themes.install', { items: [{ source: source('#654321'), expected_revision: 1 }] })
  await preview.getByRole('button', { name: 'Apply preview', exact: true }).click()
  await expect(preview.getByText(/changed from revision 1 to 2/)).toBeVisible()
  expect(await profile.call('settings.appearance', {})).toEqual(before)
  await expect(preview.locator('[data-appearance-preview="dark"]')).toHaveCSS('--primary', '#123456')
  await preview.getByRole('button', { name: 'Rebase preview', exact: true }).click()
  await expect(preview.locator('[data-appearance-preview="dark"]')).toHaveCSS('--primary', '#654321')
  await window.screenshot({ path: testInfo.outputPath('custom-theme-preview.png') })
  await preview.getByRole('button', { name: 'Apply preview', exact: true }).click()
  await expect(preview).not.toBeVisible()
  await library.getByRole('button', { name: 'Close library', exact: true }).click()
  await expect(window.locator('html')).toHaveCSS('--primary', '#654321')
  const committed = await profile.call('settings.appearance', {})
  expect(committed.theme_id).toBe('user:complete')
  expect(committed.syntax.palette.tokens['syntax-keyword']).toBe('#654321')
  expect(committed.terminal.palette[255]).toEqual({ r: 171, g: 205, b: 239 })
  await profile.call('themes.install', { items: [{ source: source('#abcdef'), expected_revision: 2 }] })
  await expect(window.locator('html')).toHaveCSS('--primary', '#abcdef')
  await app.close()
  await profile.restartDaemon('kill')
  const reopened = await desktop.launch(profile)
  await expect(reopened.window.locator('html')).toHaveCSS('--primary', '#abcdef')
  expect((await profile.call('settings.appearance', {})).theme_id).toBe('user:complete')
})

test('library choices expose only supplied sections and fixed terminal and syntax themes leave app colors intact', async ({
  profile,
  desktop,
}) => {
  const complete = JSON.parse(source())
  const terminal = { ...complete, id: 'user:terminal-only', app: undefined, syntax: undefined }
  const syntax = { ...complete, id: 'user:syntax-only', app: undefined, terminal: undefined }
  await profile.call('themes.install', {
    items: [
      { source: JSON.stringify(terminal), expected_revision: 0 },
      { source: JSON.stringify(syntax), expected_revision: 0 },
    ],
  })
  const before = await profile.call('settings.appearance', {})
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Theme library', exact: true }).click()
  const library = window.getByRole('dialog', { name: 'Theme library', exact: true })
  for (const [id, target] of [
    ['user:terminal-only', 'terminal'],
    ['user:syntax-only', 'syntax'],
  ] as const) {
    await library.getByLabel('Installed theme', { exact: true }).selectOption(id)
    await expect(library.getByLabel('Use theme for', { exact: true })).toHaveValue(target)
    await expect(library.getByLabel('Use theme for', { exact: true }).locator('option')).toHaveCount(1)
    await library.getByRole('button', { name: 'Preview and select theme', exact: true }).click()
    const preview = window.getByRole('dialog', { name: 'Preview appearance', exact: true })
    await expect(preview.locator('[data-appearance-preview="dark"] canvas')).toBeVisible()
    await preview.getByRole('button', { name: 'Apply preview', exact: true }).click()
    await expect(preview).not.toBeVisible()
    const appearance = await profile.call('settings.appearance', {})
    expect(appearance.tokens).toEqual(before.tokens)
    expect(appearance.theme_id).toBe(before.theme_id)
  }
  expect((await profile.call('settings.get', {})).settings).toMatchObject({
    terminal_binding: { kind: 'fixed', theme_id: 'user:terminal-only' },
    syntax_binding: { kind: 'fixed', theme_id: 'user:syntax-only' },
  })
  const appearance = await profile.call('settings.appearance', {})
  expect(appearance.terminal.foreground).toEqual({ r: 18, g: 52, b: 86 })
  expect(appearance.syntax.palette.tokens['syntax-keyword']).toBe('#123456')
  await library.getByRole('button', { name: 'Close library', exact: true }).click()
  await expect(window.locator('html')).toHaveCSS('--primary', before.tokens.primary!)
})
