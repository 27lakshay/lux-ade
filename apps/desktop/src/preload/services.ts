import { forward } from './ipc'
import type { ServicesBridge } from '../shared/bridge/services'

export const services: ServicesBridge = {
  request: forward('ade:service-request'),
  requestScript: forward('ade:script-request'),
}
