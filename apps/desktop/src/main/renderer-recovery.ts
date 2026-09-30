import { dialog, type BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { appUrl } from './app-protocol'

// When an app window stops responding or its renderer dies, reload it with `?safeMode=1` so the
// renderer shows core recovery controls. All work lives in the daemon, so a reload loses only what the
// window was showing. A window that fails again soon after a recovery is left alone, with a message,
// so a crash on startup cannot loop.

const HANG_GRACE_MS = 8_000
const REPEAT_WINDOW_MS = 30_000

/** The window's own page, keeping its name, in safe mode. */
function safeModeUrl(window: BrowserWindow): string {
  const url = new URL(window.webContents.getURL() || appUrl())
  url.searchParams.set('safeMode', '1')
  return url.toString()
}

export function recoverRendererFailures(window: BrowserWindow): void {
  const scoped = log.scope('recovery')
  let hangTimer: NodeJS.Timeout | null = null
  let lastRecovery = 0

  const recover = (reason: string): void => {
    if (window.isDestroyed()) return
    const now = Date.now()
    if (now - lastRecovery < REPEAT_WINDOW_MS) {
      scoped.error(`window failed again after recovery (${reason}); not reloading`)
      void dialog.showMessageBox(window, {
        type: 'error',
        title: 'The window keeps failing',
        message: 'The window failed again after recovery.',
        detail:
          'Your agents, terminals and services keep running in the background. Close and reopen the window to try again.',
      })
      return
    }
    lastRecovery = now
    scoped.warn(`reloading window in safe mode (${reason})`)
    void window.loadURL(safeModeUrl(window))
    void dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Window reloaded',
      message: `The window ${reason === 'unresponsive' ? 'stopped responding' : 'crashed'} and was reloaded into recovery.`,
      detail: 'Your agents, terminals and services kept running in the background.',
    })
  }

  // A hang is ended by crashing the renderer; render-process-gone then reloads it.
  let crashedForHang = false
  window.on('unresponsive', () => {
    if (hangTimer) return
    hangTimer = setTimeout(() => {
      hangTimer = null
      if (window.isDestroyed()) return
      crashedForHang = true
      window.webContents.forcefullyCrashRenderer()
    }, HANG_GRACE_MS)
  })
  window.on('responsive', () => {
    if (hangTimer) clearTimeout(hangTimer)
    hangTimer = null
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    recover(crashedForHang ? 'unresponsive' : details.reason)
    crashedForHang = false
  })
}
