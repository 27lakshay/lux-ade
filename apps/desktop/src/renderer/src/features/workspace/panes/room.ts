import { toast } from '@/components/ui/toast'
import type { Layout, LayoutAction, LayoutNode, PaneNode, SplitDirection } from '../model/layout'
import { layoutNow, splitPane } from '../model/layout-store'
import { findPane, minSize, paneOfTab, zoneDirection } from '../model/layout-tree'

// A change to the panes is allowed only when the result still fits the centre at every pane's
// minimum (PANE_MIN): layouts never squeeze a pane below what its content needs. The centre is
// taken as it is now; closing a sidebar or widening the window makes room.
//
// The daemon makes the change; this checks it first. It needs only the shape the change leaves:
// which panes, holding which tabs, side by side or stacked. A tree's minimum does not depend on
// how its splits are nested or sized, so the shape is built plainly, without the daemon's rules.

const centreBox = (): { width: number; height: number } | null => {
  const centre = document.getElementById('centre')
  if (!centre) return null
  const { width, height } = centre.getBoundingClientRect()
  return width > 0 && height > 0 ? { width, height } : null
}

type Rewrite = (pane: PaneNode) => LayoutNode | null

/** The tree with each pane rewritten (null takes it out). */
function rewrite(node: LayoutNode, change: Rewrite): LayoutNode | null {
  if (node.type === 'pane') return change(node)
  const children = node.children.map((child) => rewrite(child, change)).filter((child) => child !== null)
  if (children.length === 0) return null
  return children.length === 1 ? children[0]! : { ...node, children }
}

const beside = (pane: LayoutNode, added: LayoutNode, direction: SplitDirection): LayoutNode => ({
  type: 'split',
  id: 'room',
  direction,
  children: [pane, added],
  sizes: [50, 50],
})
const newPane = (tabs: string[]): PaneNode => ({ type: 'pane', id: 'room-new', tabs, active: tabs[0] ?? null })
const without = (pane: PaneNode, tabId: string): PaneNode | null => {
  const tabs = pane.tabs.filter((id) => id !== tabId)
  return tabs.length === 0 ? null : { ...pane, tabs }
}

/** The shape `action` leaves, for sizing only; null when it adds nothing that needs room. */
function shapeAfter(layout: Layout, action: LayoutAction): LayoutNode | null {
  const root = layout.root
  switch (action.type) {
    case 'split_pane':
      return rewrite(root, (pane) => (pane.id === action.pane_id ? beside(pane, newPane([]), action.direction) : pane))
    case 'move_tab':
    case 'drop_tab': {
      const source = paneOfTab(root, action.tab_id)
      if (!source) return null
      const zone = action.type === 'move_tab' ? 'centre' : action.zone
      return rewrite(root, (pane) => {
        const kept = pane.id === source.id ? without(pane, action.tab_id) : pane
        if (pane.id !== action.pane_id) return kept
        if (zone === 'centre') return { ...pane, tabs: [...pane.tabs, action.tab_id] }
        return beside(kept ?? pane, newPane([action.tab_id]), zoneDirection(zone))
      })
    }
    case 'move_pane':
    case 'swap_panes': {
      const moving = findPane(root, action.pane_id)
      const target = findPane(root, action.target_id)
      if (!moving || !target) return null
      const zone = action.type === 'swap_panes' ? 'centre' : action.zone
      return rewrite(root, (pane) => {
        if (zone === 'centre') return pane.id === moving.id ? target : pane.id === target.id ? moving : pane
        if (pane.id === moving.id) return null
        return pane.id === target.id ? beside(pane, moving, zoneDirection(zone)) : pane
      })
    }
    case 'dock_tab': {
      const rest = rewrite(root, (pane) =>
        paneOfTab(root, action.tab_id)?.id === pane.id ? without(pane, action.tab_id) : pane,
      )
      return beside(rest ?? newPane([]), newPane([action.tab_id]), zoneDirection(action.edge))
    }
    case 'dock_pane': {
      const moving = findPane(root, action.pane_id)
      const rest = rewrite(root, (pane) => (pane.id === action.pane_id ? null : pane))
      return moving && rest ? beside(rest, moving, zoneDirection(action.edge)) : null
    }
    default:
      return null
  }
}

/** Whether the panes would still fit after `action`. A change that needs no more room always fits. */
export function hasRoomFor(action: LayoutAction): boolean {
  const layout = layoutNow()
  const box = centreBox()
  if (!box) return true
  const next = shapeAfter(layout, action)
  if (!next) return true
  const before = minSize(layout.root, layout.tabs)
  const after = minSize(next, layout.tabs)
  // A layout already over (a tab of a wider kind moved in) may still get smaller.
  return (
    after.width <= Math.max(box.width, before.width) + 0.5 && after.height <= Math.max(box.height, before.height) + 0.5
  )
}

/** Says why a change was refused. */
export function noRoom(): void {
  toast.add({
    title: 'No room for another pane',
    description: 'Close a sidebar or a pane, or make the window larger.',
  })
}

/** Splits a pane when the result fits; otherwise says there is no room. */
export function trySplit(paneId: string, direction: SplitDirection): void {
  if (hasRoomFor({ type: 'split_pane', pane_id: paneId, direction, new_pane_id: 'room-check' }))
    void splitPane(paneId, direction)
  else noRoom()
}
