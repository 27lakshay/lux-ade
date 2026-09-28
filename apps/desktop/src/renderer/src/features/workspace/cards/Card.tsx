import type { ReactNode, Ref } from 'react'
import { cn } from '@/lib/utils'

// A floating card: the sidebars and every pane. Its size changes (collapse, split, resize) reflow
// it for real, frame by frame, so content never slides or stretches; see CardArea for how those
// changes are animated.
export function Card({
  surface,
  label,
  grip,
  children,
  className,
  paneId,
  ref,
}: {
  /** Set on panes, so a drop can find where the pane it made landed. */
  paneId?: string
  ref?: Ref<HTMLElement>
  surface: 'panel' | 'pane'
  label: string
  /** The drag handle on the bottom edge. */
  grip: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      ref={ref}
      aria-label={label}
      data-pane-id={paneId}
      className={cn(
        'flex h-full min-w-0 flex-col overflow-hidden rounded-xl',
        surface === 'panel' ? 'bg-panel' : 'bg-background',
        className,
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      {grip}
    </section>
  )
}
