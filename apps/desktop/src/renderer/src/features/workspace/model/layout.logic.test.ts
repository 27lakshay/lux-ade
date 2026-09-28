import { describe, expect, test } from 'vitest'
import { defaultLayout, GUTTER, PANE_MIN, SIDEBAR_WIDTH, type Layout, type LayoutNode, type Tab } from './layout'
import { parseLayout } from './layout-schema'
import { boundaryToward, findPane, minSize, neighbourPane, panes, structureKey } from './layout-tree'
import { layoutReducer, type LayoutAction } from './layout.logic'

const tab = (id: string): Tab => ({ id, kind: 'conversation', title: id })
const run = (layout: Layout, ...actions: LayoutAction[]): Layout => actions.reduce(layoutReducer, layout)
const start = (): Layout => defaultLayout('p1')
const withTabs = (...ids: string[]): Layout =>
  run(start(), ...ids.map((id) => ({ type: 'openTab', tab: tab(id) }) as const))
const shape = (layout: Layout): string => structureKey(layout.root)
const sizes = (node: LayoutNode): unknown =>
  node.type === 'pane' ? node.id : { [node.direction]: node.sizes, of: node.children.map(sizes) }

describe('sidebars', () => {
  test('swap sides, and toggles act on whichever sidebar is on that side', () => {
    const swapped = run(start(), { type: 'swapSidebars' })
    expect(swapped.sidebars).toEqual(['inspector', 'navigator'])
    const collapsed = run(swapped, { type: 'toggleSide', side: 'left' })
    expect(collapsed.collapsed).toEqual({ navigator: false, inspector: true })
    expect(run(collapsed, { type: 'toggleSide', side: 'left' }).collapsed.inspector).toBe(false)
  })

  test('widths are clamped and whole pixels', () => {
    expect(run(start(), { type: 'setWidth', sidebar: 'navigator', width: 50 }).widths.navigator).toBe(SIDEBAR_WIDTH.min)
    expect(run(start(), { type: 'setWidth', sidebar: 'navigator', width: 9000 }).widths.navigator).toBe(
      SIDEBAR_WIDTH.max,
    )
    expect(run(start(), { type: 'setWidth', sidebar: 'inspector', width: 300.6 }).widths.inspector).toBe(301)
  })
})

describe('tabs', () => {
  test('open after the active tab, in the focused pane, and become active', () => {
    const layout = run(withTabs('a', 'b'), { type: 'activateTab', tabId: 'a' }, { type: 'openTab', tab: tab('c') })
    expect(findPane(layout.root, 'p1')).toMatchObject({ tabs: ['a', 'c', 'b'], active: 'c' })
  })

  test('closing the active tab activates its right neighbour, else its left', () => {
    const middle = run(withTabs('a', 'b', 'c'), { type: 'activateTab', tabId: 'b' }, { type: 'closeTab', tabId: 'b' })
    expect(findPane(middle.root, 'p1')).toMatchObject({ tabs: ['a', 'c'], active: 'c' })
    expect(middle.tabs.b).toBeUndefined()
    const last = run(withTabs('a', 'b'), { type: 'closeTab', tabId: 'b' })
    expect(findPane(last.root, 'p1')?.active).toBe('a')
  })

  test('closing the last tab of the only pane keeps the empty pane', () => {
    const layout = run(withTabs('a'), { type: 'closeTab', tabId: 'a' })
    expect(layout.root).toEqual({ type: 'pane', id: 'p1', tabs: [], active: null })
  })

  test('reordering within a pane lands where it was dropped', () => {
    const layout = run(withTabs('a', 'b', 'c'), { type: 'moveTab', tabId: 'a', paneId: 'p1', index: 3 })
    expect(findPane(layout.root, 'p1')?.tabs).toEqual(['b', 'c', 'a'])
    const back = run(layout, { type: 'moveTab', tabId: 'a', paneId: 'p1', index: 0 })
    expect(findPane(back.root, 'p1')?.tabs).toEqual(['a', 'b', 'c'])
  })

  test('moving the last tab out of a pane removes that pane', () => {
    const split = run(withTabs('a', 'b'), { type: 'dropTab', tabId: 'b', paneId: 'p1', zone: 'right', newPaneId: 'p2' })
    const merged = run(split, { type: 'moveTab', tabId: 'b', paneId: 'p1', index: 0 })
    expect(shape(merged)).toBe('p1')
    expect(findPane(merged.root, 'p1')?.tabs).toEqual(['b', 'a'])
  })
})

