// Native desktop notifications for durable activity (F114). The daemon's
// delivery claim is the dedupe: this process presents an activity only after
// the daemon grants it the claim, and reports only what the OS said. A claim
// whose outcome was never reported stays unknown and is never shown again.
import { randomUUID } from 'node:crypto'
import { BrowserWindow, Notification } from 'electron'
import { decodeDailyUseFeedFrame, type AdeClient, type ConnectionStatus, type DailyUseResponse } from '@ade/client'
import { decideNotification, rememberHandled, type NotifiableActivity } from './notification-policy'

type Activity = DailyUseResponse<'activity.list'>['activities'][number]

const clientId = `desktop_${randomUUID()}`
const handled = new Set<string>()
// Electron drops a notification's click handler once the object is collected.
const live = new Map<string, Notification>()

const focused = (): boolean => BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused())

function report(client: AdeClient, activityId: string, outcome: 'shown' | 'failed' | 'suppressed', reason?: string): void {
  void client.command({ op: 'notification.delivery.report', activity_id: activityId, channel: 'desktop',
    client_id: clientId, outcome, ...(reason ? { reason: reason.replace(/\s+/g, ' ').slice(0, 500) } : {}) })
    .catch((error: unknown) => console.error('Notification delivery report failed', error))
}

function openTarget(client: AdeClient, activity: Activity): void {
  const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
  if (window) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
  void client.command({ op: 'activity.mark', activity_ids: [activity.id], mark: 'read' })
    .catch((error: unknown) => console.error('Activity mark failed', error))
}

async function consider(client: AdeClient, activity: Activity): Promise<void> {
  const decision = decideNotification(activity as NotifiableActivity, { focused: focused(), now: Date.now(), handled })
  if (decision.action === 'skip') return
  rememberHandled(handled, activity.id)
  let claim
  try {
    claim = await client.command({ op: 'notification.delivery.claim', activity_id: activity.id,
      channel: 'desktop', client_id: clientId })
  } catch (error) {
    // Nothing was shown, and this client's own claim may be retried safely.
    handled.delete(activity.id)
    throw error
  }
  if (!claim.granted) return
  if (decision.action === 'suppress') return report(client, activity.id, 'suppressed', decision.reason)
  // Hidden E2E windows must not raise banners over the user's desktop.
  if (process.env.ADE_E2E_HIDE_WINDOW === '1') return report(client, activity.id, 'suppressed', 'e2e_hidden_window')
  if (!Notification.isSupported()) return report(client, activity.id, 'failed', 'notifications_unsupported')
  const notification = new Notification({ id: activity.id, title: decision.title, body: decision.body })
  live.set(activity.id, notification)
  if (live.size > 50) live.delete(live.keys().next().value as string)
  let settled = false
  notification.once('show', () => {
    if (!settled) { settled = true; report(client, activity.id, 'shown') }
  })
  notification.once('failed', (_event, error) => {
    if (!settled) { settled = true; report(client, activity.id, 'failed', String(error) || 'os_failed') }
  })
  notification.on('click', () => openTarget(client, activity))
  notification.on('close', () => { live.delete(activity.id) })
  notification.show()
}

function handle(client: AdeClient, activity: Activity): void {
  void consider(client, activity).catch((error: unknown) => console.error('Desktop notification failed', error))
}

/** Watches one profile client's activity; returns the unsubscribe function. */
export function watchActivity(client: AdeClient): () => void {
  let status: ConnectionStatus | null = null
  const stopState = client.subscribe((state) => {
    const reconnected = state.status === 'connected' && status !== 'connected'
    status = state.status
    if (!reconnected) return
    // Activity recorded while disconnected: the daemon claim prevents repeats.
    void client.command<'activity.list'>({ op: 'activity.list', unread_only: true, limit: 50 })
      .then((page) => { for (const activity of [...page.activities].reverse()) handle(client, activity) })
      .catch((error: unknown) => console.error('Activity catch-up failed', error))
  })
  const stopFeed = client.subscribeFeed((frame) => {
    if (frame.type !== 'activity_changed') return
    let decoded
    try { decoded = decodeDailyUseFeedFrame(frame) } catch (error) {
      console.error('Activity frame failed its contract', error)
      return
    }
    if (decoded.type === 'activity_changed') handle(client, decoded.activity)
  })
  return () => { stopState(); stopFeed() }
}
