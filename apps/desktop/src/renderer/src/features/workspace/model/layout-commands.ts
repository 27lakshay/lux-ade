import type { AppCommand } from '../../../../../shared/app-commands'
import { commandService } from '../../../app/commands'
import type { Edge, LayoutAction } from './layout'
import { findPane, neighbourPane } from './layout-tree'
import { toggleSidebar } from '../cards/fit'
import { growFocusedPane } from '../panes/grow'
import { hasRoomFor, noRoom, trySplit } from '../panes/room'
import { closePane, closeTab, newTerminal } from '../terminals/terminal-tabs'
import { dispatch, layoutNow, openTab, swapSidebars, toggleMaximize } from './layout-store'

// The workspace's commands: from the native menu (app commands) and in the palette. Every mouse
// action on the layout has one.

const focused = () => {
  const layout = layoutNow()
  return { layout, pane: findPane(layout.root, layout.focused_pane) }
}

/** Applies a change to the panes when they still fit afterwards (panes/room.ts). */
const whenRoom = (action: LayoutAction): void => (hasRoomFor(action) ? void dispatch(action) : noRoom())

/** Handles a native-menu command that acts on the layout; returns whether it did. */
export function handleLayoutCommand(command: AppCommand): boolean {
  switch (command) {
    case 'toggle-left-sidebar':
      toggleSidebar('left')
      return true
    case 'toggle-right-sidebar':
      toggleSidebar('right')
      return true
    case 'split-right': {
      const { pane } = focused()
      if (pane) trySplit(pane.id, 'row')
      return true
    }
    case 'new-tab':
    case 'new-conversation':
      void openTab({ kind: 'new_conversation' })
      return true
    case 'new-terminal':
      void newTerminal(focused().pane?.id)
      return true
    case 'close-tab': {
      const { pane } = focused()
      if (pane?.active) void closeTab(pane.active)
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
  commandService.registerCommand({
    id: 'terminal.new',
    title: 'New terminal',
    category: 'Terminal',
    run: () => void newTerminal(focused().pane?.id),
  })
  add('layout.swapSidebars', 'Swap sidebars', () => void swapSidebars())
  add('layout.toggleLeft', 'Toggle left sidebar', () => toggleSidebar('left'))
  add('layout.toggleRight', 'Toggle right sidebar', () => toggleSidebar('right'))
  add('layout.splitRight', 'Split pane right', () => {
    const { pane } = focused()
    if (pane) trySplit(pane.id, 'row')
  })
  add('layout.splitDown', 'Split pane down', () => {
    const { pane } = focused()
    if (pane) trySplit(pane.id, 'column')
  })
  add('layout.resetLayout', 'Reset layout', () => void dispatch({ type: 'reset_layout' }))
  add('layout.equalizePanes', 'Equalize panes', () => void dispatch({ type: 'equalize_splits', split_id: null }))
  add('layout.toggleMaximize', 'Maximize or restore pane', () => {
    const { pane } = focused()
    if (pane) void toggleMaximize(pane.id)
  })
  commandService.registerKeybinding({ key: '$mod+Shift+Enter', command: 'layout.toggleMaximize' })
  add('layout.closePane', 'Close pane', () => {
    const { pane } = focused()
    if (pane) void closePane(pane.id)
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
      if (found?.target) void dispatch({ type: 'focus_pane', pane_id: found.target.id })
    })
    add(`layout.swap${name}`, `Swap pane ${name.toLowerCase()}`, `$mod+Alt+Shift+${arrow}`, () => {
      const found = neighbour(edge)
      if (found?.target) whenRoom({ type: 'swap_panes', pane_id: found.pane.id, target_id: found.target.id })
    })
    add(`layout.grow${name}`, `Grow pane ${name.toLowerCase()}`, `$mod+Control+${arrow}`, () =>
      growFocusedPane(edge, false),
    )
    add(`layout.growMore${name}`, `Grow pane ${name.toLowerCase()} a lot`, `$mod+Control+Shift+${arrow}`, () =>
      growFocusedPane(edge, true),
    )
    add(`layout.moveTab${name}`, `Move tab to pane ${name.toLowerCase()}`, null, () => {
      const found = neighbour(edge)
      if (found?.target && found.pane.active)
        whenRoom({
          type: 'move_tab',
          tab_id: found.pane.active,
          pane_id: found.target.id,
          index: Number.MAX_SAFE_INTEGER,
        })
    })
  }
}
