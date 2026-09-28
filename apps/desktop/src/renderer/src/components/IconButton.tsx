import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Icon } from '@/icons/Icon'
import type { IconName } from '@/icons/icons'
import type { APP_COMMAND_KEYS } from '../../../shared/app-commands'
import { Shortcut } from './Shortcut'

// A button that shows only an icon: strip buttons, toolbar actions, sidebar toggles. Its label is
// both the accessible name and the tooltip, so neither can be forgotten; a shortcut, when it has
// one, shows in the tooltip from the keys that are actually bound.

type IconButtonProps = {
  icon: IconName
  /** Sentence case; says what happens ("Split right", "Close tab"). */
  label: string
  onClick?: () => void
  /** 28px (default) or 24px for tight rows. */
  size?: 'sm' | 'xs'
  /** A toggle that is on, such as the active rail section: drawn with the kit's secondary fill. */
  selected?: boolean
  disabled?: boolean
  shortcut?: { appCommand: keyof typeof APP_COMMAND_KEYS } | { keys: string }
  side?: 'top' | 'bottom' | 'left' | 'right'
}

export function IconButton({
  icon,
  label,
  onClick,
  size = 'sm',
  selected,
  disabled,
  shortcut,
  side = 'bottom',
}: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={selected ? 'secondary' : 'ghost'}
            size={size === 'xs' ? 'icon-xs' : 'icon-sm'}
            aria-label={label}
            aria-pressed={selected}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        <Icon name={icon} />
      </TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        {shortcut &&
          ('appCommand' in shortcut ? (
            <Shortcut appCommand={shortcut.appCommand} />
          ) : (
            <Shortcut keys={shortcut.keys} />
          ))}
      </TooltipContent>
    </Tooltip>
  )
}
