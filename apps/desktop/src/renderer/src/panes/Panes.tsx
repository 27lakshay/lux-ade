// oxlint-disable react/immutability -- prototype shell, not yet approved; fix when rebuilt against the Pen design
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { createPortal } from 'react-dom'
import { Pane, LAYOUT_SPRING } from './Pane'
import {
  addTab,
  closeTab,
  cornerPanes,
  demoLayout,
  insertTab,
  mergePane,
  paneOfTab,
  reorderTab,
  resizeSplit,
  setActive,
  setKind,
  splitRight,
  splitWithPane,
  splitWithTab,
  swapPanes,
  type Layout,
  type Node as LayoutNode,
  type Side,
} from './model'

// Drag and drop for tabs and panes.
//   Live reflow, for reorders: a tab dragged along its own strip, and a pane dragged over the
//   middle of another pane (they swap). The layout changes during the drag; siblings glide aside.
//   Drop zones with a preview, for structural moves: a tab onto another pane (joins its tabs),
//   onto any pane edge (splits), and a pane onto an edge (splits) or another pane's tab strip
//   (merges). Nothing moves until the drop; a preview shows the result.
// A drag starts after 4px of travel. Escape cancels and restores the layout from before the drag;
// ⌘Z undoes the last layout change.

type Item = { kind: 'tab'; tabId: string } | { kind: 'pane'; paneId: string }
type Target =
  | { type: 'insert'; paneId: string; index: number }
  | { type: 'split'; paneId: string; side: Side }
  | { type: 'merge'; paneId: string }
  | null
interface Rect {
  left: number
  top: number
  width: number
  height: number
}
interface DragView {
  item: Item
  label: string
  // Where the ghost card sits: the pointer minus the point where the item was grabbed.
  ghostX: number
  ghostY: number
  preview: Rect | null
  caret: Rect | null
}

const THRESHOLD = 4
const EDGE = 0.25 // share of a pane's width or height that counts as an edge zone
const SWAP_DWELL = 300 // ms a dragged pane must rest over another pane's middle to swap
const DIVIDER = 8 // px; the gutter between panes is the divider's hit area
const MIN_PANE = { width: 240, height: 140 } // px a divider drag leaves each neighbour

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}
const inside = (r: Rect, x: number, y: number) =>
  x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height

function zoneOf(r: Rect, x: number, y: number): Side | 'center' {
  const fx = (x - r.left) / r.width
  const fy = (y - r.top) / r.height
  const edges: [Side, number][] = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy],
  ]
  const [side, d] = edges.sort((a, b) => a[1] - b[1])[0]
  return d < EDGE ? side : 'center'
}

function halfOf(r: Rect, side: Side): Rect {
  const g = 4 // half the gutter, so the preview sits where the new pane will
  if (side === 'left') return { ...r, width: r.width / 2 - g }
  if (side === 'right') return { ...r, left: r.left + r.width / 2 + g, width: r.width / 2 - g }
  if (side === 'top') return { ...r, height: r.height / 2 - g }
  return { ...r, top: r.top + r.height / 2 + g, height: r.height / 2 - g }
}

// Commands the rest of the app (the command palette) can run on the panes. They act on the
// current pane: the one last pressed in, or the top-left pane.
export interface PanesHandle {
  newTab(): void
  splitRight(): void
  closeTab(): void
  undo(): boolean
  // Focuses the tab with this title, or opens it as a new chat tab in the current pane.
  openChat(title: string): void
}

