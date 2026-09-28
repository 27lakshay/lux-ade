import { useMatchRoute, useNavigate } from '@tanstack/react-router'
import { interactive } from '@/components/interactive'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Icon } from '@/icons/Icon'
import type { IconName } from '@/icons/icons'

// The fixed column of sections on the left edge. It runs from under the title bar into the bottom
// bar and never moves. Its first item lines up with the cards' top rows, its last with their
// footers.

function RailItem({
  icon,
  label,
  selected,
  needsYou,
  onClick,
}: {
  icon: IconName
  label: string
  selected?: boolean
  needsYou?: boolean
  onClick?: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-current={selected ? 'page' : undefined}
            data-selected={selected || undefined}
            onClick={onClick}
            className={cn(
              interactive,
              'relative flex size-10 items-center justify-center rounded-md text-muted-foreground data-[selected]:text-foreground',
            )}
          />
        }
      >
        <Icon name={icon} size="lg" />
        {needsYou && <span aria-hidden className="absolute end-2 top-2 size-2 rounded-full bg-attention" />}
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

export function Rail() {
  const navigate = useNavigate()
  const onWorkspace = Boolean(useMatchRoute()({ to: '/' }))
  return (
    <nav aria-label="Sections" className="flex w-14 shrink-0 flex-col items-center gap-1.5 bg-sidebar pt-2 pb-6">
      <RailItem icon="workspace" label="Workspace" selected={onWorkspace} onClick={() => void navigate({ to: '/' })} />
      <RailItem icon="projects" label="Projects" />
      <RailItem icon="activity" label="Activity" />
      <div className="flex-1" />
      <RailItem icon="settings" label="Settings" onClick={() => void navigate({ to: '/settings' })} />
    </nav>
  )
}
