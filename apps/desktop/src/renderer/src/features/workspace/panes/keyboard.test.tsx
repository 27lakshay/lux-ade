import { userEvent } from 'vitest/browser'
import { beforeEach, expect, test } from 'vitest'
import { commandService } from '../../../app/commands'
import { registerLayoutCommands } from '../model/layout-commands'
import { dispatch, layoutStore, openTab } from '../model/layout-store'
import { panes } from '../model/layout-tree'
import { renderWorkspace, resetLayout, section } from '../testing'
import { tabAfterKey } from './TabStrip'

// Everything the mouse does to tabs and sizes, the keyboard can do too.

beforeEach(resetLayout)
const layout = () => layoutStore.getState().layouts.default!
const titleOf = (id: string | null) => (id ? layout().tabs[id]!.title : null)

test('arrow keys, Home and End pick the tab they move to, and stop at the ends', () => {
  const pane = { type: 'pane' as const, id: 'p', tabs: ['a', 'b', 'c'], active: 'b' }
  expect(tabAfterKey(pane, 'ArrowRight')).toBe('c')
  expect(tabAfterKey(pane, 'ArrowLeft')).toBe('a')
  expect(tabAfterKey(pane, 'Home')).toBe('a')
  expect(tabAfterKey(pane, 'End')).toBe('c')
  expect(tabAfterKey({ ...pane, active: 'c' }, 'ArrowRight')).toBeNull()
  expect(tabAfterKey(pane, 'x')).toBeNull()
})

test('the keyboard moves between tabs: one Tab stop, then arrows, Home and End', async () => {
  await renderWorkspace()
  for (const title of ['One', 'Two', 'Three']) openTab({ kind: 'terminal', title })
  const tab = (title: string) =>
    [...document.querySelectorAll<HTMLElement>('[data-tab-bar] [role=tab]')].find((e) => e.textContent === title)!
  await expect.poll(() => tab('Three')).toBeTruthy()
  tab('Three').focus()
  await userEvent.keyboard('{ArrowLeft}')
  await expect.poll(() => titleOf(panes(layout().root)[0]!.active)).toBe('Two')
  await expect.poll(() => document.activeElement).toBe(tab('Two'))
  await userEvent.keyboard('{Home}')
  await expect.poll(() => document.activeElement).toBe(tab('One'))
  await userEvent.keyboard('{End}')
  await expect.poll(() => document.activeElement).toBe(tab('Three'))
  // Only the active tab is a Tab stop, and it names the panel it controls.
  expect([...document.querySelectorAll('[data-tab-bar] [role=tab]')].map((e) => e.getAttribute('tabindex'))).toEqual([
    '-1',
    '-1',
    '0',
  ])
  const panel = document.getElementById(tab('Three').getAttribute('aria-controls')!)!
  expect(panel.getAttribute('role')).toBe('tabpanel')
  expect(panel.getAttribute('aria-labelledby')).toBe(tab('Three').id)
})

test('the inspector’s views work the same way, and never change width', async () => {
  await renderWorkspace()
  const view = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('section[aria-label="Inspector"] [role=tab]')].find(
      (e) => e.textContent === name,
    )!
  await expect.poll(() => view('Changes')).toBeTruthy()
  const widths = () => ['Changes', 'Files', 'Preview'].map((name) => view(name).getBoundingClientRect().width)
  const before = widths()
  view('Changes').focus()
  await userEvent.keyboard('{ArrowRight}')
  await expect.poll(() => view('Files').getAttribute('aria-selected')).toBe('true')
  expect(document.activeElement).toBe(view('Files'))
  expect(widths()).toEqual(before)
})

test('every resize handle says what it resizes; Escape goes back to the focused pane', async () => {
  await renderWorkspace()
  openTab({ kind: 'terminal', title: 'Shell' })
  dispatch({ type: 'splitPane', paneId: 'p1', direction: 'row', newPaneId: 'p2' })
  await expect.poll(() => document.querySelectorAll('section[aria-label="Pane"]').length).toBe(2)
  const names = [...document.querySelectorAll('[role=separator]')].map((e) => e.getAttribute('aria-label'))
  expect(names).toEqual(expect.arrayContaining(['Resize navigator', 'Resize inspector', 'Resize panes side by side']))
  const tab = document.querySelector<HTMLElement>('[data-tab-bar] [role=tab]')!
  tab.focus()
  const handle = document.getElementById(layout().root.id)!.querySelector<HTMLElement>(':scope > [role=separator]')!
  while (document.activeElement !== handle) await userEvent.keyboard('{Tab}')
  await userEvent.keyboard('{Escape}')
  expect(document.activeElement).toBe(tab)
})

test('Ctrl+Cmd+Arrow grows the focused pane, never past the pane beyond’s minimum', async () => {
  registerLayoutCommands()
  await renderWorkspace()
  dispatch({ type: 'splitPane', paneId: 'p1', direction: 'row', newPaneId: 'p2' })
  dispatch({ type: 'focusPane', paneId: 'p1' })
  await expect.poll(() => document.querySelectorAll('section[aria-label="Pane"]').length).toBe(2)
  const width = () => section('Pane')!.getBoundingClientRect().width
  const before = width()
  commandService.execute('layout.growRight')
  await expect.poll(() => Math.round(width() - before)).toBe(32)
  for (let i = 0; i < 20; i++) commandService.execute('layout.growMoreRight')
  // The pane beyond is empty: it keeps its 240px.
  await expect
    .poll(() => Math.round(document.querySelectorAll('section[aria-label="Pane"]')[1]!.getBoundingClientRect().width))
    .toBe(240)
  expect(commandService.keybindingFor('layout.growRight')).toBe('$mod+Control+ArrowRight')
})
