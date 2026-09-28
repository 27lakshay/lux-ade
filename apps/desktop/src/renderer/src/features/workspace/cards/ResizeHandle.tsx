import * as Panels from 'react-resizable-panels'
import { cn } from '@/lib/utils'

// The 8px gutter between two cards, and the handle that resizes them. Invisible at rest; after a
// short hover a track and grip appear (so crossing a gutter does not flash it); while dragging the
// track brightens. Arrow keys resize a focused handle, Enter collapses. Double-click does what
// `onDoubleClick` says: even out a split, or reset a sidebar's width.
export function ResizeHandle({
  orientation,
  hidden,
  onDoubleClick,
}: {
  orientation: 'horizontal' | 'vertical'
  hidden?: boolean
  onDoubleClick: () => void
}) {
  const across = orientation === 'horizontal'
  const gutter = cn(
    'group flex shrink-0 items-center justify-center',
    across ? 'w-2 flex-col' : 'h-2',
    hidden && (across ? 'w-0' : 'h-0'),
  )
  return (
    <Panels.Separator disabled={hidden} disableDoubleClick onDoubleClick={onDoubleClick} className={gutter}>
      <span
        className={cn(
          'flex items-center justify-center rounded-full transition-colors duration-100 group-data-[separator=hover]:bg-input group-data-[separator=hover]:delay-150 group-data-[separator=active]:bg-ring group-data-[separator=focus]:bg-ring',
          across ? 'h-full w-0.5' : 'h-0.5 w-full',
        )}
      >
        <span
          className={cn(
            'rounded-full transition-colors duration-100 group-data-[separator=hover]:bg-muted-foreground group-data-[separator=hover]:delay-150 group-data-[separator=active]:bg-foreground group-data-[separator=focus]:bg-foreground',
            across ? 'h-9 w-1' : 'h-1 w-9',
          )}
        />
      </span>
    </Panels.Separator>
  )
}
