import { beforeEach, expect, test } from 'vitest'
import { userEvent } from 'vitest/browser'
import { layoutStore, toggleSide } from '../model/layout-store'
import { renderWorkspace, resetLayout, section } from '../testing'

beforeEach(resetLayout)

// Samples an element's transform every frame for a while.
async function transformsOf(element: Element, frames = 20): Promise<string[]> {
  const seen: string[] = []
  for (let frame = 0; frame < frames; frame++) {
    seen.push(getComputedStyle(element).transform)
    await new Promise(requestAnimationFrame)
  }
  return seen
}
const scaleOf = (transform: string): number => (transform === 'none' ? 1 : new DOMMatrixReadOnly(transform).a)
const layers = () => {
  const card = section('Pane')!
  return { surface: card.children[0]!, content: card.children[1]! }
}

test('collapsing a sidebar animates the centre card; its content moves but is never scaled', async () => {
  await renderWorkspace()
  const { surface, content } = layers()
  toggleSide('left')
  const [surfaceFrames, contentFrames] = await Promise.all([transformsOf(surface), transformsOf(content)])
  // The background layer animates into the new space…
  expect(surfaceFrames.some((transform) => transform !== 'none')).toBe(true)
  // …while the content only ever moves.
  expect(contentFrames.every((transform) => scaleOf(transform) === 1)).toBe(true)
  expect(contentFrames.some((transform) => transform !== 'none')).toBe(true)
})

test('resizing never starts a layout animation, and the new width is saved', async () => {
  await renderWorkspace()
  const { surface, content } = layers()
  const width = () => section('Navigator')!.getBoundingClientRect().width
  const before = width()
  const gutter = document.querySelectorAll('[data-separator]')[0] as HTMLElement
  gutter.focus()
  await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')
  const frames = [...(await transformsOf(surface, 10)), ...(await transformsOf(content, 10))]
  expect(width()).toBeGreaterThan(before)
  expect(frames.every((transform) => transform === 'none')).toBe(true)
  await expect
    .poll(() => layoutStore.getState().layouts.default!.widths.navigator, { timeout: 4000 })
    .toBe(Math.round(width()))
})

test('resizing between split panes saves the new split', async () => {
  const screen = await renderWorkspace()
  await screen.getByRole('button', { name: 'Split right' }).click()
  await expect.poll(() => document.querySelectorAll('[data-separator]').length).toBe(3)
  // Gutters in order: left sidebar, the split between panes, right sidebar.
  const between = document.querySelectorAll('[data-separator]')[1] as HTMLElement
  between.focus()
  await userEvent.keyboard('{ArrowRight}{ArrowRight}')
  await expect
    .poll(() => {
      const root = layoutStore.getState().layouts.default!.root
      return root.type === 'split' ? root.sizes[0]! : 0
    })
    .toBeGreaterThan(50)
})
