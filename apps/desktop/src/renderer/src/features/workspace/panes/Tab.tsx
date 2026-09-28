import { IconButton } from '@/components/IconButton'
import { interactive } from '@/components/interactive'
import { Caption } from '@/components/Typography'
import { cn } from '@/lib/utils'
import { Icon } from '@/icons/Icon'
import type { IconName } from '@/icons/icons'
import type { Tab as TabData, TabKind } from '../model/layout'
import { dispatch } from '../model/layout-store'

export const TAB_ICON: Record<TabKind, IconName> = {
  conversation: 'conversation',
  terminal: 'terminal',
  browser: 'browser',
  file: 'fileCode',
  diff: 'diff',
}

// One tab in a pane's strip. The active tab of the focused pane is filled; in other panes it keeps
// its text colour but no fill. Close shows on the active tab and on hover.
export function Tab({ tab, active, focused }: { tab: TabData; active: boolean; focused: boolean }) {
  const activate = (): void => dispatch({ type: 'activateTab', tabId: tab.id })
  return (
    <div
      role="tab"
      tabIndex={active ? 0 : -1}
      aria-selected={active}
      data-selected={(active && focused) || undefined}
      onClick={activate}
      onAuxClick={(event) => event.button === 1 && dispatch({ type: 'closeTab', tabId: tab.id })}
      onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && activate()}
      className={cn(
        interactive,
        'group/tab flex h-7 max-w-48 min-w-0 shrink-0 items-center gap-2 rounded-sm ps-2 pe-0.5',
        active ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      <Icon name={TAB_ICON[tab.kind]} size="sm" />
      <Caption tone="inherit" weight={active ? 'medium' : 'regular'} truncate className="min-w-0 flex-1">
        {tab.title}
      </Caption>
      <span className={cn('flex', active ? 'visible' : 'invisible group-hover/tab:visible')}>
        <IconButton
          icon="close"
          label="Close tab"
          size="xs"
          onClick={() => dispatch({ type: 'closeTab', tabId: tab.id })}
        />
      </span>
    </div>
  )
}
