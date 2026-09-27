// Pure cores for design context capture (F094): the in-page collection script,
// the bounds and redaction applied to what the page returns, the screenshot
// crop and the encoding choice. Nothing here touches Electron (AGENTS.md test
// policy). The page is untrusted: everything it returns is re-checked here, and
// the daemon checks the owner's reply again.
//
// Pattern studied, no code copied: Orca src/main/browser/browser-grab-payload.ts
// and browser-grab-screenshot.ts (MIT): clamp the guest payload main-side,
// redact secret-looking values, and derive the crop scale from the bitmap.

/** The isolated world the collection script runs in, apart from page scripts. */
export const CAPTURE_WORLD = 1094
export const CAPTURE_LIMITS = {
  selector: 1024,
  html: 64 * 1024,
  text: 4096,
  attributes: 64,
  attributeValue: 1024,
  title: 512,
  url: 8192,
  /** Kept below the daemon's 1 MiB owner reply bound once base64-encoded. */
  screenshotBytes: 512 * 1024,
  /** A crop is scaled down so neither side exceeds this many pixels. */
  screenshotEdge: 1600,
}
export const STYLE_PROPERTIES = [
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  'box-sizing',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-radius',
  'outline',
  'box-shadow',
  'background-color',
  'background-image',
  'color',
  'opacity',
  'visibility',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-transform',
  'text-decoration-line',
  'white-space',
  'overflow-x',
  'overflow-y',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'justify-content',
  'align-items',
  'align-self',
  'gap',
  'grid-template-columns',
  'grid-template-rows',
  'transform',
  'transition',
  'cursor',
] as const
const SECRET = /(access_token|auth_token|api_?key|client_secret|session_?id|csrf|secret|password|passwd|bearer)/i
const SAFE_ATTRIBUTE =
  /^(id|class|role|name|type|href|src|alt|title|for|placeholder|rel|target|width|height|disabled|checked|tabindex|lang|dir|aria-[a-z-]+|data-[a-z0-9-]+)$/

export type CaptureRect = { x: number; y: number; width: number; height: number }
export type CapturedElement = {
  tag: string
  html: string
  text: string
  rect: CaptureRect
  styles: Record<string, string>
  attributes: Record<string, string>
}
export type CapturedPage = {
  url: string
  title: string
  element: CapturedElement
  viewport: { width: number; height: number; device_pixel_ratio: number }
  truncated: string[]
}
export type CaptureOutcome =
  | { ok: true; page: CapturedPage }
  | { ok: false; code: 'invalid_request' | 'unavailable'; message: string }

export function validSelector(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= CAPTURE_LIMITS.selector &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

/**
 * The script run in the page's isolated world. It reads the first element the
 * selector matches, clones it and strips what must never leave the page: script
 * and style contents, event handlers, form values and child frame documents.
 */
export function collectionScript(selector: string): string {
  return `(() => {
  const selector = ${JSON.stringify(selector)};
  let element;
  try { element = document.querySelector(selector); } catch { return { error: 'invalid_selector' }; }
  if (!element) return { error: 'not_found' };
  const clone = element.cloneNode(true);
  const all = [clone, ...clone.querySelectorAll('*')];
  for (const node of all) {
    const tag = node.tagName ? node.tagName.toLowerCase() : '';
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') { node.textContent = ''; }
    if (tag === 'iframe' || tag === 'frame') node.removeAttribute('srcdoc');
    if (tag === 'textarea') node.textContent = '';
    for (const attribute of [...(node.attributes || [])]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'value' || name === 'srcdoc' || name === 'nonce' ||
        name === 'integrity' || name === 'srcset' || name.startsWith('xlink:')) { node.removeAttribute(attribute.name); continue; }
      if (name === 'href' || name === 'src' || name === 'action' || name === 'poster') {
        if (/^\\s*(javascript|data|blob|vbscript):/i.test(attribute.value)) node.removeAttribute(attribute.name);
        else node.setAttribute(attribute.name, attribute.value.replace(/[?#][\\s\\S]*$/, ''));
      }
    }
  }
  const style = getComputedStyle(element);
  const styles = {};
  for (const name of ${JSON.stringify(STYLE_PROPERTIES)}) styles[name] = style.getPropertyValue(name);
  const attributes = {};
  for (const attribute of [...element.attributes].slice(0, 256)) attributes[attribute.name] = attribute.value;
  const box = element.getBoundingClientRect();
  return {
    url: location.href, title: document.title,
    tag: element.tagName, html: clone.outerHTML.slice(0, 262144),
    text: (element.innerText || element.textContent || '').slice(0, 16384),
    rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    styles, attributes,
    viewport: { width: innerWidth, height: innerHeight, device_pixel_ratio: devicePixelRatio },
  };
})()`
}

const finite = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : NaN)
const clip = (value: unknown, limit: number): [string, boolean] => {
  const text = typeof value === 'string' ? value : ''
  return text.length > limit ? [text.slice(0, limit), true] : [text, false]
}

/** A page URL for the record: HTTP(S) without user information, query or fragment. */
export function recordUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > CAPTURE_LIMITS.url) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    const text = url.toString()
    return text.length <= CAPTURE_LIMITS.url ? text : null
  } catch {
    return null
  }
}

