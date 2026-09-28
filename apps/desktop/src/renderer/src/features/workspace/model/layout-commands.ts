import type { AppCommand } from '../../../../../shared/app-commands'
import { commandService } from '../../../app/commands'
import { findPane } from './layout.logic'
import { dispatch, layoutStore, openTab, splitPane, toggleSide } from './layout-store'

// The workspace's commands: from the native menu (app commands) and in the palette. Every mouse
// action on the layout has one.

const focused = () => {
  const { layouts, active } = layoutStore.getState()
  const layout = layouts[active]!
  return { layout, pane: findPane(layout.root, layout.focusedPane) }
}

/** Handles a native-menu command that acts on the layout; returns whether it did. */
export function handleLayoutCommand(command: AppCommand): boolean {
  switch (command) {
    case 'toggle-left-sidebar':
      toggleSide('left')
      return true
    case 'toggle-right-sidebar':
      toggleSide('right')
      return true
    case 'split-right': {
      const { pane } = focused()
      if (pane) splitPane(pane.id, 'row')
      return true
    }
    case 'new-tab':
    case 'new-conversation':
      openTab({ kind: 'conversation', title: 'New conversation' })
      return true
    case 'close-tab': {
      const { pane } = focused()
      if (pane?.active) dispatch({ type: 'closeTab', tabId: pane.active })
      return true
    }
    default:
      return false
  }
}

export function registerLayoutCommands(): void {
  const add = (id: string, title: string, run: () => void): void => {
    commandService.registerCommand({ id, title, category: 'Layout', run })
  }
  add('layout.swapSidebars', 'Swap sidebars', () => dispatch({ type: 'swapSidebars' }))
  add('layout.toggleLeft', 'Toggle left sidebar', () => toggleSide('left'))
  add('layout.toggleRight', 'Toggle right sidebar', () => toggleSide('right'))
  add('layout.splitRight', 'Split pane right', () => {
    const { pane } = focused()
    if (pane) splitPane(pane.id, 'row')
  })
  add('layout.splitDown', 'Split pane down', () => {
    const { pane } = focused()
    if (pane) splitPane(pane.id, 'column')
  })
  add('layout.closePane', 'Close pane', () => {
    const { pane } = focused()
    if (pane) dispatch({ type: 'closePane', paneId: pane.id })
  })
}
