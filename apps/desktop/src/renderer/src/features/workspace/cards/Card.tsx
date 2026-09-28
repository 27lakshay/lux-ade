import * as m from 'motion/react-m'
import { createContext, useContext, type ReactNode, type Ref } from 'react'
import { cn } from '@/lib/utils'
import { transitions } from '../../../app/motion'

// A floating card: the sidebars and every pane. Two layers, so layout changes can animate without
// stretching content: the plain background may scale to its new size, while the content takes its
// final size at once and only moves (layout="position"). Both animate only when the layout's
// structure changes (the key), never while resizing.

/** The layout's structure: sidebar order, collapsed sidebars, pane tree. Never sizes. */
export const LayoutKeyContext = createContext('')

/** --radius-xl in the theme (the kit's 0.625rem × 1.4). Motion corrects a numeric radius while scaling. */
const CARD_RADIUS = 14

export function Card({
  surface,
  label,
  grip,
  children,
  className,
  ref,
}: {
  ref?: Ref<HTMLElement>
  surface: 'panel' | 'pane'
  label: string
  /** The drag handle on the bottom edge. */
  grip: ReactNode
  children: ReactNode
  className?: string
}) {
  const layoutKey = useContext(LayoutKeyContext)
  return (
    <section ref={ref} aria-label={label} className={cn('relative flex h-full min-w-0 flex-col', className)}>
      <m.div
        aria-hidden
        layout
        layoutDependency={layoutKey}
        transition={transitions.layout}
        style={{ borderRadius: CARD_RADIUS }}
        className={cn('absolute inset-0', surface === 'panel' ? 'bg-panel' : 'bg-background')}
      />
      <m.div
        layout="position"
        layoutDependency={layoutKey}
        transition={transitions.layout}
        className="relative flex min-h-0 flex-1 flex-col"
      >
        {children}
        {grip}
      </m.div>
    </section>
  )
}
