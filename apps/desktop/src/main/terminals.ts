import type { ThemeBinding } from '@ade/contracts'
import { randomUUID } from 'node:crypto'
import { dailyUseCommand, DaemonRequestError } from '@ade/client'
import { handle, handleResult } from './ipc'
import { getClient, getSocket, isSwitching } from './profile-connection'
import { validId } from './validation'
import { recordOf } from './windows'

// The renderer's terminal commands: create and restart a workspace's terminals. Each is one daemon
// effect command under a fresh operation ID. A shell closes with its last tab (layouts.ts).

function endpoint(): string {
  const socket = getSocket()
  if (!socket || isSwitching() || getClient().getState().status !== 'connected')
    throw new DaemonRequestError('unavailable', 'Profile daemon is unavailable')
  return socket
}

export function registerTerminalIpc(): void {
  handleResult('ade:terminal-appearance', async (_event, workspaceId: unknown, terminalId: unknown) => {
    if (!validId(workspaceId) || !validId(terminalId))
      throw new DaemonRequestError('invalid_request', 'Invalid terminal')
    return dailyUseCommand(endpoint(), {
      op: 'terminal.appearance.get',
      workspace_id: workspaceId,
      terminal_id: terminalId,
    })
  })
  handleResult(
    'ade:terminal-set-appearance',
    async (_event, workspaceId: unknown, terminalId: unknown, binding: unknown, revision: unknown) => {
      if (!validId(workspaceId) || !validId(terminalId))
        throw new DaemonRequestError('invalid_request', 'Invalid terminal')
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
        throw new DaemonRequestError('invalid_request', 'Invalid appearance revision')
      return dailyUseCommand(endpoint(), {
        op: 'terminal.appearance.set',
        workspace_id: workspaceId,
        terminal_id: terminalId,
        binding: binding as ThemeBinding | null,
        expected_appearance_revision: revision,
      })
    },
  )

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
    if (!validId(workspaceId) || !validId(terminalId))
      throw new DaemonRequestError('invalid_request', 'Invalid terminal')
    // The daemon refuses a terminal that is not the workspace's own.
    await dailyUseCommand(endpoint(), {
      op: 'terminal.restart',
      operation_id: randomUUID(),
      workspace_id: workspaceId,
      terminal_id: terminalId,
    })
  })
}
