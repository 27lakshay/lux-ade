import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  type VirtualItem,
} from '@tanstack/react-virtual'
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Body } from '@/components/Typography'
import { ScrollArea } from '@/components/ui/scroll-area'
import { MessageRow } from './ConversationMessage'
import type { ConversationMessage, ConversationStore } from '../../../state/conversation-store'

type ReadingAnchor = { id: string; offset: number }

type TimelineSnapshot = { items: VirtualItem[]; totalSize: number; messages: ConversationMessage[] }

// React Compiler rejects useVirtualizer's mutable return value. This cached
// external-store adapter exposes render snapshots, while the installed TanStack
// core owns all windowing, row measurements, observers and scroll corrections.
class TimelineVirtualizer {
  private messages: ConversationMessage[] = []
  private listeners = new Set<() => void>()
  private snapshot: TimelineSnapshot = { items: [], totalSize: 0, messages: this.messages }
  private instance = new Virtualizer<HTMLElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => null,
    estimateSize: () => 120,
    overscan: 4,
    anchorTo: 'start',
    followOnAppend: false,
    scrollToFn: elementScroll,
    observeElementOffset,
    observeElementRect,
    useAnimationFrameWithResizeObserver: true,
    onChange: () => this.publish(),
  })

  measureElement = this.instance.measureElement
  getSnapshot = (): TimelineSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  // Match @tanstack/react-virtual 3.14.13's installed core lifecycle.
  mount = (): (() => void) => this.instance._didMount()
  commit = (): void => this.instance._willUpdate()

  update(messages: ConversationMessage[], viewport: HTMLElement | null): void {
    this.messages = messages
    this.instance.setOptions({
      ...this.instance.options,
      count: messages.length,
      getItemKey: (index) => messages[index]!.id,
      getScrollElement: () => viewport,
    })
    this.publish()
  }

  private publish(): void {
    const items = this.instance.getVirtualItems()
    const totalSize = this.instance.getTotalSize()
    if (
      items === this.snapshot.items &&
      totalSize === this.snapshot.totalSize &&
      this.messages === this.snapshot.messages
    )
      return
    this.snapshot = { items, totalSize, messages: this.messages }
    for (const listener of this.listeners) listener()
  }
}

export function ConversationTimeline({
  store,
  messages,
  provider,
  ariaLabel,
  captureAnchorRef,
}: {
  store: ConversationStore
  messages: ConversationMessage[]
  provider: string
  ariaLabel: string
  captureAnchorRef: { current: (() => void) | null }
}) {
  const [viewport, setViewport] = useState<HTMLElement | null>(null)
  const anchor = useRef<ReadingAnchor | null>(null)
  const anchorLocked = useRef(false)
  const bindRoot = useCallback((root: HTMLDivElement | null) => {
    setViewport(root?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null)
  }, [])
  const [timeline] = useState(() => new TimelineVirtualizer())
  const snapshot = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot, timeline.getSnapshot)
  useLayoutEffect(() => timeline.mount(), [timeline])
  useLayoutEffect(() => timeline.update(messages, viewport), [timeline, messages, viewport])
  useLayoutEffect(() => timeline.commit())
  const captureAnchor = useCallback(() => {
    if (!viewport) return
    const bounds = viewport.getBoundingClientRect()
    for (const visible of viewport.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const rect = visible.getBoundingClientRect()
      if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue
      anchor.current = { id: visible.dataset.messageId!, offset: rect.top - bounds.top }
      return
    }
    anchor.current = null
  }, [viewport])

  const captureForUpdate = useCallback(() => {
    captureAnchor()
    // Keep the reader's intent through page arrival and viewport resize;
    // library-generated scroll corrections must not replace that intent.
    anchorLocked.current = true
  }, [captureAnchor])
  const releaseAnchor = useCallback(() => {
    anchorLocked.current = false
  }, [])
  const captureUserScroll = useCallback(() => {
    if (!anchorLocked.current) captureAnchor()
  }, [captureAnchor])

  useLayoutEffect(() => {
    captureAnchorRef.current = captureForUpdate
    return () => {
      if (captureAnchorRef.current === captureForUpdate) captureAnchorRef.current = null
    }
  }, [captureAnchorRef, captureForUpdate])

  useLayoutEffect(() => {
    const saved = anchor.current
    if (!saved || !viewport) return
    for (const element of viewport.querySelectorAll<HTMLElement>('[data-message-id]')) {
      if (element.dataset.messageId !== saved.id) continue
      viewport.scrollBy({
        top: element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - saved.offset,
        behavior: 'instant',
      })
      break
    }
  }, [snapshot, viewport])

  return (
    <ScrollArea
      ref={bindRoot}
      onScrollCapture={captureUserScroll}
      onWheelCapture={releaseAnchor}
      onPointerDownCapture={releaseAnchor}
      onTouchStartCapture={releaseAnchor}
      onKeyDownCapture={releaseAnchor}
      className="min-h-0 flex-1"
      role="region"
      aria-label={ariaLabel}
    >
      <div className="mx-auto w-full max-w-[640px] px-4 py-4" aria-live="polite">
        {messages.length === 0 ? (
          <div className="py-8 text-center" role="status">
            <Body tone="muted">No retained messages yet.</Body>
          </div>
        ) : (
          <div className="relative w-full" style={{ height: snapshot.totalSize }}>
            {snapshot.items.map((item) => (
              <div
                key={item.key}
                ref={timeline.measureElement}
                data-index={item.index}
                data-row-id={snapshot.messages[item.index]!.id}
                className="absolute inset-x-0 top-0 pb-4"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <MessageRow
                  store={store}
                  id={snapshot.messages[item.index]!.id}
                  fallbackMessage={snapshot.messages[item.index]!}
                  provider={provider}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
  )
}
