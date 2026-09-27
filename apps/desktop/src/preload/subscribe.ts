import { ipcRenderer } from 'electron'

/** Forwards the first argument of each `channel` event to `listener`; returns the unsubscribe function. */
export function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const receive = (_event: Electron.IpcRendererEvent, value: T): void => listener(value)
  ipcRenderer.on(channel, receive)
  return () => ipcRenderer.removeListener(channel, receive)
}
