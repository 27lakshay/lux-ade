// Pointer actions on a resize handle (press, drag, double-click) never take the keyboard focus:
// whatever had it, a terminal or the composer, keeps it. The resize library focuses a handle itself
// when a press lands on or near it, so the focus is handed back as it arrives. A handle still takes
// focus from the keyboard (Tab), where arrow keys resize it and Escape goes back to work: the pane
// content the keyboard came from, or the focused pane's active tab.

let pressing = false
/** Where the keyboard came from when it reached a handle; Escape goes back there. */
let returnTo: HTMLElement | null = null

function onPointerDown(): void {
  pressing = true
  // Cleared after the event has been through every listener, the library's included.
  setTimeout(() => {
    pressing = false
  })
}

const isHandle = (target: EventTarget | null): target is HTMLElement =>
  target instanceof HTMLElement && target.getAttribute('role') === 'separator'

/** Where Escape on a handle goes: the content the keyboard came from, else the focused pane's tab. */
function workPlace(): HTMLElement | null {
  if (returnTo?.isConnected && returnTo.closest('[data-pane-body]')) return returnTo
  const pane = document.querySelector('[data-pane-focused]')
  return (
    pane?.querySelector<HTMLElement>('[data-tab-bar] [role=tab][aria-selected=true]') ??
    // A pane with no tabs: its first control (New tab).
    pane?.querySelector<HTMLElement>('button:not([disabled])') ??
    (returnTo?.isConnected ? returnTo : null)
  )
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !isHandle(event.target)) return
  event.preventDefault()
  const place = workPlace()
  if (place) place.focus({ preventScroll: true })
  else event.target.blur()
}

function onFocusIn(event: FocusEvent): void {
  const target = event.target
  if (!isHandle(target)) return
  if (!pressing) {
    // Reached by the keyboard. Moving between handles keeps the first place.
    if (!isHandle(event.relatedTarget))
      returnTo = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null
    return
  }
  const previous = event.relatedTarget
  // Not here, inside the library's focus() call: the handle's blur would reach the library before
  // its own focus handler, leaving the handle marked focused. A microtask runs once that call has
  // returned, still before the next paint.
  queueMicrotask(() => {
    if (document.activeElement !== target) return
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    else target.blur()
  })
}

/** Installs the rule for the window; returns its removal. */
export function keepFocusOffHandles(): () => void {
  window.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('keydown', onKeyDown, true)
  return () => {
    window.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('focusin', onFocusIn, true)
    document.removeEventListener('keydown', onKeyDown, true)
  }
}
