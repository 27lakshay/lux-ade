import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { interactive } from './interactive'
import { Text } from './Typography'

// A list or tree row: 28px, the default control height. Everything in a sidebar, tree, list or
// menu that is one line and can be clicked is a Row, so rows line up and behave the same.

/** Indent per tree level, on the 4px grid. */
const INDENT = 16

type RowProps = Omit<ComponentProps<'button'>, 'children'> & {
  children: ReactNode
  selected?: boolean
  /** Tree depth; each level indents 16px. */
  depth?: number
  /** An icon or status before the title. */
  leading?: ReactNode
  /** Metadata or actions after the title. */
  trailing?: ReactNode
  /**
   * Corner radius: `sm` (6px) in sidebars and panes, `lg` (10px) inside a popover, whose 14px
   * corner and 4px inset make the rows concentric.
   */
  radius?: 'sm' | 'lg'
}

export function Row({
  children,
  selected,
  depth = 0,
  leading,
  trailing,
  radius = 'sm',
  className,
  style,
  ...props
}: RowProps) {
  return (
    <button
      type="button"
      data-selected={selected || undefined}
      {...props}
      style={{ paddingInlineStart: 8 + depth * INDENT, ...style }}
      className={cn(
        interactive,
        'flex h-7 w-full min-w-0 items-center gap-2 pe-2 text-start',
        radius === 'lg' ? 'rounded-lg' : 'rounded-sm',
        className,
      )}
    >
      {leading}
      {typeof children === 'string' ? (
        <Text truncate tone="inherit" className="min-w-0 flex-1">
          {children}
        </Text>
      ) : (
        <span className="flex min-w-0 flex-1 items-center">{children}</span>
      )}
      {trailing}
    </button>
  )
}
