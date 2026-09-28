import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { Shortcut } from './Shortcut'
import { isMac } from '@/lib/shortcut'

test('an app command shows the key the native menu binds', async () => {
  const screen = await render(<Shortcut appCommand="command-palette" />)
  await expect.element(screen.getByText(isMac() ? '⌘⇧P' : 'Ctrl+Shift+P')).toBeInTheDocument()
})

test('a chord shows one key group per step', async () => {
  const screen = await render(<Shortcut keys="$mod+K $mod+K" />)
  expect(screen.container.querySelectorAll('[data-slot="kbd"]')).toHaveLength(2)
})
