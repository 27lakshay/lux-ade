import { randomUUID } from 'node:crypto'
import { dailyUseCommand } from '@ade/client'
import { handle } from './ipc'
import { getClient, getSocket, isSwitching } from './profile-connection'
import { validId } from './validation'
import { recordOf } from './windows'

// The renderer's terminal commands: create and restart a workspace's terminals. Each is one daemon
// effect command under a fresh operation ID. A shell closes with its last tab (layouts.ts).

function endpoint(): string {
  const socket = getSocket()
  if (!socket || isSwitching() || getClient().getState().status !== 'connected')
    throw new Error('Profile daemon is unavailable')
  return socket
}

export function registerTerminalIpc(): void {
  handle('ade:terminal-create', async (event, workspaceId: unknown, paneId: unknown) => {
    if (!validId(workspaceId) || (paneId !== undefined && !validId(paneId)))
      throw new Error('Invalid workspace or pane')
    const created = await dailyUseCommand(endpoint(), {
      op: 'terminal.create',
      workspace_id: workspaceId,
      operation_id: randomUUID(),
      // Its tab opens in this window in the same step.
      place: { window_id: recordOf(event.sender.id), ...(paneId !== undefined ? { pane_id: paneId } : {}) },
    })
    return created.terminal_id
  })

  handle('ade:terminal-restart', async (_event, workspaceId: unknown, terminalId: unknown) => {
    if (!validId(workspaceId) || !validId(terminalId)) throw new Error('Invalid terminal')
    // The daemon refuses a terminal that is not the workspace's own.
    await dailyUseCommand(endpoint(), {
      op: 'terminal.restart',
      operation_id: randomUUID(),
      workspace_id: workspaceId,
      terminal_id: terminalId,
    })
  })
}
