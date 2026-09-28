import { Caption } from '@/components/Typography'
import { useSizeLabels } from '../content/size-label'

// The active tab's own size, centred on the pane while it is resized (a terminal's columns × rows).
export function SizeReadout({ tabId }: { tabId: string | null }) {
  const label = useSizeLabels((state) => (state.resizing && tabId ? state.labels[tabId] : undefined))
  if (!label) return null
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div data-size-readout className="rounded-md bg-popover px-2 py-1 shadow-md">
        <Caption numeric weight="medium">
          {label}
        </Caption>
      </div>
    </div>
  )
}
