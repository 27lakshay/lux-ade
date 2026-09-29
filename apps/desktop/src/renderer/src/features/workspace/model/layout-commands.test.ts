import { beforeEach, expect, test } from 'vitest'
import { commandService } from '../../../app/commands'
import { resetLayout, shown } from '../testing'
import { handleLayoutCommand, registerLayoutCommands } from './layout-commands'
import { panes } from './layout-tree'

beforeEach(resetLayout)

test('native-menu commands act on the focused pane and the sidebars', async () => {
  expect(handleLayoutCommand('toggle-right-sidebar')).toBe(true)
  expect((await shown()).collapsed.inspector).toBe(true)
  handleLayoutCommand('new-tab')
  await shown()
  handleLayoutCommand('new-conversation')
  expect(panes((await shown()).root)[0]!.tabs).toHaveLength(2)
  handleLayoutCommand('close-tab')
  expect(panes((await shown()).root)[0]!.tabs).toHaveLength(1)
  handleLayoutCommand('split-right')
  expect(panes((await shown()).root)).toHaveLength(2)
  expect(handleLayoutCommand('open-settings')).toBe(false)
})

test('the palette lists the layout commands', async () => {
  registerLayoutCommands()
  const titles = commandService.commands().map((command) => command.title)
  expect(titles).toEqual(expect.arrayContaining(['Swap sidebars', 'Split pane right', 'Split pane down', 'Close pane']))
  commandService.execute('layout.swapSidebars')
  expect((await shown()).sidebars).toEqual(['inspector', 'navigator'])
})

test('arrow commands focus, swap and move tabs to the pane in that direction', async () => {
  registerLayoutCommands()
  handleLayoutCommand('new-tab')
  await shown()
  handleLayoutCommand('split-right')
  await shown()
  handleLayoutCommand('new-tab')
  const [left, right] = panes((await shown()).root).map((pane) => pane.id)
  expect((await shown()).focused_pane).toBe(right)
  commandService.execute('layout.focusLeft')
  expect((await shown()).focused_pane).toBe(left)
  // Nothing further left: focus stays.
  commandService.execute('layout.focusLeft')
  expect((await shown()).focused_pane).toBe(left)
  commandService.execute('layout.swapRight')
  expect(panes((await shown()).root).map((pane) => pane.id)).toEqual([right, left])
  commandService.execute('layout.moveTabLeft')
  // The left pane's only tab joined the right pane, which closed the emptied left pane.
  const after = await shown()
  expect(panes(after.root)).toHaveLength(1)
  expect(panes(after.root)[0]!.tabs).toHaveLength(2)
  expect(commandService.keybindingFor('layout.focusLeft')).toBe('$mod+Alt+ArrowLeft')
  expect(commandService.keybindingFor('layout.swapDown')).toBe('$mod+Alt+Shift+ArrowDown')
})
