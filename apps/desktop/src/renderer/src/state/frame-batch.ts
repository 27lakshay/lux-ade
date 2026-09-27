/**
 * Delivers only the latest value once per animation frame. For state that replaces itself (client
 * state, a conversation projection), intermediate values between two paints are never shown, so
 * they are dropped instead of rendered.
 */
export function latestPerFrame<T>(deliver: (value: T) => void): (value: T) => void {
  let pending: { value: T } | null = null
  return (value) => {
    const scheduled = pending !== null
    pending = { value }
    if (scheduled) return
    requestAnimationFrame(() => {
      const next = pending
      pending = null
      if (next) deliver(next.value)
    })
  }
}
