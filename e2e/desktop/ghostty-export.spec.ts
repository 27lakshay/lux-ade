import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test('desktop discloses Ghostty export omissions before writing a compatible color file', async ({
  profile,
  desktop,
}, testInfo) => {
  const ghosttyConfig = join(profile.env.XDG_CONFIG_HOME!, 'ghostty', 'config')
  await mkdir(join(profile.env.XDG_CONFIG_HOME!, 'ghostty'), { recursive: true })
  await writeFile(ghosttyConfig, 'theme = retained-configuration\n')
  const before = await profile.call('settings.appearance', {})
  const { app, window } = await desktop.launch(profile)
  const file = join(profile.root, 'graphite.ghostty')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, file)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Theme library', exact: true }).click()
  const library = window.getByRole('dialog')
  await library.getByLabel('Installed theme', { exact: true }).selectOption('ade:graphite')
  await expect(library.getByRole('button', { name: 'Export Ghostty colors to file', exact: true })).toBeDisabled()
  await library.getByRole('button', { name: 'Export Ghostty colors', exact: true }).click()
  await expect(library.getByLabel('Exported Ghostty colors', { exact: true })).toContainText('palette = 255=')
  await expect(library.getByText('Ghostty theme files do not represent ADE app colors.', { exact: true })).toBeVisible()
  await library.getByRole('button', { name: 'Export Ghostty colors to file', exact: true }).click()
  await expect(library.getByRole('status')).toContainText(`Exported Ghostty revision 0 to ${file}.`)
  const exported = await profile.call('themes.ghostty.export', { id: 'ade:graphite', expected_revision: 0 })
  expect(await readFile(file, 'utf8')).toBe(exported.source)
  const reimported = await profile.call('themes.ghostty.validate', {
    source: exported.source,
    id: 'user:reimported',
    name: 'Reimported',
    mode: 'dark',
    source_name: file,
  })
  expect(reimported.validation.valid).toBe(true)
  expect(reimported.validation.definition?.terminal?.tokens).toEqual(
    (await profile.call('themes.inspect', { id: 'ade:graphite' })).theme.definition.terminal?.tokens,
  )
  await writeFile(file, 'existing file')
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  })
  await library.getByRole('button', { name: 'Export Ghostty colors to file', exact: true }).click()
  await expect(library.getByRole('status')).toContainText('Ghostty file export canceled.')
  expect(await readFile(file, 'utf8')).toBe('existing file')
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  })
  await library.getByRole('button', { name: 'Export Ghostty colors to file', exact: true }).click()
  await expect(library.getByRole('status')).toContainText(`Exported Ghostty revision 0 to ${file}.`)
  expect(await readFile(file, 'utf8')).toBe(exported.source)
  expect(await readFile(ghosttyConfig, 'utf8')).toBe('theme = retained-configuration\n')
  expect(await profile.call('settings.appearance', {})).toEqual(before)
  await library.getByRole('status').scrollIntoViewIfNeeded()
  await expect(library.getByRole('status')).toBeVisible()
  await window.screenshot({ path: testInfo.outputPath('ghostty-theme-export.png') })
})
