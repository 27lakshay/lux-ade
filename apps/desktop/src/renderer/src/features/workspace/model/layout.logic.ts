import { produce } from 'immer'
import {
  SIDEBAR_WIDTH,
  type DropZone,
  type Edge,
  type Layout,
  type PaneNode,
  type Side,
  type SidebarId,
  type SplitDirection,
  type Tab,
} from './layout'
import {
  dock,
  findNode,
  findPane,
  insertBeside,
  paneOfTab,
  panes,
  removeNode,
  swapNodes,
  zoneAfter,
  zoneDirection,
} from './layout-tree'

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
  | { type: 'swapPanes'; paneId: string; targetId: string }
  | { type: 'dockTab'; tabId: string; edge: Edge; newPaneId: string }
  | { type: 'dockPane'; paneId: string; edge: Edge }
  | { type: 'closePane'; paneId: string }
  | { type: 'focusPane'; paneId: string }
  | { type: 'setSplitSizes'; splitId: string; sizes: number[] }

/** Every pane, in reading order. */

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
        // A pane dropped on another's centre trades places with it; tabs are merged by dragging tabs.
        if (action.zone === 'centre') {
          draft.root = swapNodes(draft.root, pane.id, target.id)
          draft.focusedPane = pane.id
          return
        }
        const moving = { ...pane, tabs: [...pane.tabs] }
        draft.root = removeNode(draft.root, pane.id)
        draft.root = insertBeside(draft.root, target.id, moving, zoneDirection(action.zone), zoneAfter(action.zone))
        draft.focusedPane = moving.id
        return
      }
      case 'swapPanes': {
        const pane = findPane(draft.root, action.paneId)
        const target = findPane(draft.root, action.targetId)
        if (!pane || !target || pane === target) return
        draft.root = swapNodes(draft.root, pane.id, target.id)
        draft.focusedPane = pane.id
        return
      }
      case 'dockTab': {
        const source = paneOfTab(draft.root, action.tabId)
        if (!source) return
        // Docking the only tab of the only pane would leave nothing behind: nothing to do.
        if (source.tabs.length === 1 && panes(draft.root).length === 1) return
        takeTab(draft, action.tabId)
        dropIfEmpty(draft, source)
        const pane: PaneNode = { type: 'pane', id: action.newPaneId, tabs: [action.tabId], active: action.tabId }
        draft.root = dock(draft.root, pane, action.edge)
        draft.focusedPane = pane.id
        return
      }
      case 'dockPane': {
        const pane = findPane(draft.root, action.paneId)
        if (!pane || panes(draft.root).length === 1) return
        const moving = { ...pane, tabs: [...pane.tabs] }
        draft.root = removeNode(draft.root, pane.id)
        draft.root = dock(draft.root, moving, action.edge)
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
