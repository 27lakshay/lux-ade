import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
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
import { closeTab } from '../terminals/terminal-tabs'
import { activeLayout, showDragPreview, type DragData } from './drag'
import { DragChip } from './DragChip'

export const TAB_ICON: Record<TabKind, IconName> = {
  conversation: 'conversation',
  terminal: 'terminal',
  browser: 'browser',
  file: 'fileCode',
  diff: 'diff',
}

// One tab in a pane's strip. The active tab of the focused pane is filled (by CSS, from the pane's
// data-pane-focused); in other panes it keeps its text colour but no fill. Close shows on the active tab and on hover. A tab drags to another
// place in any strip (TabStrip decides where), onto a pane to join or split it, or onto the
// centre's edges to dock.
export function Tab({
  tab,
  paneId,
  layoutKey,
  active,
  springing,
}: {
  tab: TabData
  paneId: string
  /** The strip's tab order and drop slot: tabs slide only when these change. */
  layoutKey: string
  active: boolean
  /** A drag is hovering this tab; it opens when the fill completes. */
  springing: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const activate = (): void => dispatch({ type: 'activateTab', tabId: tab.id })

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const tabId = tab.id
    return draggable({
      element,
      getInitialData: (): DragData => ({ kind: 'tab', tabId, paneId }),
      // Read at drag time, so the drag is not re-attached whenever the title changes.
      onGenerateDragPreview: ({ nativeSetDragImage }) => {
        const data = activeLayout()?.tabs[tabId]
        if (data) showDragPreview(nativeSetDragImage, <DragChip icon={TAB_ICON[data.kind]} label={data.title} />)
      },
      onDragStart: () => setDragging(true),
      onDrop: () => setDragging(false),
    })
  }, [tab.id, paneId])

  return (
    <m.div
      ref={ref}
      layout="position"
      layoutDependency={layoutKey}
      transition={transitions.layout}
      role="tab"
      id={tab.id}
      aria-controls={`panel-${paneId}`}
      data-tab-id={tab.id}
      tabIndex={active ? 0 : -1}
      aria-selected={active}
      // Filled only in the focused pane, by CSS from the pane's own attribute: a change of focus
      // re-renders no tab.
      data-active={active || undefined}
      onClick={activate}
      onAuxClick={(event) => event.button === 1 && void closeTab(tab.id)}
      onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && activate()}
      className={cn(
        interactive,
        'in-data-[pane-focused]:data-[active]:bg-accent',
        'group/tab relative flex h-7 max-w-48 min-w-0 shrink-0 items-center gap-2 overflow-hidden rounded-sm ps-2 pe-0.5',
        active ? 'text-foreground' : 'text-muted-foreground',
        dragging && 'opacity-50',
      )}
    >
      {springing && (
        <m.span
          aria-hidden
          data-spring-fill
          className="pointer-events-none absolute inset-0 origin-left bg-accent"
          // With reduced motion the growth is off; the fade still shows the wait.
          initial={{ scaleX: 0, opacity: 0 }}
          animate={{ scaleX: 1, opacity: 1 }}
          transition={transitions.springLoad}
        />
      )}
      <Icon name={TAB_ICON[tab.kind]} size="sm" className="relative" />
      {/* Always as wide as when selected: selecting a tab never nudges its neighbours. */}
      <Caption
        tone="inherit"
        weight={active ? 'medium' : 'regular'}
        steadyWidth="medium"
        truncate
        className="relative min-w-0 flex-1"
      >
        {tab.title}
      </Caption>
      <span className={cn('relative flex', active ? 'visible' : 'invisible group-hover/tab:visible')}>
        <IconButton icon="close" label="Close tab" size="xs" onClick={() => void closeTab(tab.id)} />
      </span>
    </m.div>
  )
}
