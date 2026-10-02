/** A draft writer that hands each edit to main at once, keeping at most one write in flight. */
export type LatestSave = { (text: string): void; cancel: () => void; flush: () => void }

/**
 * Starts a write for an edit immediately when none is in flight, so a renderer crash right
 * after typing still leaves the text with main. Edits made while a write is in flight
 * collapse to the newest, written when it settles; `flush` starts that write now.
 */
export function latestSave(write: (text: string) => Promise<void>): LatestSave {
  let running = false
  let pending: { text: string } | null = null
  const start = (text: string): void => {
    running = true
    void write(text).finally(() => {
      running = false
      const next = pending
      pending = null
      if (next) start(next.text)
    })
  }
  const save = (text: string): void => {
    if (running) pending = { text }
    else start(text)
  }
  save.cancel = (): void => {
    pending = null
  }
  save.flush = (): void => {
    const next = pending
    pending = null
    // The writer serializes writes, so starting this one now still lands after the one in flight.
    if (next) void write(next.text)
  }
  return save
}
