// Window claim (daemon authority ticket 07/08): on start, Electron main asks
// the daemon for its windows. It opens one native window per open record; with
// none open, `window.claim` reopens the last closed record, else makes one on
// the first workspace (apps/desktop/src/main/windows.ts).
import type { Page } from '@playwright/test'
import { expect, test, windowRecordOf, type ScratchProfile } from './fixtures'

type WindowRecord = { id: string; state: 'open' | 'closed'; workspace_id: string }

async function windows(profile: ScratchProfile): Promise<WindowRecord[]> {
  const listed = await profile.cli('window', 'list')
  expect(listed.code, listed.stderr).toBe(0)
  return (listed.json as { windows: WindowRecord[] }).windows
}

/** The window is connected and draws the navigator with the workspace its record shows. */
async function expectShowing(window: Page, workspaceName: string): Promise<void> {
  await expect(window.getByRole('contentinfo').getByRole('img', { name: 'Connected' })).toBeVisible()
  const row = window
    .getByRole('list', { name: 'Projects' })
    .getByRole('button', { name: workspaceName, exact: true })
    .last()
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('data-selected', 'true')
  await expect(row).toHaveAttribute('aria-current', 'true')
}

test('the first start claims a new window record, and a restart reopens that record', async ({ profile, desktop }) => {
  expect(await windows(profile)).toEqual([])
  const { catalog } = await profile.call('catalog.get', {})
  const workspace = catalog.workspaces[0]!

  const first = await desktop.launch(profile)
  await expectShowing(first.window, workspace.name)
  const record = windowRecordOf(first.window)
  expect(record).toBeTruthy()
  expect(await windows(profile)).toEqual([
    expect.objectContaining({ id: record, state: 'open', workspace_id: workspace.id }),
  ])

  // Quitting keeps the record open for the next launch.
  await desktop.quit(first)
  expect(await windows(profile)).toEqual([expect.objectContaining({ id: record, state: 'open' })])

  const second = await desktop.launch(profile)
  await expectShowing(second.window, workspace.name)
  expect(windowRecordOf(second.window)).toBe(record)
  expect(second.app.windows()).toHaveLength(1)
  expect(await windows(profile)).toEqual([expect.objectContaining({ id: record, state: 'open' })])
})

test('a window closed by hand closes its record, and the next start claims it back', async ({ profile, desktop }) => {
  const first = await desktop.launch(profile)
  await expect(first.window.getByRole('list', { name: 'Projects' })).toBeVisible()
  const record = windowRecordOf(first.window)!
  expect(record).toBeTruthy()

  await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
  await expect.poll(async () => (await windows(profile)).map((window) => window.state)).toEqual(['closed'])
  await desktop.quit(first)

  // No record is open: the claim reopens the closed one instead of making another.
  const second = await desktop.launch(profile)
  await expect(second.window.getByRole('list', { name: 'Projects' })).toBeVisible()
  expect(windowRecordOf(second.window)).toBe(record)
  expect(await windows(profile)).toEqual([expect.objectContaining({ id: record, state: 'open' })])
})

test('windows another client opened are shown as they are, one native window each', async ({
  ade,
  profile,
  desktop,
}) => {
  const repo = await ade.repo({ name: 'shop' })
  const shop = (await profile.call('workspace.open', { path: repo.path })).workspace
  const { catalog } = await profile.call('catalog.get', {})
  const home = catalog.workspaces.find((workspace) => workspace.id !== shop.id)!
  for (const [id, workspace] of [
    ['cli-home', home.id],
    ['cli-shop', shop.id],
  ]) {
    const created = await profile.cli('window', 'create', workspace!, '--id', id!)
    expect(created.code, created.stderr).toBe(0)
  }

  const running = await desktop.launch(profile)
  await expect.poll(() => running.app.windows().length).toBe(2)
  const shown = new Map(running.app.windows().map((window) => [windowRecordOf(window), window]))
  expect([...shown.keys()].sort()).toEqual(['cli-home', 'cli-shop'])
  await expectShowing(shown.get('cli-home')!, home.name)
  await expectShowing(shown.get('cli-shop')!, shop.name)
  // Nothing was claimed or made: the two records are still the only ones.
  expect((await windows(profile)).map((window) => [window.id, window.state])).toEqual([
    ['cli-home', 'open'],
    ['cli-shop', 'open'],
  ])
})
