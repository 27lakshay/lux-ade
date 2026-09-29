import { announce } from '@atlaskit/pragmatic-drag-and-drop-live-region'
import { create } from 'zustand'
import { GUTTER, SIDEBAR_WIDTH, type Side, type SidebarId } from '../model/layout'
import { layoutNow, toggleSide } from '../model/layout-store'

// When the window is too narrow for the open sidebars beside the panes at their minimum, sidebars
// close for the moment, the one opened longest ago first, and open again when there is room. This
// is the window's state now, not the saved layout: the layout keeps what the person chose.

/** Which open sidebars fit beside the centre's minimum width, taken in priority order. */
export function sidebarsThatFit(input: {
  /** The width the sidebars and the centre share, gutters included. */
  available: number
  centreMin: number
  /** The sidebars the layout has open, most wanted first. */
  open: SidebarId[]
}): SidebarId[] {
  const kept: SidebarId[] = []
  let used = input.centreMin
  for (const id of input.open) {
    const need = SIDEBAR_WIDTH.min + GUTTER
    if (used + need > input.available) continue
    kept.push(id)
    used += need
  }
  return kept
}

export const useSidebarFit = create<{
  /** Most recently opened first; the last gives way first. */
  priority: SidebarId[]
  /** Open in the layout but closed for want of room. */
  squeezed: SidebarId[]
  /** What the card area measured: the width sidebars and centre share, and the centre's minimum. */
  room: { available: number; centreMin: number } | null
}>(() => ({ priority: ['navigator', 'inspector'], squeezed: [], room: null }))

const promote = (id: SidebarId): void =>
  useSidebarFit.setState((state) => ({ priority: [id, ...state.priority.filter((other) => other !== id)] }))

const LABEL: Record<SidebarId, string> = { navigator: 'navigator', inspector: 'inspector' }

/**
 * The title-bar toggles and their commands. A sidebar closed for want of room opens by taking the
 * room of the other; one that cannot fit even alone stays closed, and says so.
 */
export function toggleSidebar(side: Side): void {
  const layout = layoutNow()
  const id = layout.sidebars[side === 'left' ? 0 : 1]
  const squeezed = useSidebarFit.getState().squeezed.includes(id)
  if (layout.collapsed[id] || squeezed) {
    const { room } = useSidebarFit.getState()
    if (room && sidebarsThatFit({ ...room, open: [id] }).length === 0) {
      announce(`No room for the ${LABEL[id]}: widen the window or close a pane`)
      return
    }
    promote(id)
    if (layout.collapsed[id]) void toggleSide(side)
    return
  }
  void toggleSide(side)
}
