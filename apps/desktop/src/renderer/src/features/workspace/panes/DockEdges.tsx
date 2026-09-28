import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { Edge } from '../model/layout'
import { canDock, isDragData, useDragState, type TargetData } from './drag'

// Thin drop strips along the four outer edges of the centre, present only while a tab or pane is
// dragged. Dropping there docks it as a full-height column or full-width row on that side; the
// part of the centre it will take lights up.

const STRIP: Record<Edge, string> = {
  left: 'inset-y-0 start-0 w-4',
  right: 'inset-y-0 end-0 w-4',
  top: 'inset-x-0 top-0 h-4',
  bottom: 'inset-x-0 bottom-0 h-4',
}
const REGION: Record<Edge, string> = {
  left: 'inset-y-0 start-0 w-1/3',
  right: 'inset-y-0 end-0 w-1/3',
  top: 'inset-x-0 top-0 h-1/3',
  bottom: 'inset-x-0 bottom-0 h-1/3',
}

function DockStrip({ edge }: { edge: Edge }) {
  const ref = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState(false)
  useEffect(() => {
    if (!ref.current) return
    return dropTargetForElements({
      element: ref.current,
      canDrop: ({ source }) => isDragData(source.data) && canDock(source.data),
      getData: (): TargetData => ({ kind: 'dock-target', edge }),
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: () => setOver(false),
    })
  }, [edge])
  return (
    <>
      {over && (
        <div
          aria-hidden
          className={cn('pointer-events-none absolute z-10 rounded-xl bg-accent opacity-60', REGION[edge])}
        />
      )}
      <div ref={ref} data-dock-edge={edge} className={cn('absolute z-20', STRIP[edge])} />
    </>
  )
}

export function DockEdges() {
  const active = useDragState((state) => state.active)
  if (!active || active.kind === 'sidebar') return null
  return (
    <>
      <DockStrip edge="left" />
      <DockStrip edge="right" />
      <DockStrip edge="top" />
      <DockStrip edge="bottom" />
    </>
  )
}
