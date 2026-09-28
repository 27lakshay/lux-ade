import assert from 'node:assert/strict'
import { test } from 'node:test'
import { injectBeforeEntry } from './dev-helpers.ts'

const page = (entry) => `<head></head><body><script type="module" src="${entry}"></script></body>`
const helper = '<script type="module" src="/src/dev/react-scan.ts"></script>'

test('the helpers go before the entry however the dev server has written it', () => {
  for (const entry of [
    './src/bootstrap.ts',
    '/src/bootstrap.ts',
    '/src/bootstrap.ts?t=1790621906822',
    './src/bootstrap.ts?t=1',
  ]) {
    const html = injectBeforeEntry(page(entry), ['/src/dev/react-scan.ts'])
    assert.ok(html.indexOf(helper) >= 0 && html.indexOf(helper) < html.indexOf(`src="${entry}"`), entry)
  }
})

test('a page without the entry fails loudly instead of dropping the helpers', () => {
  assert.throws(() => injectBeforeEntry('<body></body>', ['/src/dev/react-scan.ts']), /entry script tag was not found/)
  assert.equal(injectBeforeEntry('<body></body>', []), '<body></body>')
})
