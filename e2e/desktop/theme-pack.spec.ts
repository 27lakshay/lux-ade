import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'

function member(id: string, color: string) {
  return {
    format: 'ade-theme',
    version: 1,
    id,
    name: 'Packed draft',
    mode: 'dark',
    provenance: { kind: 'user', author: 'Pack author', license: 'MIT' },
    terminal: { defaults: 'ade:graphite', tokens: { 'terminal-foreground': color } },
  }
}
function pack(themes: ReturnType<typeof member>[]) {
  return `// coordinated source\n${JSON.stringify({ format: 'ade-theme-pack', version: 1, id: 'user:desktop-pack', name: 'Desktop pack', themes }, null, 2)}`
}
async function chooseFiles(app: import('@playwright/test').ElectronApplication, files: string[]) {
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths })
  }, files)
}

test('desktop pack import discloses member errors and installs only explicit accepted members with retained identity', async ({
  profile,
  desktop,
}, testInfo) => {
  const file = join(profile.root, 'coordinated.jsonc')
  await writeFile(
    file,
    pack([member('user:first', '#AbC'), member('user:invalid', 'invalid'), member('user:ignored', '#112233')]),
  )
  const before = await profile.call('settings.appearance', {})
  const { app, window } = await desktop.launch(profile)
  await chooseFiles(app, [file])
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Import theme files', exact: true }).click()
  const dialog = window.getByRole('dialog')
  await expect(dialog.getByText('Pack: Desktop pack — user:desktop-pack').first()).toBeVisible()
  await expect(dialog.getByText('/themes/1/terminal/tokens/terminal-foreground', { exact: false })).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: `Accept ${file}`, exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Install selected themes', exact: true })).toBeDisabled()
  await dialog.getByRole('checkbox', { name: 'Accept user:first', exact: true }).check()
  await window.screenshot({ path: testInfo.outputPath('pack-member-preview.png') })
  await dialog.getByRole('button', { name: 'Install selected themes', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('Installed 1 theme at library revision 1.')
  expect(
    (await profile.call('themes.list', {})).themes.filter((theme) => !theme.bundled).map((theme) => theme.id),
  ).toEqual(['user:first'])
  expect(await profile.call('settings.appearance', {})).toEqual(before)
  await dialog.getByRole('button', { name: 'Close import', exact: true }).click()
  await rm(file)
  await app.close()
  await profile.restartDaemon('kill')
  const reopened = await desktop.launch(profile)
  await reopened.window.getByRole('button', { name: 'Settings', exact: true }).click()
  await reopened.window.getByRole('button', { name: 'Theme library', exact: true }).click()
  const library = reopened.window.getByRole('dialog')
  await library.getByLabel('Installed theme', { exact: true }).selectOption('user:first')
  await expect(library.getByText('Pack: Desktop pack — user:desktop-pack')).toBeVisible()
  await expect(library.getByText('Author: Pack author')).toBeVisible()
  expect(
    (await profile.call('themes.inspect', { id: 'user:first' })).theme.definition.terminal?.tokens[
      'terminal-foreground'
    ],
  ).toBe('#aabbcc')
})

test('retained pack members survive a revision conflict and source deletion until explicit review and acceptance', async ({
  profile,
  desktop,
}) => {
  await profile.call('themes.install', {
    items: [{ source: JSON.stringify(member('user:replace', '#112233')), expected_revision: 0 }],
  })
  const file = join(profile.root, 'replacement.jsonc')
  await writeFile(file, pack([member('user:replace', '#445566')]))
  const { app, window } = await desktop.launch(profile)
  await chooseFiles(app, [file])
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Import theme files', exact: true }).click()
  const dialog = window.getByRole('dialog')
  await dialog.getByRole('checkbox', { name: 'Accept user:replace', exact: true }).check()
  await profile.call('themes.rename', { id: 'user:replace', name: 'External edit', expected_revision: 1 })
  await dialog.getByRole('button', { name: 'Install selected themes', exact: true }).click()
  await expect(dialog.getByText(/changed from revision 1 to 2/)).toBeVisible()
  await rm(file)
  await dialog.getByRole('button', { name: 'Review retained definitions', exact: true }).click()
  await expect(dialog.getByText('Diagnostics now refer to the retained definition data.')).toBeVisible()
  await expect(dialog.getByText('Existing revision 2.', { exact: false })).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: 'Accept user:replace', exact: true })).not.toBeChecked()
  await expect(dialog.getByRole('button', { name: 'Install selected themes', exact: true })).toBeDisabled()
  await dialog.getByRole('checkbox', { name: 'Accept user:replace', exact: true }).check()
  await dialog.getByRole('button', { name: 'Install selected themes', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('Installed 1 theme at library revision 3.')
  expect((await profile.call('themes.inspect', { id: 'user:replace' })).theme.definition).toMatchObject({
    name: 'Packed draft',
    pack: { id: 'user:desktop-pack', name: 'Desktop pack' },
    terminal: { tokens: { 'terminal-foreground': '#445566' } },
  })
})

test('desktop exports selected pack members at captured revisions and requires explicit review after a conflict', async ({
  profile,
  desktop,
}, testInfo) => {
  const { readFile } = await import('node:fs/promises')
  await profile.call('themes.install', {
    items: [{ source: JSON.stringify(member('user:export-member', '#112233')), expected_revision: 0 }],
  })
  const before = await profile.call('settings.appearance', {})
  const { app, window } = await desktop.launch(profile)
  const output = join(profile.root, 'desktop-export.json')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  }, output)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Theme library', exact: true }).click()
  await window.getByRole('button', { name: 'Export theme pack', exact: true }).click()
  const dialog = window.getByRole('dialog', { name: 'Export theme pack', exact: true })
  await dialog.getByLabel('Pack ID', { exact: true }).fill('user:desktop-export')
  await dialog.getByLabel('Pack name', { exact: true }).fill('Desktop export')
  await dialog.getByRole('checkbox', { name: /Include .*user:export-member/ }).check()
  await dialog.getByRole('checkbox', { name: /Include .*ade:chalk/ }).check()
  await profile.call('themes.rename', { id: 'user:export-member', name: 'New member name', expected_revision: 1 })
  await dialog.getByRole('button', { name: 'Export pack to file', exact: true }).click()
  await expect(dialog.getByText(/changed from revision 1 to 2/)).toBeVisible()
  await expect.poll(async () => readFile(output, 'utf8').catch(() => 'absent')).toBe('absent')
  await dialog.getByRole('button', { name: 'Review selected revisions', exact: true }).click()
  await expect(dialog.getByText('user:export-member — captured revision 2', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Export pack data', exact: true }).click()
  const data = await dialog.getByLabel('Exported ADE pack', { exact: true }).inputValue()
  expect(JSON.parse(data).themes.map((theme: { id: string }) => theme.id)).toEqual(['user:export-member', 'ade:chalk'])
  await dialog.getByRole('button', { name: 'Export pack to file', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText(`Exported pack user:desktop-export to ${output}.`)
  expect(await readFile(output, 'utf8')).toBe(data)
  await dialog.getByRole('status').scrollIntoViewIfNeeded()
  await window.screenshot({ path: testInfo.outputPath('pack-export.png') })
  await writeFile(output, 'existing content')
  await dialog.getByRole('button', { name: 'Export pack to file', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('Pack file export canceled.')
  expect(await readFile(output, 'utf8')).toBe('existing content')
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  })
  await dialog.getByRole('button', { name: 'Export pack to file', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('Exported pack user:desktop-export')
  expect(await readFile(output, 'utf8')).toBe(data)
  expect(await profile.call('settings.appearance', {})).toEqual(before)
})

test('pack export retains members across pages and recovers from invalid identity and file publication failure', async ({
  profile,
  desktop,
}) => {
  await profile.call('themes.install', {
    items: Array.from({ length: 6 }, (_, index) => ({
      source: JSON.stringify(member(`user:paged-${index}`, '#123456')),
      expected_revision: 0,
    })),
  })
  const before = await profile.call('settings.appearance', {})
  const { app, window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Theme library', exact: true }).click()
  await window.getByRole('button', { name: 'Export theme pack', exact: true }).click()
  const dialog = window.getByRole('dialog', { name: 'Export theme pack', exact: true })
  await dialog.getByLabel('Pack ID', { exact: true }).fill('unqualified')
  await dialog.getByLabel('Pack name', { exact: true }).fill('Paged pack')
  await dialog.getByRole('checkbox', { name: /Include .*user:paged-0/ }).check()
  await dialog.getByRole('button', { name: 'Next pack members', exact: true }).click()
  await dialog.getByRole('checkbox', { name: /Include .*user:paged-5/ }).check()
  await dialog.getByRole('button', { name: 'First pack members', exact: true }).click()
  await expect(dialog.getByRole('checkbox', { name: /Include .*user:paged-0/ })).toBeChecked()
  await expect(dialog.getByText('user:paged-5 — captured revision 1', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Export pack data', exact: true }).click()
  await expect(dialog.getByText(/Invalid pack identity/)).toBeVisible()
  await dialog.getByLabel('Pack ID', { exact: true }).fill('user:paged-pack')
  const missing = join(profile.root, 'missing', 'pack.json')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, missing)
  await dialog.getByRole('button', { name: 'Export pack to file', exact: true }).click()
  await expect(dialog.getByText(/ENOENT/)).toBeVisible()
  const output = join(profile.root, 'paged.json')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, output)
  await dialog.getByRole('button', { name: 'Export pack to file', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText(`Exported pack user:paged-pack to ${output}.`)
  const { readFile } = await import('node:fs/promises')
  expect(JSON.parse(await readFile(output, 'utf8')).themes.map((theme: { id: string }) => theme.id)).toEqual([
    'user:paged-0',
    'user:paged-5',
  ])
  await dialog.getByRole('button', { name: 'Close pack export', exact: true }).click()
  await window.getByRole('button', { name: 'Export theme pack', exact: true }).click()
  await expect(dialog.getByLabel('Pack ID', { exact: true })).toHaveValue('')
  await expect(dialog.getByRole('button', { name: 'Export pack to file', exact: true })).toBeDisabled()
  expect(await profile.call('settings.appearance', {})).toEqual(before)
})
