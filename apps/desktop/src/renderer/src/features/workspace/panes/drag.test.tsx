import { beforeEach, expect, test } from 'vitest'
import { structureKey, panes } from '../model/layout-tree'
import { dispatch, layoutNow } from '../model/layout-store'
import { dragTo, openTitled, renderWorkspace, resetLayout, startDrag, titleOf } from '../testing'
import { zoneAt } from './drag'
import { SPRING_LOAD_MS } from '../../../app/motion'

beforeEach(resetLayout)

const layout = () => layoutNow()
const titles = (paneIndex = 0) => panes(layout().root)[paneIndex]!.tabs.map((id) => titleOf(id))

test('the zone is the nearest edge within a quarter of the pane, else the centre', () => {
  const rect = new DOMRect(0, 0, 400, 200)
  expect(zoneAt(rect, 20, 100)).toBe('left')
  expect(zoneAt(rect, 390, 100)).toBe('right')
  expect(zoneAt(rect, 200, 10)).toBe('top')
  expect(zoneAt(rect, 200, 195)).toBe('bottom')
  expect(zoneAt(rect, 200, 100)).toBe('centre')
  // In a corner, the nearer edge wins.
  expect(zoneAt(rect, 10, 30)).toBe('left')
})

test('dragging a tab onto another reorders the strip', async () => {
  const screen = await renderWorkspace()
  for (const title of ['One', 'Two', 'Three']) await openTitled('terminal', title)
  await expect.element(screen.getByRole('tab', { name: /Three/ })).toBeVisible()
  const three = screen.getByRole('tab', { name: /Three/ }).element()
  const one = screen.getByRole('tab', { name: /One/ }).element()
  // Onto One's left half: Three lands before it.
  await dragTo(three, one, { x: 4, y: 14 })
  await expect.poll(() => titles()).toEqual(['Three', 'One', 'Two'])
})

