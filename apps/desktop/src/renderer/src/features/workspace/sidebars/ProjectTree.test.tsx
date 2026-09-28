import type { Conversation, Workspace } from '@ade/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
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
const catalog = (workspaces: Workspace[], conversations: Conversation[] = []) =>
  setCatalog({ workspaces, conversations })
const two = [workspace('w1', 'main', 'r1'), workspace('w2', 'feature', 'r1'), workspace('w3', 'notes', null)]
/** A workspace row (second level), by its name. */
const workspaceRow = (name: string) => () =>
  [...document.querySelectorAll<HTMLElement>('[aria-label="Projects"] > li > ul > li > button')].find(
    (row) => row.textContent === name,
  )
const selectSpy = () => {
  const select = vi.fn(async () => true)
  window.adeHost = {
    workspaces: { select, choose: vi.fn() },
    setWindowMinimumSize: vi.fn(),
  } as unknown as typeof window.adeHost
  return select
}

test('lists projects, their workspaces and conversations from the catalog', async () => {
  const screen = await renderWorkspace()
  catalog(two, [conversation('c1', 'w2', 'Fix the build', 'running')])
  const projects = screen.getByRole('list', { name: 'Projects' })
  await expect.element(projects.getByRole('button', { name: /Fix the build/ })).toBeVisible()
  const rows = (selector: string) => [...projects.element().querySelectorAll(selector)].map((row) => row.textContent)
  // Grouped by repository and sorted; until project names arrive, a project takes its first
  // workspace's name.
  expect(rows(':scope > li > button')).toEqual(['feature', 'notes'])
  expect(rows(':scope > li:first-child > ul > li > button')).toEqual(['feature', 'main'])
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
  document.querySelector<HTMLElement>('[aria-label="Projects"] > li > button')!.click()
  await expect.poll(workspaceRow('main')).toBeFalsy()
  void screen
  expect(JSON.parse(localStorage.getItem('ade.navigator.collapsed:main')!)).toEqual(['r1'])
})

test('with no projects, the navigator says so', async () => {
  const screen = await renderWorkspace()
  catalog([])
  await expect.element(screen.getByText('No projects yet')).toBeVisible()
})