describe('splits and drops', () => {
  test('dropping a tab on an edge splits the target that way, and focuses the new pane', () => {
    const right = run(withTabs('a', 'b'), { type: 'dropTab', tabId: 'b', paneId: 'p1', zone: 'right', newPaneId: 'p2' })
    expect(shape(right)).toBe('row(p1,p2)')
    expect(right.focusedPane).toBe('p2')
    const top = run(right, { type: 'dropTab', tabId: 'a', paneId: 'p2', zone: 'top', newPaneId: 'p3' })
    // p1 emptied and was removed; p2 split into a column with p3 above.
    expect(shape(top)).toBe('column(p3,p2)')
  })

  test('dropping onto the centre joins the target pane', () => {
    const split = run(withTabs('a', 'b', 'c'), {
      type: 'dropTab',
      tabId: 'c',
      paneId: 'p1',
      zone: 'bottom',
      newPaneId: 'p2',
    })
    const joined = run(split, { type: 'dropTab', tabId: 'b', paneId: 'p2', zone: 'centre', newPaneId: 'unused' })
    expect(findPane(joined.root, 'p2')).toMatchObject({ tabs: ['c', 'b'], active: 'b' })
  })

  test('a pane cannot be split off its own only tab', () => {
    const layout = withTabs('a')
    expect(run(layout, { type: 'dropTab', tabId: 'a', paneId: 'p1', zone: 'left', newPaneId: 'p2' })).toBe(layout)
  })

  test('splitting in the same direction shares the target’s space instead of nesting', () => {
    const layout = run(
      start(),
      { type: 'splitPane', paneId: 'p1', direction: 'row', newPaneId: 'p2' },
      { type: 'splitPane', paneId: 'p2', direction: 'row', newPaneId: 'p3' },
    )
    expect(shape(layout)).toBe('row(p1,p2,p3)')
    expect(sizes(layout.root)).toEqual({ row: [50, 25, 25], of: ['p1', 'p2', 'p3'] })
  })

  test('removing a pane gives its space to a neighbour and flattens one-child splits', () => {
    const layout = run(
      start(),
      { type: 'splitPane', paneId: 'p1', direction: 'row', newPaneId: 'p2' },
      { type: 'splitPane', paneId: 'p2', direction: 'column', newPaneId: 'p3' },
      { type: 'splitPane', paneId: 'p3', direction: 'row', newPaneId: 'p4' },
    )
    expect(shape(layout)).toBe('row(p1,column(p2,row(p3,p4)))')
    const closed = run(layout, { type: 'closePane', paneId: 'p2' })
    // The column is left with one row, which merges into the outer row.
    expect(shape(closed)).toBe('row(p1,p3,p4)')
    expect(sizes(closed.root)).toEqual({ row: [50, 25, 25], of: ['p1', 'p3', 'p4'] })
  })

  const three = () =>
    run(
      withTabs('a'),
      { type: 'splitPane', paneId: 'p1', direction: 'row', newPaneId: 'p2' },
      { type: 'openTab', tab: tab('b'), paneId: 'p2' },
      { type: 'splitPane', paneId: 'p2', direction: 'row', newPaneId: 'p3' },
      { type: 'openTab', tab: tab('c'), paneId: 'p3' },
    )

  test('moving a pane onto another pane’s edge places it beside that pane', () => {
    const moved = run(three(), { type: 'movePane', paneId: 'p1', targetId: 'p3', zone: 'bottom' })
    expect(shape(moved)).toBe('row(p2,column(p3,p1))')
  })

  test('moving a pane onto another pane’s centre swaps their places; each place keeps its size', () => {
    const resized = run(three(), { type: 'setSplitSizes', splitId: three().root.id, sizes: [20, 30, 50] })
    const swapped = run(resized, { type: 'movePane', paneId: 'p1', targetId: 'p3', zone: 'centre' })
    expect(shape(swapped)).toBe('row(p3,p2,p1)')
    expect(sizes(swapped.root)).toEqual({ row: [20, 30, 50], of: ['p3', 'p2', 'p1'] })
    expect(findPane(swapped.root, 'p1')?.tabs).toEqual(['a'])
    expect(swapped.focusedPane).toBe('p1')
  })

  test('swapping works across nested splits', () => {
    const nested = run(three(), { type: 'splitPane', paneId: 'p3', direction: 'column', newPaneId: 'p4' })
    expect(shape(nested)).toBe('row(p1,p2,column(p3,p4))')
    expect(shape(run(nested, { type: 'swapPanes', paneId: 'p1', targetId: 'p4' }))).toBe('row(p4,p2,column(p3,p1))')
  })

  test('docking a pane on an outer edge makes it a full-height column or full-width row', () => {
    const left = run(three(), { type: 'dockPane', paneId: 'p3', edge: 'left' })
    expect(shape(left)).toBe('row(p3,p1,p2)')
    const bottom = run(three(), { type: 'dockPane', paneId: 'p2', edge: 'bottom' })
    expect(shape(bottom)).toBe('column(row(p1,p3),p2)')
    // The only pane cannot dock anywhere.
    expect(run(start(), { type: 'dockPane', paneId: 'p1', edge: 'left' })).toEqual(start())
  })

  test('docking a tab gives it a new pane along that edge', () => {
    const layout = run(withTabs('a', 'b'), { type: 'dockTab', tabId: 'b', edge: 'top', newPaneId: 'p2' })
    expect(shape(layout)).toBe('column(p2,p1)')
    expect(findPane(layout.root, 'p2')?.tabs).toEqual(['b'])
    // The only tab of the only pane stays put.
    expect(run(withTabs('a'), { type: 'dockTab', tabId: 'a', edge: 'top', newPaneId: 'p2' })).toEqual(withTabs('a'))
  })

  test('the neighbour in each direction is the nearest pane that way', () => {
    const layout = run(three(), { type: 'splitPane', paneId: 'p3', direction: 'column', newPaneId: 'p4' })
    const root = layout.root
    expect(neighbourPane(root, 'p1', 'right')?.id).toBe('p2')
    expect(neighbourPane(root, 'p2', 'right')?.id).toBe('p3')
    expect(neighbourPane(root, 'p4', 'left')?.id).toBe('p2')
    expect(neighbourPane(root, 'p3', 'bottom')?.id).toBe('p4')
    expect(neighbourPane(root, 'p1', 'left')).toBeUndefined()
    expect(neighbourPane(root, 'p2', 'top')).toBeUndefined()
  })

  test('a pane grows across the nearest boundary on that side', () => {
    const layout = run(three(), { type: 'splitPane', paneId: 'p3', direction: 'column', newPaneId: 'p4' })
    // row(p1, p2, column(p3, p4))
    expect(boundaryToward(layout.root, 'p1', 'right')).toMatchObject({ index: 0, beyond: 1 })
    expect(boundaryToward(layout.root, 'p4', 'left')).toMatchObject({
      split: { direction: 'row' },
      index: 2,
      beyond: 1,
    })
    expect(boundaryToward(layout.root, 'p4', 'top')).toMatchObject({
      split: { direction: 'column' },
      index: 1,
      beyond: 0,
    })
    expect(boundaryToward(layout.root, 'p1', 'left')).toBeUndefined()
    expect(boundaryToward(layout.root, 'p2', 'bottom')).toBeUndefined()
  })

  test('closing the focused pane focuses another; the last pane only empties', () => {
    const split = run(withTabs('a'), { type: 'splitPane', paneId: 'p1', direction: 'row', newPaneId: 'p2' })
    expect(split.focusedPane).toBe('p2')
    const closed = run(split, { type: 'closePane', paneId: 'p2' })
    expect(closed.focusedPane).toBe('p1')
    const emptied = run(closed, { type: 'closePane', paneId: 'p1' })
    expect(emptied.root).toEqual({ type: 'pane', id: 'p1', tabs: [], active: null })
    expect(emptied.tabs).toEqual({})
  })

  test('split sizes are set only when they match the split', () => {
    const split = run(start(), { type: 'splitPane', paneId: 'p1', direction: 'row', newPaneId: 'p2' })
    const id = split.root.id
    expect(sizes(run(split, { type: 'setSplitSizes', splitId: id, sizes: [30, 70] }).root)).toEqual({
      row: [30, 70],
      of: ['p1', 'p2'],
    })
    expect(run(split, { type: 'setSplitSizes', splitId: id, sizes: [100] })).toEqual(split)
  })
})

