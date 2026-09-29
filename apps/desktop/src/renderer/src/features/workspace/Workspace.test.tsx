import { beforeEach, expect, test } from 'vitest'
import { layoutNow, swapSidebars } from './model/layout-store'
import { renderWorkspace, resetLayout, section } from './testing'

beforeEach(resetLayout)

const centre = (element: Element | null | undefined): number => {
  const rect = element!.getBoundingClientRect()
  return Math.round(rect.top + rect.height / 2)
}

test('rows line up across the rail and every card, as in the design', async () => {
  await renderWorkspace()
  const rail = [...document.querySelectorAll('nav[aria-label="Sections"] button')]
  const top = [
    centre(rail[0]),
    centre(section('Navigator')?.querySelector('button')),
    centre(section('Pane')?.querySelector('[role="tablist"]')?.parentElement),
    centre(section('Inspector')?.querySelector('[role="tablist"]')?.parentElement),
  ]
  // The title bar is 40px; every first row is centred 28px below it (8px gutter + 20).
  expect(top).toEqual([68, 68, 68, 68])
  expect(centre(rail.at(-1))).toBe(centre(document.querySelector('button[aria-label="Add project"]')))
  const grips = [...document.querySelectorAll('[aria-label^="Move"]')].map(centre)
  expect(new Set(grips).size).toBe(1)
})

test('the title-bar toggles collapse and restore the sidebar on that side', async () => {
  const screen = await renderWorkspace()
  const paneWidth = () => section('Pane')!.getBoundingClientRect().width
  const before = paneWidth()
  await screen.getByRole('button', { name: 'Toggle left sidebar' }).click()
  await expect.poll(() => section('Navigator')!.getBoundingClientRect().width).toBe(0)
  expect(paneWidth()).toBeGreaterThan(before)
  await screen.getByRole('button', { name: 'Toggle left sidebar' }).click()
  await expect.poll(paneWidth).toBe(before)
})

test('tabs open in the pane, and the pane splits and closes', async () => {
  const screen = await renderWorkspace()
  await screen.getByRole('button', { name: 'New tab' }).click()
  await screen.getByRole('menuitem', { name: /New conversation/ }).click()
  await expect.element(screen.getByRole('tab', { name: /New conversation/ })).toBeVisible()
  await screen.getByRole('button', { name: 'Split right' }).click()
  await expect.poll(() => document.querySelectorAll('section[aria-label="Pane"]').length).toBe(2)
  // The new, focused pane is empty.
  await expect.element(screen.getByText('Nothing open in this pane')).toBeVisible()
  await screen.getByRole('button', { name: 'Close pane' }).nth(1).click()
  await expect.poll(() => document.querySelectorAll('section[aria-label="Pane"]').length).toBe(1)
})

test('swapping sidebars moves each to the other side', async () => {
  await renderWorkspace()
  const left = (label: string) => section(label)!.getBoundingClientRect().left
  expect(left('Navigator')).toBeLessThan(left('Inspector'))
  await swapSidebars()
  await expect.poll(() => left('Navigator') > left('Inspector')).toBe(true)
})

test('restoring a sidebar keeps its exact width when the gutter finishes resizing', async () => {
  const screen = await renderWorkspace()
  const paneWidth = () => section('Pane')!.getBoundingClientRect().width
  const before = paneWidth()
  const saved = { ...layoutNow().widths }
  await screen.getByRole('button', { name: 'Toggle left sidebar' }).click()
  await expect.poll(() => section('Navigator')!.getBoundingClientRect().width).toBe(0)
  await expect.poll(() => document.querySelector('[data-layout-animating]')).toBeNull()

  // Hold the opening gutter just short of its final 8px. The real panel library
  // must reconcile its pixel shares after this last part of the transition.
  const gutter = document.querySelector('[aria-label="Resize navigator"]') as HTMLElement
  gutter.style.transition = 'none'
  gutter.style.width = '7px'
  expect(gutter.getBoundingClientRect().width).toBe(7)
  try {
    await screen.getByRole('button', { name: 'Toggle left sidebar' }).click()
  } finally {
    gutter.style.removeProperty('width')
    gutter.style.removeProperty('transition')
  }
  await expect.poll(() => section('Navigator')!.getBoundingClientRect().width).toBe(saved.navigator)
  await expect.poll(() => section('Inspector')!.getBoundingClientRect().width).toBe(saved.inspector)
  await expect.poll(paneWidth).toBe(before)
  expect(layoutNow().widths).toEqual(saved)
})
