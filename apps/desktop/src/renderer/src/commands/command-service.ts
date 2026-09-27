import { tinykeys } from 'tinykeys'
import { whenHolds } from './when'

// Commands and keybindings, in the style of VS Code. Features and plugins register commands;
// keybindings map a key sequence (tinykeys syntax: `$mod+K`, `$mod+K $mod+S`) to a command, under a
// `when` clause. When several bindings share a key, the highest-priority source whose `when` holds
// wins: user over plugin over default, then the most recently registered. The command palette lists
// commands with their shortcut labels.
//
// Global shortcuts (new tab, close tab, palette…) belong to the native menu and arrive as app
// commands (src/shared/app-commands.ts); do not bind those keys here.

export interface Command {
  id: string
  title: string
  category?: string
  /** The command is available only where this `when` clause holds. */
  when?: string
  run: (args?: unknown) => void
}

export type KeybindingSource = 'default' | 'plugin' | 'user'

export interface Keybinding {
  key: string
  command: string
  when?: string
  args?: unknown
  source?: KeybindingSource
}

type Dispose = () => void
const PRIORITY: Record<KeybindingSource, number> = { default: 0, plugin: 1, user: 2 }

const isEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

export interface CommandService {
  registerCommand(command: Command): Dispose
  registerKeybinding(binding: Keybinding): Dispose
  setContext(key: string, value: unknown): void
  /** Runs a command if it exists and its `when` holds; returns whether it ran. */
  execute(id: string, args?: unknown): boolean
  /** Commands available now, for the palette. */
  commands(): Command[]
  /** The key that would run this command now, for labels. */
  keybindingFor(id: string): string | undefined
  /** Listens for key presses on `target`; returns the function that stops listening. */
  listen(target: Window | HTMLElement): Dispose
}

export function createCommandService(): CommandService {
  const commands = new Map<string, Command>()
  const bindings: (Keybinding & { order: number })[] = []
  const context: Record<string, unknown> = {}
  const listeners = new Set<() => void>()
  let order = 0

  const changed = (): void => {
    for (const rebuild of listeners) rebuild()
  }
  const available = (command: Command | undefined): command is Command =>
    Boolean(command && whenHolds(command.when, context))
  const winner = (key: string): (Keybinding & { order: number }) | undefined =>
    bindings
      .filter(
        (binding) =>
          binding.key === key && whenHolds(binding.when, context) && available(commands.get(binding.command)),
      )
      .sort((a, b) => PRIORITY[b.source ?? 'default'] - PRIORITY[a.source ?? 'default'] || b.order - a.order)[0]

  const service: CommandService = {
    registerCommand(command) {
      commands.set(command.id, command)
      changed()
      return () => {
        if (commands.get(command.id) === command) commands.delete(command.id)
        changed()
      }
    },
    registerKeybinding(binding) {
      const entry = { ...binding, order: order++ }
      bindings.push(entry)
      changed()
      return () => {
        const index = bindings.indexOf(entry)
        if (index >= 0) bindings.splice(index, 1)
        changed()
      }
    },
    setContext(key, value) {
      context[key] = value
    },
    execute(id, args) {
      const command = commands.get(id)
      if (!available(command)) return false
      command.run(args)
      return true
    },
    commands: () => [...commands.values()].filter(available),
    keybindingFor: (id) =>
      [...new Set(bindings.map((binding) => binding.key))].find((key) => winner(key)?.command === id),
    listen(target) {
      let stop: Dispose = () => undefined
      const rebuild = (): void => {
        stop()
        const keys = [...new Set(bindings.map((binding) => binding.key))]
        stop = tinykeys(
          target,
          Object.fromEntries(
            keys.map((key) => [
              key,
              (event: KeyboardEvent) => {
                context.inputFocus = isEditable(event.target)
                const binding = winner(key)
                if (!binding) return
                event.preventDefault()
                commands.get(binding.command)?.run(binding.args)
              },
            ]),
          ),
          // Bindings decide for themselves with `when: '!inputFocus'`.
          { ignore: () => false },
        )
      }
      listeners.add(rebuild)
      rebuild()
      return () => {
        listeners.delete(rebuild)
        stop()
      }
    },
  }
  return service
}
