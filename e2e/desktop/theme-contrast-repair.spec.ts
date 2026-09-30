import { expect, test } from './fixtures'

test('repairs contrast only in an unsaved custom Graphite draft', async ({ profile, desktop }) => {
  const appearanceBefore = await profile.call('settings.appearance', {})
  const graphiteBefore = await profile.call('themes.inspect', { id: 'ade:graphite' })
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Theme library', exact: true }).click()
  const library = window.getByRole('dialog')
  await library.getByLabel('Installed theme', { exact: true }).selectOption('ade:graphite')
  await library.getByLabel('Custom copy ID', { exact: true }).fill('user:contrast-repair-copy')
  await library.getByRole('button', { name: 'Create custom draft', exact: true }).click()

  const editor = window.getByRole('dialog').filter({ hasText: 'Edit theme draft' })
  const foreground = editor.locator('#theme-role-app-primary-foreground')
  const primaryColor = await editor.locator('#theme-role-app-primary').inputValue()
  await foreground.fill(primaryColor)
  const report = editor.getByTestId('contrast-row-app-primary-default')
  await expect(report).toContainText('Contrast: 1.00 : 1; minimum 4.5 : 1')
  await expect(report.getByRole('button', { name: 'Improve contrast in draft', exact: true })).toBeVisible()
  await expect(editor.getByTestId('contrast-row-diff-lines')).toBeVisible()
  await expect(editor.getByText(/Diagnostics only, not accessibility certification/)).toBeVisible()

  await report.getByRole('button', { name: 'Improve contrast in draft', exact: true }).click()
  await expect(foreground).not.toHaveValue(primaryColor)
  await expect.poll(async () => await report.innerText()).not.toContain('Contrast: 1.00 : 1')
  const result = await report.innerText()
  const ratio = Number(result.match(/Contrast: ([0-9.]+) : 1/)?.[1])
  expect(ratio).toBeGreaterThanOrEqual(4.5)
  await expect(report).toContainText('minimum 4.5 : 1')
  await expect(editor.getByTestId('contrast-row-diff-lines')).toBeVisible()

  expect(await profile.call('themes.inspect', { id: 'ade:graphite' })).toEqual(graphiteBefore)
  expect((await profile.call('themes.list', {})).themes.some((theme) => theme.id === 'user:contrast-repair-copy')).toBe(
    false,
  )
  expect(await profile.call('settings.appearance', {})).toEqual(appearanceBefore)
})
