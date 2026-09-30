import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { expect, test } from './fixtures'

function source() {
  return JSON.stringify({
    format: 'ade-theme',
    version: 1,
    id: 'user:remove',
    name: 'Custom removal',
    mode: 'light',
    provenance: { kind: 'user' },
    app: { defaults: 'ade:chalk', tokens: { primary: '#123456' } },
    terminal: { defaults: 'ade:chalk', tokens: { 'terminal-foreground': '#123456' } },
    syntax: { defaults: 'ade:chalk', tokens: {} },
  })
}

test('removal shows affected choices, cancels safely and applies same-mode fallbacks with preferences intact', async ({
  profile,
  desktop,
}, testInfo) => {
  await profile.call('themes.install', { items: [{ source: source(), expected_revision: 0 }] })
  await profile.call('settings.set', {
    appearance: 'dark',
    app_light_theme: 'user:remove',
    terminal_binding: { kind: 'fixed', theme_id: 'user:remove' },
    reduced_motion: 'on',
    terminal_minimum_contrast: 4.5,
  })
  const before = (await profile.call('settings.get', {})).settings
  const { app, window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Theme library', exact: true }).click()
  const library = window.getByRole('dialog', { name: 'Theme library', exact: true })
  await library.getByLabel('Installed theme', { exact: true }).selectOption('ade:chalk')
  await expect(library.getByRole('button', { name: 'Remove theme', exact: true })).toBeDisabled()
  await library.getByLabel('Installed theme', { exact: true }).selectOption('user:remove')
  await library.getByRole('button', { name: 'Remove theme', exact: true }).click()
  const removal = window.getByRole('dialog', { name: 'Remove theme', exact: true })
  await expect(removal.getByText(/Affected selections: 3/)).toBeVisible()
  await expect(removal.getByText('Terminal fixed: Profile → ade:chalk', { exact: true })).toBeVisible()
  await expect(
    removal.getByText('Syntax light: Profile → ade:chalk (through app selection)', { exact: true }),
  ).toBeVisible()
  await window.screenshot({ path: testInfo.outputPath('theme-removal-plan.png') })
  await removal.getByRole('button', { name: 'Cancel removal', exact: true }).click()
  expect((await profile.call('settings.get', {})).settings).toEqual(before)
  expect((await profile.call('themes.inspect', { id: 'user:remove' })).theme.revision).toBe(1)
  await library.getByRole('button', { name: 'Remove theme', exact: true }).click()
  await expect(removal.getByRole('button', { name: 'Remove theme and apply fallbacks', exact: true })).toBeEnabled()
  await removal.getByRole('button', { name: 'Remove theme and apply fallbacks', exact: true }).click()
  await expect(removal).not.toBeVisible()
  await expect(library.getByLabel('Installed theme', { exact: true })).toHaveValue('')
  expect((await profile.call('settings.get', {})).settings).toEqual({
    ...before,
    app_light_theme: 'ade:chalk',
    terminal_binding: { kind: 'fixed', theme_id: 'ade:chalk' },
    appearance_revision: before.appearance_revision + 1,
  })
  expect((await profile.call('settings.appearance', {})).terminal.dark).toBe(false)
  await app.close()
  await profile.restartDaemon('kill')
  await desktop.launch(profile)
  expect((await profile.call('settings.get', {})).settings.terminal_binding).toEqual({
    kind: 'fixed',
    theme_id: 'ade:chalk',
  })
})

test('stale removal plans and persistence failures retain the definition until explicit review and retry', async ({
  profile,
  desktop,
}) => {
  await profile.call('themes.install', { items: [{ source: source(), expected_revision: 0 }] })
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Theme library', exact: true }).click()
  const library = window.getByRole('dialog', { name: 'Theme library', exact: true })
  await library.getByLabel('Installed theme', { exact: true }).selectOption('user:remove')
  await library.getByRole('button', { name: 'Remove theme', exact: true }).click()
  const removal = window.getByRole('dialog', { name: 'Remove theme', exact: true })
  const apply = removal.getByRole('button', { name: 'Remove theme and apply fallbacks', exact: true })
  await expect(apply).toBeEnabled()
  await profile.call('themes.rename', { id: 'user:remove', name: 'Renamed elsewhere', expected_revision: 1 })
  await apply.click()
  await expect(removal.getByText(/changed from revision 1 to 2/)).toBeVisible()
  await removal.getByRole('button', { name: 'Review removal again', exact: true }).click()
  await expect(removal.getByText(/definition revision 2/)).toBeVisible()
  await profile.call('settings.set', { terminal_binding: { kind: 'fixed', theme_id: 'user:remove' } })
  await apply.click()
  await expect(removal.getByText(/appearance changed/i)).toBeVisible()
  await removal.getByRole('button', { name: 'Review removal again', exact: true }).click()
  await expect(removal.getByText(/Affected selections: 1/)).toBeVisible()
  const database = new DatabaseSync(join(profile.dataDirectory, 'sessions.sqlite'))
  try {
    // The live daemon can hold a brief write transaction while publishing appearance.
    database.exec('PRAGMA busy_timeout = 5000')
    database.exec(
      "CREATE TRIGGER fail_remove BEFORE DELETE ON theme_definitions BEGIN SELECT RAISE(ABORT,'removal persistence failure'); END",
    )
    await apply.click()
    await expect(removal.getByText(/removal persistence failure/)).toBeVisible()
    expect((await profile.call('themes.inspect', { id: 'user:remove' })).theme.definition.name).toBe(
      'Renamed elsewhere',
    )
    database.exec('DROP TRIGGER fail_remove')
    await removal.getByRole('button', { name: 'Review removal again', exact: true }).click()
    await expect(removal.getByText(/removal persistence failure/)).not.toBeVisible()
    await apply.click()
    await expect(removal).not.toBeVisible()
  } finally {
    database.close()
  }
})

test('core restore-defaults remains available in safe mode and preserves the custom library and motion choice', async ({
  profile,
  desktop,
}) => {
  await profile.call('themes.install', { items: [{ source: source(), expected_revision: 0 }] })
  await profile.call('settings.set', { appearance: 'light', app_light_theme: 'user:remove', reduced_motion: 'on' })
  const { window } = await desktop.launch(profile)
  const safe = new URL(window.url())
  safe.searchParams.set('safeMode', '1')
  safe.hash = '/settings'
  await window.goto(safe.toString())
  await window.getByRole('button', { name: 'Restore default appearance', exact: true }).click()
  await expect.poll(async () => (await profile.call('settings.get', {})).settings.app_light_theme).toBe('ade:chalk')
  expect((await profile.call('settings.get', {})).settings.reduced_motion).toBe('on')
  expect((await profile.call('themes.inspect', { id: 'user:remove' })).theme.revision).toBe(1)
  expect(new URL(window.url()).searchParams.get('safeMode')).toBe('1')
})
