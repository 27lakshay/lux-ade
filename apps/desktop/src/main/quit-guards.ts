import { app } from 'electron'

/**
 * Work a feature must finish before ADE quits.
 *
 * `before-quit` calls the guard until it releases. The guard returns the flush to
 * start when the quit must wait now, or null when nothing holds the quit. The
 * flush resolves true to release the guard and quit again, or false to keep ADE
 * open; the next quit attempt calls the guard again.
 */
export type QuitGuard = () => (() => Promise<boolean>) | null

type Registration = { guard: QuitGuard; released: boolean; flushing: boolean }

const registrations: Registration[] = []

/** Guards run in registration order; a later guard waits until every earlier one lets the quit through. */
export function registerQuitGuard(guard: QuitGuard): void {
  registrations.push({ guard, released: false, flushing: false })
}

/** Returns true, and prevents the quit, while any guard holds it. */
export function holdQuit(event: Electron.Event): boolean {
  for (const registration of registrations) {
    if (registration.released) continue
    const flush = registration.guard()
    if (!flush) continue
    event.preventDefault()
    if (registration.flushing) return true
    registration.flushing = true
    void flush().then((ready) => {
      if (!ready) return
      registration.released = true
      app.quit()
    }).finally(() => { registration.flushing = false })
    return true
  }
  return false
}
