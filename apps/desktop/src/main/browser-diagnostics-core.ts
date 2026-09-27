// Portions adapted from Orca src/main/observability/redactor.ts (MIT, (c) 2026 Lovecast Inc.):
// the labeled key-value, provider-key and URL userinfo rules. Changed for browser
// console text and request URLs, with header-line, bearer and query-parameter rules.
//
// Pure cores for browser diagnostics (F096): redaction, bounding, CDP event
// normalization and paging. Nothing here touches Electron, so the rules are
// testable in-process (AGENTS.md test policy). Capture never reads headers,
// cookies or bodies; these rules cover what does get through: console text and
// request URLs.

export const REDACTION_POLICY = 'ade-browser-redaction-v1'
export const DIAGNOSTICS_EXCLUDED = [
  'request and response headers', 'cookies', 'request and response bodies', 'URL fragments and user information',
  'values of credential-like query parameters', 'object contents of console arguments', 'child-frame and worker targets',
]
export const TEXT_LIMIT = 1024
export const URL_LIMIT = 1024
/** Input longer than this is cut before the redaction passes run. */
const SCAN_LIMIT = 16 * 1024
const MAX_CONSOLE_ARGS = 20

export type ConsoleEntry = { seq: number; at_ms: number; source: 'console' | 'exception' | 'browser'; level: string
  text: string; url: string | null; line: number | null }
export type NetworkOutcome = 'completed' | 'failed' | 'canceled' | 'blocked' | 'incomplete'
export type NetworkEntry = { seq: number; at_ms: number; method: string; url: string; resource_type: string | null
  status: number | null; mime_type: string | null; encoded_bytes: number | null; duration_ms: number | null
  outcome: NetworkOutcome; error: string | null }

const HEADER_LINE = /\b(cookie|set-cookie|authorization|proxy-authorization|x-api-key)\b(\s*:)[^\r\n]*/gi
const LABELED_KV = new RegExp('\\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|' +
  'client[-_]?secret|password|passwd|bearer|session[-_]?id)\\b\\s*[:=]\\s*(?:(?:Bearer|Basic|Token)\\s+\\S+|' +
  '"[^"]*"|\'[^\']*\'|[^\\s,;&]+)', 'gi')
const BARE_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g
const PROVIDER_PATTERNS: Array<[string, RegExp]> = [
  ['anthropic-key', /sk-ant-[a-zA-Z0-9_-]{40,}/g],
  ['openai-key', /sk-(?:proj-)?[a-zA-Z0-9_-]{32,}/g],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{36,}/g],
  ['aws-access-key-id', /AKIA[0-9A-Z]{16}/g],
  ['jwt', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['slack-token', /xox[baprsoe]-[A-Za-z0-9-]{10,}/g],
  ['pem', /-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g],
]
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi
const EMBEDDED_URL = /\bhttps?:\/\/[^\s"'<>`]+/gi
/** Query parameter names whose values are replaced. Over-matching is deliberate. */
const SENSITIVE_PARAM = /token|secret|passw|pwd|auth|session|^sid$|sig|key|code|credential|jwt|cookie|nonce|^state$/i
// Control characters other than tab and newline.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** Cuts to `limit` UTF-16 units without splitting a surrogate pair. */
export function clip(value: string, limit: number): string {
  if (value.length <= limit) return value
  let end = limit - 1
  const code = value.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return `${value.slice(0, end)}…`
}

function redactSecrets(input: string): string {
  let out = input.replace(HEADER_LINE, '$1$2 [redacted]')
  out = out.replace(LABELED_KV, '[redacted:labeled-kv]')
  out = out.replace(BARE_SCHEME, '$1 [redacted]')
  for (const [tag, pattern] of PROVIDER_PATTERNS) out = out.replace(pattern, `[redacted:${tag}]`)
  return out.replace(URL_USERINFO, '$1[redacted]@')
}

/** Redacts one URL: no user information or fragment, credential-like query values replaced. */
export function redactUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  const input = value.slice(0, SCAN_LIMIT).replace(CONTROL, '')
  if (/^data:/i.test(input)) return 'data:[omitted]'
  let url: URL
  try { url = new URL(input) } catch { return clip(redactSecrets(input), URL_LIMIT) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return clip(`${url.protocol}[omitted]`, URL_LIMIT)
  }
  const pairs: string[] = []
  url.searchParams.forEach((item, name) => {
    const kept = SENSITIVE_PARAM.test(name) ? '[redacted]'
      : redactSecrets(item) === item ? encodeURIComponent(item) : '[redacted]'
    pairs.push(`${encodeURIComponent(name)}=${kept}`)
  })
  const path = redactSecrets(url.pathname)
  return clip(`${url.protocol}//${url.host}${path}${pairs.length ? `?${pairs.join('&')}` : ''}`, URL_LIMIT)
}

