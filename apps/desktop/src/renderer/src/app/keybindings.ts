import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { APP_COMMAND_KEYS, type AppCommand, type Keybindings } from '../../../shared/app-commands'

// The profile's keybindings for app commands, from the daemon's settings (profile-settings.ts).
// The defaults show until the daemon answers. The native menu binds them (main/app-menu.ts); every
// shortcut label reads them here, so a label never disagrees with the key that works.

const keybindingStore = createStore<Keybindings>(() => ({ ...APP_COMMAND_KEYS }))

/** Shows the profile's keybindings and has the native menu bind them. */
export function applyKeybindings(keybindings: Keybindings): void {
  keybindingStore.setState(keybindings, true)
  window.adeHost?.setKeybindings(keybindings)
}

/** An app command's accelerator now; null when it is unbound or no command is given. */
export const useKeybinding = (command: (keyof typeof APP_COMMAND_KEYS & AppCommand) | undefined): string | null =>
  useStore(keybindingStore, (bindings) => (command ? (bindings[command] ?? null) : null))
