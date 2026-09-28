import { domMax, LazyMotion, MotionConfig } from 'motion/react'
import type { ReactNode } from 'react'
import { transitions } from './motion'
import { useMotionPreference } from './motion-preference'

// Motion for the whole window. Components render `m` elements (motion/react-m) with the features
// loaded here once: domMax, for layout animations. A full `motion` component would bundle every
// feature again; lint refuses it (no-restricted-imports). LazyMotion's own `strict` check is inert
// here: Motion only runs it where a global `process` exists, which a sandboxed renderer lacks.
// Reduced motion turns off transform and layout animations and keeps fades.
const REDUCED = { system: 'user', on: 'always', off: 'never' } as const

export function MotionProvider({ children }: { children: ReactNode }) {
  const preference = useMotionPreference()
  return (
    <LazyMotion features={domMax}>
      <MotionConfig reducedMotion={REDUCED[preference]} transition={transitions.fade}>
        {children}
      </MotionConfig>
    </LazyMotion>
  )
}
