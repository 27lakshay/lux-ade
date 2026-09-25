import { contextBridge, ipcRenderer } from 'electron'
import type { TerminalBridge, TerminalFrame } from '@ade/terminal'

const terminal: TerminalBridge = {
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

contextBridge.exposeInMainWorld('adeHost', {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('ade:app-version'),
  getClientState: () => ipcRenderer.invoke('ade:client-state'),
  onClientState: (listener: (state: unknown) => void): (() => void) => {
    const receive = (_event: Electron.IpcRendererEvent, state: unknown): void => listener(state)
    ipcRenderer.on('ade:client-state-changed', receive)
    return () => ipcRenderer.removeListener('ade:client-state-changed', receive)
  },
  terminal,
})
