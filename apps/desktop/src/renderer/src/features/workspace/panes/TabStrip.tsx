import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element'
import * as m from 'motion/react-m'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SPRING_LOAD_MS, transitions } from '../../../app/motion'
import type { PaneNode } from '../model/layout'
import { dispatch, layoutNow, useLayout } from '../model/layout-store'
import { findPane } from '../model/layout-tree'
import { isDragData, type TargetData } from './drag'
import { hasRoomFor } from './room'
import { Tab } from './Tab'

// A pane's tab strip, and the whole bar around it as one drop target for tabs. When a tab is dragged
// in, the tabs' positions are measured once; the landing spot and the tab under the pointer come
// from those (hitTab), so the strip can open a slot where the tab will land (tabs slide apart)
// without the sliding changing the answer. Resting on the middle of an inactive tab opens it after
// SPRING_LOAD_MS, with a fill that shows the wait. A long strip scrolls near its ends and with a
// vertical wheel.

interface Measured {
  id: string
  left: number
  right: number
}
interface Slot {
  /** Insert before this index of the current tabs. */
  index: number
  width: number
}

/** The tab an arrow, Home or End key moves to, as in any tab list; null for other keys. */
export function tabAfterKey(pane: PaneNode, key: string): string | null {
  const index = pane.active ? pane.tabs.indexOf(pane.active) : -1
  const last = pane.tabs.length - 1
  const target =
    key === 'ArrowRight'
      ? Math.min(last, index + 1)
      : key === 'ArrowLeft'
        ? Math.max(0, index - 1)
        : key === 'Home'
          ? 0
          : key === 'End'
            ? last
            : null
  return target === null || target === index ? null : (pane.tabs[target] ?? null)
}

/**
 * What content x is over. A tab's outer quarters reorder: the tab lands before or after it. Its
 * middle half is for opening it (`over`); a drop there lands just after it. Between and beyond tabs,
 * the tab lands at the nearest gap.
 */
export function hitTab(tabs: Measured[], x: number): { index: number; over: string | null } {
  for (const [i, tab] of tabs.entries()) {
    if (x >= tab.right) continue
    if (x < tab.left) return { index: i, over: null }
    const across = (x - tab.left) / (tab.right - tab.left)
    if (across < 0.25) return { index: i, over: null }
    return { index: i + 1, over: across > 0.75 ? null : tab.id }
  }
  return { index: tabs.length, over: null }
}

