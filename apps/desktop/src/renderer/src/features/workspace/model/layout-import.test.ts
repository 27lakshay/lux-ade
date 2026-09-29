import { beforeEach, expect, test } from 'vitest'
import { daemonLayouts, resetLayout, settle, WORKSPACE } from '../testing'
import { defaultLayout } from './layout'
import { convertSavedLayout, hasSavedLayouts, importSavedLayouts, type Known } from './layout-import'
import { layoutBridge } from './layout-store'

// Layouts saved in localStorage before the daemon owned them are imported once, then deleted.

beforeEach(async () => {
  await resetLayout()
  for (const key of ['ade.layouts:main', 'ade.layouts', 'ade.navigator.collapsed:main']) localStorage.removeItem(key)
})

const known: Known = { conversations: new Set(['c1']), terminals: new Set(['t1']) }

/** A layout as the app saved it: camel-case focus, tabs with a kind and a title. */
const saved = (fields: Record<string, unknown> = {}) => ({
  version: 1,
  sidebars: ['inspector', 'navigator'],
  collapsed: { navigator: false, inspector: true },
  widths: { navigator: 999, inspector: 300.4 },
  tabs: {
    a: { id: 'a', kind: 'conversation', title: 'New conversation' },
    b: { id: 'b', kind: 'terminal', title: 'Shell', target: { kind: 'terminal', id: 't1' } },
    c: { id: 'c', kind: 'terminal', title: 'Gone', target: { kind: 'terminal', id: 't-gone' } },
    d: { id: 'd', kind: 'browser', title: 'Browser' },
    e: { id: 'e', kind: 'conversation', title: 'Chat', target: { kind: 'conversation', id: 'c1' } },
  },
  root: {
    type: 'split',
    id: 's',
    direction: 'row',
    sizes: [60, 30],
    children: [
      { type: 'pane', id: 'p1', tabs: ['a', 'b', 'c'], active: 'c' },
      { type: 'pane', id: 'p2', tabs: ['d', 'e'], active: 'd' },
    ],
  },
  focusedPane: 'p2',
  maximized: 'p2',
  ...fields,
})

test('a saved layout converts to the daemon shape, keeping only tabs with a target that exists', () => {
  expect(convertSavedLayout(saved(), known)).toEqual({
    sidebars: ['inspector', 'navigator'],
    collapsed: { navigator: false, inspector: true },
    // Widths are clamped and rounded as the daemon keeps them; sizes sum to 100.
    widths: { navigator: 480, inspector: 300 },
    tabs: {
      a: { id: 'a', target: { kind: 'new_conversation' } },
      b: { id: 'b', target: { kind: 'terminal', id: 't1' } },
      e: { id: 'e', target: { kind: 'conversation', id: 'c1' } },
    },
    root: {
      type: 'split',
      id: 's',
      direction: 'row',
      sizes: [(60 * 100) / 90, (30 * 100) / 90],
      children: [
        { type: 'pane', id: 'p1', tabs: ['a', 'b'], active: 'a' },
        { type: 'pane', id: 'p2', tabs: ['e'], active: 'e' },
      ],
    },
    focused_pane: 'p2',
    maximized: 'p2',
  })
  expect(convertSavedLayout({ ...saved(), sidebars: ['navigator', 'navigator'] }, known)).toBeNull()
  expect(convertSavedLayout({ nonsense: true }, known)).toBeNull()
})

test('the import stores each saved layout the daemon lacks, never one it has, then deletes the keys', async () => {
  const fake = daemonLayouts()
  // The window has changed its layout for the shown workspace; w2 and w3 have none in the daemon.
  expect(fake.revision(WORKSPACE)).toBeGreaterThan(0)
  localStorage.setItem(
    'ade.layouts:main',
    JSON.stringify({
      state: { active: 'w2', layouts: { [WORKSPACE]: saved(), w2: saved(), gone: saved(), default: saved() } },
      version: 1,
    }),
  )
  localStorage.setItem('ade.layouts', JSON.stringify({ state: { layouts: { w3: saved() } }, version: 1 }))
  localStorage.setItem('ade.navigator.collapsed:main', JSON.stringify(['r1']))
  expect(hasSavedLayouts()).toBe(true)
  const window = fake.window()
  await importSavedLayouts(layoutBridge()!, window, new Set([WORKSPACE, 'w2', 'w3']), known)
  await settle()
  expect(fake.layout(WORKSPACE)).toEqual(defaultLayout('p1'))
  expect(fake.layout('w2').focused_pane).toBe('p2')
  expect(fake.layout('w3').sidebars).toEqual(['inspector', 'navigator'])
  expect(fake.calls.filter((call) => call === 'layout.replace')).toHaveLength(2)
  // The window showed nothing else yet: it shows what the app showed last.
  expect(fake.window().workspace_id).toBe('w2')
  expect(fake.window().view.collapsed_projects).toEqual(['r1'])
  expect(hasSavedLayouts()).toBe(false)
})
