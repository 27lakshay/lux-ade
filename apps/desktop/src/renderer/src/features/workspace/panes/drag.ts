import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/extract-closest-edge'
import { useEffect } from 'react'
import type { DropZone, SidebarId } from '../model/layout'
import { dispatch, dropTab, layoutStore } from '../model/layout-store'
import { findPane } from '../model/layout.logic'

// Dragging: tabs (reorder within a strip, move to another strip, or drop on a pane's edge to split
// it), whole panes (by their grip, onto another pane's edge or centre), and sidebars (by their grip,
// onto the other sidebar, to swap sides). Drag
// sources and targets attach plain data; one monitor turns a drop into one reducer action.

export type DragData =
  | { kind: 'tab'; tabId: string; paneId: string }
  | { kind: 'pane'; paneId: string }
  | { kind: 'sidebar'; sidebar: SidebarId }

export type TargetData =
  | { kind: 'tab-target'; paneId: string; index: number }
  | { kind: 'strip-target'; paneId: string }
  | { kind: 'body-target'; paneId: string; zone: DropZone }
  | { kind: 'sidebar-target'; sidebar: SidebarId }

export const isDragData = (data: Record<string | symbol, unknown>): data is DragData & Record<string, unknown> =>
  data.kind === 'tab' || data.kind === 'pane' || data.kind === 'sidebar'

/** Which part of a pane the pointer is over: an edge band (a quarter of the pane) or the centre. */
export function zoneAt(rect: DOMRect, x: number, y: number): DropZone {
  const across = (x - rect.left) / rect.width
  const down = (y - rect.top) / rect.height
  const distances: [DropZone, number][] = [
    ['left', across],
    ['right', 1 - across],
    ['top', down],
    ['bottom', 1 - down],
  ]
  const [edge, distance] = distances.reduce((nearest, next) => (next[1] < nearest[1] ? next : nearest))
  return distance < 0.25 ? edge : 'centre'
}

/** Whether dropping `source` on a pane's zone would change anything. */
export function canDropOnZone(source: DragData, paneId: string, zone: DropZone): boolean {
  if (source.kind === 'sidebar') return false
  if (source.kind === 'pane') return source.paneId !== paneId
  if (source.paneId !== paneId) return true
  // Onto its own pane: joining is a no-op, and a pane's only tab cannot split off from itself.
  const layout = layoutStore.getState().layouts[layoutStore.getState().active]
  const tabs = layout ? (findPane(layout.root, paneId)?.tabs.length ?? 0) : 0
  return zone !== 'centre' && tabs > 1
}

function onDrop(source: DragData, target: Record<string | symbol, unknown>): void {
  const data = target as unknown as TargetData
  // Sidebars only ever trade places with each other.
  if (source.kind === 'sidebar') {
    if (data.kind === 'sidebar-target' && data.sidebar !== source.sidebar) dispatch({ type: 'swapSidebars' })
    return
  }
  if (source.kind === 'tab') {
    if (data.kind === 'tab-target') {
      const after = extractClosestEdge(target) === 'right'
      dispatch({ type: 'moveTab', tabId: source.tabId, paneId: data.paneId, index: data.index + (after ? 1 : 0) })
    } else if (data.kind === 'strip-target') {
      dispatch({ type: 'moveTab', tabId: source.tabId, paneId: data.paneId, index: Number.MAX_SAFE_INTEGER })
    } else if (data.kind === 'body-target' && canDropOnZone(source, data.paneId, data.zone)) {
      dropTab(source.tabId, data.paneId, data.zone)
    }
    return
  }
  if (data.kind === 'body-target' && canDropOnZone(source, data.paneId, data.zone))
    dispatch({ type: 'movePane', paneId: source.paneId, targetId: data.paneId, zone: data.zone })
}

/** Watches every drag in the window and applies drops. Mount once. */
export function useDropMonitor(): void {
  useEffect(
    () =>
      monitorForElements({
        canMonitor: ({ source }) => isDragData(source.data),
        onDrop: ({ source, location }) => {
          const target = location.current.dropTargets[0]
          if (target && isDragData(source.data)) onDrop(source.data, target.data)
        },
      }),
    [],
  )
}
