import { userEvent } from 'vitest/browser'
import { beforeEach, expect, test } from 'vitest'
import { commandService } from '../../../app/commands'
import { setSizeLabel, noteResizing, useSizeLabels } from '../content/size-label'
import { SIDEBAR_WIDTH, type Tab } from '../model/layout'
import { registerLayoutCommands } from '../model/layout-commands'
import { dispatch, layoutStore, openTab } from '../model/layout-store'
import { panes } from '../model/layout-tree'
import { renderWorkspace, resetLayout, section, startDrag } from '../testing'
import { hitTab } from './TabStrip'

beforeEach(resetLayout)

const layout = () => layoutStore.getState().layouts.default!
const tabEl = (title: string) =>
  [...document.querySelectorAll<HTMLElement>('[role=tab]')].find((tab) => tab.textContent?.trim() === title)!
const pointIn = (element: Element, fx: number) => {
  const rect = element.getBoundingClientRect()
  return { x: rect.width * fx, y: rect.height / 2 }
}
const paneSplitHandle = () => document.getElementById(layout().root.id)!.querySelector(':scope > [role=separator]')!
const paneWidths = () =>
  [...document.querySelectorAll('section[aria-label="Pane"]')].map((pane) =>
    Math.round(pane.getBoundingClientRect().width),
  )

async function panesWith(...titles: string[][]) {
  const screen = await renderWorkspace()
  for (const [index, group] of titles.entries()) {
    if (index > 0)
      dispatch({
        type: 'splitPane',
        paneId: panes(layout().root).at(-1)!.id,
        direction: 'row',
        newPaneId: `p${index + 1}`,
      })
    for (const title of group) openTab({ kind: 'terminal', title } satisfies Omit<Tab, 'id'>, `p${index + 1}`)
  }
  await expect.poll(() => document.querySelectorAll('[role=tab][data-tab-id]').length).toBe(titles.flat().length)
  return screen
}

test('a tab’s outer quarters reorder around it; its middle opens it', () => {
  const tabs = [
    { id: 'a', left: 0, right: 100 },
    { id: 'b', left: 102, right: 202 },
  ]
  expect(hitTab(tabs, 10)).toEqual({ index: 0, over: null })
  expect(hitTab(tabs, 50)).toEqual({ index: 1, over: 'a' })
  expect(hitTab(tabs, 90)).toEqual({ index: 1, over: null })
  expect(hitTab(tabs, 101)).toEqual({ index: 1, over: null })
  expect(hitTab(tabs, 400)).toEqual({ index: 2, over: null })
})

test('dragging over a tab’s edge opens a slot and slides the tabs; over its middle, the tab fills', async () => {
  await panesWith(['A', 'B', 'C'], ['D'])
  // C, opened last, is active; A and B are not.
  const before = tabEl('A').getBoundingClientRect().left
  const drag = await startDrag(tabEl('D'))
  await drag.over(tabEl('A'), pointIn(tabEl('A'), 0.1))
  await expect.poll(() => document.querySelector('[data-tab-slot]')).not.toBeNull()
  await expect.poll(() => tabEl('A').getBoundingClientRect().left - before).toBeGreaterThan(20)
  await drag.over(tabEl('B'), pointIn(tabEl('B'), 0.5))
  await expect.poll(() => document.querySelector('[data-tab-slot]')).toBeNull()
  await expect.poll(() => tabEl('B').querySelector('[data-spring-fill]')).not.toBeNull()
  await drag.drop()
  // Dropped on B's middle: it lands just after B.
  expect(panes(layout().root)[0]!.tabs.map((id) => layout().tabs[id]!.title)).toEqual(['A', 'B', 'D', 'C'])
})

test('a drop settles an outline onto the pane it made and announces it', async () => {
  await panesWith(['A1', 'A2'], ['B1'])
  const body = document.querySelectorAll('[data-pane-drop]')[1]!
  const drag = await startDrag(tabEl('A2'))
  await drag.over(body)
  // The outline starts from the highlight, so drop once it shows, as a person would.
  await expect.poll(() => document.querySelector('[data-drop-zone]')).not.toBeNull()
  await drag.drop()
  await expect.poll(() => document.querySelector('[data-drop-settle]')).not.toBeNull()
  await expect.poll(() => document.querySelector('[data-drop-settle]'), { timeout: 2000 }).toBeNull()
  await expect
    .poll(() => document.querySelector('[role=status]')?.textContent, { timeout: 2000 })
    .toBe('Moved A2 to position 2 of 2 in pane 2 of 2')
})

