import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('adeHost', {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('ade:app-version'),
  getClientState: () => ipcRenderer.invoke('ade:client-state'),
  onClientState: (listener: (state: unknown) => void): (() => void) => {
    const receive = (_event: Electron.IpcRendererEvent, state: unknown): void => listener(state)
    ipcRenderer.on('ade:client-state-changed', receive)
    return () => ipcRenderer.removeListener('ade:client-state-changed', receive)
  },
})
