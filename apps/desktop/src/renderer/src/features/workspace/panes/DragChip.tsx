import { Caption } from '@/components/Typography'
import { Icon } from '@/icons/Icon'
import type { IconName } from '@/icons/icons'

// The small picture that follows the pointer while dragging a tab, pane or sidebar.
export function DragChip({ icon, label }: { icon: IconName; label: string }) {
  return (
    <div className="flex h-7 max-w-60 items-center gap-2 rounded-md bg-popover px-2 text-foreground shadow-md">
      <Icon name={icon} size="sm" />
      <Caption weight="medium" truncate>
        {label}
      </Caption>
    </div>
  )
}
