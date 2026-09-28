import type { Conversation, Workspace } from '@ade/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { DEFAULT_WORKSPACE, layoutStore, openTab, setActiveWorkspace } from '../model/layout-store'
import { renderWorkspace, resetLayout, setCatalog } from '../testing'

beforeEach(() => {
  resetLayout()
  localStorage.removeItem('ade.navigator.collapsed:main')
})
afterEach(() => {
  window.adeHost = undefined as unknown as typeof window.adeHost
})

const workspace = (id: string, name: string, repository_id: string | null): Workspace => ({
  id,
  name,
  repository_id,
  root: `/code/${name}`,
  terminal_id: `t-${id}`,
  needs_rebind: false,
  worktree_lifecycle_needs_rebind: false,
})
const conversation = (id: string, workspace_id: string, title: string, status = 'idle'): Conversation => ({
  id,
  workspace_id,
  title,
  provider: 'codex',
  status,
})
const catalog = (
  workspaces: Workspace[],
  conversations: Conversation[] = [],
  repositories: { id: string; root: string; name: string }[] = [],
) => setCatalog({ workspaces, conversations, repositories })
const two = [workspace('w1', 'main', 'r1'), workspace('w2', 'feature', 'r1'), workspace('w3', 'notes', null)]
/** The rows' titles at a level: projects, or the workspaces of one project. */
const PROJECT_ROWS = ':scope > li > div > button'
const WORKSPACE_ROWS = ':scope > li > ul > li > div > div > button'
/** A workspace row (second level), by its name. */
const workspaceRow = (name: string) => () =>
  [...document.querySelectorAll<HTMLElement>(`[aria-label="Projects"] ${WORKSPACE_ROWS.slice(7)}`)].find(
    (row) => row.textContent === name,
  )
/** A host whose workspace actions are spies; each resolves as given. */
const hostSpy = (overrides: Partial<Window['adeHost']['workspaces']> = {}) => {
  const workspaces = {
    select: vi.fn(async () => true),
    choose: vi.fn(),
    rename: vi.fn(async () => {}),
    remove: vi.fn(async () => ({ removed: true as const })),
    createWorktree: vi.fn(async () => 'w9'),
    checkWorktree: vi.fn(async () => ({ path: '/code/feature', reasons: [] as string[] })),
    deleteWorktree: vi.fn(async () => ({ removed: true as const })),
    ...overrides,
  }
  window.adeHost = { workspaces, setWindowMinimumSize: vi.fn() } as unknown as typeof window.adeHost
  return workspaces
}
const selectSpy = () => hostSpy().select

test('lists projects, their workspaces and conversations from the catalog', async () => {
  const screen = await renderWorkspace()
  catalog(two, [conversation('c1', 'w2', 'Fix the build', 'running')])
  const projects = screen.getByRole('list', { name: 'Projects' })
  await expect.element(projects.getByRole('button', { name: /Fix the build/ })).toBeVisible()
  const rows = (selector: string) => [...projects.element().querySelectorAll(selector)].map((row) => row.textContent)
  // Grouped by repository and sorted; until project names arrive, a project takes its first
  // workspace's name.
  expect(rows(PROJECT_ROWS)).toEqual(['feature', 'notes'])
  expect(rows(WORKSPACE_ROWS.replace(':scope > li', ':scope > li:first-child'))).toEqual(['feature', 'main'])
  await expect.element(screen.getByText('Projects')).toBeVisible()
})

test('choosing a workspace shows its layout and tells main', async () => {
  const select = selectSpy()
  await renderWorkspace()
  catalog(two)
  const notes = workspaceRow('notes')
  await expect.poll(notes).toBeTruthy()
  notes()!.click()
  await expect.poll(() => layoutStore.getState().active).toBe('w3')
  expect(select).toHaveBeenCalledWith('w3', null)
  await expect.poll(() => workspaceRow('notes')()?.getAttribute('aria-current')).toBe('true')
})

test('the layout from before the catalog arrived carries over to the first workspace', async () => {
  selectSpy()
  await renderWorkspace()
  openTab({ kind: 'terminal', title: 'Kept' })
  expect(layoutStore.getState().active).toBe(DEFAULT_WORKSPACE)
  catalog(two)
  await expect.poll(() => layoutStore.getState().active).toBe('w1')
  const layout = layoutStore.getState().layouts.w1!
  expect(Object.values(layout.tabs).map((tab) => tab.title)).toEqual(['Kept'])
  expect(layoutStore.getState().layouts[DEFAULT_WORKSPACE]).toBeUndefined()
})

test('a window whose workspace is removed moves to one that is left; a non-daemon layout is left alone', async () => {
  selectSpy()
  await renderWorkspace()
  catalog(two)
  await expect.poll(workspaceRow('notes')).toBeTruthy()
  workspaceRow('notes')()!.click()
  await expect.poll(() => layoutStore.getState().active).toBe('w3')
  catalog(two.slice(0, 2))
  await expect.poll(() => layoutStore.getState().active).toBe('w1')
  // A layout that never was a daemon workspace, as the benchmark's, stays on screen.
  setActiveWorkspace('bench-1')
  catalog(two.slice(0, 1))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(layoutStore.getState().active).toBe('bench-1')
})

