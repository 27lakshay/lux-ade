// Pointer actions on a resize handle (press, drag, double-click) never take the keyboard focus:
// whatever had it, a terminal or the composer, keeps it. The resize library focuses a handle itself
// when a press lands on or near it, so the focus is handed back as it arrives. A handle still takes
// focus from the keyboard (Tab), where arrow keys resize it.

let pressing = false

function onPointerDown(): void {
  pressing = true
  // Cleared after the event has been through every listener, the library's included.
  setTimeout(() => {
    pressing = false
  })
}

function onFocusIn(event: FocusEvent): void {
  const target = event.target
  if (!pressing || !(target instanceof HTMLElement) || target.getAttribute('role') !== 'separator') return
  const previous = event.relatedTarget
  if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
  else target.blur()
}

/** Installs the rule for the window; returns its removal. */
export function keepFocusOffHandles(): () => void {
  window.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('focusin', onFocusIn, true)
  return () => {
    window.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('focusin', onFocusIn, true)
  }
}
