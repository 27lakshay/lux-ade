import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'

async function chooseSave(app: import('@playwright/test').ElectronApplication, filePath: string, replace = false) {
  // Only native dialog decisions are substituted. Serialization and publication use the real daemon and filesystem.
  await app.evaluate(
    ({ dialog }, choice) => {
      dialog.showSaveDialog = async () => ({ canceled: !choice.filePath, filePath: choice.filePath })
      dialog.showMessageBox = async (
        parentOrOptions: Electron.BaseWindow | Electron.MessageBoxOptions,
        supplied?: Electron.MessageBoxOptions,
      ) => {
        const options = supplied ?? ('buttons' in parentOrOptions ? parentOrOptions : undefined)
        if (options?.buttons?.[1] !== 'Replace file') throw new Error('Expected explicit overwrite confirmation')
        return { response: choice.replace ? 1 : 0, checkboxChecked: false }
      }
    },
    { filePath, replace },
  )
}

test('desktop exports a definition to a chosen file and cancellation preserves existing content', async ({
  profile,
  desktop,
}, testInfo) => {
  const before = await profile.call('settings.appearance', {})
  const { app, window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Theme library', exact: true }).click()
  const library = window.getByRole('dialog')
  await library.getByLabel('Installed theme', { exact: true }).selectOption('ade:graphite')
  const folder = join(profile.root, 'exports')
  await mkdir(folder)
  const file = join(folder, 'graphite.json')
  await chooseSave(app, file)
  await library.getByRole('button', { name: 'Export definition to file', exact: true }).click()
  await expect(library.getByRole('status')).toContainText(`Exported revision 0 to ${file}.`)
  const exported = await readFile(file, 'utf8')
  const validated = await profile.call('themes.validate', { source: exported })
  expect(validated.valid).toBe(true)
  expect(validated.definition).toEqual((await profile.call('themes.inspect', { id: 'ade:graphite' })).theme.definition)
  await library.getByRole('status').scrollIntoViewIfNeeded()
  await expect(library.getByRole('status')).toBeVisible()
  await window.screenshot({ path: testInfo.outputPath('theme-file-export.png') })
  await writeFile(file, 'existing content')
  await chooseSave(app, file, false)
  await library.getByRole('button', { name: 'Export definition to file', exact: true }).click()
  await expect(library.getByRole('status')).toHaveText('File export canceled.')
  expect(await readFile(file, 'utf8')).toBe('existing content')
  await chooseSave(app, file, true)
  await library.getByRole('button', { name: 'Export definition to file', exact: true }).click()
  await expect(library.getByRole('status')).toContainText('Exported revision 0')
  expect(await readFile(file, 'utf8')).toBe(exported)
  await chooseSave(app, '')
  await library.getByRole('button', { name: 'Export definition to file', exact: true }).click()
  await expect(library.getByRole('status')).toHaveText('File export canceled.')
  expect(await readdir(folder)).toEqual(['graphite.json'])
  expect(await profile.call('settings.appearance', {})).toEqual(before)
})

test('failed desktop export leaves the library usable and can retry after choosing a valid destination', async ({
  profile,
  desktop,
}) => {
  const { app, window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Theme library', exact: true }).click()
  const library = window.getByRole('dialog')
  await library.getByLabel('Installed theme', { exact: true }).selectOption('ade:chalk')
  await chooseSave(app, join(profile.root, 'missing', 'chalk.json'))
  await library.getByRole('button', { name: 'Export definition to file', exact: true }).click()
  await expect(library.getByText(/ENOENT/)).toBeVisible()
  const file = join(profile.root, 'chalk.json')
  await chooseSave(app, file)
  await library.getByRole('button', { name: 'Export definition to file', exact: true }).click()
  await expect(library.getByRole('status')).toContainText(`Exported revision 0 to ${file}.`)
  expect(JSON.parse(await readFile(file, 'utf8')).id).toBe('ade:chalk')
})
