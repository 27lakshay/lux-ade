import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import * as m from 'motion/react-m'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Group, Panel, usePanelRef, type PanelImperativeHandle } from 'react-resizable-panels'
import { DURATION, transitions } from '../../../app/motion'
import { SIDEBAR_WIDTH, type SidebarId } from '../model/layout'
import { dispatch, layoutStore, useLayout } from '../model/layout-store'
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

function SidebarPanel({ id, panelRef }: { id: SidebarId; panelRef: React.RefObject<PanelImperativeHandle | null> }) {
  const width = useLayout((layout) => layout.widths[id])
  const collapsed = useLayout((layout) => layout.collapsed[id])
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
  const collapsed = useLayout((layout) => layout.collapsed)
  const widths = useLayout((layout) => layout.widths)
  // The width each sidebar panel was last given, by a drag or by this sync. The panels' own
  // getSize() reads stale for a frame after a change, so it cannot be compared with the model.
  const applied = useRef({
    navigator: collapsed.navigator ? Number.NaN : widths.navigator,
    inspector: collapsed.inspector ? Number.NaN : widths.inspector,
  })
  const root = useLayout((layout) => layout.root)
  const tabs = useLayout((layout) => layout.tabs)
  const maximized = useLayout((layout) => (layout.maximized ? findPane(layout.root, layout.maximized) : undefined))
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
      if (!isCollapsed) {
        dispatch({ type: 'setWidth', sidebar: id, width: panel.getSize().inPixels })
        applied.current[id] = layoutStore.getState().layouts[layoutStore.getState().active]!.widths[id]
      }
    }
  }

  // The model decides what is collapsed and how wide an open sidebar is; the panels follow it
  // (Reset layout, a double-clicked gutter). Not while a handle is held: the pointer wins. Right
  // after the sidebars swap, wait a frame: the resize library re-reads the panels' order first, and
  // a resize in the same update is lost.
  const order = sidebars.join(',')
  const syncedOrder = useRef(order)
  useEffect(() => {
    const sync = (): void => {
      if (document.querySelector('[data-separator=active]')) return
      const layout = layoutStore.getState().layouts[layoutStore.getState().active]
      if (!layout) return
      for (const id of ['navigator', 'inspector'] as const) {
        const panel = refs[id].current
        if (!panel) continue
        syncing.current = true
        // Expanding restores the saved width itself; the size reads stale until the next render.
        if (panel.isCollapsed() !== layout.collapsed[id]) {
          if (layout.collapsed[id]) panel.collapse()
          // A sidebar that mounted collapsed has no width to return to: open it at the saved one.
          else if (Number.isNaN(applied.current[id])) {
            const width = layout.widths[id]
            panel.resize(`${width}px`)
            applied.current[id] = width
            // The library turns pixels into a share of the group as it is now, while the gutter
            // beside the sidebar is still growing in: correct the width once that settles.
            setTimeout(
              () => {
                if (!panel.isCollapsed() && Math.abs(panel.getSize().inPixels - width) > 0.5) panel.resize(`${width}px`)
              },
              DURATION.base * 1000 + 100,
            )
          } else panel.expand()
        } else if (!layout.collapsed[id] && applied.current[id] !== layout.widths[id]) {
          panel.resize(`${layout.widths[id]}px`)
          applied.current[id] = layout.widths[id]
        }
        syncing.current = false
      }
    }
    if (syncedOrder.current === order) return sync()
    syncedOrder.current = order
    const next = requestAnimationFrame(sync)
    return () => cancelAnimationFrame(next)
  })

  // Animate panel sizes while a collapse or expand settles, then stop, so a drag never lags.
  const sizesKey = `${collapsed.navigator ? 1 : 0}${collapsed.inspector ? 1 : 0}`
  const group = useRef<HTMLDivElement>(null)
  // Compared with the last collapsed state, not a first-run flag: React runs effects twice in
  // development, and the window must open at its saved sizes without animating.
  const shownKey = useRef<string | null>(null)
  useLayoutEffect(() => {
    const element = group.current
    const previous = shownKey.current
    shownKey.current = sizesKey
    if (!element || previous === null || previous === sizesKey) return
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
  // Double-clicking a sidebar's gutter puts it back to its default width.
  const resetWidth = (id: SidebarId): void => dispatch({ type: 'setWidth', sidebar: id, width: SIDEBAR_WIDTH[id] })
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <Group
        id="cards"
        elementRef={group}
        orientation="horizontal"
        className="min-h-0 flex-1 p-2"
        onLayoutChange={noteResizing}
        onLayoutChanged={(_layout, meta) => {
          if (meta.isUserInteraction && !syncing.current) requestAnimationFrame(commitSizes)
        }}
      >
        <SidebarPanel key={left} id={left} panelRef={refs[left]} />
        <ResizeHandle
          key={`gutter-${left}`}
          orientation="horizontal"
          hidden={collapsed[left]}
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
          hidden={collapsed[right]}
          onDoubleClick={() => resetWidth(right)}
        />
        <SidebarPanel key={right} id={right} panelRef={refs[right]} />
      </Group>
      {/* Outside the panels, which scroll whatever overflows them: the strips reach into the gutters. */}
      <DockEdges centre={centre} />
      <DropSettle />
    </div>
  )
}