test('a project collapses and stays collapsed across a restart of the window', async () => {
  const screen = await renderWorkspace()
  catalog(two)
  await expect.poll(workspaceRow('main')).toBeTruthy()
  document.querySelector<HTMLElement>('[aria-label="Projects"] > li > div > button')!.click()
  await expect.poll(workspaceRow('main')).toBeFalsy()
  void screen
  expect(JSON.parse(localStorage.getItem('ade.navigator.collapsed:main')!)).toEqual(['r1'])
})

test('with no projects, the navigator says so', async () => {
  const screen = await renderWorkspace()
  catalog([])
  await expect.element(screen.getByText('No projects yet')).toBeVisible()
})

test('a repository project is named after its checkout folder', async () => {
  const screen = await renderWorkspace()
  catalog(two, [], [{ id: 'r1', root: '/code/shop/.git', name: 'shop' }])
  const projects = screen.getByRole('list', { name: 'Projects' })
  await expect.element(projects.getByRole('button', { name: 'shop', exact: true })).toBeVisible()
})

/** Opens a workspace's "⋯" menu and chooses an item. */
async function choose(screen: Awaited<ReturnType<typeof renderWorkspace>>, workspace: string, item: string) {
  await screen.getByRole('button', { name: `${workspace} actions` }).click()
  await screen.getByRole('menuitem', { name: item }).click()
}

test('a workspace is renamed in place; Escape keeps its name', async () => {
  const host = hostSpy()
  const screen = await renderWorkspace()
  catalog(two)
  await choose(screen, 'notes', 'Rename')
  const field = screen.getByRole('textbox', { name: 'Rename notes' })
  await expect.element(field).toHaveFocus()
  await field.fill('Notes and ideas')
  await userEvent.keyboard('{Enter}')
  expect(host.rename).toHaveBeenCalledWith('w3', 'Notes and ideas')
  await expect.poll(workspaceRow('notes')).toBeTruthy()

  await choose(screen, 'notes', 'Rename')
  await screen.getByRole('textbox', { name: 'Rename notes' }).fill('Other')
  await userEvent.keyboard('{Escape}')
  await expect.poll(workspaceRow('notes')).toBeTruthy()
  expect(host.rename).toHaveBeenCalledTimes(1)
})

test('removing a workspace asks first, and a refusal says what is running', async () => {
  const host = hostSpy({
    remove: vi.fn(async () => ({ removed: false as const, reasons: ['“Fix the build” is running'] })),
  })
  const screen = await renderWorkspace()
  catalog(two)
  await choose(screen, 'notes', 'Remove from ADE')
  const dialog = screen.getByRole('alertdialog')
  await expect.element(dialog.getByText('Remove “notes” from ADE?')).toBeVisible()
  await dialog.getByRole('button', { name: 'Remove' }).click()
  expect(host.remove).toHaveBeenCalledWith('w3')
  await expect.element(screen.getByText('“Fix the build” is running.')).toBeVisible()
})

test('only a repository workspace offers to delete its worktree; a blocked one says why without asking', async () => {
  const host = hostSpy({
    checkWorktree: vi.fn(async () => ({ path: '/code/main', reasons: ['It is the project’s main checkout'] })),
  })
  const screen = await renderWorkspace()
  catalog(two)
  await screen.getByRole('button', { name: 'notes actions' }).click()
  await expect.element(screen.getByRole('menuitem', { name: 'Remove from ADE' })).toBeVisible()
  expect(screen.getByRole('menuitem', { name: 'Delete worktree' }).query()).toBeNull()
  await userEvent.keyboard('{Escape}')

  await choose(screen, 'main', 'Delete worktree')
  await expect.element(screen.getByText('It is the project’s main checkout.')).toBeVisible()
  expect(screen.getByRole('alertdialog').query()).toBeNull()
  expect(host.deleteWorktree).not.toHaveBeenCalled()
})

test('deleting a worktree names its folder before it goes', async () => {
  const host = hostSpy()
  const screen = await renderWorkspace()
  catalog(two)
  await choose(screen, 'feature', 'Delete worktree')
  const dialog = screen.getByRole('alertdialog')
  await expect.element(dialog.getByText(/deletes \/code\/feature\. Its branch stays\./)).toBeVisible()
  await dialog.getByRole('button', { name: 'Delete worktree' }).click()
  expect(host.deleteWorktree).toHaveBeenCalledWith('w2')
})

test('a new workspace is a worktree of the project, shown once it is made', async () => {
  const host = hostSpy()
  const screen = await renderWorkspace()
  catalog(two, [], [{ id: 'r1', root: '/code/shop/.git', name: 'shop' }])
  expect(screen.getByRole('button', { name: 'New workspace in notes' }).query()).toBeNull()
  await screen.getByRole('button', { name: 'New workspace in shop' }).click()
  const dialog = screen.getByRole('dialog')
  await expect.element(dialog.getByRole('button', { name: 'Create' })).toBeDisabled()
  await dialog.getByRole('textbox', { name: 'Name' }).fill('  Checkout flow ')
  await userEvent.keyboard('{Enter}')
  expect(host.createWorktree).toHaveBeenCalledWith('w2', 'Checkout flow')
  await expect.poll(() => layoutStore.getState().active).toBe('w9')
  expect(host.select).toHaveBeenCalledWith('w9', null)
})
