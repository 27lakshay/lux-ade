import { useSyncExternalStore } from 'react'

// Reduce motion: follow the system, always on, or always off. The profile's setting lives in the
// daemon (`reduced_motion`); until it arrives the window follows the system.
// The effective value is written to <html data-reduced-motion> so CSS transitions and the kit's CSS
// animations obey it too; Motion reads it through MotionConfig.

export type MotionPreference = 'system' | 'on' | 'off'

const listeners = new Set<() => void>()
const systemReduce = (): MediaQueryList => window.matchMedia('(prefers-reduced-motion: reduce)')

/** The preference shown now; `system` until the daemon's setting arrives. */
let current: MotionPreference = 'system'
const motionPreference = (): MotionPreference => current

export const reducesMotion = (preference: MotionPreference, systemReduces: boolean): boolean =>
  preference === 'on' || (preference === 'system' && systemReduces)

function apply(): void {
  const reduce = reducesMotion(motionPreference(), systemReduce().matches)
  document.documentElement.toggleAttribute('data-reduced-motion', reduce)
  for (const listener of listeners) listener()
}

/** Shows a preference. */
export function applyMotionPreference(preference: MotionPreference): void {
  current = preference
  apply()
}

/** Changes the profile's reduce-motion setting, showing it at once. */
export function setMotionPreference(preference: MotionPreference): void {
  applyMotionPreference(preference)
  void window.adeHost?.settings.set({ reduced_motion: preference }).catch(() => {})
}

/** Applies the saved preference and follows the system setting. Call once at startup. */
export function startMotionPreference(): void {
  apply()
  systemReduce().addEventListener('change', apply)
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The saved preference, re-rendering when it changes. */
export const useMotionPreference = (): MotionPreference => useSyncExternalStore(subscribe, motionPreference)