test("dragging a tab onto a pane's right edge splits it off", async () => {
  const screen = await renderWorkspace()
  for (const title of ['One', 'Two']) await openTitled('terminal', title)
  await expect.element(screen.getByRole('tab', { name: /Two/ })).toBeVisible()
  const body = document.querySelector('[data-pane-drop]')!
  const width = body.getBoundingClientRect().width
  await dragTo(screen.getByRole('tab', { name: /Two/ }).element(), body, { x: width - 20, y: 200 })
  await expect.poll(() => structureKey(layout().root)).toMatch(/^row\(p1,pane-/)
  expect(titles(0)).toEqual(['One'])
  expect(titles(1)).toEqual(['Two'])
})

/** Two panes side by side, holding the tabs `Left` and `Right`. */
async function twoPanes() {
  const screen = await renderWorkspace()
  await openTitled('terminal', 'Left')
  await screen.getByRole('button', { name: 'Split right' }).click()
  await openTitled('terminal', 'Right')
  await expect.poll(() => panes(layout().root).length).toBe(2)
  return screen
}
const paneGrip = (index: number) => document.querySelectorAll('[aria-label="Move pane"]')[index]!.parentElement!
const paneBody = (index: number) => document.querySelectorAll('[data-pane-drop]')[index]!

test("dragging a pane by its grip onto another pane's centre swaps their places", async () => {
  await twoPanes()
  const [first, second] = panes(layout().root).map((pane) => pane.id)
  await dragTo(paneGrip(1), paneBody(0))
  await expect.poll(() => panes(layout().root).map((pane) => pane.id)).toEqual([second, first])
  expect(titles(0)).toEqual(['Right'])
  expect(titles(1)).toEqual(['Left'])
})

test('a pane over another pane’s centre shows “Swap”, and the dragged pane dims', async () => {
  const screen = await twoPanes()
  const drag = await startDrag(paneGrip(1))
  await drag.over(paneBody(0))
  await expect.element(screen.getByText('Swap')).toBeVisible()
  expect(document.querySelectorAll('section[aria-label="Pane"]')[1]!.className).toContain('opacity-50')
  await drag.cancel()
  await expect.poll(() => document.querySelector('[data-drop-zone]')).toBeNull()
  expect(document.querySelectorAll('section[aria-label="Pane"]')[1]!.className).not.toContain('opacity-50')
})

test('a cancelled drag changes nothing', async () => {
  await twoPanes()
  const before = JSON.stringify(layout())
  const drag = await startDrag(screenTab('Right'))
  await drag.over(paneBody(0), { x: 10, y: 100 })
  await drag.cancel()
  expect(JSON.stringify(layout())).toBe(before)
  expect(document.querySelector('[data-dock-edge]')).toBeNull()
})

const screenTab = (title: string) =>
  [...document.querySelectorAll('[role=tab]')].find((tab) => tab.textContent?.includes(title))!

test('the dock edges appear only while a tab or pane is dragged', async () => {
  await twoPanes()
  expect(document.querySelector('[data-dock-edge]')).toBeNull()
  const sidebar = await startDrag(document.querySelector('[aria-label="Move navigator"]')!.parentElement!)
  expect(document.querySelector('[data-dock-edge]')).toBeNull()
  await sidebar.cancel()
  const pane = await startDrag(paneGrip(0))
  await expect.poll(() => document.querySelectorAll('[data-dock-edge]').length).toBe(4)
  await pane.cancel()
  await expect.poll(() => document.querySelector('[data-dock-edge]')).toBeNull()
})

test('a pane dropped on the bottom dock edge spans the whole width', async () => {
  await twoPanes()
  const [first, second] = panes(layout().root).map((pane) => pane.id)
  const drag = await startDrag(paneGrip(0))
  await expect.poll(() => document.querySelector('[data-dock-edge=bottom]')).not.toBeNull()
  await drag.over(document.querySelector('[data-dock-edge=bottom]')!)
  await drag.drop()
  await expect.poll(() => structureKey(layout().root)).toBe(`column(${second},${first})`)
})

test('a tab dropped on the left dock edge becomes a full-height pane', async () => {
  await twoPanes()
  // Three terminal panes need 976px: room the centre has with the sidebars closed.
  await dispatch({ type: 'set_collapsed', sidebar: 'navigator', collapsed: true })
  await dispatch({ type: 'set_collapsed', sidebar: 'inspector', collapsed: true })
  await expect.poll(() => document.getElementById('centre')!.getBoundingClientRect().width).toBeGreaterThan(1000)
  await openTitled('terminal', 'Extra')
  await expect.poll(() => screenTab('Extra')).toBeTruthy()
  const drag = await startDrag(screenTab('Extra'))
  await expect.poll(() => document.querySelector('[data-dock-edge=left]')).not.toBeNull()
  await drag.over(document.querySelector('[data-dock-edge=left]')!)
  await drag.drop()
  await expect.poll(() => panes(layout().root).length).toBe(3)
  expect(structureKey(layout().root)).toMatch(/^row\(pane-[^,]+,/)
  expect(titles(0)).toEqual(['Extra'])
})

test('the only tab of the only pane cannot dock', async () => {
  const screen = await renderWorkspace()
  await openTitled('terminal', 'Only')
  await expect.element(screen.getByRole('tab', { name: /Only/ })).toBeVisible()
  const before = JSON.stringify(layout())
  const drag = await startDrag(screenTab('Only'))
  await expect.poll(() => document.querySelector('[data-dock-edge=left]')).not.toBeNull()
  await drag.over(document.querySelector('[data-dock-edge=left]')!)
  await drag.drop()
  expect(JSON.stringify(layout())).toBe(before)
})

test('hovering a dragged tab over an inactive tab opens it; passing over does not', async () => {
  await twoPanes()
  await openTitled('terminal', 'Hidden', panes(layout().root)[0]!.id)
  await dispatchActivate('Left')
  const drag = await startDrag(screenTab('Right'))
  await drag.over(screenTab('Hidden'))
  await drag.over(paneBody(0))
  await new Promise((resolve) => setTimeout(resolve, SPRING_LOAD_MS + 150))
  expect(activeTitle(0)).toBe('Left')
  await drag.over(screenTab('Hidden'))
  await expect.poll(() => activeTitle(0), { timeout: SPRING_LOAD_MS + 1000 }).toBe('Hidden')
  await drag.cancel()
})

const activeTitle = (paneIndex: number) => {
  const pane = panes(layout().root)[paneIndex]!
  return pane.active ? titleOf(pane.active) : null
}
async function dispatchActivate(title: string) {
  ;(screenTab(title) as HTMLElement).click()
  await expect.poll(() => activeTitle(0)).toBe(title)
}

test('a pane’s grip never drops into a tab strip, and a tab never swaps panes', async () => {
  await twoPanes()
  const before = JSON.stringify(layout().root)
  await dragTo(paneGrip(1), screenTab('Left'))
  expect(JSON.stringify(layout().root)).toBe(before)
  // A tab on another pane's centre joins it; it never swaps the panes.
  await openTitled('terminal', 'Mover', panes(layout().root)[1]!.id)
  await expect.poll(() => screenTab('Mover')).toBeTruthy()
  await dragTo(screenTab('Mover'), paneBody(0))
  await expect.poll(() => titles(0)).toEqual(['Left', 'Mover'])
  expect(titles(1)).toEqual(['Right'])
})

test('a long tab strip scrolls sideways with the wheel', async () => {
  const screen = await renderWorkspace()
  for (let index = 0; index < 20; index++) await openTitled('terminal', `Tab number ${index}`)
  await expect.element(screen.getByRole('tab', { name: /Tab number 19/ })).toBeVisible()
  const viewport = document
    .querySelector('[data-pane-drop]')!
    .closest('section')!
    .querySelector('[data-slot=scroll-area-viewport]')!
  // The newest tab is active, so the strip has already scrolled to it.
  expect(viewport.scrollLeft).toBeGreaterThan(0)
  viewport.scrollLeft = 0
  viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }))
  await expect.poll(() => viewport.scrollLeft).toBeGreaterThan(0)
})

