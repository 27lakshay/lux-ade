import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { pointerOutsideOfPreview } from '@atlaskit/pragmatic-drag-and-drop/element/pointer-outside-of-preview'
import { setCustomNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview'
import { extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/extract-closest-edge'
import { useEffect, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { create } from 'zustand'
import type { DropZone, Edge, SidebarId } from '../model/layout'
import { dispatch, dockTab, dropTab, layoutStore } from '../model/layout-store'
import { findPane, panes } from '../model/layout-tree'

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
  | { kind: 'dock-target'; edge: Edge }

export const isDragData = (data: Record<string | symbol, unknown>): data is DragData & Record<string, unknown> =>
  data.kind === 'tab' || data.kind === 'pane' || data.kind === 'sidebar'

/** What is being dragged right now, for targets that appear only during a drag (the dock edges). */
export const useDragState = create<{ active: DragData | null }>(() => ({ active: null }))

export const activeLayout = () => layoutStore.getState().layouts[layoutStore.getState().active]

/** Whether docking `source` on an outer edge of the centre would change anything. */
export function canDock(source: DragData): boolean {
  const layout = activeLayout()
  if (!layout || source.kind === 'sidebar') return false
  const count = panes(layout.root).length
  if (source.kind === 'pane') return count > 1
  return count > 1 || (findPane(layout.root, source.paneId)?.tabs.length ?? 0) > 1
}

/**
 * Replaces the browser's snapshot of the dragged element (a whole card, for a pane) with a small
 * chip that follows the pointer. Rendered synchronously: the browser takes the picture at once.
 */
export function showDragPreview(
  nativeSetDragImage: ((image: Element, x: number, y: number) => void) | null,
  chip: ReactNode,
): void {
  setCustomNativeDragPreview({
    nativeSetDragImage,
    getOffset: pointerOutsideOfPreview({ x: '12px', y: '8px' }),
    render({ container }) {
      const root = createRoot(container)
      flushSync(() => root.render(chip))
      return () => root.unmount()
    },
  })
}

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
  const layout = activeLayout()
  const tabs = layout ? (findPane(layout.root, paneId)?.tabs.length ?? 0) : 0
  return zone !== 'centre' && tabs > 1
}

function onDrop(source: DragData, target: Record<string | symbol, unknown>): void {
  const data = target as unknown as TargetData
  if (data.kind === 'dock-target') {
    if (!canDock(source)) return
    if (source.kind === 'tab') dockTab(source.tabId, data.edge)
    else if (source.kind === 'pane') dispatch({ type: 'dockPane', paneId: source.paneId, edge: data.edge })
    return
  }
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
        onDragStart: ({ source }) => useDragState.setState({ active: source.data as DragData }),
        onDrop: ({ source, location }) => {
          useDragState.setState({ active: null })
          const target = location.current.dropTargets[0]
          if (target && isDragData(source.data)) onDrop(source.data, target.data)
        },
      }),
    [],
  )
}
