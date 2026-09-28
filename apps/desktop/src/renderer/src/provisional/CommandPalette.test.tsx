import { expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import '../app/app.css'
import { createCommandService } from '../commands/command-service'
import { CommandPalette, openCommandPalette } from './CommandPalette'

test('the palette lists available commands with their shortcuts and runs the one picked', async () => {
  const service = createCommandService()
  const run = vi.fn()
  service.registerCommand({ id: 'theme.dark', title: 'Use dark theme', category: 'Appearance', run })
  service.registerCommand({ id: 'hidden', title: 'Hidden command', when: 'never', run: () => undefined })
  service.registerKeybinding({ key: '$mod+K $mod+T', command: 'theme.dark' })

  const screen = await render(<CommandPalette service={service} />)
  openCommandPalette()

  const item = screen.getByRole('option', { name: /Use dark theme/ })
  await expect.element(item).toBeVisible()
  await expect.element(screen.getByText('Appearance')).toBeVisible()
  await expect.element(screen.getByText('Hidden command')).not.toBeInTheDocument()
  await item.click()
  expect(run).toHaveBeenCalledOnce()
  await expect.element(item).not.toBeInTheDocument()
})
