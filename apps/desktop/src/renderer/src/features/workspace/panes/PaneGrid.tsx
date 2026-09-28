import { Fragment, useEffect } from 'react'
import { Group, Panel, useGroupRef } from 'react-resizable-panels'
import { ResizeHandle } from '../cards/ResizeHandle'
import { noteResizing } from '../content/size-label'
import type { LayoutNode, SplitNode } from '../model/layout'
import { dispatch, useLayout } from '../model/layout-store'
import { minSize } from '../model/layout-tree'
import { Pane } from './Pane'

// The centre: the pane tree, rendered as nested resizable groups. Splits save their sizes when a
// resize ends. The resize library tracks panels by the order they mounted, so a split whose children
// change (a swap, a move, a split) mounts a fresh group; pane content survives, since it lives in
// stable hosts (content/hosts.ts) that panes only attach.
//
// Each pane has a minimum size from what its tabs show (PANE_MIN); a gutter stops there. Double-
// clicking a gutter evens out that split.

const CLIPPED = { overflow: 'hidden' } as const

function Child({ node, split, index }: { node: LayoutNode; split: SplitNode; index: number }) {
  // A number, not the tab list: only a change to this node's minimum renders it.
  const row = split.direction === 'row'
  const min = useLayout((layout) => {
    const size = minSize(node, layout.tabs)
    return row ? size.width : size.height
  })
  return (
    <Panel
      id={node.id}
      defaultSize={`${split.sizes[index]}%`}
      minSize={`${min}px`}
      // Never a scrollbar at this level: content too big for a small pane is clipped by its card.
      style={CLIPPED}
    >
      <PaneGrid node={node} />
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
              label={node.direction === 'row' ? 'Resize panes side by side' : 'Resize stacked panes'}
              onDoubleClick={() => dispatch({ type: 'equalizeSplits', splitId: node.id })}
            />
          )}
          <Child node={child} split={node} index={index} />
        </Fragment>
      ))}
    </Group>
  )
}
