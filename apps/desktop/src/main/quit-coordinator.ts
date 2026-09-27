/**
 * Work a feature must finish before ADE quits.
 *
 * `before-quit` calls the guard until it releases. The guard returns the flush to
 * start when the quit must wait now, or null when nothing holds the quit. The
 * flush resolves true to release the guard and quit again, or false to keep ADE
 * open.
 */
export type QuitGuard = () => (() => Promise<boolean>) | null

/** Shutdown work that must wait until every window has closed. */
export type QuitTeardown = () => void | Promise<void>

type Preventable = { preventDefault(): void }
type Registration = { guard: QuitGuard; released: boolean; flushing: boolean }

/**
 * Orders ADE's quit: guards hold `before-quit`, and teardown runs in `will-quit`.
 *
 * A released guard stays released only within one quit attempt. When a guard
 * keeps ADE open, or every guard lets a quit through (a window may still cancel
 * it), every guard is asked again on the next attempt. Teardown runs only after
 * Electron has closed every window, so a window that cancels the quit leaves the
 * client, terminals and browser owner running.
 */
export class QuitCoordinator {
  private readonly registrations: Registration[] = []
  private readonly teardowns: QuitTeardown[] = []
  private teardown: 'idle' | 'running' | 'done' = 'idle'

  private readonly requestQuit: () => void
  private readonly report: (error: unknown) => void

  constructor(
    requestQuit: () => void,
    report: (error: unknown) => void = (error) => console.error('Quit step failed', error),
  ) {
    this.requestQuit = requestQuit
    this.report = report
  }

  /** Guards run in registration order; a later guard waits until every earlier one lets the quit through. */
  registerGuard(guard: QuitGuard): void {
    this.registrations.push({ guard, released: false, flushing: false })
  }

  /** Teardowns run in registration order, once, from `will-quit`. */
  registerTeardown(teardown: QuitTeardown): void {
    this.teardowns.push(teardown)
  }

  /** For `before-quit`: returns true, and prevents the quit, while any guard holds it. */
  holdQuit(event: Preventable): boolean {
    if (this.teardown !== 'idle') return false
    for (const registration of this.registrations) {
      if (registration.released) continue
      const flush = registration.guard()
      if (!flush) continue
      event.preventDefault()
      if (registration.flushing) return true
      registration.flushing = true
      void Promise.resolve()
        .then(flush)
        .then(
          (ready) => {
            registration.flushing = false
            if (!ready) {
              this.resetReleases()
              return
            }
            registration.released = true
            this.requestQuit()
          },
          (error: unknown) => {
            registration.flushing = false
            this.resetReleases()
            this.report(error)
          },
        )
      return true
    }
    // Every guard let this attempt through. A window can still cancel it, so the
    // next attempt must ask every guard again.
    this.resetReleases()
    return false
  }

  /** For `will-quit`: holds the quit once while teardown runs, then quits again. */
  finishQuit(event: Preventable): void {
    if (this.teardown === 'done') return
    event.preventDefault()
    if (this.teardown === 'running') return
    this.teardown = 'running'
    void (async () => {
      for (const teardown of this.teardowns) {
        try {
          await teardown()
        } catch (error) {
          this.report(error)
        }
      }
      this.teardown = 'done'
      this.requestQuit()
    })()
  }

  private resetReleases(): void {
    for (const registration of this.registrations) registration.released = false
  }
}
