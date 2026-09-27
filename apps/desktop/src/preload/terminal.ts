import { ipcRenderer } from 'electron'
import type { TerminalBridge, TerminalFrame } from '@ade/terminal'

export const terminal: TerminalBridge = {
  async attach(workspaceId, terminalId, onFrame, onClose) {
    const connectionId = globalThis.crypto.randomUUID()
    const frameListener = (_event: Electron.IpcRendererEvent, id: string, frame: TerminalFrame): void => {
      if (id === connectionId) onFrame(frame)
    }
    const closeListener = (_event: Electron.IpcRendererEvent, id: string, reason: string): void => {
      if (id === connectionId) onClose(reason)
    }
    ipcRenderer.on('ade:terminal-frame', frameListener)
    ipcRenderer.on('ade:terminal-close', closeListener)
    try {
      await ipcRenderer.invoke('ade:terminal-attach', connectionId, workspaceId, terminalId)
    } catch (error) {
      ipcRenderer.removeListener('ade:terminal-frame', frameListener)
      ipcRenderer.removeListener('ade:terminal-close', closeListener)
      throw error
    }
    return {
      input: (data) => ipcRenderer.send('ade:terminal-input', connectionId, data),
      binary: (bytes) => ipcRenderer.send('ade:terminal-binary', connectionId, bytes),
      resize: (cols, rows, widthPx, heightPx) =>
        ipcRenderer.send('ade:terminal-resize', connectionId, cols, rows, widthPx, heightPx),
      dispose: () => {
        ipcRenderer.removeListener('ade:terminal-frame', frameListener)
        ipcRenderer.removeListener('ade:terminal-close', closeListener)
        ipcRenderer.send('ade:terminal-detach', connectionId)
      },
    }
  },
}
