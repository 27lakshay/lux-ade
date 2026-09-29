// Creating a worktree from the navigator (daemon authority ticket 03/08): main sends
// `workspace.create_worktree` with `show_in` naming the asking window, waits for the
// operation on the feed (`workspace_worktree_operation_changed`), and the daemon shows
// the new workspace in that window. The renderer does not select it itself.
import { expect, test, windowRecordOf } from './fixtures'

test('a worktree created in the navigator appears there and is shown in the asking window', async ({
  ade,
  profile,
  desktop,
}) => {
  const repo = await ade.repo({ name: 'shop' })
  const main = (await profile.call('workspace.open', { path: repo.path })).workspace
  const { app, window } = await desktop.launch(profile)
  const record = windowRecordOf(window)!
  expect(record).toBeTruthy()
  const projects = window.getByRole('list', { name: 'Projects' })
  const project = projects.getByRole('button', { name: 'shop', exact: true }).first()
  await expect(project).toBeVisible()
  const before = (await profile.call('window.list', {})).windows.find((item) => item.id === record)!
  expect(before.workspace_id).not.toBe(main.id)

  // Record every workspace selection the renderer asks main for. A handler on the window's own
  // `webContents.ipc` answers before main's, so a selection would be recorded (and refused).
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents
    const selections: unknown[] = []
    ;(globalThis as { selections?: unknown[] }).selections = selections
    contents.ipc.handle('ade:window-show-workspace', (_event, workspaceId: unknown) => {
      selections.push(workspaceId)
      throw new Error('Recorded by the E2E spec')
    })
  })
  const selections = () => app.evaluate(() => (globalThis as { selections?: unknown[] }).selections ?? [])

  await project.hover()
  await window.getByRole('button', { name: 'New workspace in shop' }).click()
  const dialog = window.getByRole('dialog', { name: 'New workspace in shop' })
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Payments')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  // The new workspace is listed under its project and drawn as the one this window shows.
  await expect(window.getByRole('region', { name: 'Notifications' })).toContainText('Created “Payments”')
  const row = projects.getByRole('button', { name: 'Payments', exact: true })
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('data-selected', 'true')
  await expect(row).toHaveAttribute('aria-current', 'true')
  await expect(projects.locator('[aria-current="true"]')).toHaveCount(1)

  // The daemon made it and shows it in the window that asked.
  const { catalog } = await profile.call('catalog.get', {})
  const created = catalog.workspaces.find((workspace) => workspace.name === 'Payments')!
  expect(created).toMatchObject({ project_id: main.project_id, kind: 'linked_worktree', ade_owned: true })
  const listed = await profile.cli('window', 'list')
  expect(listed.json).toMatchObject({ windows: [{ id: record, state: 'open', workspace_id: created.id }] })
  const layout = await profile.cli('layout', 'get', '--window', record)
  expect(layout.code, layout.stderr).toBe(0)
  expect(layout.json).toMatchObject({ type: 'layout', layout: { window_id: record, workspace_id: created.id } })

  // The renderer never selected it. Clicking a workspace row does select, and is recorded.
  expect(await selections()).toEqual([])
  await projects.getByRole('button', { name: 'shop', exact: true }).last().click()
  await expect.poll(selections).toEqual([main.id])
})
