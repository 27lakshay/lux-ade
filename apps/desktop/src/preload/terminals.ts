import { invoke, invokeResult } from './ipc'
import type { TerminalsBridge } from '../shared/bridge/terminals'

export const terminals: TerminalsBridge = {
  appearance: (workspaceId, terminalId) => invokeResult('ade:terminal-appearance', workspaceId, terminalId),
  setAppearance: (workspaceId, terminalId, binding, revision) =>
    invokeResult('ade:terminal-set-appearance', workspaceId, terminalId, binding, revision),
  create: (workspaceId, paneId) => invoke('ade:terminal-create', workspaceId, paneId),
  restart: (workspaceId, terminalId) => invoke('ade:terminal-restart', workspaceId, terminalId),
}
