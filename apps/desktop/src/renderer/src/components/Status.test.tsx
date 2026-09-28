import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import '../app/app.css'
import { Status } from './Status'

const colour = (value: string): string => {
  const probe = document.createElement('span')
  probe.style.backgroundColor = value
  document.body.append(probe)
  const computed = getComputedStyle(probe).backgroundColor
  probe.remove()
  return computed
}

test('each state is named for screen readers and drawn in its colour', async () => {
  const screen = await render(
    <>
      <Status state="needsYou" />
      <Status state="running" />
      <Status state="error" />
      <Status state="done" />
      <Status state="idle" label="Nothing running" />
    </>,
  )
  const dot = (name: string) => screen.getByRole('img', { name }).element().firstElementChild!
  expect(getComputedStyle(dot('Needs you')).backgroundColor).toBe(colour('var(--attention)'))
  expect(getComputedStyle(dot('Running')).backgroundColor).toBe(colour('var(--running)'))
  expect(getComputedStyle(dot('Error')).backgroundColor).toBe(colour('var(--destructive)'))
  expect(getComputedStyle(dot('Done')).backgroundColor).toBe(colour('var(--success)'))
  await expect.element(screen.getByRole('img', { name: 'Nothing running' })).toBeInTheDocument()
})
