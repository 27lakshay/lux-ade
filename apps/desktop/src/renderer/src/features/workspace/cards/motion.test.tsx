import { beforeEach, expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { dispatch, layoutNow, swapSidebars, toggleSide } from '../model/layout-store'
import { openTitled, renderWorkspace, resetLayout, section } from '../testing'

beforeEach(resetLayout)

const frame = (): Promise<unknown> => new Promise(requestAnimationFrame)

test('collapsing a sidebar grows the centre frame by frame; its contents stay anchored and are never transformed', async () => {
  const screen = await renderWorkspace()
  await openTitled('terminal', 'Shell')
  await expect.element(screen.getByRole('tab', { name: /Shell/ })).toBeVisible()
  const tab = screen.getByRole('tab', { name: /Shell/ }).element()
  const split = screen.getByRole('button', { name: 'Split right' }).element()
  const pane = section('Pane')!
  const lefts: number[] = []
  void toggleSide('left')
  for (let index = 0; index < 20; index++) {
    const box = pane.getBoundingClientRect()
    lefts.push(Math.round(box.left))
    // The tab keeps its place inside the pane; controls never leave it.
    expect(Math.round(tab.getBoundingClientRect().left - box.left)).toBe(6)
    expect(split.getBoundingClientRect().right).toBeLessThanOrEqual(box.right)
    for (const element of [pane, tab, split]) expect(getComputedStyle(element).transform).toBe('none')
    await frame()
  }
  // It glides: several distinct in-between positions, moving one way only.
  expect(new Set(lefts).size).toBeGreaterThan(4)
  expect(lefts.every((left, index) => index === 0 || left <= lefts[index - 1]!)).toBe(true)
})

test('resizing follows the pointer with no transition, and the new width is saved', async () => {
  await renderWorkspace()
  const width = () => section('Navigator')!.getBoundingClientRect().width
  const before = width()
  const gutter = document.querySelectorAll('[data-separator]')[0] as HTMLElement
  gutter.focus()
  await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')
  const after = width()
  expect(after).toBeGreaterThan(before)
  await frame()
  // Already at its final size: no animation stood between the key and the result.
  expect(width()).toBe(after)
  expect(document.querySelector('[data-layout-animating]')).toBeNull()
  await expect.poll(() => layoutNow().widths.navigator, { timeout: 4000 }).toBe(Math.round(after))
})

test('resizing between split panes saves the new split', async () => {
  const screen = await renderWorkspace()
  await screen.getByRole('button', { name: 'Split right' }).click()
  await expect.poll(() => document.querySelectorAll('[data-separator]').length).toBe(3)
  await expect.poll(() => document.querySelector('[data-layout-animating]')).toBeNull()
  // Gutters in order: left sidebar, the split between panes, right sidebar.
  const between = document.querySelectorAll('[data-separator]')[1] as HTMLElement
  between.focus()
  await userEvent.keyboard('{ArrowRight}{ArrowRight}')
  await expect
    .poll(() => {
      const root = layoutNow().root
      return root.type === 'split' ? root.sizes[0]! : 0
    })
    .toBeGreaterThan(50)
})

test('pressing a handle while a size animation runs ends the animation at once', async () => {
  const screen = await renderWorkspace()
  await screen.getByRole('button', { name: 'Toggle left sidebar' }).click()
  expect(document.querySelector('[data-layout-animating]')).not.toBeNull()
  const gutters = document.querySelectorAll('[data-separator]')
  const right = gutters[gutters.length - 1] as HTMLElement
  right.focus()
  await userEvent.keyboard('{ArrowLeft}')
  expect(document.querySelector('[data-layout-animating]')).toBeNull()
})

test('no scrollbar appears while the sidebars swap, and nothing changes size mid-swap', async () => {
  // Uneven widths, so the centre moves too.
  await dispatch({ type: 'set_width', sidebar: 'inspector', width: 420 })
  await renderWorkspace()
  await expect
    .poll(() => document.querySelector('section[aria-label="Inspector"]')?.getBoundingClientRect().width)
    .toBe(420)
  const cards = document.getElementById('cards')!
  const scrolling = () =>
    [...cards.querySelectorAll<HTMLElement>('*')].filter(
      (element) =>
        /auto|scroll/.test(getComputedStyle(element).overflowX) &&
        !element.closest('[data-slot=scroll-area-viewport]') &&
        element.scrollWidth > element.clientWidth + 1,
    ).length
  const sizes = () =>
    [...cards.querySelectorAll('section')].map((section) => Math.round(section.getBoundingClientRect().width)).join(',')
  const before = sizes()
  await swapSidebars()
  const seen = new Set<string>()
  let worst = 0
  const start = performance.now()
  while (performance.now() - start < 500) {
    await new Promise(requestAnimationFrame)
    worst = Math.max(worst, scrolling())
    seen.add(sizes())
  }
  expect(worst).toBe(0)
  // Only the arrangement before and after: no size in between.
  expect([...seen].filter((set) => set !== before)).toHaveLength(1)
})

test('pressing, dragging or double-clicking a resize handle leaves the focus where it was', async () => {
  await openTitled('terminal', 'Shell')
  await renderWorkspace()
  const tab = await vi.waitFor(() => document.querySelector<HTMLElement>('[role=tab]')!)
  const handle = document
    .getElementById('cards')!
    .querySelector<HTMLElement>(':scope > [role=separator]:not([data-separator=disabled])')!
  tab.focus()
  await userEvent.click(handle)
  expect(document.activeElement).toBe(tab)
  await userEvent.dblClick(handle)
  expect(document.activeElement).toBe(tab)
  await userEvent.dragAndDrop(handle, document.querySelector('section[aria-label="Pane"]')!)
  expect(document.activeElement).toBe(tab)
  // No handle is left looking focused: neither the library's state nor the drawn track.
  await userEvent.hover(document.querySelector('[data-pane-drop]')!)
  const lit = () =>
    [...document.querySelectorAll<HTMLElement>('[role=separator]')].filter((separator) => {
      const track = getComputedStyle(separator.firstElementChild!).backgroundColor
      return separator.dataset.separator === 'focus' || !(track.endsWith('/ 0)') || track.endsWith(', 0)'))
    }).length
  await expect.poll(lit).toBe(0)
  // With nothing focused, nothing gains it.
  tab.blur()
  await userEvent.dblClick(handle)
  expect(document.activeElement).toBe(document.body)
  // The keyboard still reaches the handle, and shows it.
  tab.focus()
  while (document.activeElement !== handle) await userEvent.keyboard('{Tab}')
  await expect.poll(() => getComputedStyle(handle.firstElementChild!).backgroundColor.endsWith('/ 0)')).toBe(false)
})
