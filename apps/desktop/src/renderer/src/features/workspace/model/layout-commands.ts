import type { AppCommand } from '../../../../../shared/app-commands'
import { commandService } from '../../../app/commands'
import type { Edge } from './layout'
import { findPane, neighbourPane } from './layout-tree'
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
  registerPaneDirectionCommands()
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
  add('layout.resetLayout', 'Reset layout', () => dispatch({ type: 'resetLayout' }))
  add('layout.equalizePanes', 'Equalize panes', () => dispatch({ type: 'equalizeSplits' }))
  add('layout.toggleMaximize', 'Maximize or restore pane', () => {
    const { pane } = focused()
    if (pane) dispatch({ type: 'toggleMaximize', paneId: pane.id })
  })
  commandService.registerKeybinding({ key: '$mod+Shift+Enter', command: 'layout.toggleMaximize' })
  add('layout.closePane', 'Close pane', () => {
    const { pane } = focused()
    if (pane) dispatch({ type: 'closePane', paneId: pane.id })
  })
}

const DIRECTIONS: [Edge, string, string][] = [
  ['left', 'Left', 'ArrowLeft'],
  ['right', 'Right', 'ArrowRight'],
  ['top', 'Up', 'ArrowUp'],
  ['bottom', 'Down', 'ArrowDown'],
]

/** Keyboard equivalents of dragging: focus, swap or move a tab to the pane in a direction. */
function registerPaneDirectionCommands(): void {
  const neighbour = (edge: Edge) => {
    const { layout, pane } = focused()
    return pane ? { pane, target: neighbourPane(layout.root, pane.id, edge) } : undefined
  }
  for (const [edge, name, arrow] of DIRECTIONS) {
    const add = (id: string, title: string, key: string | null, run: () => void): void => {
      commandService.registerCommand({ id, title, category: 'Layout', run })
      if (key) commandService.registerKeybinding({ key, command: id })
    }
    add(`layout.focus${name}`, `Focus pane ${name.toLowerCase()}`, `$mod+Alt+${arrow}`, () => {
      const found = neighbour(edge)
      if (found?.target) dispatch({ type: 'focusPane', paneId: found.target.id })
    })
    add(`layout.swap${name}`, `Swap pane ${name.toLowerCase()}`, `$mod+Alt+Shift+${arrow}`, () => {
      const found = neighbour(edge)
      if (found?.target) dispatch({ type: 'swapPanes', paneId: found.pane.id, targetId: found.target.id })
    })
    add(`layout.moveTab${name}`, `Move tab to pane ${name.toLowerCase()}`, null, () => {
      const found = neighbour(edge)
      if (found?.target && found.pane.active)
        dispatch({ type: 'moveTab', tabId: found.pane.active, paneId: found.target.id, index: Number.MAX_SAFE_INTEGER })
    })
  }
}
