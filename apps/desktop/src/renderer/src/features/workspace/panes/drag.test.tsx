import { beforeEach, expect, test } from 'vitest'
import { structureKey, panes } from '../model/layout.logic'
import { layoutStore, openTab } from '../model/layout-store'
import { dragTo, renderWorkspace, resetLayout } from '../testing'
import { zoneAt } from './drag'

beforeEach(resetLayout)

const layout = () => layoutStore.getState().layouts.default!
const titles = (paneIndex = 0) => panes(layout().root)[paneIndex]!.tabs.map((id) => layout().tabs[id]!.title)

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
  for (const title of ['One', 'Two', 'Three']) openTab({ kind: 'terminal', title })
  await expect.element(screen.getByRole('tab', { name: /Three/ })).toBeVisible()
  const three = screen.getByRole('tab', { name: /Three/ }).element()
  const one = screen.getByRole('tab', { name: /One/ }).element()
  // Onto One's left half: Three lands before it.
  await dragTo(three, one, { x: 4, y: 14 })
  await expect.poll(() => titles()).toEqual(['Three', 'One', 'Two'])
})

test("dragging a tab onto a pane's right edge splits it off", async () => {
  const screen = await renderWorkspace()
  for (const title of ['One', 'Two']) openTab({ kind: 'terminal', title })
  await expect.element(screen.getByRole('tab', { name: /Two/ })).toBeVisible()
  const body = document.querySelector('[data-pane-drop]')!
  const width = body.getBoundingClientRect().width
  await dragTo(screen.getByRole('tab', { name: /Two/ }).element(), body, { x: width - 20, y: 200 })
  await expect.poll(() => structureKey(layout().root)).toMatch(/^row\(p1,pane-/)
  expect(titles(0)).toEqual(['One'])
  expect(titles(1)).toEqual(['Two'])
})

test("dragging a pane by its grip onto another pane's centre merges their tabs", async () => {
  const screen = await renderWorkspace()
  openTab({ kind: 'terminal', title: 'Left' })
  await screen.getByRole('button', { name: 'Split right' }).click()
  openTab({ kind: 'terminal', title: 'Right' })
  await expect.poll(() => panes(layout().root).length).toBe(2)
  const grips = document.querySelectorAll('[aria-label="Move pane"]')
  const leftBody = document.querySelectorAll('[data-pane-drop]')[0]!
  await dragTo(grips[1]!.parentElement!, leftBody)
  await expect.poll(() => panes(layout().root).length).toBe(1)
  expect(titles(0)).toEqual(['Left', 'Right'])
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
  openTab({ kind: 'terminal', title: 'One' })
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
