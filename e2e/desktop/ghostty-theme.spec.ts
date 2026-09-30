import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test('desktop imports Ghostty readability settings only after separate preview and acceptance', async ({
  profile,
  desktop,
}, testInfo) => {
  const file = join(profile.root, 'Ghostty with optional settings')
  await writeFile(
    file,
    'foreground = #000000\nbackground = #000000\nminimum-contrast = 21\nbold-color = bright\ncursor-opacity = 0.5\n',
  )
  const before = await profile.call('settings.get', {})
  const { app, window } = await desktop.launch(profile)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
  }, file)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Import Ghostty theme', exact: true }).click()
  const dialog = window.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Review Ghostty colors', exact: true }).click()
  await dialog.getByRole('button', { name: 'Review optional settings', exact: true }).click()
  await expect(dialog.getByRole('checkbox', { name: 'Import minimum contrast: 21', exact: true })).not.toBeChecked()
  await expect(
    dialog.getByRole('checkbox', { name: 'Import bold colors: Use bright palette', exact: true }),
  ).not.toBeChecked()
  const apply = dialog.getByRole('button', { name: 'Apply optional terminal settings', exact: true })
  await expect(apply).toBeDisabled()
  await dialog.getByRole('checkbox', { name: 'Import minimum contrast: 21', exact: true }).check()
  const policyPreview = dialog.getByRole('region', { name: 'Optional settings preview', exact: true })
  await expect(policyPreview.getByRole('img')).toHaveCount(3)
  const canvas = policyPreview.getByRole('img').first()
  await expect(canvas).toBeVisible()
  expect(
    await canvas.evaluate((element: HTMLCanvasElement) => {
      const context = element.getContext('2d')!
      const row = element.height / 6
      const bytes = context.getImageData(0, 3 * row, element.width, row).data
      let white = 0
      for (let i = 0; i < bytes.length; i += 4)
        if (bytes[i] === 255 && bytes[i + 1] === 255 && bytes[i + 2] === 255) white++
      return white
    }),
  ).toBeGreaterThan(0)
  expect(await profile.call('settings.get', {})).toEqual(before)
  await dialog.getByRole('checkbox', { name: 'Accept reviewed colors', exact: true }).check()
  await dialog.getByRole('button', { name: 'Install Ghostty theme', exact: true }).click()
  await expect(dialog.getByText(/Ghostty theme installed at library revision/)).toBeVisible()
  expect(await profile.call('settings.get', {})).toEqual(before)
  await rm(file)
  await apply.click()
  await expect(dialog.getByText('Optional terminal settings applied.', { exact: true })).toBeVisible()
  const saved = await profile.call('settings.get', {})
  expect(saved.settings).toMatchObject({
    terminal_minimum_contrast: 21,
    terminal_bold_color: 'inherit',
    app_dark_theme: before.settings.app_dark_theme,
    terminal_binding: before.settings.terminal_binding,
  })
  await window.screenshot({ path: testInfo.outputPath('ghostty-optional-settings.png') })
  await window.keyboard.press('Escape')
  await profile.restartDaemon('kill')
  expect((await profile.call('settings.get', {})).settings).toEqual(saved.settings)
})

