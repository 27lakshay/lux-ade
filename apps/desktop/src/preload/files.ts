import { ipcRenderer } from 'electron'
import type { FilesBridge } from '../renderer/src/host/files'

export const files: FilesBridge = {
  request: (op, fields) => ipcRenderer.invoke('ade:file-request', op, fields),
}
