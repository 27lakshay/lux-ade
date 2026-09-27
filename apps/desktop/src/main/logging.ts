import { app, type WebContents } from 'electron'
import log from 'electron-log/main'
import { join } from 'node:path'

// App logs: the main process, plus the console of the app's own windows. Browser tabs are never
// logged, since their pages may print user content.
//
// Development: <repo>/.dev/logs/main.log, so agents can read it. Packaged: the platform's log
// folder (~/Library/Logs/<product>/main.log on macOS).

export function logFile(): string {
  return log.transports.file.getFile().path
}

export function initializeLogging(): void {
  log.initialize({ preload: false })
  if (!app.isPackaged) {
    log.transports.file.resolvePathFn = () => join(app.getAppPath(), '../../.dev/logs/main.log')
  }
  // Uncaught main-process errors are logged; the existing startup handler decides what to show.
  log.errorHandler.startCatching({ showDialog: false })
  Object.assign(console, log.functions)
}

const LEVELS = { debug: 'debug', info: 'info', warning: 'warn', error: 'error' } as const
// Known, harmless messages from development-only helpers. react-grab imports a web font, which the
// content security policy blocks.
const DEVELOPMENT_NOISE = [/fonts\.googleapis\.com\/css2\?family=Geist/]

/** Copies an app window's console into the log, tagged with the window's name. */
export function logWindowConsole(contents: WebContents, name: string): void {
  const scoped = log.scope(name)
  contents.on('console-message', (event) => {
    if (!app.isPackaged && DEVELOPMENT_NOISE.some((pattern) => pattern.test(event.message))) return
    const source = event.sourceId ? ` (${event.sourceId}:${event.lineNumber})` : ''
    scoped[LEVELS[event.level]](`${event.message}${source}`)
  })
  contents.on('render-process-gone', (_event, details) => scoped.error('renderer gone', details))
}
