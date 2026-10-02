// The element each tab's content lives in, created once per tab and kept for the tab's life. A
// pane shows a tab by attaching its element into the pane body; moving the tab to another pane
// re-attaches the same element, so its React tree, terminal buffers and scroll position survive.

type ScrollPosition = { viewport: HTMLElement; left: number; top: number }

const hosts = new Map<string, HTMLElement>()
/** The element that had focus inside a host when it was detached, to focus again on attach. */
const focusOnAttach = new Map<string, HTMLElement>()
const scrollPositions = new WeakMap<HTMLElement, ScrollPosition[]>()
// Scroll viewports can reset their offsets when a tab host is detached from the document.

export function hostFor(tabId: string): HTMLElement {
  let host = hosts.get(tabId)
  if (!host) {
    host = document.createElement('div')
    host.className = 'h-full'
    host.dataset.contentHost = tabId
    hosts.set(tabId, host)
  }
  return host
}

export function releaseHost(tabId: string): void {
  hosts.get(tabId)?.remove()
  hosts.delete(tabId)
  focusOnAttach.delete(tabId)
}

const focusedIn = (host: HTMLElement): HTMLElement | null =>
  document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : null

function saveScrollPositions(host: HTMLElement): void {
  const positions = Array.from(
    host.querySelectorAll<HTMLElement>('[data-slot="scroll-area-viewport"]'),
    (viewport) => ({
      viewport,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    }),
  )
  if (positions.length > 0) scrollPositions.set(host, positions)
  else scrollPositions.delete(host)
}

function restoreScrollPositions(host: HTMLElement): void {
  const positions = scrollPositions.get(host)
  if (!positions) return
  for (const { viewport, left, top } of positions) {
    if (!host.contains(viewport)) continue
    viewport.scrollLeft = left
    viewport.scrollTop = top
  }
  if (scrollPositions.get(host) === positions) scrollPositions.delete(host)
}

/**
 * Shows a tab's element in a pane body. Detaching an element drops the keyboard focus inside it,
 * so it is remembered on detach and restored on the next attach (a move, or showing the tab again).
 */
export function attachHost(body: HTMLElement, tabId: string): () => void {
  const host = hostFor(tabId)
  if (host.parentElement !== body) {
    // A caller can move a host without its previous attachment cleanup. Capture live offsets
    // before replaceChildren disconnects it from its current body.
    if (host.parentElement) saveScrollPositions(host)
    const focused = focusedIn(host) ?? focusOnAttach.get(tabId)
    focusOnAttach.delete(tabId)
    body.replaceChildren(host)
    restoreScrollPositions(host)
    if (focused && host.contains(focused)) focused.focus({ preventScroll: true })
  }
  return () => {
    if (host.parentElement !== body) return
    const focused = focusedIn(host)
    if (focused) focusOnAttach.set(tabId, focused)
    saveScrollPositions(host)
    host.remove()
  }
}