/** Replaces credential-like values and strips query strings from URL attributes. */
function attributeValue(name: string, value: string): string {
  if (SECRET.test(value)) return '[redacted]'
  if (name === 'href' || name === 'src') {
    if (/^(javascript|data|blob|vbscript):/i.test(value.trim())) return '[removed]'
    return value.replace(/[?#].*$/s, '')
  }
  return value
}

/** Bounds, allowlists and redacts what the collection script returned. */
export function clampCapture(raw: unknown): CaptureOutcome {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'unavailable', message: 'The page returned no capture' }
  }
  const value = raw as Record<string, unknown>
  if (value.error === 'invalid_selector')
    return { ok: false, code: 'invalid_request', message: 'The selector is not valid CSS' }
  if (value.error === 'not_found') return { ok: false, code: 'unavailable', message: 'No element matches the selector' }
  const url = recordUrl(value.url)
  if (!url) return { ok: false, code: 'unavailable', message: 'The page is not an HTTP(S) page' }
  const tag = typeof value.tag === 'string' ? value.tag.toLowerCase() : ''
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(tag))
    return { ok: false, code: 'unavailable', message: 'The element tag is invalid' }
  const rect = (value.rect ?? {}) as Record<string, unknown>
  const view = (value.viewport ?? {}) as Record<string, unknown>
  const box = { x: finite(rect.x), y: finite(rect.y), width: finite(rect.width), height: finite(rect.height) }
  const viewport = {
    width: finite(view.width),
    height: finite(view.height),
    device_pixel_ratio: finite(view.device_pixel_ratio),
  }
  if ([...Object.values(box), ...Object.values(viewport)].some((n) => Number.isNaN(n) || Math.abs(n) > 1e7)) {
    return { ok: false, code: 'unavailable', message: 'The element geometry is invalid' }
  }
  const truncated: string[] = []
  const [html, htmlCut] = clip(value.html, CAPTURE_LIMITS.html)
  const [text, textCut] = clip(value.text, CAPTURE_LIMITS.text)
  if (htmlCut) truncated.push('html')
  if (textCut) truncated.push('text')
  const styles: Record<string, string> = {}
  const rawStyles = (value.styles ?? {}) as Record<string, unknown>
  for (const name of STYLE_PROPERTIES) {
    const [style, cut] = clip(rawStyles[name], CAPTURE_LIMITS.attributeValue)
    if (cut && !truncated.includes('styles')) truncated.push('styles')
    if (style) styles[name] = style
  }
  const attributes: Record<string, string> = {}
  const rawAttributes =
    value.attributes && typeof value.attributes === 'object' ? (value.attributes as Record<string, unknown>) : {}
  let dropped = false
  for (const [key, item] of Object.entries(rawAttributes)) {
    const name = key.toLowerCase()
    if (!SAFE_ATTRIBUTE.test(name) || typeof item !== 'string') continue
    if (Object.keys(attributes).length >= CAPTURE_LIMITS.attributes) {
      dropped = true
      break
    }
    const [kept, cut] = clip(attributeValue(name, item), CAPTURE_LIMITS.attributeValue)
    if (cut) dropped = true
    attributes[name] = kept
  }
  if (dropped) truncated.push('attributes')
  const [title] = clip(value.title, CAPTURE_LIMITS.title)
  return {
    ok: true,
    page: { url, title, element: { tag, html, text, rect: box, styles, attributes }, viewport, truncated },
  }
}

/**
 * The crop, in bitmap pixels, of an element's viewport rect, or why there is
 * none. The scale comes from the bitmap itself, which already reflects zoom and
 * device pixel ratio.
 */
export function screenshotCrop(
  rect: CaptureRect,
  viewport: { width: number; height: number },
  bitmap: { width: number; height: number },
): { ok: true; crop: CaptureRect; scale: number } | { ok: false; reason: 'not_visible' | 'capture_failed' } {
  if (!(viewport.width > 0) || !(bitmap.width > 0) || !(bitmap.height > 0))
    return { ok: false, reason: 'capture_failed' }
  const scale = bitmap.width / viewport.width
  const left = Math.max(0, Math.floor(rect.x * scale))
  const top = Math.max(0, Math.floor(rect.y * scale))
  const right = Math.min(bitmap.width, Math.ceil((rect.x + rect.width) * scale))
  const bottom = Math.min(bitmap.height, Math.ceil((rect.y + rect.height) * scale))
  if (right - left < 1 || bottom - top < 1) return { ok: false, reason: 'not_visible' }
  return { ok: true, crop: { x: left, y: top, width: right - left, height: bottom - top }, scale }
}

/** The size a crop is resized to so neither side exceeds the edge bound. */
export function fitWithin(
  width: number,
  height: number,
  edge = CAPTURE_LIMITS.screenshotEdge,
): { width: number; height: number } {
  const factor = Math.min(1, edge / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) }
}

/**
 * PNG when it fits the byte bound, else JPEG at falling quality, else nothing.
 * `encode` returns the image bytes for a format and quality.
 */
export function pickEncoding(
  encode: (format: 'png' | 'jpeg', quality: number) => Uint8Array,
  limit = CAPTURE_LIMITS.screenshotBytes,
): Uint8Array | null {
  const png = encode('png', 100)
  if (png.byteLength <= limit) return png
  for (const quality of [85, 70, 50]) {
    const jpeg = encode('jpeg', quality)
    if (jpeg.byteLength <= limit) return jpeg
  }
  return null
}
