import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useGroupRef, type PanelImperativeHandle } from 'react-resizable-panels'
import { DURATION } from '../../../app/motion'
import { clampWidth, SIDEBAR_WIDTH, type SidebarId } from '../model/layout'
import { dispatch, layoutNow, useLayout } from '../model/layout-store'
import { minSize } from '../model/layout-tree'
import { sidebarsThatFit, useSidebarFit } from './fit'

// Keeps the two sidebar panels in step with the layout and the window:
// - Which sidebars show: the ones the layout has open, less any the window is too narrow for
//   (cards/fit.ts). The window never shrinks below what the panes need with both closed.
// - Their widths: the layout's, applied when it changes from outside (Reset layout, a double-clicked
//   gutter); a drag saves what the panels show.
// - Collapse and expand animate the panels' real sizes for a moment ([data-layout-animating]).

const IDS = ['navigator', 'inspector'] as const
/** A sidebar panel's width on screen. The library's getSize() can lag a frame behind it. */
const drawnWidth = (id: SidebarId): number => document.getElementById(id)?.getBoundingClientRect().width ?? 0

/** The pixels shared by panels after the current gutter widths are excluded. */
function availablePanelWidth(element: HTMLElement): number {
  const style = getComputedStyle(element)
  const gutters = [...element.querySelectorAll(':scope > [role=separator]')].reduce(
    (total, separator) => total + separator.getBoundingClientRect().width,
    0,
  )
  return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - gutters
}

