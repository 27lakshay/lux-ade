import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { Button } from '@/components/ui/button'
import '../app/app.css'
import { Icon, IconProvider } from './Icon'
import { icons, type IconName } from './icons'

const width = (element: Element): number => element.getBoundingClientRect().width

test('the size scale is 12, 14, 16 and 18px, and 16px when unset', async () => {
  const screen = await render(
    <IconProvider>
      <Icon name="terminal" size="xs" data-testid="xs" />
      <Icon name="terminal" size="sm" data-testid="sm" />
      <Icon name="terminal" size="md" data-testid="md" />
      <Icon name="terminal" size="lg" data-testid="lg" />
      <Icon name="terminal" data-testid="unset" />
    </IconProvider>,
  )
  const sizes = ['xs', 'sm', 'md', 'lg', 'unset'].map((id) => width(screen.getByTestId(id).element()))
  expect(sizes).toEqual([12, 14, 16, 18, 16])
})

test('inside a kit component an unsized icon takes the kit size', async () => {
  // The kit sizes icons that carry no size- class; a small button's icons are 14px.
  const screen = await render(
    <IconProvider>
      <Button size="sm">
        <Icon name="new" data-testid="icon" />
        New
      </Button>
    </IconProvider>,
  )
  expect(width(screen.getByTestId('icon').element())).toBe(14)
})

test('the stroke is the same number of screen pixels at every size', async () => {
  const screen = await render(
    <IconProvider>
      <Icon name="close" size="xs" data-testid="icon" />
    </IconProvider>,
  )
  const path = screen.getByTestId('icon').element().querySelector('path')!
  expect(path.getAttribute('vector-effect')).toBe('non-scaling-stroke')
  expect(screen.getByTestId('icon').element().getAttribute('stroke-width')).toBe('1.25')
})

test('an icon keeps its size beside text too long for the row', async () => {
  const screen = await render(
    <IconProvider>
      <div style={{ display: 'flex', width: 80 }}>
        <Icon name="file" size="sm" data-testid="icon" />
        <span>a-very-long-file-name-that-does-not-fit.tsx</span>
      </div>
    </IconProvider>,
  )
  expect(width(screen.getByTestId('icon').element())).toBe(14)
})

test('icons are hidden from screen readers unless labelled', async () => {
  const screen = await render(
    <IconProvider>
      <Icon name="error" data-testid="decorative" />
      <Icon name="error" label="Failed" />
    </IconProvider>,
  )
  expect(screen.getByTestId('decorative').element().getAttribute('aria-hidden')).toBe('true')
  await expect.element(screen.getByRole('img', { name: 'Failed' })).toBeInTheDocument()
})

test('every icon in the table renders', async () => {
  const names = Object.keys(icons) as IconName[]
  const screen = await render(
    <IconProvider>
      {names.map((name) => (
        <Icon key={name} name={name} data-testid={name} />
      ))}
    </IconProvider>,
  )
  for (const name of names) expect(screen.getByTestId(name).element().tagName).toBe('svg')
})
