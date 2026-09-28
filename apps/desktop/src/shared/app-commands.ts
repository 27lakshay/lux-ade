// Commands the native application menu sends to the focused window (main → renderer on
// `ade:command`). The menu owns their shortcuts, so they work even when focus is inside a terminal
// or a browser tab; the renderer must not bind the same keys.
const APP_COMMANDS = [
  'new-conversation',
  'new-tab',
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

/**
 * The native menu's shortcut for each app command, as Electron accelerators. The menu binds them
 * (src/main/app-menu.ts) and the renderer shows them (components/Shortcut.tsx), so a label can
 * never disagree with the key that works.
 */
export const APP_COMMAND_KEYS = {
  'open-settings': 'CmdOrCtrl+,',
  'new-conversation': 'CmdOrCtrl+N',
  'new-tab': 'CmdOrCtrl+T',
  'close-tab': 'CmdOrCtrl+W',
  'command-palette': 'CmdOrCtrl+Shift+P',
  'toggle-left-sidebar': 'CmdOrCtrl+B',
  'toggle-right-sidebar': 'CmdOrCtrl+Alt+B',
  'split-right': 'CmdOrCtrl+\\',
  'toggle-dev-panel': 'CmdOrCtrl+.',
} as const satisfies Partial<Record<AppCommand, string>>
