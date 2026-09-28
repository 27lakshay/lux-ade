import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import * as m from 'motion/react-m'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Group, Panel, usePanelRef, type PanelImperativeHandle } from 'react-resizable-panels'
import { DURATION, transitions } from '../../../app/motion'
import { SIDEBAR_WIDTH, type SidebarId } from '../model/layout'
import { dispatch, layoutStore, useLayout } from '../model/layout-store'
import { cn } from '@/lib/utils'
import { DockEdges } from '../panes/DockEdges'
import { isDragData, showDragPreview, useDropMonitor, type DragData, type TargetData } from '../panes/drag'
import { DragChip } from '../panes/DragChip'
import { PaneGrid } from '../panes/PaneGrid'
import { Inspector } from '../sidebars/Inspector'
import { Navigator } from '../sidebars/Navigator'
import { Card } from './Card'
import { Grip } from './Grip'
import { ResizeHandle } from './ResizeHandle'

// The floating layer between the chrome: a sidebar, the centre, a sidebar, with 8px gutters that
// resize them. The sidebars keep their pixel width when the window resizes; the centre takes the
// rest. Collapsing a sidebar gives its space to the centre.
//
// Collapsing or expanding a sidebar animates by transitioning the top-level panels' real sizes for a
// moment (app.css, [data-layout-animating]): the content reflows each frame, as it does while
// dragging a handle, so nothing slides or stretches. Dragging a handle never animates. Splits and
// closes are instant: the resize library measures a new split group as it mounts, and must not do
// so mid-transition.
// Swapping sidebars moves whole cards (layout="position"), which keep their own widths.

const SIDEBAR = {
  navigator: { label: 'Navigator', icon: 'toggleLeftSidebar', Content: Navigator },
  inspector: { label: 'Inspector', icon: 'toggleRightSidebar', Content: Inspector },
} as const

function SidebarPanel({ id, panelRef }: { id: SidebarId; panelRef: React.RefObject<PanelImperativeHandle | null> }) {
  const width = useLayout((layout) => layout.widths[id])
  const collapsed = useLayout((layout) => layout.collapsed[id])
  const order = useLayout((layout) => layout.sidebars.join(','))
  const { label, Content } = SIDEBAR[id]
  const card = useRef<HTMLElement>(null)
  const grip = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState(false)
  const [dragging, setDragging] = useState(false)

  // Drag a sidebar by its grip onto the other sidebar to swap sides.
  useEffect(() => {
    if (!card.current || !grip.current) return
    return combine(
      draggable({
        element: card.current,
        dragHandle: grip.current,
        getInitialData: (): DragData => ({ kind: 'sidebar', sidebar: id }),
        onGenerateDragPreview: ({ nativeSetDragImage }) =>
          showDragPreview(nativeSetDragImage, <DragChip icon={SIDEBAR[id].icon} label={SIDEBAR[id].label} />),
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element: card.current,
        canDrop: ({ source }) =>
          isDragData(source.data) && source.data.kind === 'sidebar' && source.data.sidebar !== id,
        getData: (): TargetData => ({ kind: 'sidebar-target', sidebar: id }),
        onDragEnter: () => setOver(true),
        onDragLeave: () => setOver(false),
        onDrop: () => setOver(false),
      }),
    )
  }, [id])
  return (
    <Panel
      id={id}
      panelRef={panelRef}
      defaultSize={`${width}px`}
      minSize={`${SIDEBAR_WIDTH.min}px`}
      maxSize={`${SIDEBAR_WIDTH.max}px`}
      collapsible
      collapsedSize={0}
      groupResizeBehavior="preserve-pixel-size"
    >
      {/* The sidebar never animates its own size: it fades as it returns while the centre grows
          or shrinks. On a swap the whole card moves to its new side, keeping its width. */}
      <m.div
        layout="position"
        layoutDependency={order}
        transition={transitions.layout}
        className="relative h-full"
        initial={false}
        animate={{ opacity: collapsed ? 0 : 1 }}
      >
        <Card
          ref={card}
          surface="panel"
          label={label}
          className={cn(dragging && 'opacity-50')}
          grip={<Grip ref={grip} label={`Move ${label.toLowerCase()}`} />}
        >
          <Content />
        </Card>
        {over && (
          <div
            aria-hidden
            data-drop-zone="swap"
            className="pointer-events-none absolute inset-1.5 rounded-md bg-accent opacity-60"
          />
        )}
      </m.div>
    </Panel>
  )
}

