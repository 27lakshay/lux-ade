import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import * as m from 'motion/react-m'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconButton } from '@/components/IconButton'
import { cn } from '@/lib/utils'
import { transitions } from '../../../app/motion'
import { Card } from '../cards/Card'
import { Grip } from '../cards/Grip'
import { attachHost } from '../content/hosts'
import type { DropZone, PaneNode } from '../model/layout'
import { dispatch, openTab, splitPane, useLayout } from '../model/layout-store'
import { canDropOnZone, isDragData, zoneAt, type DragData, type TargetData } from './drag'
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

function usePaneDrag(paneId: string) {
  const card = useRef<HTMLElement>(null)
  const grip = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [zone, setZone] = useState<DropZone | null>(null)

  useEffect(() => {
    if (!card.current || !grip.current || !strip.current || !body.current) return
    const bodyElement = body.current
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
      }),
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
        onDrag: ({ location, source }) =>
          setZone(zoneFor(source.data, location.current.input.clientX, location.current.input.clientY)),
        onDragLeave: () => setZone(null),
        onDrop: () => setZone(null),
      }),
    )
  }, [paneId])

  return { card, grip, strip, body, zone }
}

export function Pane({ pane }: { pane: PaneNode }) {
  const focused = useLayout((layout) => layout.focusedPane === pane.id)
  const tabs = useLayout((layout) => layout.tabs)
  const { card, grip, strip, body, zone } = usePaneDrag(pane.id)
  const host = useRef<HTMLDivElement>(null)
  // Show the active tab's content: attach its host element, never re-render it.
  useLayoutEffect(
    () => (host.current && pane.active ? attachHost(host.current, pane.active) : undefined),
    [pane.active],
  )
  const order = pane.tabs.join(',')

  return (
    <Card ref={card} surface="pane" label="Pane" grip={<Grip ref={grip} label="Move pane" />}>
      <div
        className="flex min-h-0 flex-1 flex-col"
        onPointerDownCapture={() => !focused && dispatch({ type: 'focusPane', paneId: pane.id })}
      >
        <div className="flex h-10 shrink-0 items-center gap-0.5 px-1.5">
          <div ref={strip} role="tablist" aria-label="Tabs" className="flex min-w-0 items-center gap-0.5">
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
              className={cn('pointer-events-none absolute rounded-md bg-accent opacity-60', ZONE[zone])}
            />
          )}
        </div>
      </div>
    </Card>
  )
}
