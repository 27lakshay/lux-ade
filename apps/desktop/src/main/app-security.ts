import { app, shell, type Session, type WebContents } from 'electron'
import { appUrl } from './app-protocol'

// Deny by default for the app's own windows and their session. Browser tabs have their own
// partitioned sessions and handlers in browser.ts.

// The app session's only permission: writing to the clipboard (navigator.clipboard.writeText).
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write'])

export function lockDownAppSession(session: Session): void {
  session.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(ALLOWED_PERMISSIONS.has(permission)),
  )
  session.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission))
  session.setDevicePermissionHandler(() => false)
}

/** No web contents may attach a <webview>; the app uses WebContentsView for web pages. */
export function refuseWebviews(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}

/** The app window never navigates away from the app. Links to https pages open in the user's browser. */
export function lockDownAppWindow(contents: WebContents): void {
  const origin = new URL(appUrl()).origin
  contents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault()
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
}
