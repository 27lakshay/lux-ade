import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element'
import * as m from 'motion/react-m'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconButton } from '@/components/IconButton'
import { Caption } from '@/components/Typography'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { transitions } from '../../../app/motion'
import { Card } from '../cards/Card'
import { Grip } from '../cards/Grip'
import { attachHost } from '../content/hosts'
import type { DropZone, PaneNode } from '../model/layout'
import { dispatch, openTab, splitPane, useLayout } from '../model/layout-store'
import { findPane } from '../model/layout-tree'
import {
  activeLayout,
  canDropOnZone,
  isDragData,
  showDragPreview,
  zoneAt,
  type DragData,
  type TargetData,
} from './drag'
import { DragChip } from './DragChip'
import { PaneEmptyState } from './PaneEmptyState'
import { Tab } from './Tab'

// A pane: its tab strip (tabs, new tab, split and close), its body, and the grip that moves it.
// The body shows the active tab's content by attaching its host element (content/hosts.ts). While
// a tab or pane is dragged over the body, the zone it would land in lights up.

const ZONE: Record<DropZone, string> = {
  left: 'inset-y-1.5 start-1.5 end-1/2',
  right: 'inset-y-1.5 end-1.5 start-1/2',
  top: 'inset-x-1.5 top-1.5 bottom-1/2',
  bottom: 'inset-x-1.5 bottom-1.5 top-1/2',
  centre: 'inset-1.5',
}

/** What a drop on the zone does, shown on the highlight when it is not obvious. */
const zoneLabel = (source: DragData | null, zone: DropZone): string | null =>
  source?.kind === 'pane' && zone === 'centre' ? 'Swap' : null

const tabCountLabel = (paneId: string): string => {
  const layout = activeLayout()
  const count = layout ? (findPane(layout.root, paneId)?.tabs.length ?? 0) : 0
  return count === 1 ? 'Pane · 1 tab' : `Pane · ${count} tabs`
}

function usePaneDrag(paneId: string) {
  const card = useRef<HTMLElement>(null)
  const grip = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState<{ zone: DropZone; source: DragData } | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!card.current || !grip.current || !strip.current || !body.current) return
    const bodyElement = body.current
    const viewport = strip.current.closest<HTMLElement>('[data-slot=scroll-area-viewport]')
    const zoneFor = (source: Record<string | symbol, unknown>, x: number, y: number): DropZone | null => {
      if (!isDragData(source)) return null
      const next = zoneAt(bodyElement.getBoundingClientRect(), x, y)
      return canDropOnZone(source, paneId, next) ? next : null
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
      // A long strip scrolls while a tab is dragged near its ends.
      viewport
        ? autoScrollForElements({
            element: viewport,
            canScroll: ({ source }) => isDragData(source.data) && source.data.kind === 'tab',
          })
        : () => {},
      dropTargetForElements({
        element: strip.current,
        canDrop: ({ source }) => isDragData(source.data) && source.data.kind === 'tab',
        getData: (): TargetData => ({ kind: 'strip-target', paneId }),
      }),
      dropTargetForElements({
        element: bodyElement,
        canDrop: ({ source }) => isDragData(source.data),
        getData: ({ input, source }): TargetData => ({
          kind: 'body-target',
          paneId,
          zone: zoneFor(source.data, input.clientX, input.clientY) ?? 'centre',
        }),
        onDrag: ({ location, source }) => {
          const zone = zoneFor(source.data, location.current.input.clientX, location.current.input.clientY)
          setOver((previous) =>
            zone === previous?.zone ? previous : zone && isDragData(source.data) ? { zone, source: source.data } : null,
          )
        },
        onDragLeave: () => setOver(null),
        onDrop: () => setOver(null),
      }),
    )
  }, [paneId])

  return { card, grip, strip, body, over, dragging }
}

export function Pane({ pane }: { pane: PaneNode }) {
  const focused = useLayout((layout) => layout.focusedPane === pane.id)
  const tabs = useLayout((layout) => layout.tabs)
  const { card, grip, strip, body, over, dragging } = usePaneDrag(pane.id)
  const host = useRef<HTMLDivElement>(null)
  // Show the active tab's content: attach its host element, never re-render it.
  useLayoutEffect(
    () => (host.current && pane.active ? attachHost(host.current, pane.active) : undefined),
    [pane.active],
  )
  const order = pane.tabs.join(',')
  // Keep the active tab in view when it changes, and let a vertical wheel scroll the strip.
  useEffect(() => {
    strip.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [pane.active, strip])
  const zone = over?.zone
  const label = over ? zoneLabel(over.source, over.zone) : null

  return (
    <Card
      ref={card}
      surface="pane"
      label="Pane"
      className={cn(dragging && 'opacity-50')}
      grip={<Grip ref={grip} label="Move pane" />}
    >
      <div
        className="flex min-h-0 flex-1 flex-col"
        onPointerDownCapture={() => !focused && dispatch({ type: 'focusPane', paneId: pane.id })}
      >
        <div className="flex h-10 shrink-0 items-center gap-0.5 px-1.5">
          <ScrollArea
            className="min-w-0 shrink"
            onWheel={(event) => {
              const viewport = event.currentTarget.querySelector('[data-slot=scroll-area-viewport]')
              if (viewport && event.deltaX === 0) viewport.scrollLeft += event.deltaY
            }}
          >
            <div ref={strip} role="tablist" aria-label="Tabs" className="flex w-max items-center gap-0.5">
              {pane.tabs.map(
                (id, index) =>
                  tabs[id] && (
                    <Tab
                      key={id}
                      tab={tabs[id]}
                      paneId={pane.id}
                      index={index}
                      order={order}
                      active={pane.active === id}
                      focused={focused}
                    />
                  ),
              )}
            </div>
          </ScrollArea>
          <IconButton
            icon="new"
            label="New tab"
            shortcut={{ appCommand: 'new-tab' }}
            onClick={() => openTab({ kind: 'conversation', title: 'New conversation' }, pane.id)}
          />
          <div className="flex-1" />
          <IconButton
            icon="splitRight"
            label="Split right"
            shortcut={{ appCommand: 'split-right' }}
            onClick={() => splitPane(pane.id, 'row')}
          />
          <IconButton icon="splitDown" label="Split down" onClick={() => splitPane(pane.id, 'column')} />
          <IconButton
            icon="close"
            label="Close pane"
            onClick={() => dispatch({ type: 'closePane', paneId: pane.id })}
          />
        </div>
        <div ref={body} data-pane-drop={pane.id} className="relative flex min-h-0 flex-1 flex-col">
          {pane.tabs.length === 0 ? (
            <PaneEmptyState paneId={pane.id} />
          ) : (
            <div ref={host} data-pane-body={pane.id} className="min-h-0 flex-1 px-1.5" />
          )}
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
