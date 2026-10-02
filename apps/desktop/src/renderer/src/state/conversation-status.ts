/** Conversation statuses with a submission in flight: Stop can target it, and Send must wait. */
export const IN_FLIGHT: ReadonlySet<string> = new Set([
  'starting',
  'running',
  'waiting',
  'responding',
  'streaming',
  'cancelling',
])
