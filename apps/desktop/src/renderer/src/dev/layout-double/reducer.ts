import { produce } from 'immer'
import type { Layout, LayoutAction, LayoutNode, PaneNode, SidebarId } from '@ade/contracts'
import { clampWidth, SIDEBAR_WIDTH } from '../../features/workspace/model/layout'
import {
  findNode,
  findPane,
  paneOfTab,
  panes,
  zoneAfter,
  zoneDirection,
} from '../../features/workspace/model/layout-tree'
import { dock, insertBeside, removeNode, swapNodes } from './tree'

// A test and development double of the daemon's layout core (`crates/ade-core/src/layout`): the
// renderer's tests and `?bench` apply layout actions through it, in a fake daemon (fake-layouts.ts),
// because the bench's synthetic tab targets are ones the real daemon refuses. The app never applies
// a layout itself: the daemon does (daemon authority decision 1). It runs lane A's shared vectors
// (reducer.test.ts), so it cannot drift from the daemon.

/** Actions that rearrange panes: a maximised pane gives way to the new arrangement. */
const REARRANGES = new Set<LayoutAction['type']>([
  'drop_tab',
  'split_pane',
  'move_pane',
  'swap_panes',
  'dock_tab',
  'dock_pane',
  'close_pane',
  'equalize_splits',
  'reset_layout',
])

/** Actions whose repeat is not the same as doing them once: `layout.apply` wants a revision. */
export const RELATIVE = new Set<LayoutAction['type']>(['move_pane', 'swap_panes', 'dock_pane'])

/** Thrown for what the daemon refuses as `invalid_layout`. */
export class LayoutRefusal extends Error {}

const RETRY = Symbol('retry')

