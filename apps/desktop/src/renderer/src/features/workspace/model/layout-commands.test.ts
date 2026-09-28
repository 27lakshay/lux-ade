import { beforeEach, expect, test } from 'vitest'
import { commandService } from '../../../app/commands'
import { defaultLayout } from './layout'
import { handleLayoutCommand, registerLayoutCommands } from './layout-commands'
import { panes } from './layout.logic'
import { DEFAULT_WORKSPACE, layoutStore } from './layout-store'

const layout = () => layoutStore.getState().layouts[DEFAULT_WORKSPACE]!

beforeEach(() => {
  localStorage.removeItem('ade.layouts')
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
