import { cn } from '@/lib/utils'

// The one status mark: a dot whose colour means the same thing everywhere (tabs, rows, the rail,
// the bottom bar, tool calls). Amber is "needs you" and nothing else.

const STATES = {
  idle: { name: 'Idle', dot: 'bg-transparent ring-1 ring-inset ring-muted-foreground' },
  running: { name: 'Running', dot: 'bg-running' },
  needsYou: { name: 'Needs you', dot: 'bg-attention' },
  error: { name: 'Error', dot: 'bg-destructive' },
  done: { name: 'Done', dot: 'bg-success' },
} as const

export type StatusState = keyof typeof STATES

/** `label` replaces the spoken name when the row does not already say it, such as "3 need you". */
export function Status({ state, label }: { state: StatusState; label?: string }) {
  return (
    <span
      role="img"
      aria-label={label ?? STATES[state].name}
      className="flex size-4 shrink-0 items-center justify-center"
    >
      <span className={cn('size-2 rounded-full', STATES[state].dot)} />
    </span>
  )
}
