import { userEvent } from 'vitest/browser'
import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import '../app/app.css'
import { Row } from './Row'

const box = (element: Element) => element.getBoundingClientRect()
const fill = (element: Element) => getComputedStyle(element).backgroundColor
const colour = (value: string) => {
  const probe = document.createElement('span')
  probe.style.backgroundColor = value
  document.body.append(probe)
  const computed = getComputedStyle(probe).backgroundColor
  probe.remove()
  return computed
}

test('a row is 28px, indents 16px per level and truncates its title', async () => {
  const screen = await render(
    <div style={{ width: 160 }}>
      <Row>lux-ade</Row>
      <Row depth={2}>a-branch-name-too-long-for-this-row</Row>
    </div>,
  )
  const top = screen.getByRole('button', { name: 'lux-ade' }).element()
  const nested = screen.getByRole('button', { name: /a-branch-name/ }).element()
  expect(box(top).height).toBe(28)
  expect(getComputedStyle(nested).paddingInlineStart).toBe('40px')
  expect(box(nested).width).toBe(160)
})

test('selected rows use the accent fill; others stay clear until hovered', async () => {
  const screen = await render(
    <>
      <Row selected>main</Row>
      <Row>feat/settings</Row>
    </>,
  )
  expect(fill(screen.getByRole('button', { name: 'main' }).element())).toBe(colour('var(--accent)'))
  const plain = screen.getByRole('button', { name: 'feat/settings' })
  expect(fill(plain.element())).toBe('rgba(0, 0, 0, 0)')
  await plain.hover()
  // Hover uses the shared 100ms color transition; observe its settled fill.
  await expect.poll(() => fill(plain.element())).toBe(colour('var(--muted)'))
})

test('keyboard focus draws a ring; a click does not', async () => {
  const screen = await render(
    <>
      <Row>first</Row>
      <Row>second</Row>
    </>,
  )
  const first = screen.getByRole('button', { name: 'first' })
  await first.click()
  expect(getComputedStyle(first.element()).boxShadow).toBe('none')
  await userEvent.tab()
  expect(getComputedStyle(screen.getByRole('button', { name: 'second' }).element()).boxShadow).not.toBe('none')
})

test('disabled rows fade and ignore the pointer', async () => {
  const screen = await render(<Row disabled>archived</Row>)
  const row = screen.getByRole('button', { name: 'archived' }).element()
  expect(getComputedStyle(row).opacity).toBe('0.5')
  expect(getComputedStyle(row).pointerEvents).toBe('none')
})
