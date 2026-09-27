// Browser diagnostics capture (F096): console and network summaries for one
// exact tab through the Electron debugger. Capture is bound to the tab's page
// (its WebContents), never to whichever tab is selected or focused. The pure
// redaction, bounding and paging rules live in browser-diagnostics-core.ts.
import type { WebContents } from 'electron'
import { browserTabPage } from './browser'
import { clip, consoleEntry, DIAGNOSTICS_EXCLUDED, flushNetwork, networkEvent, networkTracker, pushRing, readPage,
  REDACTION_POLICY, ring, type ConsoleEntry, type NetworkEntry, type NetworkSummary, type NetworkTracker,
  type Ring } from './browser-diagnostics-core'

/** Tabs with retained capture per owner process; the oldest idle one is evicted first. */
const MAX_COLLECTORS = 16
const RING_ITEMS = 1000
const RING_BYTES = 512 * 1024
/** A read page stays well under the daemon's 1 MiB owner reply bound. */
const PAGE_BYTES = 768 * 1024

export type Collector = {
  key: string; tabId: string; contents: WebContents; attached: boolean; reason: string | null
  attachedAtMs: number | null; holders: Set<string>; detachments: number
  console: Ring<ConsoleEntry>; network: Ring<NetworkEntry>; tracker: NetworkTracker
  onMessage: (event: unknown, method: string, params: unknown, sessionId?: string) => void
  onDetach: (event: unknown, reason: string) => void
  onDestroyed: () => void
}
const collectors = new Map<string, Collector>()
let sequence = 0

const keyOf = (profileId: string, tabId: string): string => `${profileId}\u0000${tabId}`

function pushNetwork(collector: Collector, ended: NetworkSummary[]): void {
  for (const summary of ended) pushRing(collector.network, { seq: ++sequence, ...summary })
}

function endCapture(collector: Collector, reason: string): void {
  const debug = collector.contents.isDestroyed() ? null : collector.contents.debugger
  debug?.removeListener('message', collector.onMessage)
  debug?.removeListener('detach', collector.onDetach)
  if (collector.attached) collector.detachments += 1
  collector.attached = false
  collector.reason = clip(reason, 64)
  pushNetwork(collector, flushNetwork(collector.tracker, `capture ended: ${collector.reason}`))
}

function collectorFor(key: string, tabId: string, contents: WebContents): Collector {
  const collector: Collector = {
    key, tabId, contents, attached: false, reason: 'not_attached', attachedAtMs: null, holders: new Set(), detachments: 0,
    console: ring(RING_ITEMS, RING_BYTES), network: ring(RING_ITEMS, RING_BYTES), tracker: networkTracker(),
    onMessage: (_event, method, params, sessionId) => {
      // Child targets carry a session ID; capture covers the tab's own page only.
      if (sessionId) return
      const at = Date.now()
      const entry = consoleEntry(method, params, 0, at)
      if (entry) { entry.seq = ++sequence; pushRing(collector.console, entry); return }
      if (method.startsWith('Network.')) pushNetwork(collector, networkEvent(collector.tracker, method, params, at))
    },
    onDetach: (_event, reason) => endCapture(collector, reason || 'detached'),
    // The caller's hold ends with the page; recordings release theirs as they stop.
    onDestroyed: () => {
      collector.holders.delete('caller')
      if (collector.attached) endCapture(collector, 'target_closed')
    },
  }
  contents.once('destroyed', collector.onDestroyed)
  return collector
}

function retire(collector: Collector, reason: string): void {
  if (collector.attached) {
    endCapture(collector, reason)
    try { collector.contents.debugger.detach() } catch { /* The page may already be gone. */ }
  }
  if (!collector.contents.isDestroyed()) collector.contents.removeListener('destroyed', collector.onDestroyed)
  collectors.delete(collector.key)
}

async function startCapture(collector: Collector): Promise<void> {
  const debug = collector.contents.debugger
  if (debug.isAttached()) throw new Error('conflict: another debugger client holds this tab; close it and retry')
  try { debug.attach('1.3') } catch (error) {
    throw new Error(`conflict: the debugger could not attach, as when DevTools holds the tab: ${String(error)}`)
  }
  debug.on('message', collector.onMessage)
  debug.on('detach', collector.onDetach)
  collector.attached = true
  collector.reason = null
  collector.attachedAtMs = Date.now()
  try {
    await debug.sendCommand('Runtime.enable')
    await debug.sendCommand('Log.enable')
    await debug.sendCommand('Network.enable')
  } catch (error) {
    endCapture(collector, 'enable_failed')
    try { debug.detach() } catch { /* Already detached. */ }
    throw new Error(`unavailable: diagnostics could not start on this tab: ${String(error)}`)
  }
}