export function CardArea() {
  const sidebars = useLayout((layout) => layout.sidebars)
  const collapsed = useLayout((layout) => layout.collapsed)
  const root = useLayout((layout) => layout.root)
  const centre = useRef<HTMLDivElement>(null)
  const refs = { navigator: usePanelRef(), inspector: usePanelRef() }
  const syncing = useRef(false)
  useDropMonitor()
  // A resize ended: keep widths, and notice a sidebar dragged shut or open. Read a frame later:
  // inside onLayoutChanged the panels still report their sizes from before the change.
  const commitSizes = (): void => {
    for (const id of ['navigator', 'inspector'] as const) {
      const panel = refs[id].current
      if (!panel) continue
      const isCollapsed = panel.isCollapsed()
      if (isCollapsed !== layoutStore.getState().layouts[layoutStore.getState().active]?.collapsed[id])
        dispatch({ type: 'setCollapsed', sidebar: id, collapsed: isCollapsed })
      if (!isCollapsed) dispatch({ type: 'setWidth', sidebar: id, width: panel.getSize().inPixels })
    }
  }

  // The model decides what is collapsed; the panels follow it.
  useEffect(() => {
    for (const id of ['navigator', 'inspector'] as const) {
      const panel = refs[id].current
      if (!panel || panel.isCollapsed() === collapsed[id]) continue
      syncing.current = true
      if (collapsed[id]) panel.collapse()
      else panel.expand()
      syncing.current = false
    }
  })

  // Animate panel sizes while a collapse or expand settles, then stop, so a drag never lags.
  const sizesKey = `${collapsed.navigator ? 1 : 0}${collapsed.inspector ? 1 : 0}`
  const group = useRef<HTMLDivElement>(null)
  const first = useRef(true)
  useLayoutEffect(() => {
    const element = group.current
    if (!element || first.current) {
      first.current = false
      return
    }
    element.dataset.layoutAnimating = ''
    const done = setTimeout(() => delete element.dataset.layoutAnimating, DURATION.base * 1000 + 50)
    return () => clearTimeout(done)
  }, [sizesKey])
  // Any direct resize ends a size animation at once: the pointer or key must win. Plain listeners,
  // not props: the resize library handles these events on the group itself.
  useEffect(() => {
    const element = group.current
    if (!element) return
    const stop = (): void => {
      delete element.dataset.layoutAnimating
    }
    element.addEventListener('pointerdown', stop, true)
    element.addEventListener('keydown', stop, true)
    return () => {
      element.removeEventListener('pointerdown', stop, true)
      element.removeEventListener('keydown', stop, true)
    }
  }, [])
  const [left, right] = sidebars
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <Group
        id="cards"
        elementRef={group}
        orientation="horizontal"
        className="min-h-0 flex-1 p-2"
        onLayoutChanged={(_layout, meta) => {
          if (meta.isUserInteraction && !syncing.current) requestAnimationFrame(commitSizes)
        }}
      >
        <SidebarPanel key={left} id={left} panelRef={refs[left]} />
        <ResizeHandle key={`gutter-${left}`} orientation="horizontal" hidden={collapsed[left]} />
        <Panel id="centre" elementRef={centre} minSize="320px">
          {/* Moves with a sidebar swap when the sidebars differ in width. */}
          <m.div
            layout="position"
            layoutDependency={sidebars.join(',')}
            transition={transitions.layout}
            className="h-full"
          >
            <PaneGrid node={root} />
          </m.div>
        </Panel>
        <ResizeHandle key={`gutter-${right}`} orientation="horizontal" hidden={collapsed[right]} />
        <SidebarPanel key={right} id={right} panelRef={refs[right]} />
      </Group>
      {/* Outside the panels, which scroll whatever overflows them: the strips reach into the gutters. */}
      <DockEdges centre={centre} />
    </div>
  )
}
