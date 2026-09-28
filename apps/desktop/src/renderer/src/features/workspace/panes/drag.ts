import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { pointerOutsideOfPreview } from '@atlaskit/pragmatic-drag-and-drop/element/pointer-outside-of-preview'
import { setCustomNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview'
import { useEffect, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { DropZone, Edge, SidebarId } from '../model/layout'
import { dispatch, dockTab, dropTab, layoutStore } from '../model/layout-store'
import { findPane, panes } from '../model/layout-tree'
import { afterDrop, describePane, describeTab } from './drop-feedback'
import { hasRoomFor } from './room'

// Dragging: tabs (reorder within a strip, move to another strip, join or split a pane, dock on the
// centre's edges), whole panes (by their grip: beside another pane, swapped with it, or docked), and
// sidebars (by their grip, onto the other sidebar, to swap sides). Drag sources and targets attach
// plain data; one monitor turns a drop into one reducer action, then announces it
// (drop-feedback.ts).

export type DragData =
  | { kind: 'tab'; tabId: string; paneId: string }
  | { kind: 'pane'; paneId: string }
  | { kind: 'sidebar'; sidebar: SidebarId }

export type TargetData =
  /** A pane's tab bar; index is where the tab lands, or -1 when it would stay where it is. */
  | { kind: 'strip-target'; paneId: string; index: number }
  | { kind: 'body-target'; paneId: string; zone: DropZone }
  | { kind: 'sidebar-target'; sidebar: SidebarId }
  | { kind: 'dock-target'; edge: Edge }

export const isDragData = (data: Record<string | symbol, unknown>): data is DragData & Record<string, unknown> =>
  data.kind === 'tab' || data.kind === 'pane' || data.kind === 'sidebar'

export const activeLayout = () => layoutStore.getState().layouts[layoutStore.getState().active]

/** Whether docking `source` on an outer edge would change anything and still fit (panes/room.ts). */
export function canDock(source: DragData, edge: Edge): boolean {
  const layout = activeLayout()
  if (!layout || source.kind === 'sidebar') return false
  const count = panes(layout.root).length
  const changes =
    source.kind === 'pane' ? count > 1 : count > 1 || (findPane(layout.root, source.paneId)?.tabs.length ?? 0) > 1
  if (!changes) return false
  return hasRoomFor(
    source.kind === 'pane'
      ? { type: 'dockPane', paneId: source.paneId, edge }
      : { type: 'dockTab', tabId: source.tabId, edge, newPaneId: 'room-check' },
  )
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
export function dropChanges(source: DragData, paneId: string, zone: DropZone): boolean {
  if (source.kind === 'sidebar') return false
  if (source.kind === 'pane') return source.paneId !== paneId
  if (source.paneId !== paneId) return true
  // Onto its own pane: joining is a no-op, and a pane's only tab cannot split off from itself.
  const layout = activeLayout()
  const tabs = layout ? (findPane(layout.root, paneId)?.tabs.length ?? 0) : 0
  return zone !== 'centre' && tabs > 1
}

/** Whether the panes still fit after the drop (panes/room.ts). */
export function dropFits(source: DragData, paneId: string, zone: DropZone): boolean {
  if (source.kind === 'sidebar') return false
  return hasRoomFor(
    source.kind === 'pane'
      ? { type: 'movePane', paneId: source.paneId, targetId: paneId, zone }
      : { type: 'dropTab', tabId: source.tabId, paneId, zone, newPaneId: 'room-check' },
  )
}

const canDropOnZone = (source: DragData, paneId: string, zone: DropZone): boolean =>
  dropChanges(source, paneId, zone) && dropFits(source, paneId, zone)

function onDrop(source: DragData, target: Record<string | symbol, unknown>): void {
  const data = target as unknown as TargetData
  if (data.kind === 'dock-target') {
    if (!canDock(source, data.edge)) return
    if (source.kind === 'tab')
      afterDrop(
        () => dockTab(source.tabId, data.edge),
        (layout) => `${describeTab(layout, source.tabId, 'Docked')}, along the ${data.edge} edge`,
      )
    else if (source.kind === 'pane')
      afterDrop(
        () => dispatch({ type: 'dockPane', paneId: source.paneId, edge: data.edge }),
        (layout) => `${describePane(layout, source.paneId, 'Docked')} along the ${data.edge} edge`,
      )
    return
  }
  // Sidebars only ever trade places with each other.
  if (source.kind === 'sidebar') {
    if (data.kind === 'sidebar-target' && data.sidebar !== source.sidebar)
      afterDrop(
        () => dispatch({ type: 'swapSidebars' }),
        () => 'Swapped sidebars',
        false,
      )
    return
  }
  if (source.kind === 'tab') {
    if (data.kind === 'strip-target' && data.index >= 0) {
      afterDrop(
        () => dispatch({ type: 'moveTab', tabId: source.tabId, paneId: data.paneId, index: data.index }),
        (layout) => describeTab(layout, source.tabId),
        false,
      )
    } else if (data.kind === 'body-target' && canDropOnZone(source, data.paneId, data.zone)) {
      afterDrop(
        () => dropTab(source.tabId, data.paneId, data.zone),
        (layout) =>
          data.zone === 'centre' ? describeTab(layout, source.tabId) : describeTab(layout, source.tabId, 'Split off'),
      )
    }
    return
  }
  if (data.kind === 'body-target' && canDropOnZone(source, data.paneId, data.zone))
    afterDrop(
      () => dispatch({ type: 'movePane', paneId: source.paneId, targetId: data.paneId, zone: data.zone }),
      (layout) => describePane(layout, source.paneId, data.zone === 'centre' ? 'Swapped, now' : 'Moved, now'),
    )
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
