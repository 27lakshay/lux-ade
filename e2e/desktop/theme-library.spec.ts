import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'

function source(id: string, name = 'Imported sample') {
  return JSON.stringify(
    {
      format: 'ade-theme',
      version: 1,
      id,
      name,
      mode: 'dark',
      provenance: {
        kind: 'imported',
        source: 'scratch fixture',
        source_version: '1',
        author: 'Fixture author',
        license: 'MIT',
      },
      app: { defaults: 'ade:graphite', tokens: { primary: '#AbC' } },
    },
    null,
    2,
  )
}

async function chooseFiles(app: import('@playwright/test').ElectronApplication, files: string[]) {
  // Substitute only the native picker result. Main reads the real scratch files and the real daemon validates them.
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths })
  }, files)
}

test('file import previews errors, installs only explicitly accepted definitions and survives source deletion and relaunch', async ({
  profile,
  desktop,
}, testInfo) => {
  const valid = join(profile.root, 'valid.jsonc')
  const ignored = join(profile.root, 'not-accepted.jsonc')
  const invalid = join(profile.root, 'invalid.jsonc')
  await writeFile(valid, source('user:accepted'))
  await writeFile(ignored, source('user:not-accepted'))
  await writeFile(invalid, '{')
  const before = await profile.call('settings.appearance', {})
  const { app, window } = await desktop.launch(profile)
  await chooseFiles(app, [valid, ignored, invalid])
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Import theme files', exact: true }).click()
  const dialog = window.getByRole('dialog')
  await expect(dialog.getByText('Literal normalized to #aabbcc.', { exact: false }).first()).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: `Accept ${invalid}`, exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Install selected themes', exact: true })).toBeDisabled()
  await dialog.getByRole('checkbox', { name: 'Accept user:accepted', exact: true }).check()
  await dialog.getByRole('button', { name: 'Install selected themes', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('Installed 1 theme at library revision 1.')
  expect(
    (await profile.call('themes.list', {})).themes.filter((theme) => !theme.bundled).map((theme) => theme.id),
  ).toEqual(['user:accepted'])
  expect(await profile.call('settings.appearance', {})).toEqual(before)
  await window.screenshot({ path: testInfo.outputPath('theme-file-import.png') })
  await dialog.getByRole('button', { name: 'Close import', exact: true }).click()
  await rm(valid)
  await app.close()
  await profile.restartDaemon('kill')
  const reopened = await desktop.launch(profile)
  await reopened.window.getByRole('button', { name: 'Settings', exact: true }).click()
  await reopened.window.getByRole('button', { name: 'Theme library', exact: true }).click()
  const library = reopened.window.getByRole('dialog')
  await library.getByLabel('Installed theme', { exact: true }).selectOption('user:accepted')
  await expect(library.getByText('Author: Fixture author', { exact: true })).toBeVisible()
  await expect(library.getByText('License: MIT', { exact: true })).toBeVisible()
  await library.getByRole('button', { name: 'Export definition', exact: true }).click()
  const exported = await library.getByLabel('Exported ADE definition', { exact: true }).inputValue()
  expect((await profile.call('themes.validate', { source: exported })).definition).toMatchObject({
    id: 'user:accepted',
    app: { tokens: { primary: '#aabbcc' } },
  })
  expect(await profile.call('settings.appearance', {})).toEqual(before)
})

test('stale replacements preserve the source draft and require explicit validation of the latest revision', async ({
  profile,
  desktop,
}) => {
  await profile.call('themes.install', { items: [{ source: source('user:replace'), expected_revision: 0 }] })
  const before = await profile.call('settings.appearance', {})
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  const draft = source('user:replace', 'Draft name')
  await window.getByLabel('ADE theme definition', { exact: true }).fill(draft)
  await window.getByRole('button', { name: 'Validate theme', exact: true }).click()
  await expect(window.getByText(/Existing ID: user:replace/)).toContainText('revision 1')
  await profile.call('themes.rename', { id: 'user:replace', name: 'Changed elsewhere', expected_revision: 1 })
  await window.getByRole('button', { name: 'Replace theme', exact: true }).click()
  await expect(window.getByText(/changed from revision 1 to 2/)).toBeVisible()
  await expect(window.getByLabel('ADE theme definition', { exact: true })).toHaveValue(draft)
  expect((await profile.call('themes.inspect', { id: 'user:replace' })).theme.definition.name).toBe('Changed elsewhere')
  await window.getByRole('button', { name: 'Validate theme', exact: true }).click()
  await expect(window.getByText(/Existing ID: user:replace/)).toContainText('revision 2')
  await window.getByRole('button', { name: 'Replace theme', exact: true }).click()
  await expect(window.getByText(/Theme installed at library revision 3/)).toBeVisible()
  expect((await profile.call('themes.inspect', { id: 'user:replace' })).theme.definition.name).toBe('Draft name')
  expect(await profile.call('settings.appearance', {})).toEqual(before)
})

test('rename drafts survive external revisions and custom copies retain source colors and attribution', async ({
  profile,
  desktop,
}) => {
  await profile.call('themes.install', { items: [{ source: source('user:rename'), expected_revision: 0 }] })
  const before = await profile.call('settings.appearance', {})
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Theme library', exact: true }).click()
  const library = window.getByRole('dialog')
  await library.getByLabel('Installed theme', { exact: true }).selectOption('user:rename')
  await library.getByLabel('Theme display name', { exact: true }).fill('Local draft')
  await profile.call('themes.rename', { id: 'user:rename', name: 'Changed elsewhere', expected_revision: 1 })
  await expect(library.getByText('Rename draft revision 1; current revision 2.', { exact: true })).toBeVisible()
  await expect(library.getByLabel('Theme display name', { exact: true })).toHaveValue('Local draft')
  await library.getByRole('button', { name: 'Rename theme', exact: true }).click()
  await expect(library.getByText(/changed from revision 1 to 2/)).toBeVisible()
  await library.getByRole('button', { name: 'Review latest revision', exact: true }).click()
  await library.getByRole('button', { name: 'Rename theme', exact: true }).click()
  await expect
    .poll(async () => (await profile.call('themes.inspect', { id: 'user:rename' })).theme.definition.name)
    .toBe('Local draft')
  await library.getByLabel('Custom copy ID', { exact: true }).fill('user:custom-copy')
  await library.getByRole('button', { name: 'Create custom draft', exact: true }).click()
  const editor = window.getByRole('dialog').filter({ hasText: 'Edit theme draft' })
  await expect(editor.getByLabel('Definition ID', { exact: true })).toHaveValue('user:custom-copy')
  expect(await editor.getByLabel('Theme definition', { exact: true }).inputValue()).toContain('Fixture author')
  await editor.getByRole('button', { name: 'Save draft', exact: true }).click()
  await expect(library).not.toBeVisible()
  const draft = JSON.parse(await window.getByLabel('ADE theme definition', { exact: true }).inputValue())
  expect(draft).toMatchObject({
    id: 'user:custom-copy',
    provenance: { kind: 'user', author: 'Fixture author', license: 'MIT' },
    app: { tokens: { primary: '#aabbcc' } },
  })
  await window.getByRole('button', { name: 'Validate theme', exact: true }).click()
  await window.getByRole('button', { name: 'Install theme', exact: true }).click()
  await expect(window.getByText(/Theme installed at library revision 4/)).toBeVisible()
  expect((await profile.call('themes.inspect', { id: 'user:custom-copy' })).theme.definition).toEqual(draft)
  expect(await profile.call('settings.appearance', {})).toEqual(before)
  await window.getByRole('button', { name: 'Theme library', exact: true }).click()
  await library.getByLabel('Installed theme', { exact: true }).selectOption('ade:graphite')
  await expect(library.getByRole('button', { name: 'Rename theme', exact: true })).toBeDisabled()
})