test('double-clicking a grip maximizes the pane; Restore pane brings the others back', async () => {
  const screen = await panesWith(['A'], ['B'])
  await userEvent.dblClick(document.querySelectorAll('[aria-label="Move pane"]')[0]!.parentElement!)
  await expect.poll(() => document.querySelectorAll('section[aria-label="Pane"]').length).toBe(1)
  expect(layout().maximized).toBe('p1')
  await screen.getByRole('button', { name: 'Restore pane' }).click()
  await expect.poll(() => document.querySelectorAll('section[aria-label="Pane"]').length).toBe(2)
})

test('double-clicking a gutter evens out that split', async () => {
  await panesWith(['A'], ['B'])
  // Room for an uneven split of two 320px-minimum panes.
  dispatch({ type: 'setCollapsed', sidebar: 'navigator', collapsed: true })
  dispatch({ type: 'setCollapsed', sidebar: 'inspector', collapsed: true })
  dispatch({ type: 'setSplitSizes', splitId: layout().root.id, sizes: [70, 30] })
  await remountSplits()
  await expect.poll(() => paneWidths()[0]! > paneWidths()[1]! + 100).toBe(true)
  await userEvent.dblClick(paneSplitHandle())
  await expect.poll(() => Math.abs(paneWidths()[0]! - paneWidths()[1]!)).toBeLessThanOrEqual(2)
})

test('double-clicking a sidebar’s gutter resets its width', async () => {
  dispatch({ type: 'setWidth', sidebar: 'navigator', width: 420 })
  await renderWorkspace()
  const navigator = () =>
    Math.round(document.querySelector('section[aria-label="Navigator"]')!.getBoundingClientRect().width)
  await expect.poll(navigator).toBe(420)
  await userEvent.dblClick(document.getElementById('cards')!.querySelector(':scope > [role=separator]')!)
  await expect.poll(navigator).toBe(SIDEBAR_WIDTH.navigator)
  await expect.poll(() => layout().widths.navigator).toBe(SIDEBAR_WIDTH.navigator)
})

// Sizes set through the store apply when the groups next mount: remount them by maximizing and back.
async function remountSplits(): Promise<void> {
  dispatch({ type: 'toggleMaximize', paneId: 'p1' })
  await expect.poll(() => document.querySelectorAll('section[aria-label="Pane"]').length).toBe(1)
  dispatch({ type: 'toggleMaximize', paneId: 'p1' })
  await expect.poll(() => document.querySelectorAll('section[aria-label="Pane"]').length).toBe(2)
}

test('arrow keys resize a focused gutter', async () => {
  await panesWith(['A'], ['B'])
  const before = paneWidths()[0]!
  ;(paneSplitHandle() as HTMLElement).focus()
  await userEvent.keyboard('{ArrowRight}{ArrowRight}')
  await expect.poll(() => paneWidths()[0]!).toBeGreaterThan(before)
})

test('narrow panes fold their actions into a More menu that works', async () => {
  // Empty panes need only 240px, so three of them beside both sidebars are narrow.
  const screen = await panesWith(['A'], [], [])
  const bar = document.querySelectorAll('[data-tab-bar]')[2]!
  await expect.poll(() => bar.querySelector('[aria-label="Split right"]')?.checkVisibility()).toBe(false)
  const more = bar.querySelector<HTMLElement>('[aria-label="More pane actions"]')!
  expect(more.checkVisibility()).toBe(true)
  more.click()
  await screen.getByRole('menuitem', { name: 'Split down' }).click()
  await expect.poll(() => panes(layout().root).length).toBe(4)
})

test('a tab’s size label shows on its pane only while a gutter is dragged', async () => {
  await panesWith(['Shell'], ['B'])
  const shell = panes(layout().root)[0]!.active!
  setSizeLabel(shell, '120 × 40')
  expect(document.querySelector('[data-size-readout]')).toBeNull()
  paneSplitHandle().setAttribute('data-separator', 'active')
  noteResizing()
  await expect.poll(() => document.querySelector('[data-size-readout]')?.textContent).toBe('120 × 40')
  paneSplitHandle().setAttribute('data-separator', 'inactive')
  await expect.poll(() => useSizeLabels.getState().resizing, { timeout: 2000 }).toBe(false)
  expect(document.querySelector('[data-size-readout]')).toBeNull()
})

