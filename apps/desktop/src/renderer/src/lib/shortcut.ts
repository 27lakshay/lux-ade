// Turns a shortcut into the keys a person presses, as the platform writes them. Accepts both
// syntaxes the app uses: Electron accelerators from the native menu ('CmdOrCtrl+Shift+P') and
// tinykeys bindings from the command service ('$mod+K $mod+T', a space between chord steps).

const MAC: Record<string, string> = {
  mod: '⌘',
  cmdorctrl: '⌘',
  commandorcontrol: '⌘',
  cmd: '⌘',
  command: '⌘',
  meta: '⌘',
  ctrl: '⌃',
  control: '⌃',
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
}
const OTHER: Record<string, string> = {
  mod: 'Ctrl',
  cmdorctrl: 'Ctrl',
  commandorcontrol: 'Ctrl',
  cmd: 'Ctrl',
  command: 'Ctrl',
  meta: 'Win',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
}
const KEYS: Record<string, string> = {
  enter: '↵',
  return: '↵',
  escape: 'Esc',
  esc: 'Esc',
  backspace: '⌫',
  delete: '⌦',
  tab: '⇥',
  space: 'Space',
  arrowup: '↑',
  up: '↑',
  arrowdown: '↓',
  down: '↓',
  arrowleft: '←',
  left: '←',
  arrowright: '→',
  right: '→',
  backslash: '\\',
  comma: ',',
  period: '.',
}

export const isMac = (): boolean => /Mac/.test(navigator.platform)

/** One string per chord step: '$mod+K $mod+T' → ['⌘K', '⌘T'] on macOS, ['Ctrl+K', 'Ctrl+T'] elsewhere. */
export function formatShortcut(shortcut: string, mac = isMac()): string[] {
  const modifiers = mac ? MAC : OTHER
  return shortcut
    .trim()
    .split(/\s+/)
    .map((step) => {
      // A trailing '+' is the plus key itself ('CmdOrCtrl++').
      const parts = step.endsWith('++') ? [...step.slice(0, -2).split('+'), '+'] : step.split('+')
      const keys = parts.map((part) => {
        const name = part.replace(/^\$/, '').toLowerCase()
        if (modifiers[name]) return modifiers[name]
        const key = part.replace(/^(Key|Digit)(?=.)/, '')
        return KEYS[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key)
      })
      return keys.join(mac ? '' : '+')
    })
}
