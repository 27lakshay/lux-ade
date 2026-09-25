import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('adeHost', {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('ade:app-version'),
})
