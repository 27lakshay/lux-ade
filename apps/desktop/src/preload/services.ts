import { ipcRenderer } from 'electron'
import type { ServicesBridge } from '../renderer/src/host/services'

export const services: ServicesBridge = {
  request: (op, fields) => ipcRenderer.invoke('ade:service-request', op, fields),
  requestScript: (op, fields) => ipcRenderer.invoke('ade:script-request', op, fields),
}
