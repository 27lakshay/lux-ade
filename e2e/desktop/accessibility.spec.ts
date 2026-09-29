// Scan implemented UI after real interactions. Conversation content remains unbuilt.
import AxeBuilder from '@axe-core/playwright'
import type { TestInfo } from '@playwright/test'
import type { Page } from 'playwright-core'
import { expect, test } from './fixtures'

async function scan(page: Page, state: string, info: TestInfo): Promise<void> {
  const started = performance.now()
  // Electron cannot create the blank page used by axe's default aggregator.
  // Legacy mode omits cross-origin frame scans, so refuse that unsupported scope.
  expect(page.frames()).toHaveLength(1)
  const result = await new AxeBuilder({ page }).setLegacyMode().analyze()
  const elapsedMs = performance.now() - started
  await info.attach(`axe-${state}`, {
    body: JSON.stringify({ state, elapsedMs, result }, null, 2),
    contentType: 'application/json',
  })
  await info.attach(`screen-${state}`, { body: await page.screenshot(), contentType: 'image/png' })
  expect(
    result.violations,
    JSON.stringify(
      result.violations.map(({ id, impact, help, helpUrl, nodes }) => ({
        id,
        impact,
        help,
        helpUrl,
        nodes: nodes.map(({ target, html, failureSummary }) => ({ target, html, failureSummary })),
      })),
      null,
      2,
    ),
  ).toEqual([])
}

test('axe scans the built shell, command palette and workspace removal confirmation', async ({
  ade,
  profile,
  desktop,
}, info) => {
  const repo = await ade.repo({ name: 'accessibility' })
  const workspace = (await profile.call('workspace.open', { path: repo.path })).workspace
  const { window: page } = await desktop.launch(profile)
  const projects = page.getByRole('list', { name: 'Projects' })
  const row = projects.getByRole('button', { name: 'accessibility', exact: true }).last()
  await expect(row).toBeVisible()
  await row.click()
  await expect(row).toHaveAttribute('aria-current', 'true')
  await scan(page, 'shell', info)

  const search = page.getByRole('button', { name: 'Search', exact: true })
  await search.click()
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await expect(palette).toBeVisible()
  await expect(palette.getByRole('combobox')).toBeFocused()
  await palette.evaluate(async (popup) => {
    await Promise.all(popup.getAnimations({ subtree: true }).map((animation) => animation.finished))
  })
  await scan(page, 'command-palette', info)
  await page.keyboard.press('Tab')
  await expect(palette.getByRole('combobox')).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(palette.getByRole('combobox')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()

  await row.hover()
  await page.getByRole('button', { name: 'accessibility actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Remove from ADE', exact: true }).click()
  // The closing menu stays mounted for its exit animation; scan the settled dialog.
  await expect(page.locator('[role="menu"]')).toHaveCount(0)
  const confirmation = page.getByRole('alertdialog', { name: 'Remove “accessibility” from ADE?' })
  await expect(confirmation).toBeVisible()
  const cancel = confirmation.getByRole('button', { name: 'Cancel', exact: true })
  await expect(cancel).toBeFocused()
  await confirmation.evaluate(async (popup) => {
    await Promise.all(popup.getAnimations({ subtree: true }).map((animation) => animation.finished))
  })
  await scan(page, 'confirmation', info)
  await page.keyboard.press('Tab')
  await expect(confirmation.getByRole('button', { name: 'Remove', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(confirmation.getByRole('button', { name: 'Remove', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(cancel).toBeFocused()
  await cancel.press('Enter')
  await expect(confirmation).toBeHidden()
  expect((await profile.call('catalog.get', {})).catalog.workspaces.some((item) => item.id === workspace.id)).toBe(true)
})