test('desktop cancels Ghostty policy drafts and requires fresh acceptance after a settings conflict', async ({
  profile,
  desktop,
}) => {
  const file = join(profile.root, 'Ghostty policy conflict')
  await writeFile(file, 'foreground = #123456\nminimum-contrast = 7\nbold-color = bright\n')
  const before = await profile.call('settings.get', {})
  const { app, window } = await desktop.launch(profile)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
  }, file)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  for (const cancel of [true, false]) {
    await window.getByRole('button', { name: 'Import Ghostty theme', exact: true }).click()
    const dialog = window.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Review Ghostty colors', exact: true }).click()
    await dialog.getByRole('button', { name: 'Review optional settings', exact: true }).click()
    const contrast = dialog.getByRole('checkbox', { name: 'Import minimum contrast: 7', exact: true })
    const bold = dialog.getByRole('checkbox', { name: 'Import bold colors: Use bright palette', exact: true })
    await expect(contrast).not.toBeChecked()
    await expect(bold).not.toBeChecked()
    await contrast.check()
    await bold.check()
    if (cancel) {
      await window.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      expect(await profile.call('settings.get', {})).toEqual(before)
      continue
    }
    const concurrent = await profile.call('settings.set', { terminal_minimum_contrast: 3 })
    await dialog.getByRole('button', { name: 'Apply optional terminal settings', exact: true }).click()
    await expect(dialog.getByText(/Review optional settings again before retrying/)).toBeVisible()
    expect(await profile.call('settings.get', {})).toEqual(concurrent)
    await expect(dialog.getByRole('button', { name: 'Apply optional terminal settings', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('region', { name: 'Optional settings preview', exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Review optional settings', exact: true }).click()
    await expect(dialog.getByText(/Current minimum contrast: 3/)).toBeVisible()
    await expect(contrast).not.toBeChecked()
    await expect(bold).not.toBeChecked()
    await bold.check()
    await dialog.getByRole('button', { name: 'Apply optional terminal settings', exact: true }).click()
    await expect(dialog.getByText('Optional terminal settings applied.', { exact: true })).toBeVisible()
    expect((await profile.call('settings.get', {})).settings).toMatchObject({
      terminal_minimum_contrast: 3,
      terminal_bold_color: 'bright',
    })
    await expect(dialog.getByRole('checkbox', { name: 'Accept reviewed colors', exact: true })).not.toBeChecked()
    expect((await profile.call('themes.list', {})).themes.some((theme) => theme.id === 'user:ghostty-theme')).toBe(
      false,
    )
  }
})

test('desktop reviews valid Ghostty setting proposals independently of invalid color data', async ({
  profile,
  desktop,
}) => {
  const file = join(profile.root, 'Ghostty invalid colors valid settings')
  await writeFile(file, 'foreground = invalid\nminimum-contrast = 7\n')
  const { app, window } = await desktop.launch(profile)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
  }, file)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Import Ghostty theme', exact: true }).click()
  const dialog = window.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Review Ghostty colors', exact: true }).click()
  await expect(dialog.getByText('Ghostty colors have errors.', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: 'Accept reviewed colors', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Install Ghostty theme', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Review optional settings', exact: true }).click()
  await dialog.getByRole('checkbox', { name: 'Import minimum contrast: 7', exact: true }).check()
  await expect(
    dialog.getByRole('region', { name: 'Optional settings preview', exact: true }).getByRole('img'),
  ).toHaveCount(2)
  await dialog.getByRole('button', { name: 'Apply optional terminal settings', exact: true }).click()
  await expect(dialog.getByText('Optional terminal settings applied.', { exact: true })).toBeVisible()
  expect((await profile.call('settings.get', {})).settings).toMatchObject({
    terminal_minimum_contrast: 7,
    terminal_bold_color: 'inherit',
  })
  expect((await profile.call('themes.list', {})).themes.some((theme) => theme.id === 'user:ghostty-theme')).toBe(false)
})

test('desktop reviews Ghostty colors and installs accepted retained data without selecting it', async ({
  profile,
  desktop,
}, testInfo) => {
  const file = join(profile.root, 'Imported Ghostty')
  const source =
    'foreground = ForestGreen\npalette = 255=#abcdef\ncursor-color = cell-background\ncursor-text = cell-background\ncommand = touch never-execute\n'
  await writeFile(file, source)
  const before = await profile.call('settings.appearance', {})
  const { app, window } = await desktop.launch(profile)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
  }, file)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Import Ghostty theme', exact: true }).click()
  const dialog = window.getByRole('dialog')
  await expect(dialog.getByText(file, { exact: true })).toBeVisible()
  await dialog.getByLabel('Ghostty theme ID', { exact: true }).fill('user:desktop-ghostty')
  await dialog.getByLabel('Ghostty theme name', { exact: true }).fill('Desktop Ghostty')
  await dialog.getByRole('button', { name: 'Review Ghostty colors', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('Ghostty colors are valid.')
  await expect(dialog.getByRole('status')).toContainText('not applied')
  const sample = dialog.getByRole('img', {
    name: 'Terminal sample: ANSI colors, truecolor, styles, cursor and selection',
  })
  await expect(sample).toBeVisible()
  expect(
    await sample.evaluate((canvas: HTMLCanvasElement) =>
      Array.from(canvas.getContext('2d')!.getImageData(canvas.width - 2, canvas.height - 2, 1, 1).data),
    ),
  ).toEqual([40, 44, 52, 255])
  expect(
    await dialog.evaluate((root) => {
      const viewport = root.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!
      return viewport.scrollWidth - viewport.clientWidth
    }),
  ).toBe(0)
  expect(await profile.call('settings.appearance', {})).toEqual(before)
  await rm(file)
  await dialog.getByRole('checkbox', { name: 'Accept reviewed colors', exact: true }).check()
  await dialog.getByRole('button', { name: 'Install Ghostty theme', exact: true }).click()
  await expect(dialog.getByRole('status').filter({ hasText: 'Ghostty theme installed' })).toBeVisible()
  expect(
    (await profile.call('themes.inspect', { id: 'user:desktop-ghostty' })).theme.definition.provenance.source,
  ).toBe(file)
  expect(await profile.call('settings.appearance', {})).toEqual(before)
  expect(
    await dialog.evaluate((root) => {
      const viewport = root.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!
      const bounds = viewport.getBoundingClientRect()
      const scrollbar = root.querySelector<HTMLElement>('[data-slot="scroll-area-scrollbar"]')!
      const right = Math.min(bounds.right, scrollbar.getBoundingClientRect().left)
      return Array.from(viewport.querySelectorAll('input, button')).flatMap((control) => {
        const rect = control.getBoundingClientRect()
        return rect.width > 1 && (rect.left < bounds.left || rect.right > right)
          ? [
              {
                control: control.getAttribute('id') ?? control.textContent,
                left: rect.left,
                right: rect.right,
                viewport: { left: bounds.left, right },
              },
            ]
          : []
      })
    }),
  ).toEqual([])
  expect(
    (await profile.call('themes.inspect', { id: 'user:desktop-ghostty' })).theme.definition.terminal?.tokens[
      'terminal-cursor'
    ],
  ).toBe('cell-background')
  await window.keyboard.press('Escape')
  await window.getByRole('link', { name: 'Back to workspace' }).click()
  await profile.call('settings.set', { terminal_binding: { kind: 'fixed', theme_id: 'user:desktop-ghostty' } })
  await window.getByRole('button', { name: /^New terminal/ }).click()
  const terminal = window.locator('[data-terminal]:visible').first()
  const canvas = terminal.locator('canvas')
  await expect(canvas).toBeVisible()
  const terminalId = (await terminal.getAttribute('data-terminal'))!
  const { catalog } = await profile.call('catalog.get', {})
  const sent = await profile.cli(
    'terminal',
    'send',
    catalog.workspaces[0]!.id,
    terminalId,
    "printf '\\033[2J\\033[H\\033[38;2;12;34;56;48;2;90;100;110mA界éfi\\033[0m\\033[1;1H\\033[2 q'; read",
  )
  expect(sent.code, sent.stderr).toBe(0)
  const backgroundPixels = () =>
    canvas.evaluate((element: HTMLCanvasElement) => {
      const bytes = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
      let count = 0
      for (let i = 0; i < bytes.length; i += 4)
        if (bytes[i] === 90 && bytes[i + 1] === 100 && bytes[i + 2] === 110) count++
      return count
    })
  const textarea = terminal.locator('textarea')
  await textarea.evaluate((element) => element.blur())
  const withoutCursor = await backgroundPixels()
  await textarea.focus()
  await expect.poll(backgroundPixels).toBeGreaterThan(withoutCursor)
  await window.screenshot({ path: testInfo.outputPath('ghostty-theme-import-wrapped.png') })
})

test('desktop rejects invalid Ghostty colors and re-reviews retained data after a revision conflict', async ({
  profile,
  desktop,
}) => {
  const id = 'user:ghostty-stale'
  const initial = await profile.call('themes.ghostty.validate', {
    id,
    name: 'Initial',
    mode: 'dark',
    source_name: 'initial fixture',
    source: 'foreground = #123456',
  })
  await profile.call('themes.install', { items: [{ source: initial.source!, expected_revision: 0 }] })
  const file = join(profile.root, 'Ghostty replacement')
  await writeFile(file, 'foreground = #abcdef # inline comment')
  const before = await profile.call('settings.appearance', {})
  const { app, window } = await desktop.launch(profile)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
  }, file)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Import Ghostty theme', exact: true }).click()
  let dialog = window.getByRole('dialog')
  await dialog.getByLabel('Ghostty theme ID', { exact: true }).fill(id)
  await dialog.getByRole('button', { name: 'Review Ghostty colors', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('Ghostty colors have errors.')
  await expect(dialog.getByRole('checkbox', { name: 'Accept reviewed colors', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Install Ghostty theme', exact: true })).toBeDisabled()
  await window.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await writeFile(file, 'foreground = #abcdef')
  await window.getByRole('button', { name: 'Import Ghostty theme', exact: true }).click()
  dialog = window.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Review Ghostty colors', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('existing revision 1')
  await rm(file)
  await profile.call('themes.rename', { id, name: 'Concurrent rename', expected_revision: 1 })
  await dialog.getByRole('checkbox', { name: 'Accept reviewed colors', exact: true }).check()
  await dialog.getByRole('button', { name: 'Install Ghostty theme', exact: true }).click()
  await expect(dialog.getByText(/Review the retained file again before retrying/)).toBeVisible()
  expect((await profile.call('themes.inspect', { id })).theme.definition.name).toBe('Concurrent rename')
  await expect(dialog.getByRole('checkbox', { name: 'Accept reviewed colors', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Review Ghostty colors', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('existing revision 2')
  await dialog.getByRole('checkbox', { name: 'Accept reviewed colors', exact: true }).check()
  await dialog.getByRole('button', { name: 'Install Ghostty theme', exact: true }).click()
  await expect(dialog.getByRole('status').filter({ hasText: 'Ghostty theme installed' })).toBeVisible()
  expect((await profile.call('themes.inspect', { id })).theme.definition.terminal?.tokens['terminal-foreground']).toBe(
    '#abcdef',
  )
  expect(await profile.call('settings.appearance', {})).toEqual(before)
})
