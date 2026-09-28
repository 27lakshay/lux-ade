import { IconButton } from '@/components/IconButton'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Icon } from '@/icons/Icon'
import type { IconName } from '@/icons/icons'
import { dispatch, useLayout } from '../model/layout-store'
import { closePane } from '../terminals/terminal-tabs'
import { trySplit } from './room'

// A pane's actions beside its tabs. In a narrow pane (under 320px) they fold into a "More" menu so
// the tabs keep their room.

interface Action {
  icon: IconName
  label: string
  run: () => void
  shortcut?: { appCommand: 'split-right' } | { keys: string }
}

export function PaneToolbar({ paneId }: { paneId: string }) {
  const single = useLayout((layout) => layout.root.type === 'pane')
  const maximized = useLayout((layout) => layout.maximized === paneId)
  const actions: Action[] = [
    {
      icon: 'splitRight',
      label: 'Split right',
      run: () => trySplit(paneId, 'row'),
      shortcut: { appCommand: 'split-right' },
    },
    { icon: 'splitDown', label: 'Split down', run: () => trySplit(paneId, 'column') },
    ...(single
      ? []
      : [
          {
            icon: maximized ? 'restore' : 'maximize',
            label: maximized ? 'Restore pane' : 'Maximize pane',
            run: () => dispatch({ type: 'toggleMaximize', paneId }),
          } satisfies Action,
        ]),
    { icon: 'close', label: 'Close pane', run: () => void closePane(paneId) },
  ]
  return (
    <>
      <div className="flex items-center gap-0.5 @max-xs:hidden">
        {actions.map((action) => (
          <IconButton
            key={action.label}
            icon={action.icon}
            label={action.label}
            shortcut={action.shortcut}
            onClick={action.run}
          />
        ))}
      </div>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" aria-label="More pane actions" className="@xs:hidden" />}
              />
            }
          >
            <Icon name="more" />
          </TooltipTrigger>
          <TooltipContent side="bottom">More pane actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-44">
          {actions.map((action) => (
            <DropdownMenuItem key={action.label} onClick={action.run}>
              <Icon name={action.icon} />
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
