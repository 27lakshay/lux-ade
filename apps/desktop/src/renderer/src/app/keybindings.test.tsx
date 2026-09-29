import { afterEach, expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { Shortcut } from '@/components/Shortcut'
import { APP_COMMAND_KEYS, type Keybindings } from '../../../shared/app-commands'
import { applyKeybindings } from './keybindings'

afterEach(() => {
  applyKeybindings({ ...APP_COMMAND_KEYS })
  window.adeHost = undefined as unknown as typeof window.adeHost
})

test('a shortcut label shows the profile’s keybinding, and nothing when the command is unbound', async () => {
  const setKeybindings = vi.fn()
  window.adeHost = { setKeybindings } as unknown as typeof window.adeHost
  const screen = await render(<Shortcut appCommand="new-terminal" />)
  await expect.element(screen.getByText('⌃⇧`')).toBeVisible()

  const rebound: Keybindings = { ...APP_COMMAND_KEYS, 'new-terminal': 'CmdOrCtrl+Shift+E' }
  applyKeybindings(rebound)
  await expect.element(screen.getByText('⌘⇧E')).toBeVisible()
  // The native menu binds the same keys.
  expect(setKeybindings).toHaveBeenCalledWith(rebound)

  applyKeybindings({ ...rebound, 'new-terminal': null })
  await expect.poll(() => screen.container.textContent).toBe('')
})
