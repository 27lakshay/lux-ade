import { useSyncExternalStore } from 'react'

// Reduce motion: follow the system, always on, or always off. Stored like the theme preference.
// The effective value is written to <html data-reduced-motion> so CSS transitions and the kit's CSS
// animations obey it too; Motion reads it through MotionConfig.

export type MotionPreference = 'system' | 'on' | 'off'

const KEY = 'ade.reduced-motion'
const listeners = new Set<() => void>()
const systemReduce = (): MediaQueryList => window.matchMedia('(prefers-reduced-motion: reduce)')

const isPreference = (value: unknown): value is MotionPreference =>
  value === 'system' || value === 'on' || value === 'off'

function motionPreference(): MotionPreference {
  try {
    const saved = localStorage.getItem(KEY)
    return isPreference(saved) ? saved : 'system'
  } catch {
    return 'system'
  }
}

export const reducesMotion = (preference: MotionPreference, systemReduces: boolean): boolean =>
  preference === 'on' || (preference === 'system' && systemReduces)

function apply(): void {
  const reduce = reducesMotion(motionPreference(), systemReduce().matches)
  document.documentElement.toggleAttribute('data-reduced-motion', reduce)
  for (const listener of listeners) listener()
}

export function setMotionPreference(preference: MotionPreference): void {
  try {
    localStorage.setItem(KEY, preference)
  } catch {
    // Storage unavailable: the preference still applies until the window reloads.
  }
  apply()
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
