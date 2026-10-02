/**
 * Delivers only the latest value once per animation frame. For state that replaces itself (client
 * state, a conversation projection), intermediate values between two paints are never shown, so
 * they are dropped instead of rendered.
 */
export function latestPerFrame<T>(deliver: (value: T) => void): { push: (value: T) => void; stop: () => void } {
  let pending: { value: T } | null = null
  let frame: number | null = null
  let stopped = false
  return {
    push(value) {
      if (stopped) return
      pending = { value }
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        const next = pending
        pending = null
        if (next && !stopped) deliver(next.value)
      })
    },
    stop() {
      stopped = true
      pending = null
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
    },
  }
}