export function Panes({ leading, trailing, ref }: { leading: ReactNode; trailing: ReactNode; ref?: Ref<PanesHandle> }) {
  const [layout, setLayoutState] = useState<Layout>(demoLayout)
  const layoutRef = useRef(layout)
  const setLayout = (l: Layout) => {
    layoutRef.current = l
    setLayoutState(l)
  }
  const history = useRef<Layout[]>([])
  const commit = (next: Layout, before = layoutRef.current) => {
    if (next === before) return
    history.current.push(before)
    setLayout(next)
  }

  const paneEls = useRef(new Map<string, HTMLElement>())
  const stripEls = useRef(new Map<string, HTMLElement>())
  const [drag, setDrag] = useState<DragView | null>(null)
  const [resizing, setResizing] = useState(false)

  const undo = () => {
    const prev = history.current.pop()
    if (prev) setLayout(prev)
    return Boolean(prev)
  }

  // ⌘Z undoes the last layout change.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.metaKey &&
        !e.shiftKey &&
        e.code === 'KeyZ' &&
        !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      ) {
        if (undo()) e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The current pane: last pressed in, falling back to the top-left pane if it has gone.
  const currentPane = useRef<string | null>(null)
  const paneNow = () => {
    const l = layoutRef.current
    const id = currentPane.current
    return id && l.panes[id] ? id : cornerPanes(l).topLeft
  }
  useImperativeHandle(ref, () => ({
    newTab: () => commit(addTab(layoutRef.current, paneNow())),
    splitRight: () => commit(splitRight(layoutRef.current, paneNow())),
    closeTab: () => {
      const l = layoutRef.current
      commit(closeTab(l, l.panes[paneNow()].active))
    },
    undo,
    openChat: (title) => {
      const l = layoutRef.current
      const existing = Object.values(l.tabs).find((t) => t.title === title)
      if (existing) {
        const paneId = paneOfTab(l, existing.id)
        currentPane.current = paneId
        setLayout(setActive(l, paneId, existing.id))
        return
      }
      const paneId = paneNow()
      const withTab = addTab(l, paneId)
      commit(setKind(withTab, withTab.panes[paneId].active, 'chat', title), l)
    },
  }))

  const paneAt = (x: number, y: number) => {
    for (const [id, el] of paneEls.current) if (inside(rectOf(el), x, y)) return id
    return null
  }

  // Where a tab dropped at x would land in a pane's strip, ignoring the dragged tab itself.
  const stripIndex = (paneId: string, x: number, exclude: string) => {
    const strip = stripEls.current.get(paneId)!
    const tabs = [...strip.querySelectorAll<HTMLElement>('[data-tab-id]')].filter((t) => t.dataset.tabId !== exclude)
    const index = tabs.filter((t) => {
      const r = t.getBoundingClientRect()
      return r.left + r.width / 2 < x
    }).length
    const s = rectOf(strip)
    let caretX: number
    if (tabs.length === 0) caretX = s.left + 8
    else if (index < tabs.length) caretX = tabs[index].getBoundingClientRect().left - 2
    else caretX = tabs[tabs.length - 1].getBoundingClientRect().right + 2
    return { index, caret: { left: caretX - 1, top: s.top + (s.height - 22) / 2, width: 2, height: 22 } }
  }

  const startDrag = useCallback((e: ReactPointerEvent, item: Item) => {
    if (e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    const origin = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const grab = { x: startX - origin.left, y: startY - origin.top }
    const snapshot = layoutRef.current
    let active = false
    let target: Target = null
    let lastSwap: string | null = null
    // A pane swaps only after resting over another pane's middle for SWAP_DWELL ms, so passing
    // through on the way to a tab strip or an edge never reshuffles the layout.
    let dwell: { paneId: string; timer: ReturnType<typeof setTimeout> } | null = null
    let last = { x: startX, y: startY }
    const clearDwell = () => {
      if (dwell) clearTimeout(dwell.timer)
      dwell = null
    }

    const label = () => {
      const l = layoutRef.current
      if (item.kind === 'tab') return l.tabs[item.tabId].title
      const pane = l.panes[item.paneId]
      const extra = pane.tabs.length > 1 ? ` + ${pane.tabs.length - 1}` : ''
      return `${l.tabs[pane.active].title}${extra}`
    }

    const update = (x: number, y: number) => {
      last = { x, y }
      const l = layoutRef.current
      const hit = paneAt(x, y)
      let preview: Rect | null = null
      let caret: Rect | null = null
      target = null

      if (hit) {
        const paneRect = rectOf(paneEls.current.get(hit)!)
        const inStrip = inside(rectOf(stripEls.current.get(hit)!), x, y)
        const zone = zoneOf(paneRect, x, y)

        if (item.kind === 'tab') {
          const src = paneOfTab(l, item.tabId)
          if (inStrip) {
            const { index, caret: c } = stripIndex(hit, x, item.tabId)
            if (hit === src) {
              // Live reflow along its own strip.
              if (l.panes[src].tabs.indexOf(item.tabId) !== index) setLayout(reorderTab(l, item.tabId, index))
            } else {
              target = { type: 'insert', paneId: hit, index }
              preview = paneRect
              caret = c
            }
          } else if (zone === 'center') {
            if (hit !== src) {
              target = { type: 'insert', paneId: hit, index: l.panes[hit].tabs.length }
              preview = paneRect
            }
          } else if (hit !== src || l.panes[src].tabs.length > 1) {
            target = { type: 'split', paneId: hit, side: zone }
            preview = halfOf(paneRect, zone)
          }
        } else if (hit !== item.paneId) {
          if (inStrip) {
            target = { type: 'merge', paneId: hit }
            preview = paneRect
          } else if (zone !== 'center') {
            target = { type: 'split', paneId: hit, side: zone }
            preview = halfOf(paneRect, zone)
          } else if (lastSwap !== hit) {
            // Live reflow after a short rest: the panes trade places. Don't swap back with the
            // same pane until the pointer has left it, or unequal sizes would flip them back and forth.
            preview = paneRect
            if (dwell?.paneId !== hit) {
              clearDwell()
              const paneId = item.paneId
              dwell = {
                paneId: hit,
                timer: setTimeout(() => {
                  dwell = null
                  setLayout(swapPanes(layoutRef.current, paneId, hit))
                  lastSwap = hit
                  update(last.x, last.y)
                }, SWAP_DWELL),
              }
            }
          }
        }
        if (!(item.kind === 'pane' && hit !== item.paneId && !inStrip && zone === 'center' && lastSwap !== hit))
          clearDwell()
        if (hit !== lastSwap && hit !== (item.kind === 'pane' ? item.paneId : null)) lastSwap = null
      } else {
        lastSwap = null
        clearDwell()
      }

      const ox = item.kind === 'tab' ? grab.x : 24
      const oy = item.kind === 'tab' ? grab.y : 18
      setDrag({ item, label: label(), preview, caret, ghostX: x - ox, ghostY: y - oy })
    }

    const end = () => {
      clearDwell()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey, true)
      delete document.documentElement.dataset.dragging
      setDrag(null)
    }
    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return
        active = true
        // Window-drag regions swallow pointer events; switch them off for the drag.
        document.documentElement.dataset.dragging = item.kind
      }
      update(ev.clientX, ev.clientY)
    }
    const onUp = () => {
      if (active) {
        const l = layoutRef.current
        let next = l
        if (target?.type === 'insert' && item.kind === 'tab')
          next = insertTab(l, item.tabId, target.paneId, target.index)
        else if (target?.type === 'split' && item.kind === 'tab')
          next = splitWithTab(l, item.tabId, target.paneId, target.side)
        else if (target?.type === 'split' && item.kind === 'pane')
          next = splitWithPane(l, item.paneId, target.paneId, target.side)
        else if (target?.type === 'merge' && item.kind === 'pane') next = mergePane(l, item.paneId, target.paneId)
        // Record one history step for the whole drag, live reorders included.
        if (next !== snapshot) commit(next, snapshot)
      }
      end()
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && active) {
        ev.preventDefault()
        ev.stopPropagation()
        setLayout(snapshot)
        end()
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey, true)
  }, [])

  const onTabPointerDown = (e: ReactPointerEvent, tabId: string) => {
    const l = layoutRef.current
    setLayout(setActive(l, paneOfTab(l, tabId), tabId)) // select on press, not release
    startDrag(e, { kind: 'tab', tabId })
  }

  const { topLeft, topRight } = cornerPanes(layout)
  const draggedTab = drag?.item.kind === 'tab' ? drag.item.tabId : null
  const draggedPane = drag?.item.kind === 'pane' ? drag.item.paneId : null

  // The smallest a node can get along an axis without squeezing any pane inside it below MIN_PANE:
  // along its own direction a split needs the sum of its children, across it the largest child.
  const minOf = (n: LayoutNode, row: boolean): number => {
    if (n.type === 'pane') return row ? MIN_PANE.width : MIN_PANE.height
    const mins = n.children.map((c) => minOf(c, row))
    return (n.dir === 'row') === row ? mins.reduce((a, b) => a + b, 0) + DIVIDER * (mins.length - 1) : Math.max(...mins)
  }
  // Clamps the first neighbour's new weight so both neighbours keep their minimum.
  const clampPair = (split: Extract<LayoutNode, { type: 'split' }>, index: number, a: number, perPx: number) => {
    const row = split.dir === 'row'
    const [a0, b0] = [split.sizes[index], split.sizes[index + 1]]
    const minA = minOf(split.children[index], row) * perPx
    const minB = minOf(split.children[index + 1], row) * perPx
    return Math.min(Math.max(a, minA), a0 + b0 - minB)
  }

  // Drags a divider: the two neighbours trade size, neither squeezing a pane below MIN_PANE. The
  // whole drag is one undo step; Escape restores the sizes from before it.
  const startResize = (e: ReactPointerEvent, split: Extract<LayoutNode, { type: 'split' }>, index: number) => {
    if (e.button !== 0) return
    e.preventDefault()
    const row = split.dir === 'row'
    const container = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect()
    const available = (row ? container.width : container.height) - DIVIDER * (split.children.length - 1)
    const total = split.sizes.reduce((a, b) => a + b, 0)
    const perPx = total / available
    const [a0, b0] = [split.sizes[index], split.sizes[index + 1]]
    const start = row ? e.clientX : e.clientY
    const snapshot = layoutRef.current
    setResizing(true)
    document.documentElement.dataset.dragging = row ? 'resize-row' : 'resize-col'

    const onMove = (ev: PointerEvent) => {
      const delta = ((row ? ev.clientX : ev.clientY) - start) * perPx
      const a = clampPair(split, index, a0 + delta, perPx)
      setLayout(resizeSplit(layoutRef.current, split.id, index, a, a0 + b0 - a))
    }
    const end = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey, true)
      delete document.documentElement.dataset.dragging
      setResizing(false)
    }
    const onUp = () => {
      commit(layoutRef.current, snapshot)
      end()
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      setLayout(snapshot)
      end()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey, true)
  }

  // Arrow keys nudge a focused divider by 16px; double-click evens its two neighbours.
  const nudge = (split: Extract<LayoutNode, { type: 'split' }>, index: number, px: number, el: HTMLElement) => {
    const container = el.parentElement!.getBoundingClientRect()
    const available = (split.dir === 'row' ? container.width : container.height) - DIVIDER * (split.children.length - 1)
    const perPx = split.sizes.reduce((a, b) => a + b, 0) / available
    const [a0, b0] = [split.sizes[index], split.sizes[index + 1]]
    const a = clampPair(split, index, a0 + px * perPx, perPx)
    commit(resizeSplit(layoutRef.current, split.id, index, a, a0 + b0 - a))
  }
  const even = (split: Extract<LayoutNode, { type: 'split' }>, index: number) => {
    const half = (split.sizes[index] + split.sizes[index + 1]) / 2
    commit(resizeSplit(layoutRef.current, split.id, index, half, half))
  }

  const renderNode = (n: LayoutNode, grow = 1): ReactNode => {
    if (n.type === 'split') {
      const row = n.dir === 'row'
      return (
        <div key={n.id} className={`flex min-h-0 min-w-0 ${row ? '' : 'flex-col'}`} style={{ flex: `${grow} 1 0px` }}>
          {n.children.flatMap((child, i) => [
            i > 0 ? (
              <div
                key={`${n.id}-divider-${i}`}
                role="separator"
                aria-orientation={row ? 'vertical' : 'horizontal'}
                aria-label="Resize panes"
                tabIndex={0}
                onPointerDown={(e) => startResize(e, n, i - 1)}
                onDoubleClick={() => even(n, i - 1)}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 64 : 16
                  const back = row ? 'ArrowLeft' : 'ArrowUp'
                  const fwd = row ? 'ArrowRight' : 'ArrowDown'
                  if (e.key !== back && e.key !== fwd) return
                  e.preventDefault()
                  nudge(n, i - 1, e.key === fwd ? step : -step, e.currentTarget)
                }}
                className={`group relative shrink-0 outline-none ${row ? 'w-2 cursor-col-resize' : 'h-2 cursor-row-resize'}`}
              >
                {/* A thin line shows on hover, focus and while dragging: the handle, not a border. */}
                <span
                  className={`absolute rounded-full bg-fg-muted opacity-0 transition-opacity delay-100 duration-150 group-hover:opacity-50 group-focus-visible:opacity-70 group-active:opacity-70 ${
                    row ? 'inset-y-4 left-[3px] w-[2px]' : 'inset-x-4 top-[3px] h-[2px]'
                  }`}
                />
              </div>
            ) : null,
            renderNode(child, n.sizes[i]),
          ])}
        </div>
      )
    }
    const id = n.id
    return (
      <Pane
        key={id}
        pane={layout.panes[id]}
        layout={layout}
        grow={grow}
        resizing={resizing}
        leading={id === topLeft ? leading : undefined}
        trailing={id === topRight ? trailing : undefined}
        draggedTab={draggedTab}
        draggedPane={draggedPane === id}
        paneRef={(el) => (el ? paneEls.current.set(id, el) : paneEls.current.delete(id))}
        stripRef={(el) => (el ? stripEls.current.set(id, el) : stripEls.current.delete(id))}
        onTabPointerDown={onTabPointerDown}
        onActivate={() => {
          currentPane.current = id
        }}
        onGripPointerDown={(e) => startDrag(e, { kind: 'pane', paneId: id })}
        onClose={(tabId) => commit(closeTab(layoutRef.current, tabId))}
        onAdd={() => commit(addTab(layoutRef.current, id))}
        onSplit={() => commit(splitRight(layoutRef.current, id))}
        onPick={(tabId, kind) => commit(setKind(layoutRef.current, tabId, kind, kind === 'chat' ? 'New chat' : 'zsh'))}
      />
    )
  }

  return (
    <>
      <LayoutGroup>
        <div className="flex min-w-0 flex-1">{renderNode(layout.root)}</div>
      </LayoutGroup>

      {/* Drag overlays render at the top of the page, outside the panes' stacking layer, so
          they draw above the title-bar toggles. */}
      {createPortal(
        <>
          {/* Drop preview: a soft fill where the dragged item will land. It glides between zones. */}
          <AnimatePresence>
            {drag?.preview ? (
              <motion.div
                key="preview"
                className="pointer-events-none fixed z-40 rounded-xl bg-muted"
                initial={{ opacity: 0, ...drag.preview }}
                animate={{ opacity: 1, ...drag.preview }}
                exit={{ opacity: 0 }}
                transition={{ ...LAYOUT_SPRING, opacity: { duration: 0.12 } }}
              />
            ) : null}
          </AnimatePresence>
          {drag?.caret ? (
            <div className="pointer-events-none fixed z-50 rounded-full bg-fg" style={drag.caret} />
          ) : null}

          {/* The dragged item follows the pointer as a small card. */}
          {drag ? (
            <div
              className="pointer-events-none fixed left-0 top-0 z-50"
              style={{ transform: `translate(${drag.ghostX}px, ${drag.ghostY}px)` }}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.12 }}
                className={`flex items-center gap-2 bg-overlay text-[12px] font-medium text-fg shadow-[0_12px_32px_#00000066] backdrop-blur-xl ${
                  drag.item.kind === 'tab' ? 'h-[30px] rounded-md px-2.5' : 'h-9 rounded-xl px-3.5'
                }`}
              >
                {drag.label}
              </motion.div>
            </div>
          ) : null}
        </>,
        document.body,
      )}
    </>
  )
}
