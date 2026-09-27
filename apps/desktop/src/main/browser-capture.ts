// Design context capture (F094): one element of one exact tab. The owner reads
// the named tab's page only, never the selected or focused one. A page that
// navigates, is replaced or closes during the capture fails it, so a capture
// never mixes two documents. The pure bounds live in browser-capture-core.ts;
// the daemon checks the reply again, then stores it as conversation attachments.
import type { WebContents } from 'electron'
import { browserTabPage } from './browser'
import { CAPTURE_WORLD, clampCapture, collectionScript, fitWithin, pickEncoding, screenshotCrop,
  validSelector } from './browser-capture-core'

const SCRIPT_TIMEOUT_MS = 3000

function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

type Screenshot = { screenshot: Record<string, unknown> | null; screenshot_unavailable: string | null }

async function elementScreenshot(contents: WebContents, rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number }): Promise<Screenshot> {
  const none = (reason: string): Screenshot => ({ screenshot: null, screenshot_unavailable: reason })
  let image: Electron.NativeImage
  try { image = await within(contents.capturePage(), SCRIPT_TIMEOUT_MS, 'Screenshot timed out') }
  catch { return none('capture_failed') }
  // A page that is not painted, such as a tab no window shows, yields no bitmap.
  if (image.isEmpty()) return none('capture_failed')
  const plan = screenshotCrop(rect, viewport, image.getSize())
  if (!plan.ok) return none(plan.reason)
  const size = fitWithin(plan.crop.width, plan.crop.height)
  let cropped = image.crop(plan.crop)
  if (size.width !== plan.crop.width || size.height !== plan.crop.height) {
    cropped = cropped.resize({ width: size.width, height: size.height, quality: 'good' })
  }
  const bytes = pickEncoding((format, quality) => format === 'png' ? cropped.toPNG() : cropped.toJPEG(quality))
  if (!bytes) return none('too_large')
  return { screenshot: { data: Buffer.from(bytes).toString('base64'), width: size.width, height: size.height },
    screenshot_unavailable: null }
}

/** Captures one element of one exact tab. Errors carry a wire-code prefix. */
export async function captureDesignContext(browserProfileId: string, tabId: unknown, selector: unknown,
  screenshot: unknown): Promise<Record<string, unknown>> {
  if (!validSelector(selector)) throw new Error('invalid_request: selector must be 1 to 1024 characters')
  if (typeof screenshot !== 'boolean') throw new Error('invalid_request: screenshot must be true or false')
  const page = await browserTabPage(browserProfileId, tabId)
  const contents = page.contents
  if (!contents || contents.isDestroyed()) throw new Error('unavailable: the tab has no live page')
  if (contents.isCrashed()) throw new Error('unavailable: the tab page crashed')
  const startUrl = contents.getURL()
  let moved = false
  const onNavigate = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
    if (details.isMainFrame && !details.isSameDocument) moved = true
  }
  const onGone = (): void => { moved = true }
  contents.on('did-start-navigation', onNavigate)
  contents.once('destroyed', onGone)
  contents.once('render-process-gone', onGone)
  try {
    const raw: unknown = await within(
      contents.executeJavaScriptInIsolatedWorld(CAPTURE_WORLD, [{ code: collectionScript(selector) }], false),
      SCRIPT_TIMEOUT_MS, 'unavailable: the page did not answer the capture in time')
    const outcome = clampCapture(raw)
    if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`)
    const { page: captured } = outcome
    const shot: Screenshot = screenshot
      ? await elementScreenshot(contents, captured.element.rect, captured.viewport)
      : { screenshot: null, screenshot_unavailable: 'not_requested' }
    if (moved || contents.isDestroyed() || contents.getURL() !== startUrl) {
      throw new Error('unavailable: the page navigated or closed during the capture; nothing was captured')
    }
    return { type: 'browser_context_capture', tab_id: page.tabId, url: captured.url, title: captured.title,
      element: captured.element, viewport: captured.viewport, truncated: captured.truncated, ...shot }
  } finally {
    if (!contents.isDestroyed()) {
      contents.off('did-start-navigation', onNavigate)
      contents.off('destroyed', onGone)
      contents.off('render-process-gone', onGone)
    }
  }
}
