import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import * as m from 'motion/react-m'
import { useEffect, useRef, useState } from 'react'
import { Group, Panel, usePanelRef, type PanelImperativeHandle } from 'react-resizable-panels'
import { transitions } from '../../../app/motion'
import { SIDEBAR_WIDTH, type SidebarId } from '../model/layout'
import { dispatch, useLayout } from '../model/layout-store'
import { cn } from '@/lib/utils'
import { noteResizing } from '../content/size-label'
import { findPane, minSize } from '../model/layout-tree'
import { DockEdges } from '../panes/DockEdges'
import { DropSettle } from '../panes/DropSettle'
import { Pane } from '../panes/Pane'
import { isDragData, showDragPreview, useDropMonitor, type DragData, type TargetData } from '../panes/drag'
import { DragChip } from '../panes/DragChip'
import { PaneGrid } from '../panes/PaneGrid'
import { Inspector } from '../sidebars/Inspector'
import { Navigator } from '../sidebars/Navigator'
import { Card } from './Card'
import { keepFocusOffHandles } from './handle-focus'
import { Grip } from './Grip'
import { ResizeHandle } from './ResizeHandle'
import { useSidebarPanels } from './useSidebarPanels'

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

// The resize library wraps each panel's content in a box that scrolls whatever overflows it. A card
// moving to its new side (a sidebar swap) is drawn at its old place with a transform, which counts
// as overflow: that box grew a scrollbar for the whole animation, and the content reflowed around
// it. The top-level panels let their cards overflow instead; nothing inside them scrolls at that
// level (panes and sidebars scroll within themselves).
const MOVING_CARD = { overflow: 'visible' } as const

const SIDEBAR = {
  navigator: { label: 'Navigator', icon: 'toggleLeftSidebar', Content: Navigator },
  inspector: { label: 'Inspector', icon: 'toggleRightSidebar', Content: Inspector },
} as const

function SidebarPanel({
  id,
  panelRef,
  shown,
}: {
  id: SidebarId
  panelRef: React.RefObject<PanelImperativeHandle | null>
  /** Open in the layout and with room in the window (useSidebarPanels). */
  shown: boolean
}) {
  const width = useLayout((layout) => layout.widths[id])
  const collapsed = !shown
  const order = useLayout((layout) => layout.sidebars.join(','))
  const { label, Content } = SIDEBAR[id]
  const card = useRef<HTMLElement>(null)
  const grip = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState(false)
  const [dragging, setDragging] = useState(false)
  // Fixed at mount: a sidebar saved collapsed starts collapsed, so the centre never lays out narrow
  // for a frame (which would collapse panes that do not fit). The resize library also reacts to a
  // changed default size, so it must not follow later changes.
  const [mountSize] = useState(() => (collapsed ? '0px' : `${width}px`))

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
      defaultSize={mountSize}
      minSize={`${SIDEBAR_WIDTH.min}px`}
      maxSize={`${SIDEBAR_WIDTH.max}px`}
      collapsible
      collapsedSize={0}
      groupResizeBehavior="preserve-pixel-size"
      style={MOVING_CARD}
    >
      {/* The sidebar never animates its own size: it fades as it returns while the centre grows
          or shrinks. On a swap the whole card moves to its new side, keeping its width. */}
      <m.div
        layout="position"
        layoutDependency={order}
        transition={transitions.layout}
        // Above the centre: on a swap, both sidebars pass over the panes, not one over and one under.
        className="relative z-10 h-full"
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
  const root = useLayout((layout) => layout.root)
  const tabs = useLayout((layout) => layout.tabs)
  const maximized = useLayout((layout) => (layout.maximized ? findPane(layout.root, layout.maximized) : undefined))
  const centre = useRef<HTMLDivElement>(null)
  const refs = { navigator: usePanelRef(), inspector: usePanelRef() }
  const { group, groupHandle, shown, commitSizes, syncing, resync } = useSidebarPanels(refs, centre)
  useDropMonitor()
  useEffect(keepFocusOffHandles, [])
  const [left, right] = sidebars
  // Double-clicking a sidebar's gutter puts it back to its default width.
  const resetWidth = (id: SidebarId): void => dispatch({ type: 'setWidth', sidebar: id, width: SIDEBAR_WIDTH[id] })
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <Group
        id="cards"
        elementRef={group}
        groupRef={groupHandle}
        orientation="horizontal"
        className="min-h-0 flex-1 p-2"
        onLayoutChange={() => {
          noteResizing()
          // The library re-lays the panels out itself as the window resizes; bring them back to
          // what should show.
          resync()
        }}
        onLayoutChanged={(_layout, meta) => {
          if (syncing.current) return
          // A drag saves what it did; a change the library made itself (a shrinking window) is undone
          // where it disagrees with what should show.
          if (meta.isUserInteraction) requestAnimationFrame(commitSizes)
          else resync()
        }}
      >
        <SidebarPanel key={left} id={left} panelRef={refs[left]} shown={shown[left]} />
        <ResizeHandle
          key={`gutter-${left}`}
          orientation="horizontal"
          hidden={!shown[left]}
          onDoubleClick={() => resetWidth(left)}
        />
        <Panel id="centre" elementRef={centre} style={MOVING_CARD} minSize={`${minSize(root, tabs).width}px`}>
          {/* Moves with a sidebar swap when the sidebars differ in width. */}
          <m.div
            layout="position"
            layoutDependency={sidebars.join(',')}
            transition={transitions.layout}
            className="h-full"
          >
            {/* A maximized pane fills the centre; the others unmount, their content kept in its hosts. */}
            {maximized ? <Pane pane={maximized} /> : <PaneGrid node={root} />}
          </m.div>
        </Panel>
        <ResizeHandle
          key={`gutter-${right}`}
          orientation="horizontal"
          hidden={!shown[right]}
          onDoubleClick={() => resetWidth(right)}
        />
        <SidebarPanel key={right} id={right} panelRef={refs[right]} shown={shown[right]} />
      </Group>
      {/* Outside the panels, which scroll whatever overflows them: the strips reach into the gutters. */}
      <DockEdges centre={centre} />
      <DropSettle />
    </div>
  )
}