function refocus(draft: Layout, removedPaneId: string): void {
  if (draft.focused_pane === removedPaneId || !findPane(draft.root, draft.focused_pane))
    draft.focused_pane = panes(draft.root)[0]!.id
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

const evenSizes = (count: number): number[] => Array.from({ length: count }, () => 100 / count)

function equalize(node: LayoutNode, splitId?: string | null): void {
  if (node.type === 'pane') return
  if (!splitId || node.id === splitId) node.sizes = evenSizes(node.children.length)
  for (const child of node.children) equalize(child, splitId)
}

/** Whether a new pane `id` may be made; a pane already there makes the action its own retry. */
function newPane(draft: Layout, id: string): void {
  const node = findNode(draft.root, id)
  if (node?.type === 'split') throw new LayoutRefusal(`${id} already names a split`)
  if (node) throw RETRY
}

const paneNode = (id: string, tab: string | null): PaneNode => ({
  type: 'pane',
  id,
  tabs: tab ? [tab] : [],
  active: tab,
})

const other = (sidebar: SidebarId): SidebarId => (sidebar === 'navigator' ? 'inspector' : 'navigator')

/** Applies one action, as the daemon's `ade_core::layout::apply` does. */
export function applyLayout(layout: Layout, action: LayoutAction): Layout {
  try {
    return produce(layout, (draft) => {
      apply(draft, action)
      // The maximised pane is the focused one; rearranging panes or focusing another restores the grid.
      if (
        draft.maximized !== null &&
        (REARRANGES.has(action.type) ||
          draft.maximized !== draft.focused_pane ||
          // Closing or moving a tab can remove the other panes: alone, a pane has nothing to hide.
          draft.root.type === 'pane' ||
          !findPane(draft.root, draft.maximized))
      )
        draft.maximized = null
    })
  } catch (error) {
    if (error === RETRY) return layout
    throw error
  }
}

function apply(draft: Layout, action: LayoutAction): void {
  switch (action.type) {
    case 'set_sidebar_sides':
      draft.sidebars = [action.left, other(action.left)]
      return
    case 'set_side_collapsed':
      draft.collapsed[draft.sidebars[action.side === 'left' ? 0 : 1]] = action.collapsed
      return
    case 'set_collapsed':
      draft.collapsed[action.sidebar] = action.collapsed
      return
    case 'set_width':
      if (!Number.isFinite(action.width)) throw new LayoutRefusal('A sidebar width must be a finite number')
      draft.widths[action.sidebar] = clampWidth(action.width)
      return
    case 'open_tab': {
      const existing = draft.tabs[action.tab.id]
      if (existing) {
        if (JSON.stringify(existing.target) !== JSON.stringify(action.tab.target))
          throw new LayoutRefusal(`Tab ${action.tab.id} already shows another target`)
        return apply(draft, { type: 'activate_tab', tab_id: action.tab.id })
      }
      const pane = findPane(draft.root, action.pane_id ?? draft.focused_pane) ?? panes(draft.root)[0]!
      draft.tabs[action.tab.id] = action.tab
      const at = pane.active ? pane.tabs.indexOf(pane.active) + 1 : pane.tabs.length
      pane.tabs.splice(at, 0, action.tab.id)
      pane.active = action.tab.id
      draft.focused_pane = pane.id
      return
    }
    case 'activate_tab': {
      const pane = paneOfTab(draft.root, action.tab_id)
      if (!pane) return
      pane.active = action.tab_id
      draft.focused_pane = pane.id
      return
    }
    case 'close_tab': {
      const pane = takeTab(draft, action.tab_id)
      if (!pane) return
      delete draft.tabs[action.tab_id]
      dropIfEmpty(draft, pane)
      return
    }
    case 'move_tab': {
      const source = paneOfTab(draft.root, action.tab_id)
      const target = findPane(draft.root, action.pane_id)
      if (!source || !target) return
      const from = source.tabs.indexOf(action.tab_id)
      takeTab(draft, action.tab_id)
      const index = source === target && from < action.index ? action.index - 1 : action.index
      target.tabs.splice(Math.max(0, Math.min(index, target.tabs.length)), 0, action.tab_id)
      target.active = action.tab_id
      draft.focused_pane = target.id
      if (source !== target) dropIfEmpty(draft, source)
      return
    }
    case 'drop_tab': {
      const source = paneOfTab(draft.root, action.tab_id)
      const target = findPane(draft.root, action.pane_id)
      if (!source || !target) return
      if (action.zone === 'centre') {
        if (source === target) return
        takeTab(draft, action.tab_id)
        target.tabs.push(action.tab_id)
        target.active = action.tab_id
        draft.focused_pane = target.id
        dropIfEmpty(draft, source)
        return
      }
      // Splitting a pane off its only tab would leave it empty in its own place: nothing to do.
      if (source === target && source.tabs.length === 1) return
      newPane(draft, action.new_pane_id)
      takeTab(draft, action.tab_id)
      const pane = paneNode(action.new_pane_id, action.tab_id)
      draft.root = insertBeside(draft.root, target.id, pane, zoneDirection(action.zone), zoneAfter(action.zone))
      draft.focused_pane = pane.id
      if (source !== target) dropIfEmpty(draft, source)
      return
    }
    case 'split_pane': {
      if (!findPane(draft.root, action.pane_id)) return
      newPane(draft, action.new_pane_id)
      draft.root = insertBeside(draft.root, action.pane_id, paneNode(action.new_pane_id, null), action.direction, true)
      draft.focused_pane = action.new_pane_id
      return
    }
    case 'move_pane': {
      const pane = findPane(draft.root, action.pane_id)
      const target = findPane(draft.root, action.target_id)
      if (!pane || !target || pane === target) return
      // A pane dropped on another's centre trades places with it; tabs are merged by dragging tabs.
      if (action.zone === 'centre') {
        draft.root = swapNodes(draft.root, pane.id, target.id)
        draft.focused_pane = pane.id
        return
      }
      const moving = { ...pane, tabs: [...pane.tabs] }
      draft.root = removeNode(draft.root, pane.id)
      draft.root = insertBeside(draft.root, target.id, moving, zoneDirection(action.zone), zoneAfter(action.zone))
      draft.focused_pane = moving.id
      return
    }
    case 'swap_panes': {
      const pane = findPane(draft.root, action.pane_id)
      const target = findPane(draft.root, action.target_id)
      if (!pane || !target || pane === target) return
      draft.root = swapNodes(draft.root, pane.id, target.id)
      draft.focused_pane = pane.id
      return
    }
    case 'dock_tab': {
      const source = paneOfTab(draft.root, action.tab_id)
      if (!source) return
      // Docking the only tab of the only pane would leave nothing behind: nothing to do.
      if (source.tabs.length === 1 && panes(draft.root).length === 1) return
      newPane(draft, action.new_pane_id)
      takeTab(draft, action.tab_id)
      dropIfEmpty(draft, source)
      draft.root = dock(draft.root, paneNode(action.new_pane_id, action.tab_id), action.edge)
      draft.focused_pane = action.new_pane_id
      return
    }
    case 'dock_pane': {
      const pane = findPane(draft.root, action.pane_id)
      if (!pane || panes(draft.root).length === 1) return
      const moving = { ...pane, tabs: [...pane.tabs] }
      draft.root = removeNode(draft.root, pane.id)
      draft.root = dock(draft.root, moving, action.edge)
      draft.focused_pane = moving.id
      return
    }
    case 'close_pane': {
      const pane = findPane(draft.root, action.pane_id)
      if (!pane) return
      for (const tabId of pane.tabs) delete draft.tabs[tabId]
      pane.tabs = []
      pane.active = null
      dropIfEmpty(draft, pane)
      return
    }
    case 'focus_pane':
      if (findPane(draft.root, action.pane_id)) draft.focused_pane = action.pane_id
      return
    case 'set_split_sizes': {
      if (action.sizes.some((size) => !(size > 0)) || Math.abs(action.sizes.reduce((a, b) => a + b, 0) - 100) >= 0.001)
        throw new LayoutRefusal('Split sizes must be positive and sum to 100')
      const split = findNode(draft.root, action.split_id)
      if (split?.type === 'split' && action.sizes.length === split.children.length) split.sizes = action.sizes
      return
    }
    case 'set_maximized': {
      if (!action.pane_id) {
        draft.maximized = null
        return
      }
      // Only a pane among others can fill the centre.
      if (!findPane(draft.root, action.pane_id) || draft.root.type === 'pane') return
      draft.maximized = action.pane_id
      draft.focused_pane = action.pane_id
      return
    }
    case 'equalize_splits':
      equalize(draft.root, action.split_id)
      return
    case 'reset_layout':
      draft.sidebars = ['navigator', 'inspector']
      draft.collapsed = { navigator: false, inspector: false }
      draft.widths = { navigator: SIDEBAR_WIDTH.navigator, inspector: SIDEBAR_WIDTH.inspector }
      equalize(draft.root)
      return
  }
}
