import { Shortcut } from '@/components/Shortcut'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Icon } from '@/icons/Icon'
import { openTab } from '../model/layout-store'
import { newTerminal } from '../terminals/terminal-tabs'
import { TAB_ICON } from './Tab'

// The tab strip's "+": what a new tab in this pane can be. ⌘T still opens a conversation directly.
export function NewTabMenu({ paneId }: { paneId: string }) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="New tab" />} />}
        >
          <Icon name="new" />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          New tab
          <Shortcut appCommand="new-tab" />
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem onClick={() => openTab({ kind: 'conversation', title: 'New conversation' }, paneId)}>
          <Icon name={TAB_ICON.conversation} />
          New conversation
          <DropdownMenuShortcut>
            <Shortcut appCommand="new-conversation" />
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void newTerminal(paneId)}>
          <Icon name={TAB_ICON.terminal} />
          New terminal
          <DropdownMenuShortcut>
            <Shortcut appCommand="new-terminal" />
          </DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