test('the window opens at its saved sizes without animating, collapsed sidebars included', async () => {
  dispatch({ type: 'toggleSide', side: 'left' })
  await renderWorkspace()
  await expect.poll(() => document.getElementById('cards')).not.toBeNull()
  expect(document.getElementById('cards')!.dataset.layoutAnimating).toBeUndefined()
})

test('palette commands: equalize, reset and maximize with its shortcut', async () => {
  registerLayoutCommands()
  await panesWith(['A'], ['B'])
  dispatch({ type: 'setSplitSizes', splitId: layout().root.id, sizes: [70, 30] })
  commandService.execute('layout.equalizePanes')
  const root = layout().root
  expect(root.type === 'split' && root.sizes).toEqual([50, 50])
  dispatch({ type: 'setWidth', sidebar: 'inspector', width: 440 })
  const inspector = () =>
    Math.round(document.querySelector('section[aria-label="Inspector"]')!.getBoundingClientRect().width)
  await expect.poll(inspector).toBe(440)
  commandService.execute('layout.resetLayout')
  await expect.poll(inspector).toBe(SIDEBAR_WIDTH.inspector)
  // With the sidebars swapped too, both move back.
  dispatch({ type: 'setWidth', sidebar: 'inspector', width: 440 })
  dispatch({ type: 'swapSidebars' })
  await expect.poll(inspector).toBe(440)
  commandService.execute('layout.resetLayout')
  expect(layout().sidebars).toEqual(['navigator', 'inspector'])
  await expect.poll(inspector).toBe(SIDEBAR_WIDTH.inspector)
  await expect
    .poll(() => section('Navigator')!.getBoundingClientRect().left < section('Inspector')!.getBoundingClientRect().left)
    .toBe(true)
  expect(commandService.keybindingFor('layout.toggleMaximize')).toBe('$mod+Shift+Enter')
  commandService.execute('layout.toggleMaximize')
  expect(layout().maximized).toBe(layout().focusedPane)
})

test('a window saved with sidebars collapsed opens with its panes at full size, and a sidebar opens at its saved width', async () => {
  dispatch({ type: 'setCollapsed', sidebar: 'navigator', collapsed: true })
  dispatch({ type: 'setCollapsed', sidebar: 'inspector', collapsed: true })
  dispatch({ type: 'setWidth', sidebar: 'navigator', width: 300 })
  for (const [index, title] of ['A', 'B', 'C'].entries()) {
    if (index > 0) dispatch({ type: 'splitPane', paneId: `p${index}`, direction: 'row', newPaneId: `p${index + 1}` })
    openTab({ kind: 'terminal', title }, `p${index + 1}`)
  }
  const screen = await renderWorkspace()
  await expect.poll(() => document.querySelectorAll('[data-pane-drop]').length).toBe(3)
  // Every pane at its full size, none squeezed by a sidebar that opened for a frame.
  expect(paneWidths().every((width) => width >= 320)).toBe(true)
  await screen.getByRole('button', { name: 'Toggle left sidebar' }).click()
  await expect.poll(() => Math.round(section('Navigator')!.getBoundingClientRect().width)).toBe(300)
})

test('selecting a tab moves no tab: each is as wide as when selected', async () => {
  await panesWith(['New conversation', 'New conversation 2', 'Build'])
  const boxes = () =>
    [...document.querySelectorAll('[role=tab]')]
      .filter((tab) => tab.closest('[data-tab-bar]'))
      .map((tab) => {
        const rect = tab.getBoundingClientRect()
        return `${rect.left.toFixed(1)}/${rect.width.toFixed(1)}`
      })
  const before = boxes()
  for (const title of ['New conversation', 'New conversation 2', 'Build']) {
    tabEl(title).click()
    await expect.poll(() => tabEl(title).getAttribute('aria-selected')).toBe('true')
    expect(boxes()).toEqual(before)
  }
})
