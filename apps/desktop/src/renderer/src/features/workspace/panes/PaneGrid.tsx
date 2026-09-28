import { Fragment, useEffect, useMemo, useState } from 'react'
import { Group, Panel, useGroupRef, usePanelRef } from 'react-resizable-panels'
import { ResizeHandle } from '../cards/ResizeHandle'
import { noteResizing } from '../content/size-label'
import { PANE_COLLAPSED, type LayoutNode, type SplitNode } from '../model/layout'
import { dispatch, useLayout } from '../model/layout-store'
import { minSize } from '../model/layout-tree'
import { Pane } from './Pane'
import { PaneCollapse } from './pane-collapse'

// The centre: the pane tree, rendered as nested resizable groups. Splits save their sizes when a
// resize ends. The resize library tracks panels by the order they mounted, so a split whose children
// change (a swap, a move, a split) mounts a fresh group; pane content survives, since it lives in
// stable hosts (content/hosts.ts) that panes only attach.
//
// Each pane has a minimum size from what its tabs show (PANE_MIN). Dragged below it, the pane
// collapses: in a row to a strip of tab icons, in a column to its tab bar. Clicking it opens it
// again. Double-clicking a gutter evens out that split.

const CLIPPED = { overflow: 'hidden' } as const

function Child({ node, split, index }: { node: LayoutNode; split: SplitNode; index: number }) {
  const tabs = useLayout((layout) => layout.tabs)
  const panel = usePanelRef()
  const [collapsed, setCollapsed] = useState(false)
  const row = split.direction === 'row'
  const min = minSize(node, tabs)
  const isPane = node.type === 'pane'
  const collapsedSize = row ? PANE_COLLAPSED.width : PANE_COLLAPSED.height
  const direction = split.direction
  const collapse = useMemo(
    () => ({ collapsed: collapsed ? direction : null, expand: () => panel.current?.expand() }),
    [collapsed, direction, panel],
  )
  return (
    <Panel
      id={node.id}
      panelRef={panel}
      defaultSize={`${split.sizes[index]}%`}
      minSize={`${row ? min.width : min.height}px`}
      collapsible={isPane}
      collapsedSize={isPane ? `${collapsedSize}px` : undefined}
      // Never a scrollbar at this level: content too big for a small pane is clipped by its card.
      style={CLIPPED}
      onResize={isPane ? (size) => setCollapsed(size.inPixels <= collapsedSize + 1) : undefined}
    >
      <PaneCollapse value={collapse}>
        <PaneGrid node={node} />
      </PaneCollapse>
    </Panel>
  )
}

export function PaneGrid({ node }: { node: LayoutNode }) {
  if (node.type === 'pane') return <Pane pane={node} />
  return <Split key={node.children.map((child) => child.id).join(',')} node={node} />
}

function Split({ node }: { node: SplitNode }) {
  const orientation = node.direction === 'row' ? 'horizontal' : 'vertical'
  const group = useGroupRef()
  // Sizes changed from outside (equalize, reset): move the panels to them. A resize by hand has
  // already saved what the panels show, so it changes nothing here.
  const sizesKey = node.sizes.join(',')
  useEffect(() => {
    const current = group.current?.getLayout()
    if (!current) return
    const target = Object.fromEntries(node.children.map((child, index) => [child.id, node.sizes[index]!]))
    if (node.children.some((child) => Math.abs((current[child.id] ?? 0) - target[child.id]!) > 0.5))
      group.current?.setLayout(target)
    // node.children changing remounts this component (the key in PaneGrid).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sizesKey stands for node.sizes
  }, [sizesKey, group])
  return (
    <Group
      id={node.id}
      groupRef={group}
      orientation={orientation}
      className="h-full"
      onLayoutChange={noteResizing}
      onLayoutChanged={(layout, meta) => {
        if (meta.isUserInteraction)
          dispatch({
            type: 'setSplitSizes',
            splitId: node.id,
            sizes: node.children.map((child) => layout[child.id] ?? 0),
          })
      }}
    >
      {node.children.map((child, index) => (
        <Fragment key={child.id}>
          {index > 0 && (
            <ResizeHandle
              orientation={orientation}
              onDoubleClick={() => dispatch({ type: 'equalizeSplits', splitId: node.id })}
            />
          )}
          <Child node={child} split={node} index={index} />
        </Fragment>
      ))}
    </Group>
  )
}