test('dragging a sidebar by its grip onto the other swaps their sides', async () => {
  await renderWorkspace()
  const left = (label: string) => document.querySelector(`section[aria-label="${label}"]`)!.getBoundingClientRect().left
  expect(left('Navigator')).toBeLessThan(left('Inspector'))
  const grip = document.querySelector('[aria-label="Move navigator"]')!.parentElement!
  await dragTo(grip, document.querySelector('section[aria-label="Inspector"]')!)
  await expect.poll(() => layout().sidebars).toEqual(['inspector', 'navigator'])
  await expect.poll(() => left('Navigator') > left('Inspector')).toBe(true)
})

test('a sidebar cannot be dropped onto a pane, nor a pane onto a sidebar', async () => {
  const screen = await renderWorkspace()
  await openTitled('terminal', 'One')
  await expect.element(screen.getByRole('tab', { name: /One/ })).toBeVisible()
  const before = JSON.stringify(layout())
  await dragTo(
    document.querySelector('[aria-label="Move navigator"]')!.parentElement!,
    document.querySelector('[data-pane-drop]')!,
  )
  await dragTo(
    document.querySelector('[aria-label="Move pane"]')!.parentElement!,
    document.querySelector('section[aria-label="Inspector"]')!,
  )
  expect(JSON.stringify(layout())).toBe(before)
})

test('swapping two panes back and forth never breaks the resize groups', async () => {
  await twoPanes()
  const errors: unknown[] = []
  const onError = (event: ErrorEvent): void => void errors.push(event.error)
  window.addEventListener('error', onError)
  const [first, second] = panes(layout().root).map((pane) => pane.id)
  for (let round = 0; round < 4; round++) {
    await dispatch({ type: 'swap_panes', pane_id: first!, target_id: second! })
    await expect.poll(() => document.querySelectorAll('section[aria-label="Pane"]').length).toBe(2)
  }
  window.removeEventListener('error', onError)
  expect(errors).toEqual([])
  expect(document.body.textContent).not.toContain('Something went wrong')
})

test('nothing in the centre overflows while a drag shows the dock edges', async () => {
  await twoPanes()
  const drag = await startDrag(paneGrip(0))
  await expect.poll(() => document.querySelectorAll('[data-dock-edge]').length).toBe(4)
  const centre = document.getElementById('centre')!
  const overflowing = [centre, ...centre.querySelectorAll<HTMLElement>('*')].filter(
    (element) =>
      !element.closest('[data-slot=scroll-area-viewport]') &&
      (element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1),
  )
  await drag.cancel()
  expect(overflowing.map((element) => element.className)).toEqual([])
})
