import { beforeEach, expect, test } from 'vitest'
import { defaultLayout } from './layout'
import {
  DEFAULT_WORKSPACE,
  dispatch,
  flushLayouts,
  layoutStore,
  setActiveWorkspace,
  setKeepMounted,
  STORAGE_KEY,
} from './layout-store'

beforeEach(() => {
  layoutStore.setState({
    active: DEFAULT_WORKSPACE,
    layouts: { [DEFAULT_WORKSPACE]: defaultLayout('p1') },
    recent: [DEFAULT_WORKSPACE],
    keepMounted: 3,
  })
  // Write the reset out before clearing, so no batched save is left waiting.
  flushLayouts()
  localStorage.removeItem(STORAGE_KEY)
  localStorage.removeItem('ade.layouts')
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
    STORAGE_KEY,
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

test('each window saves under its own name; the main window takes over layouts saved before', async () => {
  // Tests run as the main window (no ?window= in the URL).
  expect(STORAGE_KEY).toBe('ade.layouts:main')
  const swapped = { ...defaultLayout('p1'), sidebars: ['inspector', 'navigator'] }
  localStorage.setItem(
    'ade.layouts',
    JSON.stringify({ state: { layouts: { [DEFAULT_WORKSPACE]: swapped } }, version: 1 }),
  )
  // Only when this window has nothing of its own yet.
  localStorage.removeItem(STORAGE_KEY)
  await layoutStore.persist.rehydrate()
  expect(layoutStore.getState().layouts[DEFAULT_WORKSPACE]?.sidebars).toEqual(['inspector', 'navigator'])
  dispatch({ type: 'swapSidebars' })
  // Saves are batched; closing the window writes what is waiting.
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  flushLayouts()
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).state.layouts[DEFAULT_WORKSPACE].sidebars).toEqual([
    'navigator',
    'inspector',
  ])
})