describe('maximize, equalize and reset', () => {
  const two = () => run(withTabs('a'), { type: 'splitPane', paneId: 'p1', direction: 'row', newPaneId: 'p2' })

  test('a pane maximizes among others, and restores on a second toggle', () => {
    expect(run(withTabs('a'), { type: 'toggleMaximize', paneId: 'p1' }).maximized).toBeNull()
    const maximized = run(two(), { type: 'toggleMaximize', paneId: 'p1' })
    expect(maximized).toMatchObject({ maximized: 'p1', focusedPane: 'p1' })
    expect(run(maximized, { type: 'toggleMaximize', paneId: 'p1' }).maximized).toBeNull()
  })

  test('rearranging panes or focusing another restores the grid; tab changes do not', () => {
    const maximized = run(two(), { type: 'toggleMaximize', paneId: 'p1' })
    expect(run(maximized, { type: 'openTab', tab: tab('b') }).maximized).toBe('p1')
    expect(run(maximized, { type: 'focusPane', paneId: 'p2' }).maximized).toBeNull()
    expect(
      run(maximized, { type: 'splitPane', paneId: 'p1', direction: 'column', newPaneId: 'p3' }).maximized,
    ).toBeNull()
    expect(run(maximized, { type: 'closePane', paneId: 'p2' }).maximized).toBeNull()
    // Moving the other pane's only tab in removes that pane.
    const other = run(maximized, { type: 'openTab', tab: tab('b'), paneId: 'p2' }, { type: 'focusPane', paneId: 'p1' })
    const again = run(
      other,
      { type: 'toggleMaximize', paneId: 'p1' },
      { type: 'moveTab', tabId: 'b', paneId: 'p1', index: 0 },
    )
    expect(again.maximized).toBeNull()
  })

  test('equalizing evens one split or all of them', () => {
    const nested = run(
      two(),
      { type: 'splitPane', paneId: 'p2', direction: 'column', newPaneId: 'p3' },
      { type: 'setSplitSizes', splitId: two().root.id, sizes: [20, 80] },
    )
    const inner = (layout: Layout) => (layout.root.type === 'split' ? layout.root.children[1]! : layout.root)
    const skewed = run(nested, { type: 'setSplitSizes', splitId: inner(nested).id, sizes: [10, 90] })
    const one = run(skewed, { type: 'equalizeSplits', splitId: inner(skewed).id })
    expect(sizes(one.root)).toEqual({ row: [20, 80], of: ['p1', { column: [50, 50], of: ['p2', 'p3'] }] })
    expect(sizes(run(skewed, { type: 'equalizeSplits' }).root)).toEqual({
      row: [50, 50],
      of: ['p1', { column: [50, 50], of: ['p2', 'p3'] }],
    })
  })

  test('reset puts the sidebars back and evens the splits, keeping panes and tabs', () => {
    const messy = run(
      two(),
      { type: 'swapSidebars' },
      { type: 'toggleSide', side: 'left' },
      { type: 'setWidth', sidebar: 'navigator', width: 420 },
      { type: 'setSplitSizes', splitId: two().root.id, sizes: [30, 70] },
    )
    const reset = run(messy, { type: 'resetLayout' })
    expect(reset).toMatchObject({
      sidebars: ['navigator', 'inspector'],
      collapsed: { navigator: false, inspector: false },
    })
    expect(reset.widths).toEqual({ navigator: SIDEBAR_WIDTH.navigator, inspector: SIDEBAR_WIDTH.inspector })
    expect(sizes(reset.root)).toEqual({ row: [50, 50], of: ['p1', 'p2'] })
    expect(reset.tabs).toEqual(messy.tabs)
  })

  test('a pane needs room for its widest kind of tab; splits add their children and gutters', () => {
    const layout = run(two(), { type: 'openTab', tab: { id: 'c', kind: 'terminal', title: 'c' }, paneId: 'p2' })
    expect(minSize(layout.root, layout.tabs)).toEqual({
      width: PANE_MIN.width.terminal + PANE_MIN.width.conversation + GUTTER,
      height: PANE_MIN.height,
    })
  })
})

test('a layout saved before maximizing existed loads with no pane maximized', () => {
  const { maximized: _removed, ...old } = start()
  expect(parseLayout(old)?.maximized).toBeNull()
})

test('the structure key ignores sizes, so resizing never triggers a layout animation', () => {
  const split = run(start(), { type: 'splitPane', paneId: 'p1', direction: 'row', newPaneId: 'p2' })
  const resized = run(split, { type: 'setSplitSizes', splitId: split.root.id, sizes: [20, 80] })
  expect(shape(resized)).toBe(shape(split))
  expect(panes(resized.root).map((pane) => pane.id)).toEqual(['p1', 'p2'])
})
