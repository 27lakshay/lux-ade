import { beforeEach, expect, test } from 'vitest'
import { daemonLayouts, resetLayout, settle, shown, startWith, WORKSPACE } from '../testing'
import { defaultLayout } from './layout'
import {
  activeWorkspace,
  dispatch,
  keptWorkspaces,
  layoutStore,
  openTab,
  openTabInAnother,
  setKeepMounted,
  swapSidebars,
} from './layout-store'
import { selectWorkspace } from './layout-sync'

beforeEach(resetLayout)

test('a conversation can have independent durable tab views without changing normal reopen behavior', async () => {
  const target = { kind: 'conversation' as const, id: 'conversation-1' }
  await openTab(target)
  await openTab(target)
  expect(Object.values((await shown()).tabs)).toHaveLength(1)

  await openTabInAnother(target)
  const tabs = Object.values((await shown()).tabs)
  expect(tabs).toHaveLength(2)
  expect(tabs.map((tab) => tab.target)).toEqual([target, target])
  expect(new Set(tabs.map((tab) => tab.id)).size).toBe(2)

  await openTab(target)
  expect(Object.values((await shown()).tabs)).toHaveLength(2)
})

test('each workspace keeps its own layout, in the daemon', async () => {
  await swapSidebars()
  selectWorkspace('w2')
  expect(activeWorkspace(layoutStore.getState())).toBe('w2')
  expect((await shown()).sidebars).toEqual(['navigator', 'inspector'])
  expect(daemonLayouts().window().workspace_id).toBe('w2')
  selectWorkspace(WORKSPACE)
  expect((await shown()).sidebars).toEqual(['inspector', 'navigator'])
  expect(daemonLayouts().layout(WORKSPACE).sidebars).toEqual(['inspector', 'navigator'])
})

test('the kept workspaces are the window record recent ones, up to `keepMounted`', async () => {
  for (const id of ['w2', 'w3', 'w4']) {
    selectWorkspace(id)
    await settle()
  }
  expect(keptWorkspaces(layoutStore.getState())).toEqual(['w4', 'w3', 'w2'])
  selectWorkspace('w2')
  await settle()
  expect(keptWorkspaces(layoutStore.getState())).toEqual(['w2', 'w4', 'w3'])
  setKeepMounted(1)
  expect(keptWorkspaces(layoutStore.getState())).toEqual(['w2'])
})

test('a layout another client changes shows here from its frame', async () => {
  daemonLayouts().applyElsewhere({ type: 'set_side_collapsed', side: 'right', collapsed: true })
  expect(layoutStore.getState().records[WORKSPACE]?.layout.collapsed.inspector).toBe(true)
})

test('a layout whose frame was missed is read again from the revision the catalog names', async () => {
  daemonLayouts().applyElsewhere({ type: 'set_side_collapsed', side: 'left', collapsed: true }, { missed: 'frame' })
  expect((await shown()).collapsed.navigator).toBe(true)
  expect(daemonLayouts().calls.filter((call) => call === 'layout.get').length).toBeGreaterThan(1)
})

test('a pane move made on a stale revision is refused, and the layout read again', async () => {
  await startWith({
    [WORKSPACE]: {
      ...defaultLayout('a'),
      root: {
        type: 'split',
        id: 's',
        direction: 'row',
        sizes: [50, 50],
        children: [
          { type: 'pane', id: 'a', tabs: [], active: null },
          { type: 'pane', id: 'b', tabs: [], active: null },
        ],
      },
    },
  })
  // The daemon moved on without this window hearing of it.
  daemonLayouts().applyElsewhere({ type: 'set_width', sidebar: 'navigator', width: 300 }, { missed: 'all' })
  const result = await dispatch({ type: 'swap_panes', pane_id: 'a', target_id: 'b' })
  expect(result).toBeNull()
  expect((await shown()).widths.navigator).toBe(300)
  // With the current revision, it goes through.
  await dispatch({ type: 'swap_panes', pane_id: 'a', target_id: 'b' })
  expect(daemonLayouts().layout().root).toMatchObject({ children: [{ id: 'b' }, { id: 'a' }] })
})