export function TabStrip({
  pane,
  bar,
  children,
}: {
  pane: PaneNode
  /** The bar the strip sits in: the drop target. */
  bar: RefObject<HTMLDivElement | null>
  /** Controls after the strip (new tab, toolbar). */
  children: ReactNode
}) {
  // This pane's tabs only, compared one by one: a change to another pane's tab renders nothing here.
  const records = useLayout(useShallow((layout) => pane.tabs.map((id) => layout.tabs[id])))
  const strip = useRef<HTMLDivElement>(null)
  const [slot, setSlot] = useState<Slot | null>(null)
  const [springing, setSpringing] = useState<string | null>(null)

  useEffect(() => {
    const barElement = bar.current
    const stripElement = strip.current
    const viewport = stripElement?.closest<HTMLElement>('[data-slot=scroll-area-viewport]')
    if (!barElement || !stripElement || !viewport) return
    let measured: Measured[] = []
    /** Whether a tab from another pane still fits here (its kind may need a wider pane); per drag. */
    let fits: boolean | null = null
    let springTimer: ReturnType<typeof setTimeout> | undefined
    let springTab: string | null = null
    const contentX = (clientX: number): number => clientX - viewport.getBoundingClientRect().left + viewport.scrollLeft
    const measure = (): void => {
      const origin = viewport.getBoundingClientRect().left - viewport.scrollLeft
      measured = [...stripElement.querySelectorAll<HTMLElement>('[data-tab-id]')].map((element) => {
        const rect = element.getBoundingClientRect()
        return { id: element.dataset.tabId!, left: rect.left - origin, right: rect.right - origin }
      })
    }
    const spring = (id: string | null): void => {
      if (id === springTab) return
      clearTimeout(springTimer)
      springTab = id
      setSpringing(id)
      if (id)
        springTimer = setTimeout(() => {
          void dispatch({ type: 'activate_tab', tab_id: id })
          springTab = null
          setSpringing(null)
        }, SPRING_LOAD_MS)
    }
    const reset = (): void => {
      measured = []
      fits = null
      spring(null)
      setSlot(null)
    }
    /** Where the tab lands (null: where it is already), and the tab it is over, to open. */
    const landing = (source: { tabId: string; paneId: string }, x: number) => {
      // The library asks for drop data before it reports the drag entering: measure on first use.
      if (measured.length === 0) measure()
      const { index, over } = hitTab(measured, x)
      const from = source.paneId === pane.id ? measured.findIndex((tab) => tab.id === source.tabId) : -1
      if (from === -1) {
        fits ??= hasRoomFor({ type: 'move_tab', tab_id: source.tabId, pane_id: pane.id, index })
        if (!fits) return { index: null, over }
      }
      const stays = from !== -1 && (index === from || index === from + 1)
      return { index: stays ? null : index, over: over === source.tabId ? null : over }
    }
    return combine(
      reset,
      autoScrollForElements({
        element: viewport,
        canScroll: ({ source }) => isDragData(source.data) && source.data.kind === 'tab',
      }),
      dropTargetForElements({
        element: barElement,
        canDrop: ({ source }) => isDragData(source.data) && source.data.kind === 'tab',
        getData: ({ input, source }): TargetData => {
          const data = source.data as { tabId: string; paneId: string }
          const { index } = landing(data, contentX(input.clientX))
          return { kind: 'strip-target', paneId: pane.id, index: index ?? -1 }
        },
        onDragEnter: measure,
        onDrag: ({ location, source }) => {
          const data = source.data as { tabId: string; paneId: string }
          const { index, over } = landing(data, contentX(location.current.input.clientX))
          const width = source.element.getBoundingClientRect().width
          // Over a tab's middle no slot opens, so the tab stays under the pointer while it fills.
          const gap = over ? null : index
          setSlot((previous) =>
            gap === null
              ? null
              : previous?.index === gap && previous.width === width
                ? previous
                : { index: gap, width },
          )
          const active = findPane(layoutNow().root, pane.id)?.active
          spring(over && over !== active ? over : null)
        },
        onDragLeave: reset,
        onDrop: reset,
      }),
    )
  }, [bar, pane.id])

  const layoutKey = `${pane.tabs.join(',')}|${slot?.index ?? ''}`
  const items = pane.tabs.flatMap((id, index) => {
    const tab = records[index]
    const element = tab ? (
      <Tab
        key={id}
        tab={tab}
        paneId={pane.id}
        layoutKey={layoutKey}
        active={pane.active === id}
        springing={springing === id}
      />
    ) : null
    return slot?.index === index
      ? [<SlotGap key="slot" width={slot.width} layoutKey={layoutKey} />, element]
      : [element]
  })
  if (slot && slot.index >= pane.tabs.length)
    items.push(<SlotGap key="slot" width={slot.width} layoutKey={layoutKey} />)

  // Keep the active tab in view when it changes.
  useEffect(() => {
    strip.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [pane.active])

  return (
    <>
      <ScrollArea
        className="min-w-0 shrink"
        onWheel={(event) => {
          const viewport = event.currentTarget.querySelector('[data-slot=scroll-area-viewport]')
          if (viewport && event.deltaX === 0) viewport.scrollLeft += event.deltaY
        }}
      >
        <div
          ref={strip}
          role="tablist"
          aria-label="Tabs"
          className="flex w-max items-center gap-0.5"
          onKeyDown={(event) => {
            const next = tabAfterKey(pane, event.key)
            if (!next) return
            event.preventDefault()
            void dispatch({ type: 'activate_tab', tab_id: next })
            // The tab is focusable once it is the active one, after this render.
            requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(`[data-tab-id="${next}"]`)?.focus())
          }}
        >
          {items}
        </div>
      </ScrollArea>
      {children}
    </>
  )
}

/** The open space where a dragged tab will land. */
function SlotGap({ width, layoutKey }: { width: number; layoutKey: string }) {
  return (
    <m.div
      aria-hidden
      data-tab-slot
      layout="position"
      layoutDependency={layoutKey}
      transition={transitions.layout}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="h-7 shrink-0 rounded-sm bg-accent/60"
      style={{ width }}
    />
  )
}
