import type { Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'

async function openImporter(window: Page) {
  const importButton = window.getByRole('button', { name: 'Import Warp theme', exact: true })
  if ((await importButton.count()) === 0) await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await importButton.click()
  return window.getByRole('dialog')
}

test('desktop cancels a native Warp YAML picker without changing theme library or appearance', async ({
  profile,
  desktop,
}) => {
  const beforeLibrary = await profile.call('themes.list', {})
  const beforeAppearance = await profile.call('settings.appearance', {})
  const beforeSettings = await profile.call('settings.get', {})
  const { app, window } = await desktop.launch(profile)
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async (
      windowOrOptions: Electron.BaseWindow | Electron.OpenDialogOptions,
      options?: Electron.OpenDialogOptions,
    ) => {
      ;(globalThis as Record<string, unknown>).__adeWarpPickerOptions = options ?? windowOrOptions
      return { canceled: true, filePaths: [] }
    }
  })
  const dialog = await openImporter(window)
  const pickerOptions = await app.evaluate(() => (globalThis as Record<string, unknown>).__adeWarpPickerOptions)
  expect(pickerOptions).toMatchObject({ filters: [{ name: 'Warp YAML theme', extensions: ['yaml', 'yml'] }] })
  await expect(dialog.getByText('No Warp theme file selected.', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Review Warp theme', exact: true })).toBeDisabled()
  await window.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  expect(await profile.call('themes.list', {})).toEqual(beforeLibrary)
  expect(await profile.call('settings.appearance', {})).toEqual(beforeAppearance)
  expect(await profile.call('settings.get', {})).toEqual(beforeSettings)
})

test('desktop reports malformed Warp YAML locations and preserves the library and appearance', async ({
  profile,
  desktop,
}) => {
  const file = join(profile.root, 'broken-warp.yml')
  await writeFile(file, 'name: Broken\nbackground: [\n')
  const beforeLibrary = await profile.call('themes.list', {})
  const beforeAppearance = await profile.call('settings.appearance', {})
  const { app, window } = await desktop.launch(profile)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
  }, file)
  const dialog = await openImporter(window)
  await dialog.getByRole('button', { name: 'Review Warp theme', exact: true }).click()
  const status = dialog.getByRole('status')
  await expect(status).toContainText('Warp theme has errors.')
  await expect(status).toContainText('line 3')
  await expect(dialog.getByRole('checkbox', { name: 'Accept reviewed theme', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Install Warp theme', exact: true })).toBeDisabled()
  await window.keyboard.press('Escape')
  expect(await profile.call('themes.list', {})).toEqual(beforeLibrary)
  expect(await profile.call('settings.appearance', {})).toEqual(beforeAppearance)
})

test('desktop surfaces oversized and unreadable Warp files without changing themes or appearance', async ({
  profile,
  desktop,
}) => {
  const oversized = join(profile.root, 'oversized-warp.yaml')
  await writeFile(oversized, Buffer.alloc(512 * 1024 + 1, 0x20))
  const beforeLibrary = await profile.call('themes.list', {})
  const beforeAppearance = await profile.call('settings.appearance', {})
  const { app, window } = await desktop.launch(profile)
  await app.evaluate(({ dialog }) => {
    ;(globalThis as Record<string, unknown>).__adeWarpChosenPath = ''
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [(globalThis as Record<string, unknown>).__adeWarpChosenPath as string],
    })
  })
  for (const [path, message] of [
    [oversized, 'Theme file exceeds 512 KiB'],
    [profile.root, 'Choose a regular theme file'],
  ] as const) {
    await app.evaluate((_electron, filePath) => {
      ;(globalThis as Record<string, unknown>).__adeWarpChosenPath = filePath
    }, path)
    const dialog = await openImporter(window)
    await expect(dialog.getByText(message, { exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Review Warp theme', exact: true })).toBeDisabled()
    await window.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  }
  expect(await profile.call('themes.list', {})).toEqual(beforeLibrary)
  expect(await profile.call('settings.appearance', {})).toEqual(beforeAppearance)
})

test('desktop previews supported Warp colors and installs only after acceptance without selecting the theme', async ({
  profile,
  desktop,
}, testInfo) => {
  const file = join(profile.root, 'sample-warp.yaml')
  const source = [
    'name: Sample Warp',
    'details: darker',
    "background: '#123456'",
    "foreground: '#abcdef'",
    'terminal_colors:',
    '  normal:',
    "    red: '#ff0000'",
    "    green: '#00ff00'",
    "accent: '#fedcba'",
    'background_image:',
    '  path: never-open.png',
    '',
  ].join('\n')
  await writeFile(file, source)
  await profile.call('settings.set', {
    ui_font_family: 'Atkinson Hyperlegible',
    ui_font_size: 15,
    density: 'compact',
    terminal_cursor_shape: 'bar',
  })
  const beforeAppearance = await profile.call('settings.appearance', {})
  const beforeSettings = await profile.call('settings.get', {})
  const { app, window } = await desktop.launch(profile)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
  }, file)
  const dialog = await openImporter(window)
  await expect(dialog.getByText(file, { exact: true })).toBeVisible()
  await dialog.getByLabel('Theme ID', { exact: true }).fill('user:desktop-warp')
  await dialog.getByRole('button', { name: 'Review Warp theme', exact: true }).click()
  const status = dialog.getByRole('status')
  await expect(status).toContainText('Warp theme is valid.')
  await expect(status).toContainText('Sample Warp — user:desktop-warp, dark')
  await expect(status).toContainText('warning, line 9')
  await expect(status).toContainText('warning, line 11')
  const sample = dialog.getByRole('img', {
    name: 'Terminal sample: ANSI colors, truecolor, styles, cursor and selection',
  })
  await expect(sample).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: 'Accept reviewed theme', exact: true })).not.toBeChecked()
  await expect(dialog.getByRole('button', { name: 'Install Warp theme', exact: true })).toBeDisabled()
  expect((await profile.call('themes.list', {})).themes.some((theme) => theme.id === 'user:desktop-warp')).toBe(false)
  expect(await profile.call('settings.appearance', {})).toEqual(beforeAppearance)
  expect(await profile.call('settings.get', {})).toEqual(beforeSettings)
  await window.screenshot({ path: testInfo.outputPath('warp-theme-preview.png') })
  await dialog.getByRole('checkbox', { name: 'Accept reviewed theme', exact: true }).check()
  await dialog.getByRole('button', { name: 'Install Warp theme', exact: true }).click()
  await expect(dialog.getByRole('status').filter({ hasText: 'Warp theme installed at library revision' })).toBeVisible()
  const installed = await profile.call('themes.inspect', { id: 'user:desktop-warp' })
  expect(installed.theme.definition.name).toBe('Sample Warp')
  expect(installed.theme.definition.terminal?.tokens).toMatchObject({
    terminal: '#123456',
    'terminal-foreground': '#abcdef',
    'terminal-ansi-1': '#ff0000',
    'terminal-ansi-2': '#00ff00',
  })
  expect(installed.theme.definition.provenance.source).toBe(file)
  expect(await profile.call('settings.appearance', {})).toEqual(beforeAppearance)
  expect(await profile.call('settings.get', {})).toEqual(beforeSettings)
  await window.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  expect(await readFile(file, 'utf8')).toBe(source)

  const replacementSource = [
    'name: Updated Warp',
    "background: '#123456'",
    'terminal_colors:',
    '  normal:',
    "    red: '#ff0000'",
    "    green: '#00ff00'",
    '',
  ].join('\n')
  await writeFile(file, replacementSource)
  const conflictDialog = await openImporter(window)
  await conflictDialog.getByLabel('Theme ID', { exact: true }).fill('user:desktop-warp')
  await conflictDialog.getByRole('button', { name: 'Review Warp theme', exact: true }).click()
  const conflictStatus = conflictDialog
    .getByRole('status')
    .filter({ hasText: 'Updated Warp — user:desktop-warp, dark' })
  await expect(conflictStatus).toContainText(/Installing replaces existing revision \d+\./)
  await conflictDialog.getByRole('checkbox', { name: 'Accept reviewed theme', exact: true }).check()
  await conflictDialog.getByRole('button', { name: 'Install Warp theme', exact: true }).click()
  await expect(
    conflictDialog.getByRole('status').filter({ hasText: /Warp theme installed at library revision \d+\./ }),
  ).toBeVisible()
  const replaced = await profile.call('themes.inspect', { id: 'user:desktop-warp' })
  expect(replaced.theme.definition.name).toBe('Updated Warp')
  expect(replaced.theme.definition.terminal?.tokens).toMatchObject({
    terminal: '#123456',
    'terminal-ansi-1': '#ff0000',
    'terminal-ansi-2': '#00ff00',
  })
  expect(replaced.theme.definition.provenance.source).toBe(file)
  expect(await readFile(file, 'utf8')).toBe(replacementSource)
  expect(await profile.call('settings.appearance', {})).toEqual(beforeAppearance)
  expect(await profile.call('settings.get', {})).toEqual(beforeSettings)
  await window.keyboard.press('Escape')
  await expect(conflictDialog).toBeHidden()
  await profile.call('settings.set', { terminal_binding: { kind: 'fixed', theme_id: 'user:desktop-warp' } })
  const resolved = await profile.call('settings.appearance', {})
  expect(resolved.terminal.palette[1]).toEqual({ r: 255, g: 0, b: 0 })
  expect(resolved.terminal.palette[2]).toEqual({ r: 0, g: 255, b: 0 })
  expect(resolved.terminal.background).toEqual({ r: 18, g: 52, b: 86 })

  await window.getByRole('link', { name: 'Back to workspace' }).click()
  await window.getByRole('button', { name: /^New terminal/ }).click()
  const terminal = window.locator('[data-terminal]:visible').first()
  const canvas = terminal.locator('canvas')
  await expect(canvas).toBeVisible()
  const canvasBackground = () =>
    canvas.evaluate((node) => Array.from((node as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data))
  await expect.poll(canvasBackground).toEqual([18, 52, 86, 255])
  const terminalId = (await terminal.getAttribute('data-terminal'))!
  const { catalog } = await profile.call('catalog.get', {})
  const slash = String.fromCharCode(92)
  const sent = await profile.cli(
    'terminal',
    'send',
    catalog.workspaces[0]!.id,
    terminalId,
    `printf '${slash}033[2J${slash}033[H${slash}033[42m        ${slash}033[0m'; read`,
  )
  expect(sent.code, sent.stderr).toBe(0)
  await terminal.locator('textarea').focus()
  const greenPixels = () =>
    canvas.evaluate((node) => {
      const element = node as HTMLCanvasElement
      const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
      let count = 0
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] === 0 && pixels[i + 1] === 255 && pixels[i + 2] === 0) count++
      return count
    })
  await expect.poll(greenPixels).toBeGreaterThan(0)

  await profile.restartDaemon('kill')
  expect((await profile.call('settings.get', {})).settings.terminal_binding).toEqual({
    kind: 'fixed',
    theme_id: 'user:desktop-warp',
  })
  const restartedSettings = (await profile.call('settings.get', {})).settings
  expect(restartedSettings).toMatchObject({
    ui_font_family: 'Atkinson Hyperlegible',
    ui_font_size: 15,
    density: 'compact',
    terminal_cursor_shape: 'bar',
  })
  const afterRestart = await profile.call('settings.appearance', {})
  expect(afterRestart.terminal.palette[1]).toEqual({ r: 255, g: 0, b: 0 })
  await expect.poll(canvasBackground).toEqual([18, 52, 86, 255])
})
