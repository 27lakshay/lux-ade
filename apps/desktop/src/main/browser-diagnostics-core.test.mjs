// In-process tests for the pure diagnostics cores (AGENTS.md test policy).
// Run: node --test apps/desktop/src/main/browser-diagnostics-core.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clip, consoleEntry, flushNetwork, networkEvent, networkTracker, pushRing, readPage, redactText, redactUrl,
  ring, TEXT_LIMIT, URL_LIMIT } from './browser-diagnostics-core.ts'

const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'

test('URLs lose user information, fragments and credential-like query values', () => {
  const url = redactUrl('https://user:pass@api.test/v1/items?id=7&access_token=abc&sig=zz&q=hello#secret-fragment')
  assert.equal(url, 'https://api.test/v1/items?id=7&access_token=[redacted]&sig=[redacted]&q=hello')
  assert.equal(redactUrl(`https://a.test/reset/${jwt}`), 'https://a.test/reset/[redacted:jwt]')
  assert.equal(redactUrl('https://a.test/?next=Bearer%20abcdefghijkl'), 'https://a.test/?next=[redacted]')
  assert.equal(redactUrl('data:text/html;base64,PGh0bWw+'), 'data:[omitted]')
  assert.equal(redactUrl('file:///Users/me/.ssh/id_rsa'), 'file:[omitted]')
  assert.equal(redactUrl(42), '')
  assert.ok(redactUrl(`https://a.test/${'x'.repeat(5000)}`).length <= URL_LIMIT)
})

test('console text loses header lines, labeled secrets, bearer tokens and provider keys', () => {
  const out = redactText([
    'Cookie: session=abc; theme=dark',
    'set-cookie: sid=1; HttpOnly',
    'Authorization: Bearer abcdefghijklmnop',
    'password=hunter2 and api_key: "k-123"',
    `token ${jwt}`,
    'sent Bearer abcdefghijklmnop to server',
    'fetch https://x:y@a.test/cb?code=123&ok=1 failed',
    'key sk-ant-' + 'a'.repeat(48),
  ].join('\n'))
  for (const secret of ['abc;', 'dark', 'sid=1', 'abcdefghijklmnop', 'hunter2', 'k-123', jwt, 'x:y@', 'code=123', 'aaaaaaaa']) {
    assert.ok(!out.includes(secret), `${secret} leaked in ${out}`)
  }
  assert.match(out, /Cookie: \[redacted\]/)
  assert.match(out, /https:\/\/a\.test\/cb\?code=\[redacted\]&ok=1/)
})

test('text is bounded after redaction, stripped of control characters, and never splits a surrogate pair', () => {
  assert.equal(redactText('a\u0000b\u001bc'), 'a b c')
  const long = redactText(`${'x'.repeat(TEXT_LIMIT * 20)}`)
  assert.equal(long.length, TEXT_LIMIT)
  assert.ok(long.endsWith('…'))
  const emoji = clip(`${'a'.repeat(8)}😀😀`, 10)
  assert.equal(emoji, `${'a'.repeat(8)}…`)
})

test('console, exception and log events become redacted entries; other methods are ignored', () => {
  const log = consoleEntry('Runtime.consoleAPICalled', {
    type: 'error',
    args: [{ type: 'string', value: 'failed with token=abc' }, { type: 'object', description: 'Object' },
      { type: 'number', unserializableValue: 'NaN' }],
    stackTrace: { callFrames: [{ url: 'https://a.test/app.js?key=1', lineNumber: 9 }] },
  }, 1, 100)
  assert.deepEqual(log, { seq: 1, at_ms: 100, source: 'console', level: 'error',
    text: 'failed with [redacted:labeled-kv] Object NaN', url: 'https://a.test/app.js?key=[redacted]', line: 10 })
  const thrown = consoleEntry('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught',
    exception: { description: 'TypeError: x is undefined' }, url: 'https://a.test/b.js', lineNumber: 0 } }, 2, 5)
  assert.equal(thrown.source, 'exception')
  assert.equal(thrown.text, 'TypeError: x is undefined')
  assert.equal(thrown.line, 1)
  const browser = consoleEntry('Log.entryAdded', { entry: { level: 'warning', text: 'Mixed content' } }, 3, 5)
  assert.equal(browser.source, 'browser')
  assert.equal(consoleEntry('Network.requestWillBeSent', {}, 4, 5), null)
  const many = consoleEntry('Runtime.consoleAPICalled', { type: 'log',
    args: Array.from({ length: 50 }, (_, index) => ({ type: 'number', value: index })) }, 5, 5)
  assert.ok(many.text.endsWith('19 …'))
})

