import { createCommandService } from '../commands/command-service'
import { setThemePreference } from './theme'

// The window's command service. Features register their commands here; the command palette lists
// them.
export const commandService = createCommandService()

export function registerAppCommands(): void {
  commandService.registerCommand({
    id: 'theme.light',
    title: 'Use light theme',
    category: 'Appearance',
    run: () => setThemePreference('light'),
  })
  commandService.registerCommand({
    id: 'theme.dark',
    title: 'Use dark theme',
    category: 'Appearance',
    run: () => setThemePreference('dark'),
  })
  commandService.registerCommand({
    id: 'theme.system',
    title: 'Match system theme',
    category: 'Appearance',
    run: () => setThemePreference('system'),
  })
}
