import type { Transition } from 'motion/react'

// Every animation's timing, by intent. Components pick a preset (transitions.layout), never a
// number. The CSS side of the same values is in shadcn.css (--duration-*, --ease-standard); a test
// keeps the two equal.

/** Seconds. fast: hover and press; base: fades and popovers; slow: larger surfaces. */
export const DURATION = { fast: 0.1, base: 0.2, slow: 0.3 } as const

/** A decelerating curve with no overshoot, for a serious tool. */
export const EASE_STANDARD = [0.2, 0, 0, 1] as const

/** Milliseconds a dragged tab hovers over another tab before that tab opens. */
export const SPRING_LOAD_MS = 600

export const transitions = {
  press: { duration: DURATION.fast, ease: EASE_STANDARD },
  fade: { duration: DURATION.base, ease: EASE_STANDARD },
  surface: { duration: DURATION.slow, ease: EASE_STANDARD },
  /** Cards, panes and tabs moving into place: a spring with no bounce, so it can be interrupted. */
  layout: { type: 'spring', bounce: 0, visualDuration: 0.25 },
  /** A tab's fill while a drag hovers it: steady, so it reads as a countdown to opening. */
  springLoad: { duration: SPRING_LOAD_MS / 1000, ease: 'linear' },
  /** A drop's outline settling onto the pane it made, then fading. */
  settle: { duration: DURATION.slow, ease: EASE_STANDARD },
} as const satisfies Record<string, Transition>
