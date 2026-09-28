import { produce } from 'immer'
import {
  SIDEBAR_WIDTH,
  type DropZone,
  type Layout,
  type LayoutNode,
  type PaneNode,
  type Side,
  type SidebarId,
  type SplitDirection,
  type SplitNode,
  type Tab,
} from './layout'

// Every change to a workspace layout, as one pure function: (layout, action) → layout. New ids come
// in with the action, so the reducer stays deterministic and testable.

export type LayoutAction =
  | { type: 'swapSidebars' }
  | { type: 'toggleSide'; side: Side }
  | { type: 'setCollapsed'; sidebar: SidebarId; collapsed: boolean }
  | { type: 'setWidth'; sidebar: SidebarId; width: number }
  | { type: 'openTab'; tab: Tab; paneId?: string }
  | { type: 'activateTab'; tabId: string }
  | { type: 'closeTab'; tabId: string }
  | { type: 'moveTab'; tabId: string; paneId: string; index: number }
  | { type: 'dropTab'; tabId: string; paneId: string; zone: DropZone; newPaneId: string }
  | { type: 'splitPane'; paneId: string; direction: SplitDirection; newPaneId: string }
  | { type: 'movePane'; paneId: string; targetId: string; zone: DropZone }
  | { type: 'closePane'; paneId: string }
  | { type: 'focusPane'; paneId: string }
  | { type: 'setSplitSizes'; splitId: string; sizes: number[] }

/** Every pane, in reading order. */
export function panes(node: LayoutNode): PaneNode[] {
  return node.type === 'pane' ? [node] : node.children.flatMap(panes)
}

export const findPane = (root: LayoutNode, id: string): PaneNode | undefined =>
  panes(root).find((pane) => pane.id === id)

const paneOfTab = (root: LayoutNode, tabId: string): PaneNode | undefined =>
  panes(root).find((pane) => pane.tabs.includes(tabId))

/** A string that changes only when the tree's shape changes, never when sizes do. */
export function structureKey(node: LayoutNode): string {
  return node.type === 'pane' ? node.id : `${node.direction}(${node.children.map(structureKey).join(',')})`
}

function findNode(node: LayoutNode, id: string): LayoutNode | undefined {
  if (node.id === id) return node
  if (node.type === 'pane') return undefined
  for (const child of node.children) {
    const found = findNode(child, id)
    if (found) return found
  }
  return undefined
}

function parentOf(root: LayoutNode, id: string): SplitNode | undefined {
  if (root.type === 'pane') return undefined
  for (const child of root.children) {
    if (child.id === id) return root
    const found = parentOf(child, id)
    if (found) return found
  }
  return undefined
}

const zoneDirection = (zone: Exclude<DropZone, 'centre'>): SplitDirection =>
  zone === 'left' || zone === 'right' ? 'row' : 'column'
const zoneAfter = (zone: Exclude<DropZone, 'centre'>): boolean => zone === 'right' || zone === 'bottom'

/** Puts `node` beside `targetId`, splitting the target in two. Mutates the draft; returns the root. */
function insertBeside(
  root: LayoutNode,
  targetId: string,
  node: LayoutNode,
  direction: SplitDirection,
  after: boolean,
): LayoutNode {
  const parent = parentOf(root, targetId)
  if (parent && parent.direction === direction) {
    const index = parent.children.findIndex((child) => child.id === targetId)
    const half = parent.sizes[index]! / 2
    parent.sizes[index] = half
    const at = after ? index + 1 : index
    parent.children.splice(at, 0, node)
    parent.sizes.splice(at, 0, half)
    return root
  }
  const target = findNode(root, targetId)!
  const split: SplitNode = {
    type: 'split',
    id: `split-${node.id}`,
    direction,
    children: after ? [target, node] : [node, target],
    sizes: [50, 50],
  }
  if (!parent) return split
  const index = parent.children.findIndex((child) => child.id === targetId)
  parent.children[index] = split
  return root
}

/** Takes a node out of the tree, giving its space to a neighbour and collapsing one-child splits. */
function removeNode(root: LayoutNode, id: string): LayoutNode {
  const parent = parentOf(root, id)
  if (!parent) return root
  const index = parent.children.findIndex((child) => child.id === id)
  const [freed] = parent.sizes.splice(index, 1)
  parent.children.splice(index, 1)
  const neighbour = index > 0 ? index - 1 : 0
  parent.sizes[neighbour] = (parent.sizes[neighbour] ?? 0) + (freed ?? 0)
  if (parent.children.length > 1) return root
  return replaceNode(root, parent.id, parent.children[0]!)
}

/** Replaces a node, flattening a split into a parent split of the same direction. */
function replaceNode(root: LayoutNode, id: string, replacement: LayoutNode): LayoutNode {
  const parent = parentOf(root, id)
  if (!parent) return replacement
  const index = parent.children.findIndex((child) => child.id === id)
  if (replacement.type === 'split' && replacement.direction === parent.direction) {
    const share = parent.sizes[index]!
    parent.children.splice(index, 1, ...replacement.children)
    parent.sizes.splice(index, 1, ...replacement.sizes.map((size) => (size * share) / 100))
  } else {
    parent.children[index] = replacement
  }
  return root
}

function refocus(draft: Layout, removedPaneId: string): void {
  if (draft.focusedPane === removedPaneId || !findPane(draft.root, draft.focusedPane))
    draft.focusedPane = panes(draft.root)[0]!.id
}

