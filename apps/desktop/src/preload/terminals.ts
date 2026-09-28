import { invoke } from './ipc'
import type { TerminalsBridge } from '../shared/bridge/terminals'

export const terminals: TerminalsBridge = {
  create: (workspaceId) => invoke('ade:terminal-create', workspaceId),
  close: (workspaceId, terminalId) => invoke('ade:terminal-close', workspaceId, terminalId),
  restart: (workspaceId, terminalId) => invoke('ade:terminal-restart', workspaceId, terminalId),
}
