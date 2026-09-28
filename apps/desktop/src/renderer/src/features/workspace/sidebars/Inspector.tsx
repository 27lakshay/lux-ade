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
        <div role="tablist" aria-label="Inspector" className="flex items-center gap-0.5">
          {VIEWS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={view === name}
              data-selected={view === name || undefined}
              onClick={() => setView(name)}
              className={cn(
                interactive,
                'flex h-7 items-center rounded-sm px-2 text-muted-foreground data-[selected]:text-foreground',
              )}
            >
              <Caption tone="inherit" weight={view === name ? 'medium' : 'regular'}>
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