/** `group` is the sidebars' and centre's group element, which this hook owns and returns. */
export function useSidebarPanels(
  refs: Record<SidebarId, RefObject<PanelImperativeHandle | null>>,
  centre: RefObject<HTMLDivElement | null>,
) {
  const group = useRef<HTMLDivElement>(null)
  const groupHandle = useGroupRef()
  const sidebars = useLayout((layout) => layout.sidebars)
  const collapsed = useLayout((layout) => layout.collapsed)
  const widths = useLayout((layout) => layout.widths)
  // Two numbers, not one object: a selector returning a new object each time never settles.
  const centreMin = {
    width: useLayout((layout) => minSize(layout.root, layout.tabs).width),
    height: useLayout((layout) => minSize(layout.root, layout.tabs).height),
  }
  const priority = useSidebarFit((state) => state.priority)

  // The width sidebars and centre share: the group less its padding.
  const [available, setAvailable] = useState<number | null>(null)
  useLayoutEffect(() => {
    const element = group.current
    if (!element) return
    const measure = (): void => {
      const style = getComputedStyle(element)
      setAvailable(element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [group])

  const open = priority.filter((id) => !collapsed[id])
  const kept = available === null ? open : sidebarsThatFit({ available, centreMin: centreMin.width, open })
  const squeezed = open.filter((id) => !kept.includes(id))
  const shown: Record<SidebarId, boolean> = {
    navigator: kept.includes('navigator'),
    inspector: kept.includes('inspector'),
  }
  const squeezedKey = squeezed.join(',')
  useEffect(() => {
    useSidebarFit.setState({
      squeezed: squeezedKey ? (squeezedKey.split(',') as SidebarId[]) : [],
      room: available === null ? null : { available, centreMin: centreMin.width },
    })
  }, [squeezedKey, available, centreMin.width])

  // The window may not shrink below what the panes need with both sidebars closed.
  useEffect(() => {
    const element = centre.current
    if (available === null || !element) return
    const box = element.getBoundingClientRect()
    const width = Math.ceil(window.innerWidth - available + centreMin.width)
    const height = Math.ceil(window.innerHeight - box.height + centreMin.height)
    window.adeHost?.setWindowMinimumSize(width, height)
  }, [available, centreMin.width, centreMin.height, centre])

  // The width each sidebar panel was last given, by a drag or by the sync below. The panels' own
  // getSize() reads stale for a frame after a change, so it cannot be compared with the model.
  const applied = useRef({ ...widths })
  /**
   * The layout's widths when the panels last followed them. A width changes the panels only when
   * the layout's changes: while a width dragged by hand is on its way to the daemon, the layout
   * still has the old one, and the panel keeps what the hand left.
   */
  const followed = useRef({ ...widths })
  const syncing = useRef(false)

  /** A resize by hand ended: keep widths, and notice a sidebar dragged shut or open. */
  const commitSizes = (): void => {
    for (const id of IDS) {
      const panel = refs[id].current
      // A sidebar closed for want of room is not the person's choice: leave the layout as it is.
      if (!panel || useSidebarFit.getState().squeezed.includes(id)) continue
      const isCollapsed = panel.isCollapsed()
      if (isCollapsed !== layoutNow().collapsed[id])
        void dispatch({ type: 'set_collapsed', sidebar: id, collapsed: isCollapsed })
      if (!isCollapsed) {
        // The daemon keeps the width as it rounds it; the panel already shows it, so the reply
        // moves nothing (sync compares with what was applied).
        const width = clampWidth(panel.getSize().inPixels)
        applied.current[id] = width
        if (width !== layoutNow().widths[id]) void dispatch({ type: 'set_width', sidebar: id, width })
      }
    }
  }

  // The panels follow what should show and the layout's widths. Not while a handle is held: the
  // pointer wins. Closing comes before opening, so a sidebar opens into room already made. The
  // resize library also closes sidebars itself when the window shrinks past what fits, so this runs
  // again after any layout change it makes (resync, from the group's onLayoutChanged).
  const shownNow = useRef(shown)
  useLayoutEffect(() => {
    shownNow.current = shown
  })
  /**
   * Once an open or close has settled, puts every shown sidebar at its exact saved width. The
   * library turns pixels into shares of the row as it is at that moment, while gutters are still
   * animating in or out, so a width can land a pixel or two off; one panel at a time is exact.
   */
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settleWidths = (): void => {
    if (settle.current) clearTimeout(settle.current)
    settle.current = setTimeout(
      () => {
        settle.current = null
        const now = layoutNow()
        const element = group.current
        if (!element) return
        const space = availablePanelWidth(element)
        if (space <= 0) return
        for (const id of IDS) {
          const panel = refs[id].current
          if (!panel || !shownNow.current[id] || panel.isCollapsed()) continue
          // Pixel conversion can still use the library's earlier gutter measurement.
          // Use the drawn row directly, including subpixel differences after a toggle.
          if (drawnWidth(id) !== now.widths[id]) panel.resize(`${(now.widths[id] / space) * 100}%`)
        }
      },
      DURATION.base * 1000 + 100,
    )
  }

  /**
   * Closes the sidebars that should not show, in one change to the whole row. When the window
   * shrinks past every minimum at once, the library squeezes both sidebars below theirs; it then
   * refuses to change one panel at a time, since each result still breaks the other's minimum.
   */
  const closeSqueezed = (): void => {
    const handle = groupHandle.current
    const element = group.current
    const closing = IDS.filter((id) => !shownNow.current[id] && (refs[id].current?.getSize().inPixels ?? 0) > 0.5)
    if (!handle || !element || closing.length === 0) return
    const next = { ...handle.getLayout() }
    // The pixels 100% stands for: the group's content less its gutters.
    const space = availablePanelWidth(element)
    const layout = layoutNow()
    const toPercent = (pixels: number): number => (pixels / space) * 100
    const centreMin = toPercent(minSize(layout.root, layout.tabs).width)
    // Shown sidebars get their saved width; the centre takes the rest. If that leaves the centre
    // under its minimum, they give back down to their own.
    for (const id of IDS) next[id] = shownNow.current[id] ? toPercent(layout.widths[id]) : 0
    const shown = IDS.filter((id) => shownNow.current[id])
    let over = shown.reduce((total, id) => total + next[id]!, 0) + centreMin - 100
    for (const id of shown) {
      if (over <= 0) break
      const give = Math.min(over, next[id]! - toPercent(SIDEBAR_WIDTH.min))
      next[id] = next[id]! - give
      over -= give
    }
    next.centre = 100 - shown.reduce((total, id) => total + next[id]!, 0)
    handle.setLayout(next)
    settleWidths()
  }

  const sync = (): void => {
    if (document.querySelector('[data-separator=active]')) return
    const layout = layoutNow()
    syncing.current = true
    closeSqueezed()
    for (const id of IDS) {
      const panel = refs[id].current
      if (!panel || !shownNow.current[id]) continue
      if (panel.isCollapsed()) {
        // Opens at the layout's width, not the library's memory of it: a sidebar closed by the
        // whole-row change (closeSqueezed), or mounted closed, has none.
        const width = layout.widths[id]
        panel.resize(`${width}px`)
        applied.current[id] = width
        settleWidths()
      } else if (followed.current[id] !== layout.widths[id] && applied.current[id] !== layout.widths[id]) {
        panel.resize(`${layout.widths[id]}px`)
        applied.current[id] = layout.widths[id]
      }
      followed.current[id] = layout.widths[id]
    }
    syncing.current = false
  }
  // Right after the sidebars swap, wait a frame: the resize library re-reads the panels' order
  // first, and a resize in the same update is lost.
  const order = sidebars.join(',')
  const syncedOrder = useRef(order)
  useEffect(() => {
    if (syncedOrder.current === order) return sync()
    syncedOrder.current = order
    const next = requestAnimationFrame(sync)
    return () => cancelAnimationFrame(next)
  })

  // Animate panel sizes while a collapse or expand settles, then stop, so a drag never lags.
  // Compared with the last state shown, not a first-run flag: React runs effects twice in
  // development, and the window must open at its saved sizes without animating.
  const shownKey = `${shown.navigator ? 1 : 0}${shown.inspector ? 1 : 0}`
  const lastShown = useRef<string | null>(null)
  useLayoutEffect(() => {
    const element = group.current
    const previous = lastShown.current
    lastShown.current = shownKey
    if (!element || previous === null || previous === shownKey) return
    element.dataset.layoutAnimating = ''
    const done = setTimeout(() => delete element.dataset.layoutAnimating, DURATION.base * 1000 + 50)
    return () => clearTimeout(done)
  }, [shownKey, group])
  // Any direct resize ends a size animation at once: the pointer or key must win. Plain listeners,
  // not props: the resize library handles these events on the group itself.
  useEffect(() => {
    const element = group.current
    if (!element) return
    const stop = (): void => {
      delete element.dataset.layoutAnimating
    }
    element.addEventListener('pointerdown', stop, true)
    element.addEventListener('keydown', stop, true)
    return () => {
      element.removeEventListener('pointerdown', stop, true)
      element.removeEventListener('keydown', stop, true)
    }
  }, [group])

  // Once per frame at most, after whatever the library did in this one.
  const pending = useRef<number | null>(null)
  const resync = (): void => {
    if (pending.current !== null || syncing.current || document.querySelector('[data-separator=active]')) return
    pending.current = requestAnimationFrame(() => {
      pending.current = null
      sync()
    })
  }
  useEffect(
    () => () => {
      if (pending.current !== null) cancelAnimationFrame(pending.current)
    },
    [],
  )

  return { group, groupHandle, shown, commitSizes, syncing, resync }
}
