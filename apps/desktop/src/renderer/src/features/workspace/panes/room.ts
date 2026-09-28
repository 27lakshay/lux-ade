import { toast } from '@/components/ui/toast'
import type { SplitDirection } from '../model/layout'
import { layoutReducer, type LayoutAction } from '../model/layout.logic'
import { layoutStore, splitPane } from '../model/layout-store'
import { minSize } from '../model/layout-tree'

// A change to the panes is allowed only when the result still fits the centre at every pane's
// minimum (PANE_MIN): layouts never squeeze a pane below what its content needs. The centre is
// taken as it is now; closing a sidebar or widening the window makes room.

const centreBox = (): { width: number; height: number } | null => {
  const centre = document.getElementById('centre')
  if (!centre) return null
  const { width, height } = centre.getBoundingClientRect()
  return width > 0 && height > 0 ? { width, height } : null
}

/** Whether the panes would still fit after `action`. A change that needs no more room always fits. */
export function hasRoomFor(action: LayoutAction): boolean {
  const { layouts, active } = layoutStore.getState()
  const layout = layouts[active]
  const box = centreBox()
  if (!layout || !box) return true
  const next = layoutReducer(layout, action)
  if (next === layout) return true
  const before = minSize(layout.root, layout.tabs)
  const after = minSize(next.root, next.tabs)
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
  if (hasRoomFor({ type: 'splitPane', paneId, direction, newPaneId: 'room-check' })) splitPane(paneId, direction)
  else noRoom()
}