function takeTab(draft: Layout, tabId: string): PaneNode | undefined {
  const pane = paneOfTab(draft.root, tabId)
  if (!pane) return undefined
  const index = pane.tabs.indexOf(tabId)
  pane.tabs.splice(index, 1)
  if (pane.active === tabId) pane.active = pane.tabs[index] ?? pane.tabs[index - 1] ?? null
  return pane
}

/** Removes an emptied pane unless it is the last one. */
function dropIfEmpty(draft: Layout, pane: PaneNode): void {
  if (pane.tabs.length > 0 || panes(draft.root).length === 1) return
  draft.root = removeNode(draft.root, pane.id)
  refocus(draft, pane.id)
}

const clampWidth = (width: number): number =>
  Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)))

export const layoutReducer = (layout: Layout, action: LayoutAction): Layout =>
  produce(layout, (draft) => {
    switch (action.type) {
      case 'swapSidebars':
        draft.sidebars = [draft.sidebars[1], draft.sidebars[0]]
        return
      case 'toggleSide': {
        const sidebar = draft.sidebars[action.side === 'left' ? 0 : 1]
        draft.collapsed[sidebar] = !draft.collapsed[sidebar]
        return
      }
      case 'setCollapsed':
        draft.collapsed[action.sidebar] = action.collapsed
        return
      case 'setWidth':
        draft.widths[action.sidebar] = clampWidth(action.width)
        return
      case 'openTab': {
        const pane = findPane(draft.root, action.paneId ?? draft.focusedPane) ?? panes(draft.root)[0]!
        draft.tabs[action.tab.id] = action.tab
        const at = pane.active ? pane.tabs.indexOf(pane.active) + 1 : pane.tabs.length
        pane.tabs.splice(at, 0, action.tab.id)
        pane.active = action.tab.id
        draft.focusedPane = pane.id
        return
      }
      case 'activateTab': {
        const pane = paneOfTab(draft.root, action.tabId)
        if (!pane) return
        pane.active = action.tabId
        draft.focusedPane = pane.id
        return
      }
      case 'closeTab': {
        const pane = takeTab(draft, action.tabId)
        if (!pane) return
        delete draft.tabs[action.tabId]
        dropIfEmpty(draft, pane)
        return
      }
      case 'moveTab': {
        const source = paneOfTab(draft.root, action.tabId)
        const target = findPane(draft.root, action.paneId)
        if (!source || !target) return
        const from = source.tabs.indexOf(action.tabId)
        takeTab(draft, action.tabId)
        const index = source === target && from < action.index ? action.index - 1 : action.index
        target.tabs.splice(Math.max(0, Math.min(index, target.tabs.length)), 0, action.tabId)
        target.active = action.tabId
        draft.focusedPane = target.id
        if (source !== target) dropIfEmpty(draft, source)
        return
      }
      case 'dropTab': {
        const source = paneOfTab(draft.root, action.tabId)
        const target = findPane(draft.root, action.paneId)
        if (!source || !target) return
        if (action.zone === 'centre') {
          if (source === target) return
          takeTab(draft, action.tabId)
          target.tabs.push(action.tabId)
          target.active = action.tabId
          draft.focusedPane = target.id
          dropIfEmpty(draft, source)
          return
        }
        // Splitting a pane off its only tab would leave it empty in its own place: nothing to do.
        if (source === target && source.tabs.length === 1) return
        takeTab(draft, action.tabId)
        const pane: PaneNode = { type: 'pane', id: action.newPaneId, tabs: [action.tabId], active: action.tabId }
        draft.root = insertBeside(draft.root, target.id, pane, zoneDirection(action.zone), zoneAfter(action.zone))
        draft.focusedPane = pane.id
        if (source !== target) dropIfEmpty(draft, source)
        return
      }
      case 'splitPane': {
        if (!findPane(draft.root, action.paneId)) return
        const pane: PaneNode = { type: 'pane', id: action.newPaneId, tabs: [], active: null }
        draft.root = insertBeside(draft.root, action.paneId, pane, action.direction, true)
        draft.focusedPane = pane.id
        return
      }
      case 'movePane': {
        const pane = findPane(draft.root, action.paneId)
        const target = findPane(draft.root, action.targetId)
        if (!pane || !target || pane === target) return
        if (action.zone === 'centre') {
          target.tabs.push(...pane.tabs)
          target.active = pane.active ?? target.active
          pane.tabs = []
          draft.root = removeNode(draft.root, pane.id)
          draft.focusedPane = target.id
          return
        }
        const moving = { ...pane, tabs: [...pane.tabs] }
        draft.root = removeNode(draft.root, pane.id)
        draft.root = insertBeside(draft.root, target.id, moving, zoneDirection(action.zone), zoneAfter(action.zone))
        draft.focusedPane = moving.id
        return
      }
      case 'closePane': {
        const pane = findPane(draft.root, action.paneId)
        if (!pane) return
        for (const tabId of pane.tabs) delete draft.tabs[tabId]
        pane.tabs = []
        pane.active = null
        dropIfEmpty(draft, pane)
        return
      }
      case 'focusPane':
        if (findPane(draft.root, action.paneId)) draft.focusedPane = action.paneId
        return
      case 'setSplitSizes': {
        const split = findNode(draft.root, action.splitId)
        if (split?.type === 'split' && action.sizes.length === split.children.length) split.sizes = action.sizes
        return
      }
    }
  })
