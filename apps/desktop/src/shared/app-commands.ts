// Commands the native application menu sends to the focused window (main → renderer on
// `ade:command`). The menu owns their shortcuts, so they work even when focus is inside a terminal
// or a browser tab; the renderer must not bind the same keys.
const APP_COMMANDS = [
  'new-conversation',
  'new-tab',
  'new-terminal',
  'close-tab',
  'split-right',
  'command-palette',
  'toggle-left-sidebar',
  'toggle-right-sidebar',
  'toggle-dev-panel',
  'open-settings',
  'open-onboarding',
] as const

export type AppCommand = (typeof APP_COMMANDS)[number]

export const isAppCommand = (value: unknown): value is AppCommand =>
  typeof value === 'string' && (APP_COMMANDS as readonly string[]).includes(value)

/** Each app command's shortcut as an Electron accelerator, or null when unbound. */
export type Keybindings = Record<keyof typeof APP_COMMAND_KEYS, string | null>

/**
 * The default shortcut for each app command, as Electron accelerators: shown until the profile's
 * keybindings setting arrives from the daemon, whose defaults are the same. The menu binds them
 * (src/main/app-menu.ts) and the renderer shows them (components/Shortcut.tsx), so a label can
 * never disagree with the key that works.
 */
export const APP_COMMAND_KEYS = {
  'open-settings': 'CmdOrCtrl+,',
  'new-conversation': 'CmdOrCtrl+N',
  'new-tab': 'CmdOrCtrl+T',
  // VS Code's key for a new terminal; ⌘T stays with new tabs.
  'new-terminal': 'Ctrl+Shift+`',
  'close-tab': 'CmdOrCtrl+W',
  'command-palette': 'CmdOrCtrl+Shift+P',
  'toggle-left-sidebar': 'CmdOrCtrl+B',
  'toggle-right-sidebar': 'CmdOrCtrl+Alt+B',
  'split-right': 'CmdOrCtrl+\\',
  'toggle-dev-panel': 'CmdOrCtrl+.',
} as const satisfies Partial<Record<AppCommand, string>>
