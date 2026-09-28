import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import '../app/app.css'
import { Body, Caption, Code, Meta, Text, Title } from './Typography'

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
