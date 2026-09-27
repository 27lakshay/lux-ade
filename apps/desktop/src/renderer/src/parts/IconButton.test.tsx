import { expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { IconButton } from './IconButton'

test('is a named button that reports its pressed state and clicks', async () => {
  const onClick = vi.fn()
  const screen = await render(
    <IconButton label="Toggle sidebar" pressed onClick={onClick}>
      <span />
    </IconButton>,
  )
  const button = screen.getByRole('button', { name: 'Toggle sidebar' })
  await expect.element(button).toHaveAttribute('aria-pressed', 'true')
  await button.click()
  expect(onClick).toHaveBeenCalledOnce()
})
