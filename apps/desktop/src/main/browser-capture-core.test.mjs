// In-process tests for the pure design context capture cores (AGENTS.md test policy).
// Run: node --test apps/desktop/src/main/browser-capture-core.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CAPTURE_LIMITS,
  clampCapture,
  collectionScript,
  fitWithin,
  pickEncoding,
  recordUrl,
  screenshotCrop,
  STYLE_PROPERTIES,
  validSelector,
} from './browser-capture-core.ts'

const raw = (overrides = {}) => ({
  url: 'https://u:p@a.test/page?token=1#x',
  title: 'A',
  tag: 'BUTTON',
  html: '<button class="b">Go</button>',
  text: 'Go',
  rect: { x: 10, y: 20, width: 100, height: 40 },
  styles: { color: 'rgb(0, 0, 0)', 'font-size': '14px', 'not-listed': 'x' },
  attributes: {
    class: 'b',
    onclick: 'steal()',
    href: 'https://a.test/x?session_id=9',
    'data-id': '7',
    title: 'api_key=abc',
  },
  viewport: { width: 1280, height: 800, device_pixel_ratio: 2 },
  ...overrides,
})

test('a capture keeps the element and strips credentials, queries and handlers', () => {
  const outcome = clampCapture(raw())
  assert.equal(outcome.ok, true)
  const { page } = outcome
  assert.equal(page.url, 'https://a.test/page')
  assert.equal(page.element.tag, 'button')
  assert.deepEqual(page.element.styles, { color: 'rgb(0, 0, 0)', 'font-size': '14px' })
  assert.equal(page.element.attributes.onclick, undefined)
  assert.equal(page.element.attributes.href, '[redacted]')
  assert.equal(page.element.attributes.title, '[redacted]')
  assert.equal(page.element.attributes['data-id'], '7')
  assert.deepEqual(page.truncated, [])
})

test('oversized parts are cut and reported', () => {
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`data-a${i}`, 'v']))
  const outcome = clampCapture(
    raw({ html: 'x'.repeat(CAPTURE_LIMITS.html + 1), text: 'y'.repeat(9000), attributes: many }),
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.page.element.html.length, CAPTURE_LIMITS.html)
  assert.equal(outcome.page.element.text.length, CAPTURE_LIMITS.text)
  assert.equal(Object.keys(outcome.page.element.attributes).length, CAPTURE_LIMITS.attributes)
  assert.deepEqual(outcome.page.truncated, ['html', 'text', 'attributes'])
})

test('pages outside HTTP(S), bad selectors, missing elements and bad geometry fail', () => {
  assert.deepEqual(clampCapture({ error: 'invalid_selector' }).code, 'invalid_request')
  assert.deepEqual(clampCapture({ error: 'not_found' }).code, 'unavailable')
  assert.equal(clampCapture(raw({ url: 'file:///etc/hosts' })).ok, false)
  assert.equal(clampCapture(raw({ tag: '<script>' })).ok, false)
  assert.equal(clampCapture(raw({ rect: { x: NaN, y: 0, width: 1, height: 1 } })).ok, false)
  assert.equal(clampCapture(null).ok, false)
  assert.equal(clampCapture([]).ok, false)
})

test('record URLs lose user information, query and fragment', () => {
  assert.equal(recordUrl('https://a.test/@me?x=1#y'), 'https://a.test/@me')
  assert.equal(recordUrl('javascript:alert(1)'), null)
  assert.equal(recordUrl(42), null)
})

test('selectors are bounded', () => {
  assert.equal(validSelector('main > h1'), true)
  for (const bad of ['', 'a'.repeat(1025), 'a\nb', 7]) assert.equal(validSelector(bad), false)
})

test('the collection script embeds the selector as data', () => {
  const script = collectionScript('a"); alert(1); ("')
  assert.ok(script.includes(JSON.stringify('a"); alert(1); ("')))
  for (const name of STYLE_PROPERTIES) assert.ok(script.includes(`"${name}"`))
  // The regular expressions survive the template literal with their escapes.
  assert.ok(script.includes('/^\\s*(javascript|data|blob|vbscript):/i'))
  assert.doesNotThrow(() => new Function(`return ${script}`))
})

test('the crop follows the bitmap scale and clips to the viewport', () => {
  const viewport = { width: 1000, height: 800 }
  const bitmap = { width: 2000, height: 1600 }
  assert.deepEqual(screenshotCrop({ x: 10, y: 20, width: 100, height: 50 }, viewport, bitmap), {
    ok: true,
    crop: { x: 20, y: 40, width: 200, height: 100 },
    scale: 2,
  })
  assert.deepEqual(screenshotCrop({ x: 900, y: 700, width: 500, height: 500 }, viewport, bitmap).crop, {
    x: 1800,
    y: 1400,
    width: 200,
    height: 200,
  })
  assert.deepEqual(screenshotCrop({ x: 0, y: 900, width: 10, height: 10 }, viewport, bitmap), {
    ok: false,
    reason: 'not_visible',
  })
  assert.deepEqual(screenshotCrop({ x: 0, y: 0, width: 0, height: 10 }, viewport, bitmap), {
    ok: false,
    reason: 'not_visible',
  })
  assert.deepEqual(screenshotCrop({ x: 0, y: 0, width: 1, height: 1 }, viewport, { width: 0, height: 0 }), {
    ok: false,
    reason: 'capture_failed',
  })
})

test('screenshots are resized and encoded within their bounds', () => {
  assert.deepEqual(fitWithin(3200, 800), { width: 1600, height: 400 })
  assert.deepEqual(fitWithin(300, 200), { width: 300, height: 200 })
  const sized = (sizes) => (format, quality) => new Uint8Array(sizes[`${format}${quality}`])
  assert.equal(pickEncoding(sized({ png100: 10 }), 100).byteLength, 10)
  assert.equal(pickEncoding(sized({ png100: 200, jpeg85: 150, jpeg70: 90 }), 100).byteLength, 90)
  assert.equal(pickEncoding(sized({ png100: 200, jpeg85: 200, jpeg70: 200, jpeg50: 200 }), 100), null)
})
