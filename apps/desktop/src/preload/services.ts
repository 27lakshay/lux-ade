import { invoke } from './ipc'
import type { ServicesBridge } from '../shared/bridge/services'

export const services: ServicesBridge = {
  request: (op, fields) => invoke('ade:service-request', op, fields),
  requestScript: (op, fields) => invoke('ade:script-request', op, fields),
}
