import { dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { cn } from '@/lib/utils'
import type { Edge } from '../model/layout'
import { canDock, isDragData, type TargetData } from './drag'

// Thin drop strips along the four outer edges of the centre, present only while a tab or pane is
// dragged. Dropping there docks it as a full-height column or full-width row on that side; the
// part of the centre it will take lights up.

// Each strip lies mostly in the 8px gutter around the centre and reaches 4px in: short of the tabs,
// which start 6px inside a pane, so a tab hovered near the edge still reorders.
const STRIP: Record<Edge, string> = {
  left: 'inset-y-0 -start-2 w-3',
  right: 'inset-y-0 -end-2 w-3',
  top: 'inset-x-0 -top-2 h-3',
  bottom: 'inset-x-0 -bottom-2 h-3',
}
const MARKER: Record<Edge, string> = { left: 'h-10 w-1', right: 'h-10 w-1', top: 'h-1 w-10', bottom: 'h-1 w-10' }
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
      {/* A faint marker on each edge from the start of a drag, so docking can be found. */}
      <div aria-hidden className={cn('pointer-events-none absolute flex items-center justify-center', STRIP[edge])}>
        <div className={cn('rounded-full', over ? 'bg-ring' : 'bg-muted', MARKER[edge])} />
      </div>
      {over && (
        <div
          aria-hidden
          data-dock-region
          className={cn('pointer-events-none absolute rounded-xl bg-accent opacity-60', REGION[edge])}
        />
      )}
      <div ref={ref} data-dock-edge={edge} className={cn('pointer-events-auto absolute', STRIP[edge])} />
    </>
  )
}

/** Laid over the centre's box, measured when a tab or pane drag starts (nothing resizes mid-drag). */
export function DockEdges({ centre }: { centre: RefObject<HTMLElement | null> }) {
  const [box, setBox] = useState<CSSProperties | null>(null)
  useEffect(
    () =>
      monitorForElements({
        canMonitor: ({ source }) => isDragData(source.data) && source.data.kind !== 'sidebar',
        onDragStart: () => {
          const element = centre.current
          const parent = element?.closest('#cards')?.parentElement
          if (!element || !parent) return
          const inner = element.getBoundingClientRect()
          const outer = parent.getBoundingClientRect()
          setBox({
            left: inner.left - outer.left,
            top: inner.top - outer.top,
            width: inner.width,
            height: inner.height,
          })
        },
        onDrop: () => setBox(null),
      }),
    [centre],
  )
  if (!box) return null
  return (
    <div className="pointer-events-none absolute" style={box}>
      <DockStrip edge="left" />
      <DockStrip edge="right" />
      <DockStrip edge="top" />
      <DockStrip edge="bottom" />
    </div>
  )
}
