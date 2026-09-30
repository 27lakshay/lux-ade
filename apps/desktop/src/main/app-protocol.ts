import { app, net, protocol, type Session } from 'electron'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startupAppearance } from './appearance'
import { contentSecurityPolicy } from '../shared/content-security-policy'

// The packaged renderer is served from ade://app/ instead of file://, so it has a real origin, a
// strict content security policy on every response, and no access to other files on disk.
// Development serves the renderer from the Vite dev server instead (ELECTRON_RENDERER_URL).

export const APP_SCHEME = 'ade'
export const APP_ORIGIN = `${APP_SCHEME}://app`
const CONTENT_SECURITY_POLICY = contentSecurityPolicy()

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
    },
  ])
}

/** Serves the built renderer on the app scheme for one session. */
export function serveAppScheme(session: Session): void {
  const root = resolve(join(__dirname, '../renderer'))
  session.protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    const path = resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`)
    const inside = relative(root, path)
    if (url.host !== 'app' || inside.startsWith('..') || inside.split(sep).includes('..')) {
      return new Response('Not found', { status: 404 })
    }
    if (url.pathname === '/theme-boot.js') {
      const snapshot = JSON.stringify(startupAppearance())
      const source = await net.fetch(pathToFileURL(path).toString())
      return new Response(`globalThis.adeStartupAppearance = ${snapshot};\n${await source.text()}`, {
        headers: {
          'Content-Type': 'text/javascript',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': CONTENT_SECURITY_POLICY,
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }
    const response = await net.fetch(pathToFileURL(path).toString())
    const headers = new Headers(response.headers)
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
    headers.set('X-Content-Type-Options', 'nosniff')
    return new Response(response.body, { status: response.status, headers })
  })
}

/**
 * The app page for a daemon window record (`?window=<record ID>`, read by
 * src/renderer/src/app/window-id.ts); without one until the daemon gives the window a record.
 */
export function windowUrl(record: string | null): string {
  const url = new URL(appUrl())
  if (record) url.searchParams.set('window', record)
  return url.toString()
}

/** Where the app window loads its UI from. */

export function appUrl(): string {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) return process.env.ELECTRON_RENDERER_URL
  return `${APP_ORIGIN}/index.html`
}
