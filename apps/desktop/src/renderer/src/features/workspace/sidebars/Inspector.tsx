import { useState } from 'react'
import { IconButton } from '@/components/IconButton'
import { interactive } from '@/components/interactive'
import { Caption } from '@/components/Typography'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

// The inspector sidebar: changes, files and preview for the focused workspace. The views are
// empty for now; the tab row lines up with the panes' tab strips.

const VIEWS = ['Changes', 'Files', 'Preview'] as const

export function Inspector() {
  const [view, setView] = useState<(typeof VIEWS)[number]>('Changes')
  return (
    <div className="flex min-h-0 flex-1 flex-col px-1.5">
      <div className="flex h-10 shrink-0 items-center gap-0.5">
        <div
          role="tablist"
          aria-label="Inspector"
          className="flex items-center gap-0.5"
          onKeyDown={(event) => {
            // Arrow keys, Home and End move between the views, as in any tab list.
            const index = VIEWS.indexOf(view)
            const next =
              event.key === 'ArrowRight'
                ? index + 1
                : event.key === 'ArrowLeft'
                  ? index - 1
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? VIEWS.length - 1
                      : null
            const name = next === null ? undefined : VIEWS[Math.max(0, Math.min(VIEWS.length - 1, next))]
            if (!name) return
            event.preventDefault()
            setView(name)
            event.currentTarget.querySelector<HTMLElement>(`[data-view="${name}"]`)?.focus()
          }}
        >
          {VIEWS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              data-view={name}
              tabIndex={view === name ? 0 : -1}
              aria-selected={view === name}
              data-selected={view === name || undefined}
              onClick={() => setView(name)}
              className={cn(
                interactive,
                'flex h-7 items-center rounded-sm px-2 text-muted-foreground data-[selected]:text-foreground',
              )}
            >
              <Caption tone="inherit" weight={view === name ? 'medium' : 'regular'} steadyWidth="medium">
                {name}
              </Caption>
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <IconButton icon="more" label="More" />
      </div>
      <ScrollArea role="tabpanel" aria-label={view} className="min-h-0 flex-1" />
    </div>
  )
}
