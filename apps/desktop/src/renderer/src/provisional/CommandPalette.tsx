import { groupBy } from 'es-toolkit'
import { create } from 'zustand'
import {
  Command as CommandRoot,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import type { Command, CommandService } from '../commands/command-service'
import { Shortcut } from '../components/Shortcut'

// The command palette: every command available now, grouped by category, with its shortcut. The
// native menu opens it (the `command-palette` app command). Stock kit until designed in Pen.

const usePalette = create<{ open: boolean }>(() => ({ open: false }))

export const openCommandPalette = (): void => usePalette.setState({ open: true })

export function CommandPalette({ service }: { service: CommandService }) {
  const open = usePalette((state) => state.open)
  const setOpen = (next: boolean): void => usePalette.setState({ open: next })
  const groups = groupBy(open ? service.commands() : [], (command) => command.category ?? 'General')
  const run = (command: Command): void => {
    setOpen(false)
    service.execute(command.id)
  }
  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandRoot>
        <CommandInput placeholder="Type a command" />
        <CommandList>
          <CommandEmpty>No matching commands.</CommandEmpty>
          {Object.entries(groups).map(([category, commands]) => (
            <CommandGroup key={category} heading={category}>
              {commands.map((command) => (
                <CommandItem key={command.id} value={`${category} ${command.title}`} onSelect={() => run(command)}>
                  {command.title}
                  {service.keybindingFor(command.id) && (
                    <CommandShortcut>
                      <Shortcut keys={service.keybindingFor(command.id)!} />
                    </CommandShortcut>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandRoot>
    </CommandDialog>
  )
}