/**
 * Starts capture on one exact tab for `holder` (`caller`, or a recording).
 * Attaching an attached tab only adds the holder. The collector's buffer
 * survives a detach and is dropped when the tab's page is replaced.
 */
export async function attachDiagnostics(profileId: string, tabId: unknown, holder: string): Promise<Collector> {
  const page = await browserTabPage(profileId, tabId)
  if (!page.contents) throw new Error('unavailable: the browser tab has no live page; show or navigate it first')
  const key = keyOf(profileId, page.tabId)
  let collector = collectors.get(key)
  if (collector && collector.contents !== page.contents) {
    if (collector.holders.size) throw new Error('conflict: the tab page was replaced while capture was held')
    retire(collector, 'target_replaced')
    collector = undefined
  }
  if (!collector) {
    if (collectors.size >= MAX_COLLECTORS) {
      const idle = [...collectors.values()].find((item) => !item.holders.size)
      if (!idle) throw new Error(`unavailable: ${MAX_COLLECTORS} tabs are already captured; detach one first`)
      retire(idle, 'evicted')
    }
    collector = collectorFor(key, page.tabId, page.contents)
    collectors.set(key, collector)
  }
  if (!collector.attached) await startCapture(collector)
  collector.holders.add(holder)
  return collector
}

/** Releases `holder`; capture stops when nobody holds it. Entries stay readable. */
export function releaseDiagnostics(collector: Collector, holder: string): void {
  collector.holders.delete(holder)
  if (collector.holders.size || !collector.attached) return
  endCapture(collector, 'requested')
  try { collector.contents.debugger.detach() } catch { /* Already detached. */ }
}

function attachment(collector: Collector | undefined): Record<string, unknown> {
  if (!collector) return { state: 'detached', reason: 'not_attached', attached_at_ms: null, holders: [] }
  return { state: collector.attached ? 'attached' : 'detached', reason: collector.attached ? null : collector.reason,
    attached_at_ms: collector.attachedAtMs, holders: [...collector.holders].sort() }
}

/** The tab's collector, after checking the exact tab still exists under the live owner. */
async function existingCollector(profileId: string, tabId: unknown): Promise<{ tabId: string; collector?: Collector }> {
  const page = await browserTabPage(profileId, tabId)
  const collector = collectors.get(keyOf(profileId, page.tabId))
  return { tabId: page.tabId, collector }
}

export async function diagnosticsAttach(profileId: string, tabId: unknown): Promise<Record<string, unknown>> {
  const collector = await attachDiagnostics(profileId, tabId, 'caller')
  return { type: 'browser_diagnostics_state', tab_id: collector.tabId, attachment: attachment(collector) }
}

export async function diagnosticsDetach(profileId: string, tabId: unknown): Promise<Record<string, unknown>> {
  const { tabId: id, collector } = await existingCollector(profileId, tabId)
  if (collector) releaseDiagnostics(collector, 'caller')
  return { type: 'browser_diagnostics_state', tab_id: id, attachment: attachment(collector) }
}

export async function diagnosticsRead(profileId: string, tabId: unknown, after: unknown,
  limit: unknown): Promise<Record<string, unknown>> {
  if (after !== undefined && (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0)) {
    throw new Error('invalid_request: after must be a non-negative integer')
  }
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)) {
    throw new Error('invalid_request: limit must be between 1 and 200')
  }
  const { tabId: id, collector } = await existingCollector(profileId, tabId)
  const page = readPage(collector?.console.items ?? [], collector?.network.items ?? [], (after as number | undefined) ?? 0,
    (limit as number | undefined) ?? 100, PAGE_BYTES)
  return { type: 'browser_diagnostics', tab_id: id, attachment: attachment(collector), ...page,
    in_flight: collector?.tracker.pending.size ?? 0,
    dropped: { console: collector?.console.dropped ?? 0, network: collector?.network.dropped ?? 0 },
    redaction: REDACTION_POLICY, excluded: DIAGNOSTICS_EXCLUDED }
}
