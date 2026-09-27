import type { Transition } from 'motion/react'

export interface MotionSettings {
  // The spring is the product choice. The tween stays only so the profiling modes can compare
  // them (?engine=tween).
  engine: 'spring' | 'tween'
  reduced: boolean
}

export const DEFAULT_SETTINGS: MotionSettings = { engine: 'spring', reduced: false }

// Side panels move like a drawer: one solid object, no fade, on a critically damped spring
// (bounce 0). A spring keeps its velocity when a toggle interrupts it mid-motion, so reversals
// turn around smoothly instead of snapping. restDelta and restSpeed end it once it is within a
// pixel and nearly still, which cuts the invisible sub-pixel tail.
const SPRING: Transition = { type: 'spring', stiffness: 900, damping: 60, mass: 1, restDelta: 1, restSpeed: 20 }
// Apple's drawer curve, for comparison.
const TWEEN: Transition = { duration: 0.32, ease: [0.32, 0.72, 0, 1] }

export function panelTransition(s: MotionSettings): Transition {
  if (s.reduced) return { duration: 0 }
  return s.engine === 'spring' ? SPRING : TWEEN
}
