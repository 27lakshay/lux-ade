import { invoke } from './ipc'
import type { TerminalsBridge } from '../shared/bridge/terminals'

export const terminals: TerminalsBridge = {
  create: (workspaceId, paneId) => invoke('ade:terminal-create', workspaceId, paneId),
  restart: (workspaceId, terminalId) => invoke('ade:terminal-restart', workspaceId, terminalId),
}
