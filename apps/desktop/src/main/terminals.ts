import { randomUUID } from 'node:crypto'
import { dailyUseCommand } from '@ade/client'
import { handle } from './ipc'
import { getClient, getSocket, isSwitching } from './profile-connection'
import { validId } from './validation'

// The renderer's terminal commands: create, close and restart a workspace's terminals. Each is one
// daemon effect command under a fresh operation ID; closing is two (stop, then retire) until the
// daemon has a single `terminal.close` (.scratch/daemon-authority/issues/04-lane-terminal-records.md).

function endpoint(): string {
  const socket = getSocket()
  if (!socket || isSwitching() || getClient().getState().status !== 'connected')
    throw new Error('Profile daemon is unavailable')
  return socket
}

/** The workspace, when the terminal is one of its own. */
function owner(workspaceId: unknown, terminalId: unknown) {
  if (!validId(workspaceId) || !validId(terminalId)) throw new Error('Invalid terminal')
  const workspace = getClient()
    .getState()
    .catalog?.workspaces.find((item) => item.id === workspaceId)
  if (!workspace || (workspace.terminal_id !== terminalId && !workspace.extra_terminals?.includes(terminalId)))
    throw new Error('The terminal is no longer in this workspace')
  return workspace
}

export function registerTerminalIpc(): void {
  handle('ade:terminal-create', async (_event, workspaceId: unknown) => {
    if (!validId(workspaceId)) throw new Error('Invalid workspace')
    const created = await dailyUseCommand(endpoint(), {
      op: 'terminal.create',
      workspace_id: workspaceId,
      operation_id: randomUUID(),
    })
    return created.terminal_id
  })

  handle('ade:terminal-close', async (_event, workspaceId: unknown, terminalId: unknown) => {
    const workspace = owner(workspaceId, terminalId)
    const socket = endpoint()
    const ids = { workspace_id: workspace.id, terminal_id: terminalId as string }
    await dailyUseCommand(socket, { op: 'terminal.stop', operation_id: randomUUID(), ...ids })
    // The workspace's first shell stays its own; only the others are removed.
    if (workspace.terminal_id !== terminalId)
      await dailyUseCommand(socket, { op: 'terminal.retire', operation_id: randomUUID(), ...ids })
  })

  handle('ade:terminal-restart', async (_event, workspaceId: unknown, terminalId: unknown) => {
    const workspace = owner(workspaceId, terminalId)
    await dailyUseCommand(endpoint(), {
      op: 'terminal.restart',
      operation_id: randomUUID(),
      workspace_id: workspace.id,
      terminal_id: terminalId as string,
    })
  })
}
