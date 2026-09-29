import { Kbd, KbdGroup } from '@/components/ui/kbd'
import type { APP_COMMAND_KEYS } from '../../../shared/app-commands'
import { formatShortcut } from '@/lib/shortcut'
import { useKeybinding } from '../app/keybindings'

// The keys for a command, wherever a shortcut is shown: menus, the palette, tooltips, empty states.
// Pass `appCommand` for a native-menu command (its keys are the profile's keybindings setting), or
// `keys` from the command service's keybindingFor(). Never type a shortcut label by hand.

type ShortcutProps = { appCommand: keyof typeof APP_COMMAND_KEYS; keys?: never } | { keys: string; appCommand?: never }

export function Shortcut({ appCommand, keys }: ShortcutProps) {
  // An app command's keys are the profile's keybindings; an unbound command shows none.
  const bound = useKeybinding(appCommand)
  const shortcut = appCommand ? bound : keys!
  if (!shortcut) return null
  const steps = formatShortcut(shortcut)
  return (
    <KbdGroup>
      {steps.map((step, index) => (
        // Chord steps can repeat (⌘K ⌘K), so the position is part of the key.
        <Kbd key={`${index}-${step}`}>{step}</Kbd>
      ))}
    </KbdGroup>
  )
}
