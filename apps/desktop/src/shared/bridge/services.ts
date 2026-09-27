import type { ContractRequest, ScriptOperation, ServiceOperation } from './operations'

/** `window.adeHost.services`: the main-process `services` module (managed services and scripts). */
export interface ServicesBridge {
  request: ContractRequest<ServiceOperation>
  requestScript: ContractRequest<ScriptOperation>
}
