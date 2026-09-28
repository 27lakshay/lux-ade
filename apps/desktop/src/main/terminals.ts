import { randomUUID } from 'node:crypto'
import { DaemonRequestError, dailyUseCommand } from '@ade/client'
import type { TerminalCloseOutcome } from '../shared/bridge/terminals'
import { handle } from './ipc'
import { getClient, getSocket, isSwitching } from './profile-connection'
import { validId } from './validation'

// The renderer's terminal commands: create, close and restart a workspace's terminals. Each is one
// daemon effect command under a fresh operation ID. The daemon decides whether a terminal is busy;
// a busy refusal comes back as the running command, so the window can ask before forcing.

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

  handle('ade:terminal-close', async (_event, terminalId: unknown, force: unknown): Promise<TerminalCloseOutcome> => {
    if (!validId(terminalId)) throw new Error('Invalid terminal')
    const terminal = getClient()
      .getState()
      .catalog?.terminals?.find((item) => item.id === terminalId)
    // Already gone, or a service's, script's or Conversation's terminal: those have their own
    // controls, and closing their tab only takes it out of the layout.
    if (!terminal || terminal.kind !== 'shell') return { closed: true }
    try {
      await dailyUseCommand(endpoint(), {
        op: 'terminal.close',
        operation_id: randomUUID(),
        terminal_id: terminalId,
        ...(force === true ? { force: true } : {}),
      })
      return { closed: true }
    } catch (error) {
      if (error instanceof DaemonRequestError && error.code === 'terminal_busy') {
        const running = error.details.foreground
        return { closed: false, running: typeof running === 'string' ? running : null }
      }
      throw error
    }
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
