import { invoke } from './ipc'
import type { TerminalsBridge } from '../shared/bridge/terminals'

export const terminals: TerminalsBridge = {
  create: (workspaceId) => invoke('ade:terminal-create', workspaceId),
  close: (terminalId, force) => invoke('ade:terminal-close', terminalId, force),
  restart: (workspaceId, terminalId) => invoke('ade:terminal-restart', workspaceId, terminalId),
}
