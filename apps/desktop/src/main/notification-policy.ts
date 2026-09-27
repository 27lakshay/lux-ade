// Decides whether one durable activity becomes a desktop notification. Pure:
// Electron main supplies focus, time and what this process already handled.
// The daemon's delivery claim is the durable dedupe; this set only avoids
// asking twice from one process.

export type ActivityKind = 'turn_completed' | 'turn_failed' | 'turn_interrupted' |
  'approval_requested' | 'question_requested' | 'operation_unknown'

export type NotifiableActivity = {
  id: string
  kind: ActivityKind
  state: 'unread' | 'read' | 'dismissed'
  title: string
  detail: string | null
  created_at: number
}

export type NotificationDecision =
  | { action: 'skip' }
  | { action: 'suppress'; reason: string }
  | { action: 'present'; title: string; body: string }

/** Activity older than this is left in the feed without a banner. */
export const NOTIFY_MAX_AGE_MS = 10 * 60 * 1000
/** How many handled activity IDs one process remembers. */
export const HANDLED_LIMIT = 500

const headline: Record<ActivityKind, string> = {
  turn_completed: 'Turn completed',
  turn_failed: 'Turn failed',
  turn_interrupted: 'Turn interrupted',
  approval_requested: 'Approval needed',
  question_requested: 'Question waiting',
  operation_unknown: 'Outcome unknown; check the conversation',
}

export function decideNotification(activity: NotifiableActivity,
  context: { focused: boolean; now: number; handled: ReadonlySet<string> }): NotificationDecision {
  if (context.handled.has(activity.id) || activity.state !== 'unread') return { action: 'skip' }
  if (!Object.hasOwn(headline, activity.kind)) return { action: 'skip' }
  if (context.now - activity.created_at > NOTIFY_MAX_AGE_MS) return { action: 'skip' }
  if (context.focused) return { action: 'suppress', reason: 'window_focused' }
  const title = activity.title.trim() || 'ADE'
  const detail = activity.kind === 'turn_failed' || activity.kind === 'operation_unknown' ? activity.detail : null
  const body = detail ? `${headline[activity.kind]}: ${detail.slice(0, 200)}` : headline[activity.kind]
  return { action: 'present', title, body }
}

/** Records an ID, evicting the oldest when the set is full. */
export function rememberHandled(handled: Set<string>, id: string, limit = HANDLED_LIMIT): void {
  handled.delete(id)
  handled.add(id)
  while (handled.size > limit) {
    const oldest = handled.values().next().value
    if (oldest === undefined) break
    handled.delete(oldest)
  }
}
