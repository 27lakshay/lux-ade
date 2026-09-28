import { beforeEach, expect, test } from 'vitest'
import { commandService } from '../../../app/commands'
import { defaultLayout } from './layout'
import { handleLayoutCommand, registerLayoutCommands } from './layout-commands'
import { panes } from './layout-tree'
import { DEFAULT_WORKSPACE, layoutStore, STORAGE_KEY } from './layout-store'

const layout = () => layoutStore.getState().layouts[DEFAULT_WORKSPACE]!

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY)
  layoutStore.setState({
    active: DEFAULT_WORKSPACE,
    layouts: { [DEFAULT_WORKSPACE]: defaultLayout('p1') },
    recent: [DEFAULT_WORKSPACE],
  })
})

test('native-menu commands act on the focused pane and the sidebars', () => {
  expect(handleLayoutCommand('toggle-right-sidebar')).toBe(true)
  expect(layout().collapsed.inspector).toBe(true)
  handleLayoutCommand('new-tab')
  handleLayoutCommand('new-conversation')
  expect(panes(layout().root)[0]!.tabs).toHaveLength(2)
  handleLayoutCommand('close-tab')
  expect(panes(layout().root)[0]!.tabs).toHaveLength(1)
  handleLayoutCommand('split-right')
  expect(panes(layout().root)).toHaveLength(2)
  expect(handleLayoutCommand('open-settings')).toBe(false)
})

test('the palette lists the layout commands', () => {
  registerLayoutCommands()
  const titles = commandService.commands().map((command) => command.title)
  expect(titles).toEqual(expect.arrayContaining(['Swap sidebars', 'Split pane right', 'Split pane down', 'Close pane']))
  commandService.execute('layout.swapSidebars')
  expect(layout().sidebars).toEqual(['inspector', 'navigator'])
})

test('arrow commands focus, swap and move tabs to the pane in that direction', () => {
  registerLayoutCommands()
  handleLayoutCommand('new-tab')
  handleLayoutCommand('split-right')
  handleLayoutCommand('new-tab')
  const [left, right] = panes(layout().root).map((pane) => pane.id)
  expect(layout().focusedPane).toBe(right)
  commandService.execute('layout.focusLeft')
  expect(layout().focusedPane).toBe(left)
  // Nothing further left: focus stays.
  commandService.execute('layout.focusLeft')
  expect(layout().focusedPane).toBe(left)
  commandService.execute('layout.swapRight')
  expect(panes(layout().root).map((pane) => pane.id)).toEqual([right, left])
  commandService.execute('layout.moveTabLeft')
  // The left pane's only tab joined the right pane, which closed the emptied left pane.
  expect(panes(layout().root)).toHaveLength(1)
  expect(panes(layout().root)[0]!.tabs).toHaveLength(2)
  expect(commandService.keybindingFor('layout.focusLeft')).toBe('$mod+Alt+ArrowLeft')
  expect(commandService.keybindingFor('layout.swapDown')).toBe('$mod+Alt+Shift+ArrowDown')
})
