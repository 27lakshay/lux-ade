import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { sidebarsThatFit, useSidebarFit } from '../cards/fit'
import { GUTTER, PANE_MIN, SIDEBAR_WIDTH } from '../model/layout'
import { dispatch, layoutStore, openTab } from '../model/layout-store'
import { panes } from '../model/layout-tree'
import { renderWorkspace, resetLayout, section, startDrag } from '../testing'

// The limits that keep a layout tidy: panes never go below their minimum, sidebars give way on a
// narrow window and come back, and the window never gets smaller than the panes need.

beforeEach(() => {
  resetLayout()
  useSidebarFit.setState({ priority: ['navigator', 'inspector'], squeezed: [], room: null })
})
afterEach(() => vi.restoreAllMocks())

const layout = () => layoutStore.getState().layouts.default!
/** Resizes the element the workspace is rendered in, as a window resize would. */
const setWindowWidth = (width: number) => {
  document.querySelector<HTMLElement>('[data-window-frame]')!.style.width = `${width}px`
}
const shown = (label: 'Navigator' | 'Inspector') => section(label)!.getBoundingClientRect().width > 0

test('sidebars fit in priority order beside the centre’s minimum', () => {
  const per = SIDEBAR_WIDTH.min + GUTTER
  expect(sidebarsThatFit({ available: 1000, centreMin: 320, open: ['navigator', 'inspector'] })).toEqual([
    'navigator',
    'inspector',
  ])
  expect(sidebarsThatFit({ available: 320 + per, centreMin: 320, open: ['inspector', 'navigator'] })).toEqual([
    'inspector',
  ])
  expect(sidebarsThatFit({ available: 320 + per - 1, centreMin: 320, open: ['navigator'] })).toEqual([])
})

test('a split that would squeeze a pane below its minimum is refused, and says why', async () => {
  const screen = await renderWorkspace()
  openTab({ kind: 'conversation', title: 'Talk' })
  // 2 conversations need 728px: the centre (about 750px beside both sidebars) has that, 3 do not.
  await screen.getByRole('button', { name: 'Split right' }).click()
  openTab({ kind: 'conversation', title: 'Two' })
  await expect.poll(() => panes(layout().root).length).toBe(2)
  const before = JSON.stringify(layout().root)
  await screen.getByRole('button', { name: 'Split right' }).nth(1).click()
  await expect.element(screen.getByText('No room for another pane')).toBeVisible()
  expect(JSON.stringify(layout().root)).toBe(before)
})

test('a drop that would not fit shows “No room” and changes nothing', async () => {
  await renderWorkspace()
  openTab({ kind: 'conversation', title: 'One' })
  dispatch({ type: 'splitPane', paneId: 'p1', direction: 'row', newPaneId: 'p2' })
  openTab({ kind: 'conversation', title: 'Two' }, 'p2')
  openTab({ kind: 'conversation', title: 'Three' }, 'p2')
  await expect.poll(() => document.querySelectorAll('[role=tab][data-tab-id]').length).toBe(3)
  const before = JSON.stringify(layout().root)
  const three = [...document.querySelectorAll('[role=tab]')].find((tab) => tab.textContent === 'Three')!
  const body = document.querySelectorAll('[data-pane-drop]')[0]!
  const drag = await startDrag(three)
  await drag.over(body, { x: body.getBoundingClientRect().width - 10, y: 200 })
  await expect.poll(() => document.querySelector('[data-drop-zone]')?.textContent).toBe('No room')
  await drag.drop()
  expect(JSON.stringify(layout().root)).toBe(before)
})

test('a narrowing window closes the sidebar opened longest ago, then reopens it; the layout keeps both open', async () => {
  await renderWorkspace()
  openTab({ kind: 'conversation', title: 'Talk' })
  await expect.poll(() => shown('Inspector')).toBe(true)
  // Beside a 360px conversation, both sidebars need 360 + 2 × 208 = 776px of the group; at a
  // 780px window the group has about 710.
  setWindowWidth(780)
  await expect.poll(() => shown('Inspector')).toBe(false)
  expect(shown('Navigator')).toBe(true)
  expect(layout().collapsed).toEqual({ navigator: false, inspector: false })
  setWindowWidth(1440)
  await expect.poll(() => shown('Inspector')).toBe(true)
})

test('opening a sidebar closed for room makes room by closing the other', async () => {
  const screen = await renderWorkspace()
  openTab({ kind: 'conversation', title: 'Talk' })
  setWindowWidth(780)
  await expect.poll(() => shown('Inspector')).toBe(false)
  await screen.getByRole('button', { name: 'Toggle right sidebar' }).click()
  await expect.poll(() => shown('Inspector')).toBe(true)
  await expect.poll(() => shown('Navigator')).toBe(false)
  expect(layout().collapsed).toEqual({ navigator: false, inspector: false })
})

test('the window may not shrink below what the panes need', async () => {
  const setMinimum = vi.fn()
  window.adeHost = { setWindowMinimumSize: setMinimum } as unknown as typeof window.adeHost
  await renderWorkspace()
  dispatch({ type: 'splitPane', paneId: 'p1', direction: 'row', newPaneId: 'p2' })
  await expect.poll(() => setMinimum.mock.calls.length).toBeGreaterThan(0)
  const [width] = setMinimum.mock.calls.at(-1)!
  // Two empty panes and their gutter, plus everything around the centre but the sidebars.
  const outside = window.innerWidth - (document.getElementById('cards')!.clientWidth - 16)
  expect(width).toBe(Math.ceil(outside + 2 * PANE_MIN.width.empty + GUTTER))
  window.adeHost = undefined as unknown as typeof window.adeHost
})
