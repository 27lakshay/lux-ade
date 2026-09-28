import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import * as m from 'motion/react-m'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconButton } from '@/components/IconButton'
import { Caption } from '@/components/Typography'
import { cn } from '@/lib/utils'
import { transitions } from '../../../app/motion'
import { Card } from '../cards/Card'
import { Grip } from '../cards/Grip'
import { attachHost } from '../content/hosts'
import type { DropZone, PaneNode } from '../model/layout'
import { dispatch, openTab, useLayout } from '../model/layout-store'
import { findPane } from '../model/layout-tree'
import {
  activeLayout,
  dropChanges,
  dropFits,
  isDragData,
  showDragPreview,
  zoneAt,
  type DragData,
  type TargetData,
} from './drag'
import { DragChip } from './DragChip'
import { PaneEmptyState } from './PaneEmptyState'
import { PaneToolbar } from './PaneToolbar'
import { SizeReadout } from './SizeReadout'
import { TabStrip } from './TabStrip'

// A pane: its tab bar (TabStrip, new tab, PaneToolbar), its body, and the grip that moves it. The
// body shows the active tab's content by attaching its host element (content/hosts.ts). While a tab
// or pane is dragged over the body, the zone it would land in lights up. Double-clicking the grip
// maximizes the pane.

const ZONE: Record<DropZone, string> = {
  left: 'inset-y-1.5 start-1.5 end-1/2',
  right: 'inset-y-1.5 end-1.5 start-1/2',
  top: 'inset-x-1.5 top-1.5 bottom-1/2',
  bottom: 'inset-x-1.5 bottom-1.5 top-1/2',
  centre: 'inset-1.5',
}

/** What a drop on the zone does, shown on the highlight when it is not obvious. */
const zoneLabel = (source: DragData | null, zone: DropZone, fits: boolean): string | null =>
  !fits ? 'No room' : source?.kind === 'pane' && zone === 'centre' ? 'Swap' : null

const tabCountLabel = (paneId: string): string => {
  const layout = activeLayout()
  const count = layout ? (findPane(layout.root, paneId)?.tabs.length ?? 0) : 0
  return count === 1 ? 'Pane · 1 tab' : `Pane · ${count} tabs`
}

function usePaneDrag(paneId: string) {
  const card = useRef<HTMLElement>(null)
  const grip = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState<{ zone: DropZone; source: DragData; fits: boolean } | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!card.current || !grip.current) return
    const bodyElement = body.current
    /** The zone under the pointer, when a drop there would change anything. */
    const zoneFor = (source: Record<string | symbol, unknown>, x: number, y: number): DropZone | null => {
      if (!isDragData(source) || !bodyElement) return null
      const next = zoneAt(bodyElement.getBoundingClientRect(), x, y)
      return dropChanges(source, paneId, next) ? next : null
    }
    return combine(
      draggable({
        element: card.current,
        dragHandle: grip.current,
        getInitialData: (): DragData => ({ kind: 'pane', paneId }),
        onGenerateDragPreview: ({ nativeSetDragImage }) =>
          showDragPreview(nativeSetDragImage, <DragChip icon="pane" label={tabCountLabel(paneId)} />),
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      bodyElement
        ? dropTargetForElements({
            element: bodyElement,
            canDrop: ({ source }) => isDragData(source.data),
            getData: ({ input, source }): TargetData => ({
              kind: 'body-target',
              paneId,
              zone: zoneFor(source.data, input.clientX, input.clientY) ?? 'centre',
            }),
            onDrag: ({ location, source }) => {
              const zone = zoneFor(source.data, location.current.input.clientX, location.current.input.clientY)
              setOver((previous) => {
                if (zone === previous?.zone) return previous
                if (!zone || !isDragData(source.data)) return null
                // A zone whose result would not fit shows why, and takes no drop (onDrop checks again).
                return { zone, source: source.data, fits: dropFits(source.data, paneId, zone) }
              })
            },
            onDragLeave: () => setOver(null),
            onDrop: () => setOver(null),
          })
        : () => {},
    )
  }, [paneId])

  return { card, grip, body, over, dragging }
}

export function Pane({ pane }: { pane: PaneNode }) {
  const focused = useLayout((layout) => layout.focusedPane === pane.id)
  const { card, grip, body, over, dragging } = usePaneDrag(pane.id)
  const bar = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  // Show the active tab's content: attach its host element, never re-render it.
  useLayoutEffect(
    () => (host.current && pane.active ? attachHost(host.current, pane.active) : undefined),
    [pane.active],
  )
  const zone = over?.zone
  const label = over ? zoneLabel(over.source, over.zone, over.fits) : null

  return (
    <Card
      ref={card}
      surface="pane"
      label="Pane"
      paneId={pane.id}
      focused={focused}
      className={cn(dragging && 'opacity-50')}
      grip={
        <Grip
          ref={grip}
          label="Move pane"
          onDoubleClick={() => dispatch({ type: 'toggleMaximize', paneId: pane.id })}
        />
      }
    >
      <div
        className="flex min-h-0 flex-1 flex-col"
        // A click or the keyboard arriving anywhere in the pane makes it the focused one.
        onPointerDownCapture={() => !focused && dispatch({ type: 'focusPane', paneId: pane.id })}
        onFocusCapture={() => !focused && dispatch({ type: 'focusPane', paneId: pane.id })}
      >
        <div ref={bar} data-tab-bar className="@container flex h-10 shrink-0 items-center gap-0.5 px-1.5">
          <TabStrip pane={pane} bar={bar}>
            <IconButton
              icon="new"
              label="New tab"
              shortcut={{ appCommand: 'new-tab' }}
              onClick={() => openTab({ kind: 'conversation', title: 'New conversation' }, pane.id)}
            />
            <div className="flex-1" />
            <PaneToolbar paneId={pane.id} />
          </TabStrip>
        </div>
        <div ref={body} data-pane-drop={pane.id} className="relative flex min-h-0 flex-1 flex-col">
          {pane.tabs.length === 0 ? (
            <PaneEmptyState paneId={pane.id} />
          ) : (
            <div
              ref={host}
              id={`panel-${pane.id}`}
              role="tabpanel"
              aria-labelledby={pane.active ?? undefined}
              data-pane-body={pane.id}
              className="min-h-0 flex-1 px-1.5"
            />
          )}
          <SizeReadout tabId={pane.active} />
          {zone && (
            <m.div
              aria-hidden
              data-drop-zone={zone}
              layout
              layoutDependency={zone}
              transition={transitions.layout}
              className={cn(
                'pointer-events-none absolute flex items-center justify-center rounded-md bg-accent/60',
                ZONE[zone],
              )}
            >
              {label && <Caption weight="medium">{label}</Caption>}
            </m.div>
          )}
        </div>
      </div>
    </Card>
  )
}