/** Redacts console or error text, including URLs inside it, and bounds it. */
export function redactText(value: unknown, limit = TEXT_LIMIT): string {
  if (typeof value !== 'string' || !value) return ''
  const input = value.slice(0, SCAN_LIMIT).replace(CONTROL, ' ')
  return clip(redactSecrets(input.replace(EMBEDDED_URL, (url) => redactUrl(url))), limit)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function text(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value ? clip(value.replace(CONTROL, ''), limit) : null
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}
/** CDP line numbers are zero-based; entries report one-based lines. */
function line(value: unknown): number | null {
  const zeroBased = count(value)
  return zeroBased === null ? null : zeroBased + 1
}

/** A console argument, as its primitive value or its type description only. */
function argument(value: unknown): string {
  const arg = record(value)
  if ('value' in arg && (arg.value === null || ['string', 'number', 'boolean'].includes(typeof arg.value))) {
    return String(arg.value)
  }
  if (typeof arg.unserializableValue === 'string') return arg.unserializableValue
  if (typeof arg.description === 'string') return clip(arg.description, 128)
  return typeof arg.type === 'string' ? arg.type : 'undefined'
}

/**
 * Normalizes one CDP console, exception or log event into a redacted entry,
 * or returns null for any other method.
 */
export function consoleEntry(method: string, params: unknown, seq: number, atMs: number): ConsoleEntry | null {
  const p = record(params)
  if (method === 'Runtime.consoleAPICalled') {
    const args = Array.isArray(p.args) ? p.args.slice(0, MAX_CONSOLE_ARGS) : []
    let message = ''
    for (const arg of args) {
      message += (message ? ' ' : '') + argument(arg)
      if (message.length > SCAN_LIMIT) break
    }
    if (Array.isArray(p.args) && p.args.length > MAX_CONSOLE_ARGS) message += ' …'
    const frame = record(Array.isArray(record(p.stackTrace).callFrames) ? (record(p.stackTrace).callFrames as unknown[])[0] : null)
    return { seq, at_ms: atMs, source: 'console', level: text(p.type, 32) ?? 'log', text: redactText(message),
      url: frame.url ? redactUrl(frame.url) || null : null, line: line(frame.lineNumber) }
  }
  if (method === 'Runtime.exceptionThrown') {
    const details = record(p.exceptionDetails)
    const exception = record(details.exception)
    const message = typeof exception.description === 'string' ? exception.description : details.text
    return { seq, at_ms: atMs, source: 'exception', level: 'error', text: redactText(message),
      url: details.url ? redactUrl(details.url) || null : null, line: line(details.lineNumber) }
  }
  if (method === 'Log.entryAdded') {
    const entry = record(p.entry)
    return { seq, at_ms: atMs, source: 'browser', level: text(entry.level, 32) ?? 'info', text: redactText(entry.text),
      url: entry.url ? redactUrl(entry.url) || null : null, line: line(entry.lineNumber) }
  }
  return null
}

type Pending = { atMs: number; started: number | null; method: string; url: string; resourceType: string | null
  status: number | null; mimeType: string | null }
/** Requests seen but not yet ended, bounded to `limit`. */
export type NetworkTracker = { pending: Map<string, Pending>; limit: number }
export type NetworkSummary = Omit<NetworkEntry, 'seq'>

export function networkTracker(limit = 256): NetworkTracker {
  return { pending: new Map(), limit }
}

function summary(item: Pending, outcome: NetworkOutcome, ended: unknown, bytes: number | null,
  error: string | null): NetworkSummary {
  const end = typeof ended === 'number' && Number.isFinite(ended) ? ended : null
  const duration = end !== null && item.started !== null && end >= item.started ? Math.round((end - item.started) * 1000) : null
  return { at_ms: item.atMs, method: item.method, url: item.url, resource_type: item.resourceType, status: item.status,
    mime_type: item.mimeType, encoded_bytes: bytes, duration_ms: duration, outcome, error }
}

/**
 * Applies one CDP Network event and returns the requests it ended. A redirect
 * ends the previous hop; a full in-flight table ends its oldest request as
 * `incomplete`. Headers in the events are never read.
 */
export function networkEvent(tracker: NetworkTracker, method: string, params: unknown, atMs: number): NetworkSummary[] {
  const p = record(params)
  const id = typeof p.requestId === 'string' ? p.requestId : null
  if (!id) return []
  const ended: NetworkSummary[] = []
  if (method === 'Network.requestWillBeSent') {
    const previous = tracker.pending.get(id)
    const redirect = record(p.redirectResponse)
    if (previous) {
      tracker.pending.delete(id)
      if (typeof redirect.status === 'number') previous.status = count(redirect.status)
      ended.push(summary(previous, previous.status === null ? 'incomplete' : 'completed', p.timestamp, null, null))
    }
    while (tracker.pending.size >= tracker.limit) {
      const [oldest, item] = tracker.pending.entries().next().value as [string, Pending]
      tracker.pending.delete(oldest)
      ended.push(summary(item, 'incomplete', null, null, 'in-flight table full'))
    }
    const request = record(p.request)
    tracker.pending.set(id, { atMs, started: typeof p.timestamp === 'number' ? p.timestamp : null,
      method: text(request.method, 16) ?? 'GET', url: redactUrl(request.url), resourceType: text(p.type, 32),
      status: null, mimeType: null })
    return ended
  }
  const item = tracker.pending.get(id)
  if (!item) return ended
  if (method === 'Network.responseReceived') {
    const response = record(p.response)
    item.status = count(response.status)
    item.mimeType = text(response.mimeType, 128)
    if (!item.resourceType) item.resourceType = text(p.type, 32)
    return ended
  }
  if (method === 'Network.loadingFinished') {
    tracker.pending.delete(id)
    ended.push(summary(item, 'completed', p.timestamp, count(p.encodedDataLength), null))
  } else if (method === 'Network.loadingFailed') {
    tracker.pending.delete(id)
    const outcome: NetworkOutcome = p.canceled === true ? 'canceled' : typeof p.blockedReason === 'string' ? 'blocked' : 'failed'
    const reason = typeof p.blockedReason === 'string' ? `${String(p.errorText ?? '')} (${p.blockedReason})` : p.errorText
    ended.push(summary(item, outcome, p.timestamp, null, redactText(reason, 256) || null))
  }
  return ended
}

/** Ends every in-flight request as `incomplete`, as when capture detaches. */
export function flushNetwork(tracker: NetworkTracker, reason: string): NetworkSummary[] {
  const ended = [...tracker.pending.values()].map((item) => summary(item, 'incomplete', null, null, reason))
  tracker.pending.clear()
  return ended
}

/** A bounded, oldest-first buffer. `dropped` counts what it evicted. */
export type Ring<T> = { items: T[]; sizes: number[]; bytes: number; dropped: number; maxItems: number; maxBytes: number }

export function ring<T>(maxItems: number, maxBytes: number): Ring<T> {
  return { items: [], sizes: [], bytes: 0, dropped: 0, maxItems, maxBytes }
}

export function entryBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

export function pushRing<T>(buffer: Ring<T>, item: T): void {
  const size = entryBytes(item)
  buffer.items.push(item)
  buffer.sizes.push(size)
  buffer.bytes += size
  while (buffer.items.length > buffer.maxItems || (buffer.bytes > buffer.maxBytes && buffer.items.length > 1)) {
    buffer.items.shift()
    buffer.bytes -= buffer.sizes.shift() ?? 0
    buffer.dropped += 1
  }
}

export type DiagnosticsPage = { console: ConsoleEntry[]; network: NetworkEntry[]; next: number; more: boolean }

/**
 * One page of entries after `after`, in `seq` order across both kinds, cut at
 * `limit` entries or `byteBudget` serialized bytes, whichever comes first.
 */
export function readPage(consoleItems: readonly ConsoleEntry[], networkItems: readonly NetworkEntry[],
  after: number, limit: number, byteBudget: number): DiagnosticsPage {
  const candidates = [
    ...consoleItems.filter((item) => item.seq > after).map((item) => ({ kind: 'console' as const, item })),
    ...networkItems.filter((item) => item.seq > after).map((item) => ({ kind: 'network' as const, item })),
  ].sort((left, right) => left.item.seq - right.item.seq)
  const page: DiagnosticsPage = { console: [], network: [], next: after, more: false }
  let bytes = 0
  let taken = 0
  for (const candidate of candidates) {
    const size = entryBytes(candidate.item)
    if (taken >= limit || bytes + size > byteBudget) { page.more = true; break }
    if (candidate.kind === 'console') page.console.push(candidate.item as ConsoleEntry)
    else page.network.push(candidate.item as NetworkEntry)
    bytes += size
    taken += 1
    page.next = candidate.item.seq
  }
  return page
}
