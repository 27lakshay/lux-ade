import { Fragment } from 'react'
import { Group, Panel } from 'react-resizable-panels'
import { ResizeHandle } from '../cards/ResizeHandle'
import type { LayoutNode } from '../model/layout'
import { dispatch } from '../model/layout-store'
import { Pane } from './Pane'

// The centre: the pane tree, rendered as nested resizable groups. Splits save their sizes when a
// resize ends. The resize library tracks panels by the order they mounted, so a split whose children
// change (a swap, a move, a split) mounts a fresh group; pane content survives, since it lives in
// stable hosts (content/hosts.ts) that panes only attach.
export function PaneGrid({ node }: { node: LayoutNode }) {
  if (node.type === 'pane') return <Pane pane={node} />
  const orientation = node.direction === 'row' ? 'horizontal' : 'vertical'
  return (
    <Group
      key={node.children.map((child) => child.id).join(',')}
      id={node.id}
      orientation={orientation}
      className="h-full"
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
          {index > 0 && <ResizeHandle orientation={orientation} />}
          <Panel id={child.id} defaultSize={node.sizes[index]} minSize="160px">
            <PaneGrid node={child} />
          </Panel>
        </Fragment>
      ))}
    </Group>
  )
}
