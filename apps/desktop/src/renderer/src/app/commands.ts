import { createCommandService } from '../commands/command-service'
import { setMotionPreference } from './motion-preference'
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
  commandService.registerCommand({
    id: 'motion.system',
    title: 'Reduce motion: follow system',
    category: 'Appearance',
    run: () => setMotionPreference('system'),
  })
  commandService.registerCommand({
    id: 'motion.on',
    title: 'Reduce motion: on',
    category: 'Appearance',
    run: () => setMotionPreference('on'),
  })
  commandService.registerCommand({
    id: 'motion.off',
    title: 'Reduce motion: off',
    category: 'Appearance',
    run: () => setMotionPreference('off'),
  })
}
