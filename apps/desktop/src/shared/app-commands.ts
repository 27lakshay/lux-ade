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
