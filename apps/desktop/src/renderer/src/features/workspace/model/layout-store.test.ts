import { beforeEach, expect, test } from 'vitest'
import { defaultLayout } from './layout'
import { DEFAULT_WORKSPACE, dispatch, layoutStore, setActiveWorkspace, setKeepMounted } from './layout-store'

beforeEach(() => {
  localStorage.removeItem('ade.layouts')
  layoutStore.setState({
    active: DEFAULT_WORKSPACE,
    layouts: { [DEFAULT_WORKSPACE]: defaultLayout('p1') },
    recent: [DEFAULT_WORKSPACE],
    keepMounted: 3,
  })
})

test('each workspace keeps its own layout', () => {
  dispatch({ type: 'swapSidebars' })
  setActiveWorkspace('w2')
  expect(layoutStore.getState().layouts.w2?.sidebars).toEqual(['navigator', 'inspector'])
  setActiveWorkspace(DEFAULT_WORKSPACE)
  expect(layoutStore.getState().layouts[DEFAULT_WORKSPACE]?.sidebars).toEqual(['inspector', 'navigator'])
})

test('the recent list keeps the last `keepMounted` workspaces, most recent first', () => {
  for (const id of ['w2', 'w3', 'w4']) setActiveWorkspace(id)
  expect(layoutStore.getState().recent).toEqual(['w4', 'w3', 'w2'])
  setActiveWorkspace('w2')
  expect(layoutStore.getState().recent).toEqual(['w2', 'w4', 'w3'])
  setKeepMounted(1)
  expect(layoutStore.getState().recent).toEqual(['w2'])
})

test('layouts survive a reload; damaged ones fall back to the default', async () => {
  // The saved file holds a collapsed inspector and one damaged layout; the window currently shows
  // neither.
  const collapsed = { ...defaultLayout('p1'), collapsed: { navigator: false, inspector: true } }
  const damaged = { version: 1, sidebars: ['navigator', 'navigator'] }
  localStorage.setItem(
    'ade.layouts',
    JSON.stringify({
      state: { layouts: { [DEFAULT_WORKSPACE]: collapsed, broken: damaged }, keepMounted: 3 },
      version: 1,
    }),
  )
  await layoutStore.persist.rehydrate()
  const { layouts } = layoutStore.getState()
  expect(layouts[DEFAULT_WORKSPACE]?.collapsed.inspector).toBe(true)
  expect(layouts.broken).toBeUndefined()
})
