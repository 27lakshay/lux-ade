import { dailyUseCommand } from '@ade/client'
import { handle } from './ipc'
import { getClient, getSocket } from './profile-connection'

// The profile's settings, forwarded to the daemon, which checks every key and value.

function endpoint(): string {
  const socket = getSocket()
  if (!socket || getClient().getState().status !== 'connected') throw new Error('Profile daemon is unavailable')
  return socket
}

export function registerSettingsIpc(): void {
  handle('ade:settings-get', async () => (await dailyUseCommand(endpoint(), { op: 'settings.get' })).settings)
  handle('ade:settings-set', async (_event, changes: unknown) => {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Invalid settings')
    const { appearance, reduced_motion } = changes as Record<string, unknown>
    const request = {
      op: 'settings.set' as const,
      ...(appearance === undefined ? {} : { appearance: appearance as 'light' | 'dark' | 'system' }),
      ...(reduced_motion === undefined ? {} : { reduced_motion: reduced_motion as 'system' | 'on' | 'off' }),
    }
    return (await dailyUseCommand(endpoint(), request)).settings
  })
}