test('network summaries follow a request to its end without reading headers', () => {
  const tracker = networkTracker()
  assert.deepEqual(networkEvent(tracker, 'Network.requestWillBeSent', { requestId: 'r1', type: 'Fetch', timestamp: 1,
    request: { method: 'POST', url: 'https://a.test/login?password=x', headers: { Cookie: 'sid=1' } } }, 1000), [])
  networkEvent(tracker, 'Network.responseReceived', { requestId: 'r1',
    response: { status: 401, mimeType: 'application/json', headers: { 'set-cookie': 'sid=2' } } }, 1001)
  const [done] = networkEvent(tracker, 'Network.loadingFinished', { requestId: 'r1', timestamp: 1.25,
    encodedDataLength: 321 }, 1002)
  assert.deepEqual(done, { at_ms: 1000, method: 'POST', url: 'https://a.test/login?password=[redacted]',
    resource_type: 'Fetch', status: 401, mime_type: 'application/json', encoded_bytes: 321, duration_ms: 250,
    outcome: 'completed', error: null })
  assert.ok(!JSON.stringify(done).includes('sid='))
  assert.equal(tracker.pending.size, 0)
})

test('redirects, failures, cancels and blocks end requests with their outcome', () => {
  const tracker = networkTracker()
  const send = (id, url, extra = {}) => networkEvent(tracker, 'Network.requestWillBeSent',
    { requestId: id, request: { method: 'GET', url }, timestamp: 2, ...extra }, 10)
  send('r', 'https://a.test/old')
  const [hop] = send('r', 'https://a.test/new', { redirectResponse: { status: 302 } })
  assert.equal(hop.status, 302)
  assert.equal(hop.outcome, 'completed')
  assert.equal(tracker.pending.get('r').url, 'https://a.test/new')
  const [failed] = networkEvent(tracker, 'Network.loadingFailed', { requestId: 'r', errorText: 'net::ERR_FAILED' }, 11)
  assert.equal(failed.outcome, 'failed')
  send('c', 'https://a.test/c')
  assert.equal(networkEvent(tracker, 'Network.loadingFailed', { requestId: 'c', canceled: true }, 12)[0].outcome, 'canceled')
  send('b', 'https://a.test/b')
  const [blocked] = networkEvent(tracker, 'Network.loadingFailed', { requestId: 'b', errorText: 'net::ERR_BLOCKED',
    blockedReason: 'mixed-content' }, 12)
  assert.equal(blocked.outcome, 'blocked')
  assert.deepEqual(networkEvent(tracker, 'Network.loadingFinished', { requestId: 'unknown' }, 13), [])
})

test('the in-flight table is bounded and a detach ends what is left as incomplete', () => {
  const tracker = networkTracker(2)
  for (const id of ['a', 'b']) {
    networkEvent(tracker, 'Network.requestWillBeSent', { requestId: id, request: { url: `https://a.test/${id}` } }, 1)
  }
  const [evicted] = networkEvent(tracker, 'Network.requestWillBeSent', { requestId: 'c', request: { url: 'https://a.test/c' } }, 2)
  assert.equal(evicted.url, 'https://a.test/a')
  assert.equal(evicted.outcome, 'incomplete')
  assert.equal(tracker.pending.size, 2)
  const rest = flushNetwork(tracker, 'capture ended: target_closed')
  assert.deepEqual(rest.map((item) => [item.url, item.outcome]), [['https://a.test/b', 'incomplete'], ['https://a.test/c', 'incomplete']])
  assert.equal(tracker.pending.size, 0)
})

test('rings evict the oldest entries by count and by bytes and count what they dropped', () => {
  const byCount = ring(3, 1 << 20)
  for (let seq = 1; seq <= 5; seq++) pushRing(byCount, { seq })
  assert.deepEqual(byCount.items.map((item) => item.seq), [3, 4, 5])
  assert.equal(byCount.dropped, 2)
  const byBytes = ring(100, 64)
  for (let seq = 1; seq <= 4; seq++) pushRing(byBytes, { seq, text: 'x'.repeat(20) })
  assert.ok(byBytes.bytes <= 64)
  assert.equal(byBytes.dropped + byBytes.items.length, 4)
  const single = ring(100, 8)
  pushRing(single, { seq: 1, text: 'larger than the budget' })
  assert.equal(single.items.length, 1)
})

test('pages merge both kinds in sequence order and stop at the limit or byte budget', () => {
  const consoleItems = [1, 4, 5].map((seq) => ({ seq, text: 'c' }))
  const networkItems = [2, 3, 6].map((seq) => ({ seq, url: 'n' }))
  const first = readPage(consoleItems, networkItems, 0, 4, 1 << 20)
  assert.deepEqual([...first.console, ...first.network].map((item) => item.seq).sort(), [1, 2, 3, 4])
  assert.equal(first.next, 4)
  assert.equal(first.more, true)
  const second = readPage(consoleItems, networkItems, first.next, 4, 1 << 20)
  assert.deepEqual(second.console.map((item) => item.seq), [5])
  assert.deepEqual(second.network.map((item) => item.seq), [6])
  assert.equal(second.more, false)
  const tight = readPage(consoleItems, networkItems, 0, 200, 40)
  assert.equal(tight.more, true)
  assert.ok(tight.console.length + tight.network.length < 6)
  const empty = readPage([], [], 9, 10, 100)
  assert.deepEqual(empty, { console: [], network: [], next: 9, more: false })
})
