import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { IDisposable, ITerminalInitOnlyOptions, ITerminalOptions, Terminal } from '@xterm/xterm'
import { suppressReplies } from './feed'

// How every ADE terminal view is configured. It needs no DOM, so the protocol
// E2E builds its headless xterm from the same options.

/** `allowProposedApi` is required for `terminal.unicode`. */
export const terminalOptions: ITerminalOptions & ITerminalInitOnlyOptions = {
  cols: 100, rows: 30, convertEol: false, scrollback: 10_000, allowProposedApi: true,
}

/**
 * Uses Unicode 11 cell widths, as the runtime's terminal and shells do, so an
 * emoji takes two cells here too; and stops xterm answering terminal queries
 * the runtime already answered (D06).
 */
export function prepareTerminal(terminal: Terminal): IDisposable[] {
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = '11'
  return suppressReplies(terminal)
}
