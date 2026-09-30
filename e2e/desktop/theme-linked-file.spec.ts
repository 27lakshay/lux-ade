import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test('linked theme files refresh only a local draft and retain the last usable source through bad saves', async ({
  profile,
  desktop,
}) => {
  const appearance = await profile.call('settings.appearance', {})
  const installed = await profile.call('themes.inspect', { id: 'ade:graphite' })
  const definition = structuredClone(installed.theme.definition)
  definition.id = 'user:linked-draft'
  definition.name = 'Linked draft'
  definition.provenance = { ...definition.provenance, kind: 'user' }
  const source = (primary: string) => {
    const next = structuredClone(definition)
    next.app!.tokens.primary = primary
    return JSON.stringify(next, null, 2)
  }
  const linkedPath = join(profile.root, 'linked-theme.json')
  const original = source('#123456')
  await writeFile(linkedPath, original)
  const { app, window } = await desktop.launch(profile)
  const existing = (await profile.call('catalog.get', {})).catalog.terminals.map((terminal) => terminal.id)
  await window.getByRole('button', { name: /^New terminal/ }).click()
  const selected = window.locator('[data-terminal]:visible').first()
  await expect
    .poll(async () => {
      const id = await selected.getAttribute('data-terminal')
      return id !== null && !existing.includes(id)
    })
    .toBe(true)
  const terminalId = (await selected.getAttribute('data-terminal'))!
  const terminal = (await profile.call('catalog.get', {})).catalog.terminals.find((item) => item.id === terminalId)!
  const terminalAppearance = await profile.call('terminal.appearance.get', {
    workspace_id: terminal.workspace_id,
    terminal_id: terminalId,
  })
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, linkedPath)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Theme library', exact: true }).click()
  const library = window.getByRole('dialog')
  await library.getByRole('button', { name: 'Link theme file', exact: true }).click()
  const editor = window.getByRole('dialog').filter({ hasText: 'Edit theme draft' })
  const text = editor.getByLabel('Theme definition', { exact: true })
  await expect(text).toHaveValue(original)
  await expect(editor.locator('[data-appearance-preview="dark"]')).toHaveCSS('--primary', '#123456')

  const changed = source('#234567')
  await writeFile(linkedPath, changed)
  await expect(text).toHaveValue(changed)
  await expect(editor.locator('[data-appearance-preview="dark"]')).toHaveCSS('--primary', '#234567')
  expect(await profile.call('settings.appearance', {})).toEqual(appearance)
  expect(
    await profile.call('terminal.appearance.get', {
      workspace_id: terminal.workspace_id,
      terminal_id: terminalId,
    }),
  ).toEqual(terminalAppearance)
  expect((await profile.call('themes.list', {})).themes.some((theme) => theme.id === 'user:linked-draft')).toBe(false)
  await writeFile(linkedPath, '{')
  await expect(editor.getByTestId('linked-file-diagnostic')).toContainText('line 1')
  await expect(text).toHaveValue(changed)
  const replacement = join(profile.root, 'replacement-theme.json')
  await writeFile(replacement, source('#345678'))
  await rename(replacement, linkedPath)
  await expect(text).toHaveValue(source('#345678'))

  await unlink(linkedPath)
  await expect(editor.getByTestId('linked-file-diagnostic')).toContainText('ENOENT')
  await expect(text).toHaveValue(source('#345678'))
  await writeFile(linkedPath, source('#456789'))
  await expect(text).toHaveValue(source('#456789'))

  const retained = source('#456789')
  await editor.getByRole('button', { name: 'Save draft', exact: true }).click()
  const savedDraft = window.getByLabel('ADE theme definition', { exact: true })
  await expect(savedDraft).toHaveValue(retained)
  expect(await readFile(linkedPath, 'utf8')).toBe(retained)
  await writeFile(linkedPath, source('#56789a'))
  await expect(savedDraft).toHaveValue(retained)
  expect(await readFile(linkedPath, 'utf8')).toBe(source('#56789a'))
  expect(await profile.call('settings.appearance', {})).toEqual(appearance)
  expect((await profile.call('themes.list', {})).themes.some((theme) => theme.id === 'user:linked-draft')).toBe(false)
})
