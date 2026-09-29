// The keys every app command has until the person changes them. The daemon
// owns them (crates/ade-core/src/contract/settings.rs, AppCommand::default_key).
import type { Keybindings } from '../../../packages/contracts/dist/index.js'

export const defaultKeybindings: Keybindings = {
  'new-conversation': 'CmdOrCtrl+N',
  'new-tab': 'CmdOrCtrl+T',
  'new-terminal': 'Ctrl+Shift+`',
  'close-tab': 'CmdOrCtrl+W',
  'split-right': 'CmdOrCtrl+\\',
  'command-palette': 'CmdOrCtrl+Shift+P',
  'toggle-left-sidebar': 'CmdOrCtrl+B',
  'toggle-right-sidebar': 'CmdOrCtrl+Alt+B',
  'toggle-dev-panel': 'CmdOrCtrl+.',
  'open-settings': 'CmdOrCtrl+,',
}
