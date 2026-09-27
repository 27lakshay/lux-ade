// Pane layout: a split tree. A split lays its children out in a row or a column; each leaf is
// a pane holding tabs. Splitting a pane only divides that pane, and the tree stays normalised: no
// empty splits, no single-child splits, no split directly inside one with the same direction.
// Every operation is pure and returns a new layout, so a drag can apply operations live and
// Escape can restore the snapshot taken when the drag began.

export type TabKind = 'chat' | 'terminal' | 'empty'
export type Status = 'attention' | 'running' | 'done'

export interface Tab {
  id: string
  kind: TabKind
  title: string
  status?: Status
}
export interface Pane {
  id: string
  tabs: string[]
  active: string
}
// `sizes` are the children's relative weights (flex-grow), one per child, kept in step with
// `children` by every operation.
export type Node =
  | { type: 'pane'; id: string }
  | { type: 'split'; id: string; dir: 'row' | 'col'; children: Node[]; sizes: number[] }
export interface Layout {
  root: Node
  panes: Record<string, Pane>
  tabs: Record<string, Tab>
}
export type Side = 'left' | 'right' | 'top' | 'bottom'

let counter = 0
const uid = (prefix: string) => `${prefix}-${(++counter).toString(36)}-${Date.now().toString(36)}`

export function paneOfTab(l: Layout, tabId: string): string {
  const pane = Object.values(l.panes).find((p) => p.tabs.includes(tabId))
  if (!pane) throw new Error(`tab ${tabId} is in no pane`)
  return pane.id
}

// The pane in the window's top-left corner, and the one in its top-right corner. Their tab strips
// leave room for the traffic lights and the title-bar toggles.
export function cornerPanes(l: Layout): { topLeft: string; topRight: string } {
  const walk = (n: Node, pick: (s: Extract<Node, { type: 'split' }>) => Node): string =>
    n.type === 'pane' ? n.id : walk(pick(n), pick)
  return {
    topLeft: walk(l.root, (s) => s.children[0]),
    topRight: walk(l.root, (s) => (s.dir === 'row' ? s.children[s.children.length - 1] : s.children[0])),
  }
}

// --- internal helpers; they mutate a draft ---

const draftOf = (l: Layout): Layout => structuredClone(l)
type Split = Extract<Node, { type: 'split' }>

// The split that directly holds pane `paneId`, and the pane's index in it. Null for a root pane.
function parentOf(root: Node, paneId: string): { parent: Split; index: number } | null {
  if (root.type === 'pane') return null
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i]
    if (child.type === 'pane' && child.id === paneId) return { parent: root, index: i }
    const found = parentOf(child, paneId)
    if (found) return found
  }
  return null
}

