import { LayoutGroup } from 'motion/react'
import { useEffect, useRef } from 'react'
import { Group, Panel, usePanelRef, type PanelImperativeHandle } from 'react-resizable-panels'
import { SIDEBAR_WIDTH, type SidebarId } from '../model/layout'
import { structureKey } from '../model/layout.logic'
import { dispatch, useLayout } from '../model/layout-store'
import { PaneGrid } from '../panes/PaneGrid'
import { Inspector } from '../sidebars/Inspector'
import { Navigator } from '../sidebars/Navigator'
import { Card, LayoutKeyContext } from './Card'
import { Grip } from './Grip'
import { ResizeHandle } from './ResizeHandle'

// The floating layer between the chrome: a sidebar, the centre, a sidebar, with 8px gutters that
// resize them. The sidebars keep their pixel width when the window resizes; the centre takes the
// rest. Collapsing a sidebar gives its space to the centre.

const SIDEBAR = {
  navigator: { label: 'Navigator', Content: Navigator },
  inspector: { label: 'Inspector', Content: Inspector },
} as const

function SidebarPanel({ id, panelRef }: { id: SidebarId; panelRef: React.RefObject<PanelImperativeHandle | null> }) {
  const width = useLayout((layout) => layout.widths[id])
  const { label, Content } = SIDEBAR[id]
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
      <Card surface="panel" label={label} grip={<Grip label={`Move ${label.toLowerCase()}`} />}>
        <Content />
      </Card>
    </Panel>
  )
}

export function CardArea() {
  const sidebars = useLayout((layout) => layout.sidebars)
  const collapsed = useLayout((layout) => layout.collapsed)
  const root = useLayout((layout) => layout.root)
  const refs = { navigator: usePanelRef(), inspector: usePanelRef() }
  const syncing = useRef(false)

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

  const layoutKey = `${sidebars.join(',')}|${collapsed.navigator ? 1 : 0}${collapsed.inspector ? 1 : 0}|${structureKey(root)}`
  const [left, right] = sidebars
  return (
    <LayoutKeyContext value={layoutKey}>
      <LayoutGroup>
        <Group
          id="cards"
          orientation="horizontal"
          className="min-h-0 flex-1 p-2"
          onLayoutChanged={(_layout, meta) => {
            if (!meta.isUserInteraction || syncing.current) return
            // A resize ended: keep widths, and notice a sidebar dragged shut or open.
            for (const id of sidebars) {
              const panel = refs[id].current
              if (!panel) continue
              const isCollapsed = panel.isCollapsed()
              if (isCollapsed !== collapsed[id]) dispatch({ type: 'setCollapsed', sidebar: id, collapsed: isCollapsed })
              if (!isCollapsed) dispatch({ type: 'setWidth', sidebar: id, width: panel.getSize().inPixels })
            }
          }}
        >
          <SidebarPanel key={left} id={left} panelRef={refs[left]} />
          <ResizeHandle key={`gutter-${left}`} orientation="horizontal" hidden={collapsed[left]} />
          <Panel id="centre" minSize="320px">
            <PaneGrid node={root} />
          </Panel>
          <ResizeHandle key={`gutter-${right}`} orientation="horizontal" hidden={collapsed[right]} />
          <SidebarPanel key={right} id={right} panelRef={refs[right]} />
        </Group>
      </LayoutGroup>
    </LayoutKeyContext>
  )
}
