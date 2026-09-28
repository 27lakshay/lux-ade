import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { TooltipProvider } from '@/components/ui/tooltip'
import '../app/app.css'
import { IconButton } from './IconButton'

test('an icon button is 28px, named by its label, and shows the label and shortcut as a tooltip', async () => {
  const screen = await render(
    <TooltipProvider delay={0}>
      <IconButton
        icon="toggleLeftSidebar"
        label="Toggle left sidebar"
        shortcut={{ appCommand: 'toggle-left-sidebar' }}
      />
    </TooltipProvider>,
  )
  const button = screen.getByRole('button', { name: 'Toggle left sidebar' })
  expect(button.element().getBoundingClientRect().height).toBe(28)
  await button.hover()
  await expect
    .poll(() => document.querySelector('[data-slot="tooltip-content"]')?.textContent)
    .toMatch(/Toggle left sidebar/)
  expect(document.querySelector('[data-slot="tooltip-content"] [data-slot="kbd"]')).not.toBeNull()
})

test('the compact size is 24px, and pressed state is announced', async () => {
  const screen = await render(
    <TooltipProvider>
      <IconButton icon="more" label="More" size="xs" selected />
    </TooltipProvider>,
  )
  const button = screen.getByRole('button', { name: 'More' })
  expect(button.element().getBoundingClientRect().height).toBe(24)
  expect(button.element().getAttribute('aria-pressed')).toBe('true')
})