// Drops empty splits, unwraps single-child splits, and flattens a split into its parent when both
// run the same direction. A flattened child's weights are scaled to fill the weight it had.
function normalise(n: Node): Node | null {
  if (n.type === 'pane') return n
  const children: Node[] = []
  const sizes: number[] = []
  n.children.forEach((child, i) => {
    const c = normalise(child)
    if (!c) return
    const weight = n.sizes[i] ?? 1
    if (c.type === 'split' && c.dir === n.dir) {
      const total = c.sizes.reduce((a, b) => a + b, 0)
      children.push(...c.children)
      sizes.push(...c.sizes.map((s) => (s / total) * weight))
    } else {
      children.push(c)
      sizes.push(weight)
    }
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  return { ...n, children, sizes }
}

function removeLeaf(d: Layout, paneId: string) {
  const at = parentOf(d.root, paneId)
  if (at) {
    at.parent.children.splice(at.index, 1)
    at.parent.sizes.splice(at.index, 1)
  } else if (d.root.type === 'pane' && d.root.id === paneId) {
    d.root = { type: 'split', id: uid('split'), dir: 'row', children: [], sizes: [] }
  }
}

function detachTab(d: Layout, tabId: string) {
  const pane = d.panes[paneOfTab(d, tabId)]
  const i = pane.tabs.indexOf(tabId)
  pane.tabs.splice(i, 1)
  if (pane.active === tabId) pane.active = pane.tabs[Math.min(i, pane.tabs.length - 1)] ?? ''
}

// Puts pane `paneId` beside `targetId`, dividing only the target's space.
function place(d: Layout, paneId: string, targetId: string, side: Side) {
  const dir = side === 'left' || side === 'right' ? 'row' : 'col'
  const before = side === 'left' || side === 'top'
  const leaf: Node = { type: 'pane', id: paneId }
  const at = parentOf(d.root, targetId)
  if (at && at.parent.dir === dir) {
    // The new pane takes half of the target's share, as the drop preview showed.
    const half = at.parent.sizes[at.index] / 2
    at.parent.sizes[at.index] = half
    at.parent.children.splice(before ? at.index : at.index + 1, 0, leaf)
    at.parent.sizes.splice(before ? at.index : at.index + 1, 0, half)
    return
  }
  const target: Node = { type: 'pane', id: targetId }
  const split: Node = { type: 'split', id: uid('split'), dir, children: before ? [leaf, target] : [target, leaf], sizes: [1, 1] }
  if (at) at.parent.children[at.index] = split
  else d.root = split
}

// Removes panes that lost their last tab and tidies the tree. The layout always keeps one
// pane, with an empty tab if needed.
function prune(d: Layout) {
  for (const pane of Object.values(d.panes)) {
    if (pane.tabs.length > 0) continue
    removeLeaf(d, pane.id)
    delete d.panes[pane.id]
  }
  const root = normalise(d.root)
  if (root) {
    d.root = root
    return
  }
  const tab: Tab = { id: uid('tab'), kind: 'empty', title: 'New tab' }
  const pane: Pane = { id: uid('pane'), tabs: [tab.id], active: tab.id }
  d.tabs[tab.id] = tab
  d.panes[pane.id] = pane
  d.root = { type: 'pane', id: pane.id }
}

// --- operations ---

export function setActive(l: Layout, paneId: string, tabId: string): Layout {
  if (l.panes[paneId].active === tabId) return l
  const d = draftOf(l)
  d.panes[paneId].active = tabId
  return d
}

// Moves a tab to `index` within its own pane.
export function reorderTab(l: Layout, tabId: string, index: number): Layout {
  const d = draftOf(l)
  const pane = d.panes[paneOfTab(d, tabId)]
  pane.tabs.splice(pane.tabs.indexOf(tabId), 1)
  pane.tabs.splice(index, 0, tabId)
  return d
}

// Moves a tab into another pane at `index` and makes it active there.
export function insertTab(l: Layout, tabId: string, paneId: string, index: number): Layout {
  const d = draftOf(l)
  detachTab(d, tabId)
  const pane = d.panes[paneId]
  pane.tabs.splice(Math.min(index, pane.tabs.length), 0, tabId)
  pane.active = tabId
  prune(d)
  return d
}

// Moves a tab into a new pane beside `targetId`.
export function splitWithTab(l: Layout, tabId: string, targetId: string, side: Side): Layout {
  const d = draftOf(l)
  detachTab(d, tabId)
  const pane: Pane = { id: uid('pane'), tabs: [tabId], active: tabId }
  d.panes[pane.id] = pane
  place(d, pane.id, targetId, side)
  prune(d)
  return d
}

// Moves a whole pane beside `targetId`.
export function splitWithPane(l: Layout, paneId: string, targetId: string, side: Side): Layout {
  const d = draftOf(l)
  removeLeaf(d, paneId)
  d.root = normalise(d.root) ?? d.root
  place(d, paneId, targetId, side)
  prune(d)
  return d
}

// Moves every tab of a pane into `targetId`, keeping the moved pane's active tab active.
export function mergePane(l: Layout, paneId: string, targetId: string): Layout {
  const d = draftOf(l)
  const pane = d.panes[paneId]
  d.panes[targetId].tabs.push(...pane.tabs)
  d.panes[targetId].active = pane.active
  pane.tabs = []
  prune(d)
  return d
}

// Trades two panes' places.
export function swapPanes(l: Layout, a: string, b: string): Layout {
  const d = draftOf(l)
  const visit = (n: Node) => {
    if (n.type === 'pane') n.id = n.id === a ? b : n.id === b ? a : n.id
    else n.children.forEach(visit)
  }
  visit(d.root)
  return d
}

function findSplit(n: Node, id: string): Split | null {
  if (n.type === 'pane') return null
  if (n.id === id) return n
  for (const c of n.children) {
    const found = findSplit(c, id)
    if (found) return found
  }
  return null
}

// Sets the weights of the two children either side of divider `index` in split `splitId`.
export function resizeSplit(l: Layout, splitId: string, index: number, before: number, after: number): Layout {
  const d = draftOf(l)
  const split = findSplit(d.root, splitId)
  if (!split) return l
  split.sizes[index] = before
  split.sizes[index + 1] = after
  return d
}

export function closeTab(l: Layout, tabId: string): Layout {
  const d = draftOf(l)
  detachTab(d, tabId)
  delete d.tabs[tabId]
  prune(d)
  return d
}

// A new tab starts empty: it can become anything (a chat or a terminal) once the user picks.
export function addTab(l: Layout, paneId: string): Layout {
  const d = draftOf(l)
  const tab: Tab = { id: uid('tab'), kind: 'empty', title: 'New tab' }
  d.tabs[tab.id] = tab
  const pane = d.panes[paneId]
  pane.tabs.splice(pane.tabs.indexOf(pane.active) + 1, 0, tab.id)
  pane.active = tab.id
  return d
}

export function splitRight(l: Layout, paneId: string): Layout {
  const d = draftOf(l)
  const tab: Tab = { id: uid('tab'), kind: 'empty', title: 'New tab' }
  const pane: Pane = { id: uid('pane'), tabs: [tab.id], active: tab.id }
  d.tabs[tab.id] = tab
  d.panes[pane.id] = pane
  place(d, pane.id, paneId, 'right')
  return d
}

export function setKind(l: Layout, tabId: string, kind: TabKind, title: string): Layout {
  const d = draftOf(l)
  d.tabs[tabId] = { ...d.tabs[tabId], kind, title }
  return d
}

// The demo layout: a chat with a terminal tab on the left; a second chat over a terminal on
// the right.
export function demoLayout(): Layout {
  const tabs: Tab[] = [
    { id: 't-review', kind: 'chat', title: 'Design review pass', status: 'attention' },
    { id: 't-dev', kind: 'terminal', title: 'pnpm dev' },
    { id: 't-package', kind: 'chat', title: 'Packaging E2E', status: 'running' },
    { id: 't-cargo', kind: 'terminal', title: 'cargo test' },
  ]
  return {
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    panes: {
      'p-main': { id: 'p-main', tabs: ['t-review', 't-dev'], active: 't-review' },
      'p-package': { id: 'p-package', tabs: ['t-package'], active: 't-package' },
      'p-cargo': { id: 'p-cargo', tabs: ['t-cargo'], active: 't-cargo' },
    },
    root: {
      type: 'split',
      id: 's-root',
      dir: 'row',
      sizes: [1, 1],
      children: [
        { type: 'pane', id: 'p-main' },
        { type: 'split', id: 's-right', dir: 'col', sizes: [1, 1], children: [{ type: 'pane', id: 'p-package' }, { type: 'pane', id: 'p-cargo' }] },
      ],
    },
  }
}
