import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import '../app/app.css'
import { Button } from '@/components/ui/button'
import { Body, Caption, Code, Heading, Meta, Text, Title } from './Typography'

const style = (element: Element) => {
  const computed = getComputedStyle(element)
  return { size: computed.fontSize, weight: computed.fontWeight }
}

test('each component draws its step of the type scale', async () => {
  const screen = await render(
    <>
      <Title>Title</Title>
      <Body>Body</Body>
      <Text>Text</Text>
      <Caption>Caption</Caption>
      <Meta>Meta</Meta>
      <Code>Code</Code>
    </>,
  )
  const of = (text: string) => style(screen.getByText(text, { exact: true }).element())
  expect(of('Title')).toEqual({ size: '15px', weight: '600' })
  expect(of('Body')).toEqual({ size: '14px', weight: '400' })
  expect(of('Text')).toEqual({ size: '13px', weight: '400' })
  expect(of('Caption')).toEqual({ size: '12px', weight: '400' })
  expect(of('Meta')).toEqual({ size: '11px', weight: '400' })
  expect(of('Code')).toEqual({ size: '12px', weight: '400' })
  expect(getComputedStyle(screen.getByText('Code').element()).fontFamily).toMatch(/mono/i)
})

test('components render sensible elements, and `as` changes them', async () => {
  const screen = await render(
    <>
      <Title>Heading</Title>
      <Title as="h1">Page</Title>
      <Body>Paragraph</Body>
      <Meta as="time">2m</Meta>
    </>,
  )
  await expect.element(screen.getByRole('heading', { level: 2, name: 'Heading' })).toBeInTheDocument()
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Page' })).toBeInTheDocument()
  expect(screen.getByText('Paragraph').element().tagName).toBe('P')
  expect(screen.getByText('2m').element().tagName).toBe('TIME')
})

test('tone, weight and truncation', async () => {
  const screen = await render(
    <div style={{ width: 60 }}>
      <Text tone="muted" weight="medium">
        Muted
      </Text>
      <Meta tone="default">Plain</Meta>
      <Text truncate as="div">
        a-very-long-branch-name
      </Text>
    </div>,
  )
  const muted = screen.getByText('Muted').element()
  expect(getComputedStyle(muted).fontWeight).toBe('500')
  expect(getComputedStyle(muted).color).not.toBe(getComputedStyle(screen.getByText('Plain').element()).color)
  const long = screen.getByText('a-very-long-branch-name').element()
  expect(long.scrollWidth).toBeGreaterThan(long.clientWidth)
  expect(getComputedStyle(long).textOverflow).toBe('ellipsis')
})

test('headings for full-screen views are 20 and 28px', async () => {
  const screen = await render(
    <>
      <Heading>Settings</Heading>
      <Heading level="display">Welcome to ADE</Heading>
    </>,
  )
  expect(getComputedStyle(screen.getByRole('heading', { name: 'Settings' }).element()).fontSize).toBe('20px')
  expect(getComputedStyle(screen.getByRole('heading', { name: 'Welcome to ADE' }).element()).fontSize).toBe('28px')
})

test('text is set in Inter and code in JetBrains Mono, both bundled', async () => {
  const screen = await render(
    <>
      <Text>Inter</Text>
      <Code>mono</Code>
    </>,
  )
  expect(getComputedStyle(screen.getByText('Inter').element()).fontFamily).toMatch(/^"?Inter Variable/)
  expect(getComputedStyle(screen.getByText('mono').element()).fontFamily).toMatch(/^"?JetBrains Mono Variable/)
  await document.fonts.ready
  expect(document.fonts.check('13px "Inter Variable"')).toBe(true)
  expect(document.fonts.check('12px "JetBrains Mono Variable"')).toBe(true)
})

test("the kit's text sits on the same scale as ADE's rows", async () => {
  // Kit buttons and menus use text-sm; the theme moves it to 13px, the size of <Text>.
  const screen = await render(<Button>Commit</Button>)
  expect(getComputedStyle(screen.getByRole('button', { name: 'Commit' }).element()).fontSize).toBe('13px')
})

test('chrome text cannot be selected, content can', async () => {
  const screen = await render(
    <>
      <Text>Row</Text>
      <Body>Message</Body>
      <Code>path</Code>
      <Text selectable>Copyable</Text>
    </>,
  )
  const select = (text: string) => getComputedStyle(screen.getByText(text).element()).userSelect
  expect([select('Row'), select('Message'), select('path'), select('Copyable')]).toEqual([
    'none',
    'text',
    'text',
    'text',
  ])
})

test('numbers, line clamps and inline code', async () => {
  const screen = await render(
    <div style={{ width: 120 }}>
      <Meta numeric>+12 −3</Meta>
      <Body lines={2}>A message long enough to need more than two lines at this narrow width, so it is cut.</Body>
      <Body>
        Run <Code size="inline">pnpm dev</Code> first.
      </Body>
    </div>,
  )
  expect(getComputedStyle(screen.getByText('+12 −3').element()).fontVariantNumeric).toBe('tabular-nums')
  const clamped = screen.getByText(/A message long enough/).element()
  expect(clamped.getBoundingClientRect().height).toBe(44)
  expect(parseFloat(getComputedStyle(screen.getByText('pnpm dev').element()).fontSize)).toBeCloseTo(14 * 0.92, 1)
})
