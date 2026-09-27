// Parses a snooze wake time for `conversation snooze`. Pure; the daemon
// still checks that the time is in the future and at most 366 days ahead.

const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/**
 * Accepts `+N` with a unit of m, h or d; an ISO 8601 time with an explicit
 * zone; or epoch milliseconds. A zoneless time is refused, because the
 * daemon and the caller may not share a time zone. Returns undefined for
 * anything else.
 */
export function parseWakeTime(text: string, now: number): number | undefined {
  const relative = /^\+([1-9][0-9]{0,5})([mhd])$/.exec(text)
  if (relative) return now + Number(relative[1]) * unitMs[relative[2] as keyof typeof unitMs]
  if (/^[1-9][0-9]{0,15}$/.test(text)) return Number(text)
  if (/^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    const parsed = Date.parse(text)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}
