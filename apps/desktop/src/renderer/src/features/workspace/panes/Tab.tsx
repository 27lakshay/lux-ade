import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { attachClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/attach-closest-edge'
import { extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/extract-closest-edge'
import * as m from 'motion/react-m'
import { useEffect, useRef, useState } from 'react'
import { IconButton } from '@/components/IconButton'
import { interactive } from '@/components/interactive'
import { Caption } from '@/components/Typography'
import { cn } from '@/lib/utils'
import { Icon } from '@/icons/Icon'
import type { IconName } from '@/icons/icons'
import type { Tab as TabData, TabKind } from '../model/layout'
import { transitions } from '../../../app/motion'
import { dispatch } from '../model/layout-store'
import { findPane } from '../model/layout-tree'
import { activeLayout, isDragData, showDragPreview, type DragData, type TargetData } from './drag'
import { DragChip } from './DragChip'

/** How long a dragged item hovers over an inactive tab before that tab opens. */
export const SPRING_LOAD_MS = 600

export const TAB_ICON: Record<TabKind, IconName> = {
  conversation: 'conversation',
  terminal: 'terminal',
  browser: 'browser',
  file: 'fileCode',
  diff: 'diff',
}

// One tab in a pane's strip. The active tab of the focused pane is filled; in other panes it keeps
// its text colour but no fill. Close shows on the active tab and on hover. A tab drags to another
// place in any strip, or onto a pane to split it; a bar shows where it will land, and tabs slide
// into their new order.
export function Tab({
  tab,
  paneId,
  index,
  order,
  active,
  focused,
}: {
  tab: TabData
  paneId: string
  index: number
  /** The strip's tab order: tabs animate only when it changes. */
  order: string
  active: boolean
  focused: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState<'left' | 'right' | null>(null)
  const [dragging, setDragging] = useState(false)
  const activate = (): void => dispatch({ type: 'activateTab', tabId: tab.id })

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const tabId = tab.id
    // Read at drag time, so the drag is not re-attached whenever the title or active tab changes.
    const now = () => {
      const layout = activeLayout()
      return { tab: layout?.tabs[tabId], active: layout ? findPane(layout.root, paneId)?.active === tabId : false }
    }
    // Hovering a dragged item over an inactive tab opens it, so the item can land in its content.
    let springLoad: ReturnType<typeof setTimeout> | undefined
    const cancelSpringLoad = (): void => clearTimeout(springLoad)
    return combine(
      cancelSpringLoad,
      draggable({
        element,
        getInitialData: (): DragData => ({ kind: 'tab', tabId: tab.id, paneId }),
        onGenerateDragPreview: ({ nativeSetDragImage }) => {
          const { tab: data } = now()
          if (data) showDragPreview(nativeSetDragImage, <DragChip icon={TAB_ICON[data.kind]} label={data.title} />)
        },
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element,
        canDrop: ({ source }) => isDragData(source.data) && source.data.kind === 'tab' && source.data.tabId !== tab.id,
        getData: ({ input }) =>
          attachClosestEdge({ kind: 'tab-target', paneId, index } satisfies TargetData, {
            element,
            input,
            allowedEdges: ['left', 'right'],
          }),
        onDragEnter: () => {
          cancelSpringLoad()
          if (!now().active) springLoad = setTimeout(() => dispatch({ type: 'activateTab', tabId }), SPRING_LOAD_MS)
        },
        onDrag: ({ self }) => setEdge(extractClosestEdge(self.data) as 'left' | 'right' | null),
        onDragLeave: () => {
          cancelSpringLoad()
          setEdge(null)
        },
        onDrop: () => {
          cancelSpringLoad()
          setEdge(null)
        },
      }),
    )
  }, [tab.id, paneId, index])

  return (
    <m.div
      ref={ref}
      layout="position"
      layoutDependency={order}
      transition={transitions.layout}
      role="tab"
      tabIndex={active ? 0 : -1}
      aria-selected={active}
      data-selected={(active && focused) || undefined}
      onClick={activate}
      onAuxClick={(event) => event.button === 1 && dispatch({ type: 'closeTab', tabId: tab.id })}
      onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && activate()}
      className={cn(
        interactive,
        'group/tab relative flex h-7 max-w-48 min-w-0 shrink-0 items-center gap-2 rounded-sm ps-2 pe-0.5',
        active ? 'text-foreground' : 'text-muted-foreground',
        dragging && 'opacity-50',
      )}
    >
      <Icon name={TAB_ICON[tab.kind]} size="sm" />
      <Caption tone="inherit" weight={active ? 'medium' : 'regular'} truncate className="min-w-0 flex-1">
        {tab.title}
      </Caption>
      <span className={cn('flex', active ? 'visible' : 'invisible group-hover/tab:visible')}>
        <IconButton
          icon="close"
          label="Close tab"
          size="xs"
          onClick={() => dispatch({ type: 'closeTab', tabId: tab.id })}
        />
      </span>
      {edge && (
        <span
          aria-hidden
          className={cn('absolute inset-y-1 w-0.5 rounded-full bg-ring', edge === 'left' ? '-start-0.5' : '-end-0.5')}
        />
      )}
    </m.div>
  )
}
