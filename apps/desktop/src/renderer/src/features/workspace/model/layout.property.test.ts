import fc from 'fast-check'
import { expect, test } from 'vitest'
import { defaultLayout, type Edge, type Layout, type LayoutNode } from './layout'
import { panes } from './layout-tree'
import { layoutReducer, type LayoutAction } from './layout.logic'

// Stress: thousands of random action sequences, checking after every step that the layout is still
// well formed. Drag and drop produces exactly these actions, in any order, with any ids.

function checkInvariants(layout: Layout): void {
  const all = panes(layout.root)
  const ids = all.map((pane) => pane.id)
  expect(new Set(ids).size, 'pane ids are unique').toBe(ids.length)
  const placed = all.flatMap((pane) => pane.tabs)
  expect(new Set(placed).size, 'a tab is in one pane only').toBe(placed.length)
  expect(new Set(placed), 'every placed tab has a record and every record is placed').toEqual(
    new Set(Object.keys(layout.tabs)),
  )
  for (const pane of all) {
    if (pane.active !== null) expect(pane.tabs, 'the active tab is in its pane').toContain(pane.active)
    if (pane.tabs.length > 0) expect(pane.active, 'a pane with tabs has one active').not.toBeNull()
  }
  expect(ids, 'the focused pane exists').toContain(layout.focusedPane)
  const walk = (node: LayoutNode, parentDirection?: string): void => {
    if (node.type === 'pane') return
    expect(node.children.length, 'a split has at least two children').toBeGreaterThanOrEqual(2)
    expect(node.sizes.length, 'one size per child').toBe(node.children.length)
    expect(Math.abs(node.sizes.reduce((sum, size) => sum + size, 0) - 100), 'sizes sum to 100').toBeLessThan(0.001)
    expect(node.direction, 'no split inside a split of the same direction').not.toBe(parentDirection)
    for (const child of node.children) walk(child, node.direction)
  }
  walk(layout.root)
  const nodeIds: string[] = []
  const collect = (node: LayoutNode): void => {
    nodeIds.push(node.id)
    if (node.type === 'split') node.children.forEach(collect)
  }
  collect(layout.root)
  expect(new Set(nodeIds).size, 'node ids are unique').toBe(nodeIds.length)
}

const edge = fc.constantFrom<Edge>('left', 'right', 'top', 'bottom')
const zone = fc.constantFrom('left', 'right', 'top', 'bottom', 'centre' as const)

// Actions refer to existing panes and tabs by position, so most of them do something.
type Step = (layout: Layout, fresh: () => string) => LayoutAction | null
const pick = <T>(items: T[], index: number): T | undefined => (items.length ? items[index % items.length] : undefined)
const paneAt = (layout: Layout, index: number) => pick(panes(layout.root), index)?.id
const tabAt = (layout: Layout, index: number) => pick(Object.keys(layout.tabs), index)

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.nat().map((i): Step => (l, fresh) => ({
    type: 'openTab',
    tab: { id: fresh(), kind: 'terminal', title: 't' },
    paneId: paneAt(l, i),
  })),
  fc.nat().map(
    (i): Step =>
      (l) =>
        tabAt(l, i) ? { type: 'closeTab', tabId: tabAt(l, i)! } : null,
  ),
  fc.tuple(fc.nat(), fc.nat(), fc.nat()).map(
    ([t, p, i]): Step =>
      (l) =>
        tabAt(l, t) && paneAt(l, p)
          ? { type: 'moveTab', tabId: tabAt(l, t)!, paneId: paneAt(l, p)!, index: i % 6 }
          : null,
  ),
  fc.tuple(fc.nat(), fc.nat(), zone).map(
    ([t, p, z]): Step =>
      (l, fresh) =>
        tabAt(l, t) && paneAt(l, p)
          ? { type: 'dropTab', tabId: tabAt(l, t)!, paneId: paneAt(l, p)!, zone: z, newPaneId: fresh() }
          : null,
  ),
  fc.tuple(fc.nat(), fc.boolean()).map(
    ([p, row]): Step =>
      (l, fresh) =>
        paneAt(l, p)
          ? { type: 'splitPane', paneId: paneAt(l, p)!, direction: row ? 'row' : 'column', newPaneId: fresh() }
          : null,
  ),
  fc.tuple(fc.nat(), fc.nat(), zone).map(
    ([a, b, z]): Step =>
      (l) =>
        paneAt(l, a) && paneAt(l, b)
          ? { type: 'movePane', paneId: paneAt(l, a)!, targetId: paneAt(l, b)!, zone: z }
          : null,
  ),
  fc.tuple(fc.nat(), fc.nat()).map(
    ([a, b]): Step =>
      (l) =>
        paneAt(l, a) && paneAt(l, b) ? { type: 'swapPanes', paneId: paneAt(l, a)!, targetId: paneAt(l, b)! } : null,
  ),
  fc.tuple(fc.nat(), edge).map(
    ([t, e]): Step =>
      (l, fresh) =>
        tabAt(l, t) ? { type: 'dockTab', tabId: tabAt(l, t)!, edge: e, newPaneId: fresh() } : null,
  ),
  fc.tuple(fc.nat(), edge).map(
    ([p, e]): Step =>
      (l) =>
        paneAt(l, p) ? { type: 'dockPane', paneId: paneAt(l, p)!, edge: e } : null,
  ),
  fc.nat().map(
    (p): Step =>
      (l) =>
        paneAt(l, p) ? { type: 'closePane', paneId: paneAt(l, p)! } : null,
  ),
  fc.nat().map(
    (p): Step =>
      (l) =>
        paneAt(l, p) ? { type: 'focusPane', paneId: paneAt(l, p)! } : null,
  ),
  fc.constant<Step>(() => ({ type: 'swapSidebars' })),
)

test('any sequence of layout actions keeps the layout well formed', () => {
  fc.assert(
    fc.property(fc.array(step, { minLength: 1, maxLength: 60 }), (steps) => {
      let counter = 0
      const fresh = (): string => `n${++counter}`
      let layout = defaultLayout('p0')
      for (const make of steps) {
        const action = make(layout, fresh)
        if (!action) continue
        layout = layoutReducer(layout, action)
        checkInvariants(layout)
      }
    }),
    { numRuns: 2000 },
  )
})
